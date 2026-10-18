import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from './schedule.mjs';
import { TradingError } from '../mobile/src/orderRules.ts';

const KEY = 'ths.gateway.scheduled.v1';
const T0 = Date.parse('2026-10-19T13:29:00Z');
const draft = { symbol: 'AAPL', side: 'BUY', kind: 'LIMIT', quantity: 2, limitPrice: '230', duration: 'DAY' };
const id = (n = 1) => `scheduled-order-${String(n).padStart(4, '0')}`;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness({ submit, stored } = {}) {
  let time = T0;
  const timers = new Map();
  let seq = 0;
  const values = new Map(stored === undefined ? [] : [[KEY, JSON.stringify(stored)]]);
  const vault = { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); } };
  const calls = [];
  const broker = {
    submitQuick: async (accountID, value) => {
      calls.push({ accountID, draft: value, persisted: JSON.parse(values.get(KEY)).entries.map(e => e.status) });
      if (submit) return submit();
      return { snapshot: {}, result: { orderID: '777' } };
    },
  };
  let held = false;
  const lock = { tryAcquire: () => (held ? false : (held = true)), release: () => { held = false; } };
  const scheduler = createScheduler({
    vault, broker, now: () => time,
    setTimer: (fn, ms) => { const key = ++seq; timers.set(key, { at: time + ms, fn }); return key; },
    clearTimer: key => timers.delete(key),
  });
  scheduler.useLock(lock);
  const advance = async ms => {
    const target = time + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    time = target;
    await flush();
  };
  return {
    scheduler, calls, advance, values, lock,
    hold: () => { held = true; }, isHeld: () => held,
    state: () => JSON.parse(values.get(KEY)).entries,
  };
}

test('a timed order is submitted once at its time, after "submitting" is durable', async () => {
  const h = harness();
  await h.scheduler.load();
  const entry = await h.scheduler.add('phone-a', 'acct', draft, T0 + 60_000, id());
  assert.equal(entry.status, 'pending');
  await h.advance(59_000);
  assert.equal(h.calls.length, 0);
  await h.advance(1_000);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].persisted, ['submitting']);
  assert.equal(h.calls[0].accountID, 'acct');
  assert.equal(h.calls[0].draft.limitPrice, '230');
  const [done] = h.scheduler.list();
  assert.equal(done.status, 'submitted');
  assert.equal(done.orderID, '777');
  assert.equal(h.isHeld(), false);
  await h.advance(600_000);
  assert.equal(h.calls.length, 1);
});

test('requests are validated and a retried ID never schedules twice', async () => {
  const h = harness();
  await h.scheduler.load();
  const reject = (promise, code) => assert.rejects(promise, error => error instanceof TradingError && error.code === code);
  await reject(h.scheduler.add('phone-a', 'acct', draft, T0 + 60_000, 'short'), 'invalidRequest');
  await reject(h.scheduler.add('phone-a', 'acct', draft, T0 + 1_000, id()), 'scheduleTime');
  await reject(h.scheduler.add('phone-a', 'acct', draft, T0 + 8 * 86_400_000, id()), 'scheduleTime');
  await reject(h.scheduler.add('phone-a', 'acct', { ...draft, quantity: 0 }, T0 + 60_000, id()), 'quantity');
  const first = await h.scheduler.add('phone-a', 'acct', draft, T0 + 60_000, id());
  const again = await h.scheduler.add('phone-a', 'acct', draft, T0 + 60_000, id());
  assert.deepEqual(again, first);
  await reject(h.scheduler.add('phone-b', 'acct', draft, T0 + 60_000, id()), 'invalidRequest');
  assert.equal(h.scheduler.list().length, 1);
});

test('a restart reports interrupted submissions as unknown and never catches up missed ones', async () => {
  const stored = { version: 1, entries: [
    { id: id(1), device: 'phone-a', accountID: 'acct', draft, runAt: T0 - 5_000, createdAt: T0 - 9e5, status: 'submitting' },
    { id: id(2), device: 'phone-a', accountID: 'acct', draft, runAt: T0 - 120_000, createdAt: T0 - 9e5, status: 'pending' },
    { id: id(3), device: 'phone-a', accountID: 'acct', draft, runAt: T0 + 30_000, createdAt: T0 - 9e5, status: 'pending' },
  ] };
  const h = harness({ stored });
  await h.scheduler.load();
  const byID = Object.fromEntries(h.state().map(e => [e.id, e.status]));
  assert.deepEqual(byID, { [id(1)]: 'unknown', [id(2)]: 'missed', [id(3)]: 'pending' });
  await h.advance(30_000);
  assert.equal(h.calls.length, 1);
});

test('broker rejections fail the entry; uncertain writes are marked unknown', async () => {
  const failing = harness({ submit: () => { throw new TradingError('insufficientFunds', '购买力不足'); } });
  await failing.scheduler.load();
  await failing.scheduler.add('phone-a', 'acct', draft, T0 + 10_000, id());
  await failing.advance(10_000);
  assert.equal(failing.scheduler.list()[0].status, 'failed');
  assert.equal(failing.scheduler.list()[0].code, 'insufficientFunds');
  const uncertain = harness({ submit: () => { throw new TradingError('orderOutcomeUnknown', '结果未知'); } });
  await uncertain.scheduler.load();
  await uncertain.scheduler.add('phone-a', 'acct', draft, T0 + 10_000, id());
  await uncertain.advance(10_000);
  assert.equal(uncertain.scheduler.list()[0].status, 'unknown');
  assert.equal(uncertain.isHeld(), false);
});

test('a busy write lock is waited on briefly, then the order is skipped unsent', async () => {
  const h = harness();
  await h.scheduler.load();
  await h.scheduler.add('phone-a', 'acct', draft, T0 + 10_000, id());
  h.hold();
  await h.advance(10_000 + 11_000);
  assert.equal(h.calls.length, 0);
  assert.equal(h.scheduler.list()[0].status, 'skipped');
  // A lock released in time still lets the order through.
  const h2 = harness();
  await h2.scheduler.load();
  await h2.scheduler.add('phone-a', 'acct', draft, T0 + 10_000, id());
  h2.hold();
  await h2.advance(10_500);
  h2.lock.release();
  await h2.advance(500);
  assert.equal(h2.calls.length, 1);
});

test('a pending order can be cancelled and is then never submitted', async () => {
  const h = harness();
  await h.scheduler.load();
  await h.scheduler.add('phone-a', 'acct', draft, T0 + 10_000, id());
  const cancelled = await h.scheduler.cancel(id());
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(h.scheduler.cancel(id()), error => error.code === 'scheduleChanged');
  await h.advance(60_000);
  assert.equal(h.calls.length, 0);
});
