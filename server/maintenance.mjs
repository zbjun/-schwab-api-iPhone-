/** Completion-based maintenance: no overlapping refreshes or archive flushes. */
export function startMaintenance({ broker, archive, warn = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  let stopped = false, timer, pending = Promise.resolve(), ticks = 0;
  const failures = new Set();
  const attempt = async (kind, work) => {
    try { await work(); failures.delete(kind); }
    catch {
      if (!failures.has(kind)) warn(kind); // Never log raw OAuth responses or secrets.
      failures.add(kind);
    }
  };
  const tick = () => {
    if (stopped) return;
    pending = Promise.all([
      attempt('authorization', () => broker.maintainAuthorization()),
      ++ticks % 2 === 0 && archive ? attempt('minuteArchive', () => archive.flush()) : Promise.resolve(),
    ]).then(() => {
      if (!stopped) { timer = schedule(tick, 30_000); timer.unref?.(); }
    });
  };
  tick();
  return { async stop() {
    stopped = true;
    if (timer !== undefined) cancel(timer);
    await pending;
    if (archive) await attempt('minuteArchive', () => archive.flush());
  } };
}
