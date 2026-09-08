import type { Candle, HistoryRange } from "./types.ts";

/** Scale only visible candles; overlays must not flatten the price action. */
export function candlePriceDomain(candles: Candle[], first: number, end: number) {
  let low = Infinity, high = -Infinity;
  for (let index = first; index < end; index++) {
    const candle = candles[index];
    if (!candle) continue;
    if (Number.isFinite(candle.low)) low = Math.min(low, candle.low);
    if (Number.isFinite(candle.high)) high = Math.max(high, candle.high);
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { low: 0, high: 1 };
  const padding = Math.max((high - low) * 0.08, Math.abs(high) * 0.0005, 0.01);
  return { low: low - padding, high: high + padding };
}

export const primaryRanges: HistoryRange[] = [
  "intraday",
  "daily",
  "weekly",
  "monthly",
  "fiveDay",
];
export const minuteRanges: HistoryRange[] = [
  "minute1",
  "minute5",
  "minute15",
  "minute30",
  "minute60",
  "minute120",
];
const titles: Record<HistoryRange, string> = {
  intraday: "分时",
  fiveDay: "五日",
  daily: "日K",
  weekly: "周K",
  monthly: "月K",
  minute1: "1分钟",
  minute5: "5分钟",
  minute15: "15分钟",
  minute30: "30分钟",
  minute60: "60分钟",
  minute120: "120分钟",
};
export const rangeTitle = (range: HistoryRange): string => titles[range];
export const minuteInterval = (range: HistoryRange): number | undefined =>
  range.startsWith("minute") ? Number(range.slice(6)) : undefined;
export const isLineRange = (range: HistoryRange): boolean =>
  range === "intraday" || range === "fiveDay";

export type TradingSession = "premarket" | "regular" | "postmarket" | "overnight";
export interface SessionWindow {
  session: TradingSession;
  start: number;
  end: number;
}
export const sessionTitles: Record<TradingSession, string> = {
  premarket: "盘前",
  regular: "盘中",
  postmarket: "盘后",
  overnight: "夜盘",
};
const minute = 60_000;
const maximumTimestamp = 32_503_680_000_000;
const validTime = (time: number): boolean =>
  Number.isFinite(time) && time >= 0 && time < maximumTimestamp;
const nonnegative = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const newYorkFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
function newYorkParts(time: number): DateParts {
  const parts = newYorkFormatter.formatToParts(new Date(time));
  const values: Record<string, number> = {};
  for (const part of parts)
    if (part.type !== "literal") values[part.type] = Number(part.value);
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

export function newYorkDateKey(time: number): string | undefined {
  if (!validTime(time)) return undefined;
  const parts = newYorkParts(time);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function newYorkWallTime(parts: DateParts, hour: number, minutes = 0): number {
  const requested = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    minutes,
  );
  let candidate = requested;
  // Resolve the actual IANA offset, including the two DST changes; trading opens are unambiguous.
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = newYorkParts(candidate);
    const wall = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = requested - wall;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

// Published NYSE 2026–2028 schedule, matching the native implementation. Other years
// use ordinary weekdays; unscheduled closures cannot be inferred from absent candles.
// https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/
const earlyClosingDates = new Set([
  20261127, 20261224, 20271126, 20280703, 20281124,
]);
const closedDates = new Set([
  20260101, 20260119, 20260216, 20260403, 20260525, 20260619, 20260703,
  20260907, 20261126, 20261225, 20270101, 20270118, 20270215, 20270326,
  20270531, 20270618, 20270705, 20270906, 20271125, 20271224, 20280117,
  20280221, 20280414, 20280529, 20280619, 20280704, 20280904, 20281123,
  20281225,
]);
const windowCache = new Map<number, readonly SessionWindow[]>();

function cachedWindows(time: number): readonly SessionWindow[] {
  if (!validTime(time)) return [];
  const parts = newYorkParts(time);
  const key = parts.year * 10_000 + parts.month * 100 + parts.day;
  const cached = windowCache.get(key);
  if (cached) return cached;
  const weekday = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay();
  let windows: SessionWindow[] = [];
  if (weekday !== 0 && weekday !== 6 && !closedDates.has(key)) {
    const premarket = newYorkWallTime(parts, 4);
    const regular = newYorkWallTime(parts, 9, 30);
    const close = newYorkWallTime(parts, earlyClosingDates.has(key) ? 13 : 16);
    const end = newYorkWallTime(parts, earlyClosingDates.has(key) ? 17 : 20);
    windows = [
      { session: "premarket", start: premarket, end: regular },
      { session: "regular", start: regular, end: close },
      { session: "postmarket", start: close, end },
    ];
  }
  if (windowCache.size >= 512)
    windowCache.delete(windowCache.keys().next().value!);
  windowCache.set(key, windows);
  return windows;
}

export function sessionWindows(timestamp: number): SessionWindow[] {
  return cachedWindows(timestamp).map((window) => ({ ...window }));
}

export function sessionAt(timestamp: number): TradingSession | undefined {
  return cachedWindows(timestamp).find(
    (window) => timestamp >= window.start && timestamp < window.end,
  )?.session;
}

const observedWindowCache = new Map<string, readonly SessionWindow[]>();
/** Classify actual chart observations, not trading permission or an opening calendar.
 * Overnight venues can have a different holiday schedule from the daytime exchange.
 * Never generate candles from these windows. Split at local midnight for stable buckets.
 */
export function chartSessionWindow(timestamp: number): SessionWindow | undefined {
  if (!validTime(timestamp)) return undefined;
  const day = newYorkDateKey(timestamp)!;
  let windows = observedWindowCache.get(day);
  if (!windows) {
    const parts = newYorkParts(timestamp);
    windows = [
      { session: "overnight", start: newYorkWallTime(parts, 0), end: newYorkWallTime(parts, 4) },
      ...cachedWindows(timestamp),
      { session: "overnight", start: newYorkWallTime(parts, 20), end: newYorkWallTime(parts, 24) },
    ];
    if (observedWindowCache.size >= 512) observedWindowCache.delete(observedWindowCache.keys().next().value!);
    observedWindowCache.set(day, windows);
  }
  const window = windows.find((w) => timestamp >= w.start && timestamp < w.end);
  return window ? { ...window } : undefined;
}

export function hasMissingOvernightData(candles: readonly Candle[], now: number): boolean {
  const window = chartSessionWindow(now);
  if (window?.session !== "overnight") return false;
  // Local midnight splits aggregation buckets, but both halves are one night.
  const start = window.start - (newYorkParts(now).hour < 4 ? 4 * 3600_000 : 0);
  return !candles.some((c) => c.time >= start && c.time <= now && c.time < window.end);
}

export function validCandle(candle: Candle): boolean {
  return (
    validTime(candle.time) &&
    [candle.open, candle.high, candle.low, candle.close].every(nonnegative) &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close)
  );
}

/** Input is one-minute OHLC data. Buckets never straddle a NY date or session boundary. */
export function aggregateMinutes(
  candles: Candle[],
  interval: number,
  asOf: number,
  includeExtendedHours = true,
): Candle[] {
  if (![1, 5, 15, 30, 60, 120].includes(interval) || !validTime(asOf))
    return [];
  const sessions = new Map<
    number,
    { window: SessionWindow; minutes: Map<number, Candle> }
  >();
  for (const candle of candles) {
    if (!validCandle(candle) || candle.time + minute > asOf) continue;
    const window = chartSessionWindow(candle.time);
    if (!window || (!includeExtendedHours && window.session !== "regular"))
      continue;
    const offset = (candle.time - window.start) / minute;
    if (!Number.isInteger(offset)) continue;
    let session = sessions.get(window.start);
    if (!session) {
      session = { window, minutes: new Map() };
      sessions.set(window.start, session);
    }
    // Last valid observation wins, without double-counting repeated minute volume.
    session.minutes.set(offset, candle);
  }

  const result: Candle[] = [];
  for (const { window, minutes } of [...sessions.values()].sort(
    (a, b) => a.window.start - b.window.start,
  )) {
    const available = Math.min(
      (window.end - window.start) / minute,
      Math.floor((asOf - window.start) / minute),
    );
    for (let offset = 0; offset < available; offset += interval) {
      const expected = Math.min(interval, available - offset);
      const bars: Candle[] = [];
      for (let index = offset; index < offset + expected; index++) {
        const bar = minutes.get(index);
        if (bar) bars.push(bar);
      }
      if (
        !bars.length ||
        (window.session === "regular" && bars.length !== expected)
      )
        continue;
      let volume: number | undefined = 0;
      let high = -Infinity;
      let low = Infinity;
      for (const bar of bars) {
        high = Math.max(high, bar.high);
        low = Math.min(low, bar.low);
        volume =
          volume !== undefined &&
          nonnegative(bar.volume) &&
          Number.isFinite(volume + bar.volume)
            ? volume + bar.volume
            : undefined;
      }
      result.push({
        time: bars[0].time,
        open: bars[0].open,
        high,
        low,
        close: bars[bars.length - 1].close,
        volume,
      });
    }
  }
  return result;
}

/** Undefined values preserve the unavailable warm-up or an invalid price window. */
export function movingAverage(
  candles: Candle[],
  period: number,
): (number | undefined)[] {
  const result: (number | undefined)[] = Array(candles.length).fill(undefined);
  if (!Number.isInteger(period) || period < 1 || period > candles.length)
    return result;
  for (let index = period - 1; index < candles.length; index++) {
    let sum = 0;
    for (let offset = index - period + 1; offset <= index; offset++) {
      const close = candles[offset].close;
      if (!nonnegative(close)) {
        sum = NaN;
        break;
      }
      sum += close / period;
    }
    if (Number.isFinite(sum)) result[index] = sum;
  }
  return result;
}

/** Minute-bar typical-price VWAP estimate, reset by NY date; unknown volume poisons that date. */
export function sessionAverage(candles: Candle[]): (number | undefined)[] {
  let day: string | undefined;
  let volume = 0;
  let average: number | undefined;
  let incomplete = false;
  return candles.map((candle) => {
    const nextDay = newYorkDateKey(candle.time);
    if (nextDay === undefined) {
      incomplete = true;
      return undefined;
    }
    if (nextDay !== day) {
      day = nextDay;
      volume = 0;
      average = undefined;
      incomplete = false;
    }
    if (incomplete) return undefined;
    if (
      !nonnegative(candle.volume) ||
      ![candle.high, candle.low, candle.close].every(nonnegative) ||
      candle.high < candle.close ||
      candle.low > candle.close
    ) {
      incomplete = true;
      return undefined;
    }
    if (candle.volume === 0) return average;
    const total = volume + candle.volume;
    const typical = candle.high / 3 + candle.low / 3 + candle.close / 3;
    const updated =
      average === undefined
        ? typical
        : average + (typical - average) * (candle.volume / total);
    if (
      !Number.isFinite(total) ||
      !Number.isFinite(typical) ||
      !Number.isFinite(updated)
    ) {
      incomplete = true;
      return undefined;
    }
    volume = total;
    average = updated;
    return average;
  });
}

export interface CandleViewport {
  start: number;
  count: number;
  totalCount: number;
}
function boundedViewport(
  totalCount: number,
  start: number,
  count: number,
): CandleViewport {
  const total =
    Number.isSafeInteger(totalCount) && totalCount > 0 ? totalCount : 0;
  if (!total) return { start: 0, count: 0, totalCount: 0 };
  const size = Math.min(
    Math.max(Number.isFinite(count) ? count : 120, Math.min(12, total)),
    Math.min(600, total),
  );
  return {
    start: Math.min(
      Math.max(Number.isFinite(start) ? start : 0, 0),
      total - size,
    ),
    count: size,
    totalCount: total,
  };
}
export function createViewport(
  totalCount: number,
  preferredCount = 120,
): CandleViewport {
  const viewport = boundedViewport(totalCount, 0, preferredCount);
  return { ...viewport, start: viewport.totalCount - viewport.count };
}
export function panViewport(
  viewport: CandleViewport,
  translation: number,
  plotWidth: number,
): CandleViewport {
  if (
    !Number.isFinite(translation) ||
    !Number.isFinite(plotWidth) ||
    plotWidth <= 0
  )
    return viewport;
  return boundedViewport(
    viewport.totalCount,
    viewport.start - (translation / plotWidth) * viewport.count,
    viewport.count,
  );
}
export function zoomViewport(
  viewport: CandleViewport,
  scale: number,
  anchor: number,
): CandleViewport {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(anchor))
    return viewport;
  const fraction = Math.min(1, Math.max(0, anchor));
  const count = boundedViewport(
    viewport.totalCount,
    0,
    viewport.count / scale,
  ).count;
  return boundedViewport(
    viewport.totalCount,
    viewport.start + (viewport.count - count) * fraction,
    count,
  );
}
export function reconcileViewport(
  viewport: CandleViewport,
  totalCount: number,
): CandleViewport {
  if (totalCount === viewport.totalCount) return viewport;
  if (!viewport.totalCount || !totalCount) return createViewport(totalCount);
  const count = boundedViewport(totalCount, 0, viewport.count).count;
  const atLatest =
    Math.abs(viewport.start + viewport.count - viewport.totalCount) < 0.000_001;
  return boundedViewport(
    totalCount,
    atLatest ? totalCount - count : viewport.start,
    count,
  );
}
export function visibleRange(viewport: CandleViewport): {
  first: number;
  end: number;
} {
  return {
    first: Math.max(0, Math.floor(viewport.start)),
    end: Math.min(
      viewport.totalCount,
      Math.ceil(viewport.start + viewport.count),
    ),
  };
}
