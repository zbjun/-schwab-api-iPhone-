import type {
  Candle,
  HistoryRange,
  Position,
  TradeExecution,
} from "./types.ts";
import { minuteInterval, newYorkDateKey, chartSessionWindow } from "./chartData.ts";

export interface TradeMarker {
  index: number;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  count: number;
}

function calendarKey(time: number, range: HistoryRange): string | undefined {
  const day = newYorkDateKey(time);
  if (!day) return undefined;
  if (range === "monthly") return day.slice(0, 7);
  if (range === "weekly") {
    const date = new Date(day + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  }
  return day;
}

/** A bar longer than any calendar month cannot be the bar a fill belongs to. */
const LONGEST_CALENDAR_BAR = 32 * 86_400_000;

/**
 * Map fills to actual candles; never snap a fill across missing bars or sessions. `continuous` is for a market that never
 * closes, whose bars run across US sessions and start on UTC boundaries: there the fill belongs to the bar it falls in.
 */
export function tradeMarkers(
  candles: Candle[],
  range: HistoryRange,
  symbol: string,
  executions: TradeExecution[],
  continuous = false,
): TradeMarker[] {
  const minutes =
    minuteInterval(range) ??
    (range === "intraday" ? 1 : range === "fiveDay" ? 5 : undefined);
  const calendar = new Map<string, number>();
  if (minutes === undefined && !continuous)
    candles.forEach((c, index) => {
      const key = calendarKey(c.time, range);
      if (key) calendar.set(key, index);
    });
  const groups = new Map<string, TradeMarker>();
  const seen = new Set<string>();
  for (const fill of executions) {
    if (
      fill.symbol !== symbol ||
      seen.has(fill.id) ||
      !Number.isFinite(fill.time) ||
      !Number.isFinite(fill.price) ||
      fill.price <= 0 ||
      !Number.isFinite(fill.quantity) ||
      fill.quantity <= 0 ||
      (fill.side !== "BUY" && fill.side !== "SELL")
    )
      continue;
    seen.add(fill.id);
    let index: number | undefined;
    if (minutes === undefined && !continuous)
      index = calendar.get(calendarKey(fill.time, range) ?? "");
    else {
      let lo = 0,
        hi = candles.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (candles[mid].time <= fill.time) lo = mid + 1;
        else hi = mid;
      }
      const candidate = lo - 1,
        candle = candles[candidate];
      if (candle && continuous) {
        if (fill.time < candle.time + (minutes === undefined ? LONGEST_CALENDAR_BAR : minutes * 60_000)) index = candidate;
      } else if (
        candle &&
        minutes !== undefined &&
        fill.time < candle.time + minutes * 60_000 &&
        newYorkDateKey(candle.time) === newYorkDateKey(fill.time) &&
        chartSessionWindow(candle.time)?.session === chartSessionWindow(fill.time)?.session
      )
        index = candidate;
    }
    if (index === undefined) continue;
    const key = `${index}:${fill.side}`,
      previous = groups.get(key);
    const quantity = (previous?.quantity ?? 0) + fill.quantity;
    const price = previous
      ? previous.price +
        (fill.price - previous.price) * (fill.quantity / quantity)
      : fill.price;
    if (!Number.isFinite(quantity) || !Number.isFinite(price)) continue;
    groups.set(key, {
      index,
      side: fill.side,
      price,
      quantity,
      count: (previous?.count ?? 0) + 1,
    });
  }
  return [...groups.values()].sort(
    (a, b) => a.index - b.index || a.side.localeCompare(b.side),
  );
}

export function positionAverageCost(
  positions: Position[] | undefined,
  symbol: string,
): number | undefined {
  const held =
    positions?.filter((p) => p.symbol === symbol && p.quantity !== 0) ?? [];
  if (
    !held.length ||
    held.some(
      (p) =>
        !Number.isFinite(p.quantity) ||
        p.quantity < 0 ||
        p.averagePrice === undefined ||
        !Number.isFinite(p.averagePrice) ||
        p.averagePrice <= 0,
    )
  )
    return undefined;
  const quantity = held.reduce((sum, p) => sum + p.quantity, 0);
  const cost =
    held.reduce((sum, p) => sum + p.quantity * p.averagePrice!, 0) / quantity;
  return Number.isFinite(cost) && cost > 0 ? cost : undefined;
}
