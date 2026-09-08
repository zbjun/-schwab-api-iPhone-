import {
  chartSessionWindow,
  minuteInterval,
  newYorkDateKey,
  sessionAt,
  sessionWindows,
  validCandle,
} from "./chartData.ts";
import type { Candle, History, HistoryRange, Quote } from "./types.ts";

const indexCache = new WeakMap<
  History,
  Map<HistoryRange, Map<string, number>>
>();

export function mergeFormingCandle(
  previous: Candle[],
  sample: Candle,
  now: number,
): Candle[] {
  if (!validCandle(sample) || !sample.provisional || sample.time > now + 5000)
    return previous;
  const old = previous.find((c) => c.time === sample.time);
  if (old && !old.provisional && old.time + 60_000 <= now) return previous;
  const next: Candle = {
    time: sample.time,
    open: old?.open ?? sample.open,
    high: Math.max(old?.high ?? sample.high, sample.high),
    low: Math.min(old?.low ?? sample.low, sample.low),
    close: sample.close,
    provisional: true,
  };
  if (
    old?.provisional &&
    old.open === next.open &&
    old.high === next.high &&
    old.low === next.low &&
    old.close === next.close
  )
    return previous;
  return [...previous.filter((c) => c.time !== sample.time), next]
    .sort((a, b) => a.time - b.time)
    .slice(-120);
}
function historyIndex(
  history: History,
  range: HistoryRange,
): Map<string, number> {
  let ranges = indexCache.get(history);
  if (!ranges) {
    ranges = new Map();
    indexCache.set(history, ranges);
  }
  let index = ranges.get(range);
  if (!index) {
    index = new Map();
    history.candles.forEach((c, i) => {
      const key = bucket(c.time, range)?.key;
      if (key) index!.set(key, i);
    });
    ranges.set(range, index);
  }
  return new Map(index);
}

// Provisional bars are observations since subscription, not complete exchange
// OHLCV. REST history / CHART_EQUITY is authoritative; never invent volume.
function bucket(
  time: number,
  range: HistoryRange,
): { key: string; start: number } | undefined {
  const day = newYorkDateKey(time);
  if (!day) return;
  const size =
    minuteInterval(range) ??
    (range === "intraday" ? 1 : range === "fiveDay" ? 5 : undefined);
  if (size) {
    const session = chartSessionWindow(time);
    if (!session) return;
    const start =
      session.start +
      Math.floor((time - session.start) / (size * 60_000)) * size * 60_000;
    return { key: String(start), start };
  }
  if (range === "monthly")
    return {
      key: day.slice(0, 7),
      start: Date.parse(day.slice(0, 7) + "-01T12:00:00Z"),
    };
  if (range === "weekly") {
    const monday = new Date(day + "T12:00:00Z");
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return { key: monday.toISOString().slice(0, 10), start: monday.getTime() };
  }
  return {
    key: day,
    start:
      sessionWindows(time).find((s) => s.session === "regular")?.start ?? time,
  };
}

export function overlayLiveHistory(
  base: History | undefined,
  range: HistoryRange,
  minutes: readonly Candle[],
  quote: Partial<Quote> | undefined,
  now: number,
): History | undefined {
  if (!base?.candles.length) return base;
  const calendar = ["daily", "weekly", "monthly"].includes(range);
  const exactMinute = range === "intraday" || range === "minute1";
  const bars = [...base.candles];
  const indices = historyIndex(base, range);
  const lastBase = bars.at(-1)!;
  const first = bucket(lastBase.time, range);
  let changed = false;
  const apply = (sample: Candle, exact: boolean) => {
    if (
      !validCandle(sample) ||
      sample.time > now + 5_000 ||
      (calendar && sessionAt(sample.time) !== "regular")
    )
      return;
    if (
      sample.provisional &&
      exactMinute &&
      sample.time + 60_000 <= now &&
      base.candles.some((c) => !c.provisional && c.time === sample.time)
    )
      return;
    const target = bucket(sample.time, range);
    if (!target || !first || target.start < first.start) return;
    const index = indices.get(target.key) ?? -1;
    const old = bars[index];
    const next: Candle = exact
      ? { ...sample, provisional: false }
      : {
          time: old?.time ?? target.start,
          open: old?.open ?? sample.open,
          high: Math.max(old?.high ?? sample.high, sample.high),
          low: Math.min(old?.low ?? sample.low, sample.low),
          close: sample.close,
          volume: undefined,
          provisional: true,
        };
    if (index >= 0) bars[index] = next;
    else {
      indices.set(target.key, bars.length);
      bars.push(next);
    }
    changed = true;
  };
  for (const candle of minutes)
    apply(candle, exactMinute && !candle.provisional);
  if (
    quote?.symbol === base.symbol &&
    quote.isRealtime === true &&
    quote.lastPrice !== undefined &&
    quote.lastPrice > 0 &&
    quote.tradeTime !== undefined &&
    now - quote.tradeTime <= 60_000 &&
    quote.tradeTime <= now + 5_000
  ) {
    const price = quote.lastPrice;
    // Avoid overriding an authoritative completed minute with an old last trade.
    const completed = [
      ...minutes.filter((c) => !c.provisional),
      ...(exactMinute ? base.candles.filter((c) => !c.provisional) : []),
    ].some(
      (c) =>
        c.time <= quote.tradeTime! &&
        c.time + 60_000 <= now &&
        quote.tradeTime! < c.time + 60_000,
    );
    if (!completed && quote.tradeTime >= (minutes.at(-1)?.time ?? 0))
      apply(
        {
          time: quote.tradeTime,
          open: price,
          high: price,
          low: price,
          close: price,
        },
        false,
      );
  }
  return changed
    ? { ...base, candles: bars.sort((a, b) => a.time - b.time) }
    : base;
}
