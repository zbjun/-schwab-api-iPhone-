import { chartSessionWindow, createViewport, panViewport } from "./chartData.ts";
import type { CandleViewport, TradingSession } from "./chartData.ts";

export interface SessionLocation {
  first: number;
  last: number;
  count: number;
  firstTime: number;
  lastTime: number;
}

/** Locate observations, not trading eligibility. Input timestamps are sorted and unique. */
export function latestSessionLocation(
  times: readonly number[],
  session: TradingSession,
): SessionLocation | undefined {
  let last = times.length - 1;
  while (last >= 0 && chartSessionWindow(times[last])?.session !== session) last--;
  if (last < 0) return;
  const window = chartSessionWindow(times[last])!;
  let start = window.start;
  // chartSessionWindow splits at midnight. Include the preceding evening in
  // the same observed night, resolving both sides with the IANA timezone.
  if (session === "overnight") {
    const previous = chartSessionWindow(start - 1);
    if (previous?.session === "overnight") start = previous.start;
  }
  let first = last;
  while (first > 0 && times[first - 1] >= start) first--;
  return { first, last, count: last - first + 1, firstTime: times[first], lastTime: times[last] };
}

/** Fit the latest observed session with a little surrounding context. */
export function sessionViewport(total: number, location: SessionLocation): CandleViewport {
  const view = createViewport(total, Math.max(120, location.last - location.first + 17));
  const center = (location.first + location.last) / 2;
  const start = center - (view.count - 1) / 2;
  return panViewport(view, view.start - start, view.count);
}
