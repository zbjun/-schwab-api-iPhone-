import type { HistoryRange } from "./types.ts";

const minute = 60_000;
// intraday is requested as 1-minute bars and fiveDay as 5-minute bars (broker.ts),
// so both have a fixed period. Daily/weekly/monthly bars follow market calendars.
const barMinutes: Partial<Record<HistoryRange, number>> = {
  intraday: 1,
  fiveDay: 5,
  minute1: 1,
  minute5: 5,
  minute15: 15,
  minute30: 30,
  minute60: 60,
  minute120: 120,
};

/** Length of one candle in milliseconds, or undefined for calendar-based ranges. */
export function barMilliseconds(range: HistoryRange): number | undefined {
  const minutes = barMinutes[range];
  return minutes === undefined ? undefined : minutes * minute;
}

const two = (value: number): string => String(value).padStart(2, "0");

/**
 * Time left in the candle that opened at `candleTime`, as `mm:ss` (`h:mm:ss`
 * from one hour). Uses start + period - now rather than clock alignment because
 * sources align bars differently. Undefined when not applicable, already
 * finished (market closed), invalid, or the clock ran backwards.
 */
export function candleCountdown(
  candleTime: number,
  range: HistoryRange,
  now: number,
): string | undefined {
  const period = barMilliseconds(range);
  if (period === undefined || !Number.isFinite(candleTime) || !Number.isFinite(now))
    return undefined;
  // Schwab's 60 and 120 minute bars are built from 1-minute bars and start at the first minute that
  // traded, so an unaligned start may not be the bar's real start. Better no countdown than a wrong one.
  if (period >= 60 * minute && candleTime % period !== 0) return undefined;
  const remaining = candleTime + period - now;
  if (remaining <= 0 || remaining > period) return undefined;
  const seconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(rest)}`
    : `${two(minutes)}:${two(rest)}`;
}

/** Chart height (px) for a window of the given height: about 62%, bounded. */
export function chartHeightFor(windowHeight: number): number {
  const base = Number.isFinite(windowHeight) && windowHeight > 0 ? windowHeight : 700;
  return Math.round(Math.min(680, Math.max(260, base * 0.62)));
}

/**
 * Width (px) of the price axis right of the plot: the longest label at font size 9
 * plus 4 of padding, and never less than the countdown in the last price tag needs.
 */
export function priceAxisWidth(labels: readonly string[]): number {
  const textWidth = (label: string) =>
    [...label].reduce((sum, char) => sum + (char === "." || char === "," ? 2.8 : 5.6), 0);
  return Math.ceil(Math.max(30, ...labels.map(textWidth))) + 4;
}
