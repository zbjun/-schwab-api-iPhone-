export interface ChartPress {
  readonly active: boolean;
  start(pageX: number, pageY: number, localX: number): void;
  move(pageX: number, pageY: number, localX: number): void;
  end(): void;
  cancel(): void;
}

export function createChartPress(
  onSelect: (localX: number) => void,
  onTap: (localX: number) => void = onSelect,
): ChartPress {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let startX = 0;
  let startY = 0;
  let latestX = 0;

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    active = false;
  };

  return {
    get active() {
      return active;
    },
    start(pageX, pageY, localX) {
      cancel();
      startX = pageX;
      startY = pageY;
      latestX = localX;
      timer = setTimeout(() => {
        timer = undefined;
        active = true;
        onSelect(latestX);
      }, 450);
    },
    move(pageX, pageY, localX) {
      if (active) {
        latestX = localX;
        onSelect(localX);
      } else if (timer !== undefined) {
        latestX = localX;
        if (Math.hypot(pageX - startX, pageY - startY) > 7) cancel();
      }
    },
    end() {
      const tap = timer !== undefined;
      cancel();
      if (tap) onTap(latestX);
    },
    cancel,
  };
}
