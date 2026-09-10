import assert from "node:assert/strict";
import test from "node:test";
import { mergeFormingCandle, mergeObservedCandle, pruneObservedCandles, overlayLiveHistory } from "./liveHistory.ts";
import type { Candle, History, HistoryRange, Quote } from "./types.ts";

const minute = 60_000;
const at = (iso: string): number => Date.parse(iso);
const open = at("2026-09-04T13:30:00Z");
const candle = (
  time: number,
  close = 100,
  values: Partial<Candle> = {},
): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
  ...values,
});
const history = (...candles: Candle[]): History => ({
  symbol: "AAPL",
  previousClose: 99,
  candles,
});
const quote = (
  tradeTime: number,
  lastPrice = 105,
  values: Partial<Quote> = {},
): Partial<Quote> => ({
  symbol: "AAPL",
  tradeTime,
  lastPrice,
  isRealtime: true,
  ...values,
});

test("missing or empty REST history stays unchanged", () => {
  assert.equal(
    overlayLiveHistory(undefined, "minute1", [candle(open)], quote(open), open),
    undefined,
  );
  const empty = history();
  assert.equal(
    overlayLiveHistory(empty, "minute1", [candle(open)], quote(open), open),
    empty,
  );
});

test("authoritative minute replaces a provisional minute and preserves actual OHLCV without mutating REST data", () => {
  for (const range of ["intraday", "minute1"] as const) {
    const original = candle(open, 101, {
      provisional: true,
      volume: undefined,
    });
    const base = history(original);
    const actual = candle(open, 103, {
      open: 100,
      high: 107,
      low: 98,
      volume: 1234,
    });
    const result = overlayLiveHistory(
      base,
      range,
      [actual],
      undefined,
      open + minute,
    )!;
    assert.deepEqual(result.candles, [{ ...actual, provisional: false }]);
    assert.equal(result.previousClose, 99);
    assert.equal(base.candles[0], original);
    assert.equal(original.close, 101);
    assert.equal(actual.provisional, undefined);
  }
});

test("new actual minute appends once and repeated observations replace volume rather than add it", () => {
  const base = history(candle(open));
  const next = candle(open + minute, 103, { volume: 200 });
  const correction = { ...next, close: 104, high: 104, volume: 250 };
  const result = overlayLiveHistory(
    base,
    "minute1",
    [next, correction],
    undefined,
    open + 3 * minute,
  )!;
  assert.equal(result.candles.length, 2);
  assert.deepEqual(result.candles[1], { ...correction, provisional: false });
});

test("live trade updates the current bar OHLC and marks volume unknown", () => {
  const base = history(
    candle(open, 101, { open: 100, high: 103, low: 99, volume: 600 }),
  );
  const result = overlayLiveHistory(
    base,
    "minute1",
    [],
    quote(open + 30_000, 104),
    open + 35_000,
  )!;
  assert.deepEqual(result.candles, [
    candle(open, 104, {
      open: 100,
      high: 104,
      low: 99,
      volume: undefined,
      provisional: true,
    }),
  ]);
});

test("new trade minute uses its observed price as provisional OHLC and does not invent gap bars or volume", () => {
  const base = history(candle(open));
  const tradeTime = open + 3 * minute + 20_000;
  const result = overlayLiveHistory(
    base,
    "minute1",
    [],
    quote(tradeTime, 108),
    tradeTime + 1000,
  )!;
  assert.equal(result.candles.length, 2);
  assert.deepEqual(
    result.candles[1],
    candle(open + 3 * minute, 108, { volume: undefined, provisional: true }),
  );
  assert.equal(result.candles[0].volume, 100);
});

test("late trade cannot overwrite an authoritative completed minute", () => {
  const actual = candle(open + minute, 104, {
    high: 108,
    low: 103,
    volume: 350,
  });
  const result = overlayLiveHistory(
    history(candle(open)),
    "minute1",
    [actual],
    quote(open + minute + 50_000, 107),
    open + 2 * minute + 10_000,
  )!;
  assert.deepEqual(result.candles[1], { ...actual, provisional: false });
});

test("late trade cannot overwrite a completed REST minute before the first stream candle arrives", () => {
  const base = history(candle(open, 104, { high: 108, low: 103, volume: 350 }));
  for (const range of ["intraday", "minute1"] as const) {
    const result = overlayLiveHistory(
      base,
      range,
      [],
      quote(open + 50_000, 107),
      open + minute + 10_000,
    )!;
    assert.deepEqual(result.candles, base.candles, range);
  }
});

