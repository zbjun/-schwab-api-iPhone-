/** Account stream events invalidate reads; they are not an execution ledger.
 * Coalesce bursts and always run a trailing read for an event received in flight. */
export function createActivitySync({ read, schedule = setTimeout, cancel = clearTimeout }: {
  read: () => Promise<void>; schedule?: typeof setTimeout; cancel?: typeof clearTimeout;
}) {
  let stopped = false, dirty = false;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRead = () => {
    if (stopped || pending || timer !== undefined || !dirty) return;
    timer = schedule(() => { timer = undefined; void drain().catch(() => {}); }, 200);
  };
  const drain = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    dirty = false;
    pending = Promise.resolve().then(read).finally(() => { pending = undefined; scheduleRead(); });
    return pending;
  };
  return {
    notify() { if (!stopped) { dirty = true; scheduleRead(); } },
    poll() {
      // A timer observes the existing read, without requesting an unnecessary
      // trailing read. Propagate failure for completion cadence/backoff.
      if (timer !== undefined) { cancel(timer); timer = undefined; }
      return drain();
    },
    stop() { stopped = true; dirty = false; if (timer !== undefined) cancel(timer); timer = undefined; },
  };
}
