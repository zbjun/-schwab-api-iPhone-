type Timer = ReturnType<typeof setTimeout>;

type MarketPollingOptions = {
  run: () => Promise<void>;
  interval: () => number;
  cadence?: "start" | "completion";
  onError?: (error: unknown) => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
};

/** Serial foreground polling with start-to-start cadence and bounded retries. */
export function startMarketPolling({
  run,
  interval,
  cadence = "start",
  onError,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
}: MarketPollingOptions): {
  setActive(active: boolean): void;
  stop(): void;
} {
  let active = false;
  let stopped = false;
  let inFlight = false;
  let resumePending = false;
  let failures = 0;
  let timer: Timer | undefined;

  function clearTimer() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }

  async function poll(): Promise<void> {
    if (!active || stopped || inFlight) return;
    inFlight = true;
    resumePending = false;
    const started = now();
    try {
      await run();
      failures = 0;
    } catch (error) {
      failures = Math.min(failures + 1, 20);
      try {
        onError?.(error);
      } catch {
        // A reporting callback must not interrupt future polling.
      }
    } finally {
      inFlight = false;
    }
    if (!active || stopped) return;
    if (resumePending) {
      void poll();
      return;
    }
    const requested = interval();
    const base = Number.isFinite(requested) ? Math.max(250, requested) : 1000;
    const elapsed = cadence === "completion" ? 0 : Math.max(0, now() - started);
    // Failed reads always leave at least one base interval before retrying.
    const delay = failures
      ? Math.min(60_000, Math.max(base, base * 2 ** (failures - 1) - elapsed))
      : Math.max(250, base - elapsed);
    timer = schedule(() => {
      timer = undefined;
      void poll();
    }, delay);
  }

  return {
    setActive(next) {
      if (stopped || next === active) return;
      active = next;
      clearTimer();
      if (!next) {
        resumePending = false;
      } else if (inFlight) {
        resumePending = true;
      } else {
        void poll();
      }
    },
    stop() {
      stopped = true;
      active = false;
      resumePending = false;
      clearTimer();
    },
  };
}