test("observed provisional minute never becomes authoritative or receives fabricated volume", () => {
  const observed = candle(open + minute, 106, {
    provisional: true,
    volume: undefined,
  });
  const result = overlayLiveHistory(
    history(candle(open)),
    "minute1",
    [observed],
    undefined,
    open + 2 * minute,
  )!;
  assert.equal(result.candles[1].provisional, true);
  assert.equal(result.candles[1].volume, undefined);
});

test("trade older than the newest authoritative minute cannot roll the chart backwards", () => {
  const actual = candle(open + 2 * minute, 104);
  const result = overlayLiveHistory(
    history(candle(open)),
    "minute1",
    [actual],
    quote(open + minute + 59_000, 120),
    open + 2 * minute + 10_000,
  )!;
  assert.equal(result.candles.length, 2);
  assert.equal(result.candles.at(-1)!.close, 104);
});

test("all actual minutes contribute highs and lows to a larger live bucket", () => {
  const samples = [
    candle(open + minute, 105, { high: 120, low: 95 }),
    candle(open + 2 * minute, 106, { low: 104 }),
  ];
  for (const range of [
    "fiveDay",
    "minute5",
    "minute15",
    "minute30",
    "minute60",
    "minute120",
  ] as const) {
    const result = overlayLiveHistory(
      history(candle(open)),
      range,
      samples,
      undefined,
      open + 3 * minute,
    )!;
    assert.equal(result.candles.length, 1, range);
    assert.equal(result.candles[0].open, 100, range);
    assert.equal(result.candles[0].high, 120, range);
    assert.equal(result.candles[0].low, 95, range);
    assert.equal(result.candles[0].close, 106, range);
    assert.equal(result.candles[0].volume, undefined, range);
    assert.equal(result.candles[0].provisional, true, range);
  }
});

test("larger minute buckets start at the exchange session boundary across New York DST", () => {
  for (const regularOpen of [
    "2026-03-06T14:30:00Z",
    "2026-03-09T13:30:00Z",
    "2026-10-30T13:30:00Z",
    "2026-11-02T14:30:00Z",
  ]) {
    const start = at(regularOpen);
    const tradeTime = start + 63 * minute;
    const result = overlayLiveHistory(
      history(candle(start)),
      "minute60",
      [],
      quote(tradeTime),
      tradeTime,
    )!;
    assert.equal(result.candles.at(-1)!.time, start + 60 * minute, regularOpen);
  }
});

test("minute overlays keep premarket, regular and postmarket buckets separate", () => {
  for (const [previous, next, expected] of [
    ["2026-09-04T13:00:00Z", "2026-09-04T13:31:00Z", "2026-09-04T13:30:00Z"],
    ["2026-09-04T19:30:00Z", "2026-09-04T20:01:00Z", "2026-09-04T20:00:00Z"],
  ]) {
    const result = overlayLiveHistory(
      history(candle(at(previous))),
      "minute120",
      [],
      quote(at(next)),
      at(next),
    )!;
    assert.equal(result.candles.length, 2);
    assert.equal(result.candles[1].time, at(expected));
  }
});

test("daily, weekly and monthly live bars combine only regular-session prices", () => {
  for (const range of ["daily", "weekly", "monthly"] as const) {
    const base = history(
      candle(open, 100, { high: 110, low: 90, volume: 999 }),
    );
    const samples = [
      candle(open + minute, 115, { high: 125, low: 85 }),
      candle(open + 2 * minute, 112),
    ];
    const result = overlayLiveHistory(
      base,
      range,
      samples,
      undefined,
      open + 3 * minute,
    )!;
    assert.equal(result.candles.length, 1, range);
    assert.equal(result.candles[0].open, 100, range);
    assert.equal(result.candles[0].high, 125, range);
    assert.equal(result.candles[0].low, 85, range);
    assert.equal(result.candles[0].close, 112, range);
    assert.equal(result.candles[0].volume, undefined, range);
    for (const extended of [
      at("2026-09-04T13:29:00Z"),
      at("2026-09-04T20:01:00Z"),
    ]) {
      assert.equal(
        overlayLiveHistory(
          base,
          range,
          [candle(extended, 200)],
          quote(extended, 200),
          extended,
        ),
        base,
        range,
      );
    }
  }
});

