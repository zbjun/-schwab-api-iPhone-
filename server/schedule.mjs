import { TradingError, freezeDraft, validateDraft } from '../mobile/src/orderRules.ts';

const KEY = 'ths.gateway.scheduled.v1';
const DAY = 86_400_000;
const fail = (code, message) => { throw new TradingError(code, message); };
const FINISHED = new Set(['submitted', 'failed', 'cancelled', 'missed', 'unknown', 'skipped']);

/**
 * Server-held timed orders. Each entry is submitted at most once through the
 * broker's quick path (fresh validation plus one write) under the gateway's
 * shared write lock. "submitting" is persisted before the write, so a crash
 * mid-submit is reported as unknown and never replayed; a missed time is
 * never caught up later.
 */
export function createScheduler({
  vault,
  broker,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  lateness = 60_000,
  busyWait = 10_000,
  maxPending = 20,
  keep = 100,
  warn = () => {},
}) {
  let entries = [];
  let lock;
  let timer;
  let firing = false;
  let stopped = false;
  const save = () => vault.set(KEY, JSON.stringify({ version: 1, entries }));
  const copy = entry => structuredClone(entry);
  const finish = (entry, status, fields = {}) => Object.assign(entry, { status, finishedAt: now(), ...fields });
  const prune = () => {
    const finished = entries.filter(entry => FINISHED.has(entry.status));
    if (finished.length <= keep) return;
    const drop = new Set(finished.sort((a, b) => b.runAt - a.runAt).slice(keep).map(entry => entry.id));
    entries = entries.filter(entry => !drop.has(entry.id));
  };
  const arm = () => {
    if (timer) clearTimer(timer);
    timer = undefined;
    if (stopped) return;
    const next = entries.filter(entry => entry.status === 'pending').sort((a, b) => a.runAt - b.runAt)[0];
    if (!next) return;
    // Re-check at least hourly so long waits never overflow the timer range.
    timer = setTimer(() => { timer = undefined; void fire(); }, Math.min(Math.max(0, next.runAt - now()), 3_600_000));
  };
  const acquire = async entry => {
    while (!lock?.tryAcquire()) {
      if (stopped || now() - entry.runAt > busyWait) return false;
      await new Promise(resolve => setTimer(resolve, 250));
    }
    return true;
  };
  const execute = async entry => {
    if (now() - entry.runAt > lateness) {
      finish(entry, 'missed', { message: '服务器未能按时执行，已放弃，未提交订单。' });
      return;
    }
    if (!(await acquire(entry))) {
      finish(entry, 'skipped', { message: '到点时另一笔委托正在处理，已放弃，未提交订单。' });
      return;
    }
    try {
      entry.status = 'submitting';
      entry.startedAt = now();
      await save(); // Durable before the write: a crash can never replay it.
      const { result } = await broker.submitQuick(entry.accountID, entry.draft);
      finish(entry, 'submitted', { orderID: result?.orderID });
    } catch (error) {
      const known = error instanceof TradingError;
      finish(entry, known && error.code === 'orderOutcomeUnknown' ? 'unknown' : 'failed', {
        code: known ? error.code : 'serverFailure',
        message: known ? error.message : '服务器提交失败，请到 Schwab 核对。',
      });
    } finally {
      lock.release();
    }
  };
  const fire = async () => {
    if (firing || stopped) return;
    firing = true;
    try {
      for (;;) {
        const due = entries.filter(entry => entry.status === 'pending' && entry.runAt <= now())
          .sort((a, b) => a.runAt - b.runAt)[0];
        if (!due) break;
        await execute(due);
        prune();
        await save().catch(error => warn('scheduled order state could not be saved', error));
      }
    } finally {
      firing = false;
      arm();
    }
  };
  return {
    /** The gateway shares its device write lock so timed and manual writes never overlap. */
    useLock(value) { lock = value; },
    async load() {
      const raw = await vault.get(KEY);
      const parsed = raw === null ? { version: 1, entries: [] } : JSON.parse(raw);
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('Unreadable scheduled orders');
      entries = parsed.entries;
      let changed = false;
      for (const entry of entries) {
        if (entry.status === 'submitting') {
          finish(entry, 'unknown', { message: '服务器在提交途中重启，结果未知，请到 Schwab 核对；不会重发。' });
          changed = true;
        } else if (entry.status === 'pending' && now() - entry.runAt > lateness) {
          finish(entry, 'missed', { message: '服务器停机期间错过执行时间，已放弃，未提交订单。' });
          changed = true;
        }
      }
      if (changed) await save();
      arm();
    },
    list() {
      return entries.slice().sort((a, b) => b.runAt - a.runAt).map(copy);
    },
    async add(device, accountID, draft, runAt, id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(id))
        fail('invalidRequest', '定时单编号无效。');
      if (typeof accountID !== 'string' || !accountID || accountID.length > 64 || !draft || typeof draft !== 'object')
        fail('invalidRequest', '定时单参数无效。');
      const existing = entries.find(entry => entry.id === id);
      if (existing) {
        // A retried request returns the original entry instead of scheduling twice.
        if (existing.device !== device || existing.accountID !== accountID || existing.runAt !== runAt)
          fail('invalidRequest', '定时单编号与已有内容不一致。');
        return copy(existing);
      }
      validateDraft(draft);
      if (!Number.isSafeInteger(runAt) || runAt < now() + 5_000 || runAt > now() + 7 * DAY)
        fail('scheduleTime', '执行时间须在 5 秒之后、7 天之内。');
      if (entries.filter(entry => entry.status === 'pending').length >= maxPending)
        fail('scheduleLimit', `最多同时保留 ${maxPending} 个待执行定时单。`);
      const entry = {
        id, device, accountID, draft: structuredClone(freezeDraft(draft)), runAt,
        createdAt: now(), status: 'pending',
      };
      entries.push(entry);
      await save();
      arm();
      return copy(entry);
    },
    async cancel(id) {
      const entry = entries.find(value => value.id === id);
      if (!entry) fail('scheduleMissing', '定时单不存在。');
      if (entry.status !== 'pending') fail('scheduleChanged', '定时单已执行或已结束，无法撤销。');
      finish(entry, 'cancelled', { message: '已手动撤销，未提交订单。' });
      await save();
      arm();
      return copy(entry);
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = undefined;
    },
  };
}
