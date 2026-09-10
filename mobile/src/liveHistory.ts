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

const observationAge = 10 * 24 * 60 * 60_000;
const observationLimit = 15_000;

export function pruneObservedCandles(previous: Candle[], now: number): Candle[] {
  let expired = 0;
  while (expired < previous.length && previous[expired].time < now - observationAge) expired++;
  const start = Math.max(expired, previous.length - observationLimit);
  return start > 0 ? previous.slice(start) : previous;
}

/** Retain only actual observations in memory; never manufacture absent minutes. */
export function mergeObservedCandle(
  previous: Candle[],
  sample: Candle,
  now: number,
): Candle[] {
  if (!validCandle(sample) || !Number.isFinite(now) ||
      sample.time > now + 5000 || sample.time < now - observationAge)
    return previous;
  // Buffers produced here stay sorted. Binary search avoids sorting ten days of
  // candles for every price tick.
  let first = 0, end = previous.length;
  while (first < end) {
    const middle = (first + end) >>> 1;
    if (previous[middle].time < sample.time) first = middle + 1;
    else end = middle;
  }
  const old = previous[first]?.time === sample.time ? previous[first] : undefined;
  if (old && !old.provisional && sample.provisional) return previous;
  const next: Candle = sample.provisional ? {
    time: sample.time,
    open: old?.open ?? sample.open,
    high: Math.max(old?.high ?? sample.high, sample.high),
    low: Math.min(old?.low ?? sample.low, sample.low),
    close: sample.close,
    provisional: true,
  } : { ...sample };
  if (old && old.open === next.open && old.high === next.high &&
      old.low === next.low && old.close === next.close &&
      old.volume === next.volume && old.provisional === next.provisional)
    return previous;
  const result = [...previous];
  result.splice(first, old ? 1 : 0, next);
  return pruneObservedCandles(result, now);
}

export function mergeFormingCandle(
  previous: Candle[],
  sample: Candle,
  now: number,
): Candle[] {
  return sample.provisional ? mergeObservedCandle(previous, sample, now) : previous;
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
      const key = candleBucket(c, range)?.key;
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
): { key: string; start: number; end?: number } | undefined {
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
    return { key: String(start), start, end: Math.min(start + size * 60_000, session.end) };
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

// Candle objects are stable between paints. Avoid repeating timezone work for
// every retained minute on each streamed price update.
const candleBuckets = new WeakMap<Candle, Map<HistoryRange, ReturnType<typeof bucket>>>();
const regularObservations = new WeakMap<Candle, boolean>();
function regularObservation(candle: Candle) {
  let regular = regularObservations.get(candle);
  if (regular === undefined) {
    regular = sessionAt(candle.time) === "regular";
    regularObservations.set(candle, regular);
  }
  return regular;
}
function candleBucket(candle: Candle, range: HistoryRange) {
  let ranges = candleBuckets.get(candle);
  if (!ranges) {
    ranges = new Map();
    candleBuckets.set(candle, ranges);
  }
  if (!ranges.has(range)) ranges.set(range, bucket(candle.time, range));
  return ranges.get(range);
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
  const first = bucket(bars[0].time, range);
  const restIndices = historyIndex(base, range);
  const currentBucket = bucket(now, range);
  let changed = false;
  const apply = (sample: Candle, exact: boolean) => {
    if (
      !validCandle(sample) ||
      sample.time > now + 5_000 ||
      sample.time < now - observationAge ||
      (calendar && !regularObservation(sample))
    )
      return;
    const target = candleBucket(sample, range);
    if (!target || !first || target.start < first.start) return;
    const restIndex = restIndices.get(target.key);
    const rest = restIndex === undefined ? undefined : base.candles[restIndex];
    // Completed REST bars are authoritative, including larger periods. Cached
    // observations may fill a missing bucket but must not roll a completed bar
    // back to an earlier stream snapshot.
    const complete = target.end !== undefined
      ? now >= target.end
      : currentBucket !== undefined && target.start < currentBucket.start;
    if (rest && !rest.provisional && complete) return;
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