test("calendar rollover adds a new daily, weekly or monthly bucket", () => {
  const cases: [HistoryRange, string, string][] = [
    ["daily", "2026-09-03T13:30:00Z", "2026-09-04T13:31:00Z"],
    ["weekly", "2026-08-28T13:30:00Z", "2026-08-31T13:31:00Z"],
    ["monthly", "2026-08-31T13:30:00Z", "2026-09-01T13:31:00Z"],
  ];
  for (const [range, previous, current] of cases) {
    const result = overlayLiveHistory(
      history(candle(at(previous))),
      range,
      [],
      quote(at(current)),
      at(current),
    )!;
    assert.equal(result.candles.length, 2, range);
    assert.equal(result.candles[1].close, 105, range);
    assert.equal(result.candles[1].volume, undefined, range);
    assert.ok(result.candles[1].time > result.candles[0].time, range);
  }
});

test("wrong-symbol, delayed, stale, future, missing and nonfinite quotes cannot update history", () => {
  const base = history(candle(open));
  const now = open + 30_000;
  const rejected = [
    quote(now, 105, { symbol: "MSFT" }),
    quote(now, 105, { isRealtime: false }),
    quote(now, 105, { isRealtime: undefined }),
    quote(now - 60_001),
    quote(now + 5_001),
    quote(now, 0),
    quote(now, -1),
    quote(now, NaN),
    quote(now, Infinity),
    quote(NaN),
    quote(Infinity),
    quote(now, 105, { tradeTime: undefined }),
    quote(now, 105, { lastPrice: undefined }),
  ];
  for (const item of rejected) {
    assert.equal(overlayLiveHistory(base, "minute1", [], item, now), base);
  }
});

test("invalid and future chart samples cannot alter the base", () => {
  const base = history(candle(open));
  const now = open + 2 * minute;
  for (const sample of [
    candle(now + 5_001),
    candle(NaN),
    candle(Infinity),
    candle(open + minute, NaN),
    candle(open + minute, 105, { high: 100 }),
  ]) {
    assert.equal(
      overlayLiveHistory(base, "minute1", [sample], undefined, now),
      base,
    );
  }
});

test("closed daytime sessions produce no live bars", () => {
  const base = history(candle(open));
  for (const timestamp of [
    "2026-09-05T14:00:00Z",
    "2026-09-07T14:00:00Z",
  ]) {
    const time = at(timestamp);
    assert.equal(
      overlayLiveHistory(base, "minute1", [candle(time)], quote(time), time),
      base,
      timestamp,
    );
  }
});

test("overnight trades update intraday and all minute charts without leaking into calendar candles", () => {
  const now = at("2026-09-08T06:03:10Z");
  const base = history(candle(open));
  for (const range of ["intraday", "fiveDay", "minute1", "minute5", "minute15", "minute30", "minute60", "minute120"] as const) {
    const result = overlayLiveHistory(base, range, [], quote(now, 26.7), now)!;
    assert.equal(result.candles.at(-1)!.close, 26.7, range);
    assert.equal(result.candles.at(-1)!.provisional, true, range);
    assert.equal(result.candles.at(-1)!.volume, undefined, range);
    assert.equal(overlayLiveHistory(base, range, [], undefined, now), base, range);
    assert.equal(overlayLiveHistory(base, range, [], quote(now - 120_000), now), base, range);
  }
  for (const range of ["daily", "weekly", "monthly"] as const)
    assert.equal(overlayLiveHistory(base, range, [], quote(now, 26.7), now), base);
  const minuteBar = candle(now - 10_000, 26.7);
  const actual = overlayLiveHistory(base, "minute1", [minuteBar], undefined, now)!;
  assert.equal(actual.candles.at(-1)!.volume, 100);
  assert.equal(actual.candles.at(-1)!.provisional, false);
});


