import { sessionAt, validCandle } from "./chartData.ts";
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
  retain?: { range: HistoryRange; now: number },
): History {
  if (!previous || previous.symbol !== next.symbol) return next;
  const old = new Map(previous.candles.map((c) => [c.time, c]));
  let incoming = next.candles;
  // Fill only holes inside a successful response's own window. Never extend
  // its date range, seed empty history, or retain incomplete/live estimates.
  if (retain && Number.isFinite(retain.now) &&
      (!previous.sourceCoverage || previous.sourceCoverage.range === retain.range) &&
      (!next.sourceCoverage || next.sourceCoverage.range === retain.range) &&
      ["intraday", "fiveDay", "minute1", "minute5", "minute15", "minute30"].includes(retain.range) &&
      incoming.length > 1) {
    const seen = new Set(incoming.map(c => c.time));
    const first = Math.max(incoming[0].time, retain.now - 10 * 86400000);
    const last = Math.min(incoming.at(-1)!.time, retain.now);
    const budget = Math.max(0, 15000 - incoming.length);
    const cached = previous.candles.filter(c =>
      !c.provisional && validCandle(c) && c.time >= first && c.time <= last && !seen.has(c.time));
    if (budget && cached.length) incoming = [...incoming, ...cached.slice(-budget).map(c =>
      c.retained ? c : { ...c, retained: true })].sort((a, b) => a.time - b.time);
  }
  const candles = incoming.map((c) => {
    const p = old.get(c.time);
    return p &&
      p.open === c.open &&
      p.high === c.high &&
      p.low === c.low &&
      p.close === c.close &&
      p.provisional === c.provisional &&
      p.retained === c.retained &&
      p.volume === c.volume
      ? p
      : c;
  });
  const unchanged =
    candles.length === previous.candles.length &&
    candles.every((c, i) => c === previous.candles[i]);
  if (unchanged && previous.previousClose === next.previousClose && previous.sourceCoverage === next.sourceCoverage && previous.retainedCoverage === next.retainedCoverage)
    return previous;
  return { ...next, candles: unchanged ? previous.candles : candles };
}
