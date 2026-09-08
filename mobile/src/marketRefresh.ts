import { sessionAt } from "./chartData.ts";
import type { History, HistoryRange } from "./types.ts";

export function marketRefreshInterval(
  kind: "quote" | "history" | "statistics",
  range: HistoryRange,
  now: number,
  demo: boolean,
): number {
  if (demo || !sessionAt(now)) return 60_000;
  if (kind === "quote") return 2_000;
  if (kind === "statistics") return 60_000;
  return ["daily", "weekly", "monthly"].includes(range) ? 30_000 : 10_000;
}

// Keep the old array when nothing changed, so price-only updates cannot redraw
// the SVG or recalculate all MA/session data. Preserve unchanged candle objects.
export function shareHistory(
  previous: History | undefined,
  next: History,
): History {
  if (!previous || previous.symbol !== next.symbol) return next;
  const old = new Map(previous.candles.map((c) => [c.time, c]));
  const candles = next.candles.map((c) => {
    const p = old.get(c.time);
    return p &&
      p.open === c.open &&
      p.high === c.high &&
      p.low === c.low &&
      p.close === c.close &&
      p.provisional === c.provisional &&
      p.volume === c.volume
      ? p
      : c;
  });
  const unchanged =
    candles.length === previous.candles.length &&
    candles.every((c, i) => c === previous.candles[i]);
  if (unchanged && previous.previousClose === next.previousClose)
    return previous;
  return { ...next, candles: unchanged ? previous.candles : candles };
}