test("observed night minutes survive more than two hours and fill a gap behind newer REST bars", () => {
  const night = at("2026-09-09T00:00:00Z");
  let observed: Candle[] = [];
  for (let index = 0; index < 300; index++)
    observed = mergeFormingCandle(observed, candle(night + index * minute, 26 + index / 1000,
      { provisional: true, volume: undefined }), night + 300 * minute);
  assert.equal(observed.length, 300);
  assert.equal(observed[0].time, night);
  // Foreground/reconnection pruning does not clear the same source's observations.
  assert.equal(pruneObservedCandles(observed, night + 600 * minute), observed);
  const newerRest = history(candle(night - minute, 26), candle(night + 600 * minute, 27));
  for (const range of ["intraday", "minute1", "fiveDay", "minute5", "minute15", "minute30", "minute60", "minute120"] as const) {
    const result = overlayLiveHistory(newerRest, range, observed, undefined, night + 601 * minute)!;
    const recovered = result.candles.filter(c => c.time >= night && c.time < night + 300 * minute);
    assert.ok(recovered.length > 0, range);
    assert.equal(recovered[0].open, 26, range);
    assert.ok(recovered.every(c => c.provisional && c.volume === undefined), range);
    assert.equal(result.candles.at(-1), newerRest.candles.at(-1), range);
  }
  for (const range of ["daily", "weekly", "monthly"] as const)
    assert.equal(overlayLiveHistory(newerRest, range, observed, undefined, night + 601 * minute), newerRest, range);
  assert.equal(newerRest.candles.length, 2);
});

test("completed REST candles win over retained actual and provisional stream snapshots in every period", () => {
  const night = at("2026-09-09T00:00:00Z");
  const actual = candle(night, 29, { open: 28, high: 30, low: 27, volume: 9876 });
  for (const range of ["intraday", "minute1", "fiveDay", "minute5", "minute15", "minute30", "minute60", "minute120"] as const) {
    const base = history(actual);
    for (const provisional of [true, false]) {
      const result = overlayLiveHistory(base, range,
        [candle(night, 24, { provisional, volume: provisional ? undefined : 2 })],
        undefined, night + 4 * 60 * minute)!;
      assert.equal(result, base, range);
      assert.equal(result.candles[0], actual, range);
    }
  }
  for (const [range, previous, current] of [
    ["daily", "2026-09-03T13:30:00Z", "2026-09-04T14:00:00Z"],
    ["weekly", "2026-09-04T13:30:00Z", "2026-09-08T14:00:00Z"],
    ["monthly", "2026-08-31T13:30:00Z", "2026-09-01T14:00:00Z"],
  ] as const) {
    const base = history(candle(at(previous)));
    assert.equal(overlayLiveHistory(base, range, [candle(at(previous) + minute, 150)], undefined, at(current)), base, range);
  }
});

test("retained observations never extend the loaded history backward or fabricate missing volume", () => {
  const night = at("2026-09-09T00:00:00Z");
  const completed = candle(night + minute, 28, { volume: 20 });
  const base = history(candle(night), candle(night + 4 * minute));
  const result = overlayLiveHistory(base, "minute1", [candle(night - minute), completed], undefined, night + 5 * minute)!;
  assert.equal(result.candles.length, 3);
  assert.equal(result.candles[0].time, night);
  assert.deepEqual(result.candles[1], { ...completed, provisional: false });
  const observed = candle(night + minute, 27, { provisional: true, volume: undefined });
  const updatedRest = history(...result.candles);
  assert.equal(overlayLiveHistory(updatedRest, "minute1", [observed], undefined, night + 6 * minute), updatedRest);
});

test("observation buffer expires after ten days and has a hard 15000-bar limit", () => {
  const now = at("2026-09-10T12:00:00Z");
  const old = candle(now - 10 * 24 * 60 * minute - 1);
  const recent = candle(now - minute);
  assert.deepEqual(pruneObservedCandles([old, recent], now), [recent]);
  assert.deepEqual(mergeObservedCandle([old], recent, now), [recent]);
  assert.deepEqual(mergeObservedCandle([], old, now), []);
  // A malformed high-frequency upstream cannot grow memory without bound either.
  const crowded = Array.from({length: 15000}, (_, i) => candle(now - 16000 + i));
  const bounded = mergeObservedCandle(crowded, candle(now), now);
  assert.equal(bounded.length, 15000);
  assert.equal(bounded.at(-1)!.time, now);
  assert.equal(bounded[0].time, crowded[1].time);
  assert.equal(crowded.length, 15000);
});

test("completed observed minutes resist stale forming snapshots and duplicate volume", () => {
  const actual = candle(open, 103, { open: 100, high: 105, low: 99, volume: 120 });
  const stored = mergeObservedCandle([], actual, open + minute);
  assert.equal(mergeFormingCandle(stored, candle(open, 90, {provisional: true}), open + minute), stored);
  assert.equal(mergeObservedCandle(stored, actual, open + minute), stored);
  const correction = {...actual, volume: 130};
  const corrected = mergeObservedCandle(stored, correction, open + minute);
  assert.equal(corrected.length, 1);
  assert.equal(corrected[0].volume, 130);
});
