export type CandleGeometry = {
  open: number;
  high: number;
  low: number;
  close: number;
};

/** One short animation per observation; no idle loop or whole-chart state updates. */
export function createCandleMotion(
  initial: CandleGeometry,
  paint: (value: CandleGeometry) => void,
  frames: {
    request: (callback: (time: number) => void) => number;
    cancel: (id: number) => void;
  },
) {
  let current = initial;
  let frame: number | undefined;
  let generation = 0;
  const stop = () => {
    generation++;
    if (frame !== undefined) frames.cancel(frame);
    frame = undefined;
  };
  return {
    stop,
    move(target: CandleGeometry, animate: boolean) {
      stop();
      const version = generation;
      if (
        !animate ||
        Object.keys(target).every(
          (key) =>
            target[key as keyof CandleGeometry] ===
            current[key as keyof CandleGeometry],
        )
      ) {
        current = target;
        paint(current);
        return;
      }
      const from = current;
      let start: number | undefined;
      const step = (time: number) => {
        if (version !== generation) return;
        start ??= time;
        const progress = Math.min(1, Math.max(0, (time - start) / 140));
        const eased = 1 - (1 - progress) ** 3;
        current = {
          open: target.open,
          close: from.close + (target.close - from.close) * eased,
          high: from.high + (target.high - from.high) * eased,
          low: from.low + (target.low - from.low) * eased,
        };
        // Pixel coordinates: high is above the body, low below it.
        current.high = Math.min(current.high, current.open, current.close);
        current.low = Math.max(current.low, current.open, current.close);
        paint(current);
        if (version !== generation) return;
        frame = progress < 1 ? frames.request(step) : undefined;
      };
      frame = frames.request(step);
    },
  };
}
