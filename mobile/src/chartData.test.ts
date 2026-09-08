import assert from "node:assert/strict";
import test from "node:test";
import {
  candlePriceDomain,
  chartSessionWindow,
  hasMissingOvernightData,
  aggregateMinutes,
  createViewport,
  isLineRange,
  minuteInterval,
  minuteRanges,
  movingAverage,
  newYorkDateKey,
  panViewport,
  primaryRanges,
  rangeTitle,
  reconcileViewport,
  sessionAt,
  sessionAverage,
  sessionWindows,
  visibleRange,
  zoomViewport,
} from "./chartData.ts";
import type { Candle } from "./types.ts";

const minute = 60_000;
test("overnight data status distinguishes prior daytime data and retains evening observations across midnight", () => {
  const bar = (iso: string) => ({ time: Date.parse(iso), open: 26, high: 26, low: 26, close: 26 });
  assert.equal(hasMissingOvernightData([bar("2026-09-04T23:59:00Z")], Date.parse("2026-09-08T06:00:00Z")), true);
  assert.equal(hasMissingOvernightData([bar("2026-09-08T02:00:00Z")], Date.parse("2026-09-08T06:00:00Z")), false);
  assert.equal(hasMissingOvernightData([], Date.parse("2026-09-08T14:00:00Z")), false);
  assert.equal(hasMissingOvernightData([], NaN), false);
});
test("observed overnight windows retain 20:00-04:00 data across midnight and DST", () => {
  for (const [iso, session] of [
    ["2026-09-08T00:00:00Z", "overnight"],
    ["2026-09-08T03:59:00Z", "overnight"],
    ["2026-09-08T04:00:00Z", "overnight"],
    ["2026-09-08T07:59:00Z", "overnight"],
    ["2026-09-08T08:00:00Z", "premarket"],
    ["2026-11-03T00:59:00Z", "postmarket"],
    ["2026-11-03T01:00:00Z", "overnight"],
    ["2026-11-03T08:59:00Z", "overnight"],
    ["2026-11-03T09:00:00Z", "premarket"],
  ]) assert.equal(chartSessionWindow(Date.parse(iso))?.session, session, iso);
  // Observation classification does not declare the regular exchange open on a holiday.
  assert.equal(sessionAt(Date.parse("2026-09-08T00:00:00Z")), undefined);
  assert.equal(chartSessionWindow(NaN), undefined);
});
test("hourly overnight aggregation preserves sparse real bars and splits midnight and premarket", () => {
  const source = ["2026-09-08T03:59:00Z", "2026-09-08T04:01:00Z", "2026-09-08T07:59:00Z", "2026-09-08T08:01:00Z"]
    .map((iso) => ({ time: Date.parse(iso), open: 26, high: 27, low: 25, close: 26, volume: 10 }));
  for (const size of [60, 120]) {
    const result = aggregateMinutes(source, size, Date.parse("2026-09-08T10:00:00Z"));
    assert.equal(result.length, 4);
    assert.equal(result.reduce((v, c) => v + c.volume!, 0), 40);
    assert.deepEqual(result.map((c) => chartSessionWindow(c.time)?.session), ["overnight", "overnight", "overnight", "premarket"]);
    assert.deepEqual(aggregateMinutes(source, size, Date.parse("2026-09-08T10:00:00Z"), false), []);
  }
});
test("candle scale centers visible highs and lows and ignores off-screen bars", () => {
  const candles = bars(0, 3);
  candles[0] = { ...candles[0], high: 1000, low: 1 };
  const domain = candlePriceDomain(candles, 1, 3);
  assert.equal((domain.low + domain.high) / 2, 101.5);
  assert.ok(domain.low < 100 && domain.low > 99);
  assert.ok(domain.high > 103 && domain.high < 104);
  candles[2].high = 110;
  assert.equal((candlePriceDomain(candles, 1, 3).low + candlePriceDomain(candles, 1, 3).high) / 2, 105);
});
test("flat and empty candle scales remain finite and nonzero", () => {
  const candle = { time: 0, open: 26, high: 26, low: 26, close: 26, volume: 0 };
  const domain = candlePriceDomain([candle], 0, 1);
  assert.equal((domain.low + domain.high) / 2, 26);
  assert.ok(domain.high > domain.low);
  assert.deepEqual(candlePriceDomain([], 0, 0), { low: 0, high: 1 });
});
const time = (value: string): number => Date.parse(value);
const regular = time("2026-09-04T13:30:00Z");
function bars(start: number, count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: start + index * minute,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 100,
  }));
}
const flat = (
  close: number,
  at: number,
  volume: number | undefined = 100,
): Candle => ({
  time: at,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});
const near = (actual: number | undefined, expected: number): void => {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 0.000_001,
    `${actual} differs from ${expected}`,
  );
};

test("primary and six minute ranges retain their titles and chart kinds", () => {
  assert.deepEqual(primaryRanges.map(rangeTitle), [
    "分时",
    "日K",
    "周K",
    "月K",
    "五日",
  ]);
  assert.deepEqual(minuteRanges.map(minuteInterval), [1, 5, 15, 30, 60, 120]);
  assert.deepEqual([...primaryRanges, ...minuteRanges].filter(isLineRange), [
    "intraday",
    "fiveDay",
  ]);
});

test("New York trading windows are half-open and omit weekends and invalid timestamps", () => {
  const cases = [
    ["2026-09-04T07:59:59Z", undefined],
    ["2026-09-04T08:00:00Z", "premarket"],
    ["2026-09-04T13:29:59Z", "premarket"],
    ["2026-09-04T13:30:00Z", "regular"],
    ["2026-09-04T19:59:59Z", "regular"],
    ["2026-09-04T20:00:00Z", "postmarket"],
    ["2026-09-04T23:59:59Z", "postmarket"],
    ["2026-09-05T00:00:00Z", undefined],
    ["2026-09-05T14:00:00Z", undefined],
    ["2026-09-06T14:00:00Z", undefined],
  ] as const;
  for (const [timestamp, expected] of cases)
    assert.equal(sessionAt(time(timestamp)), expected, timestamp);
  for (const timestamp of [NaN, Infinity, -1, 32_503_680_000_000]) {
    assert.equal(sessionAt(timestamp), undefined);
    assert.deepEqual(sessionWindows(timestamp), []);
  }
});

test("all three session windows follow both New York DST transitions", () => {
  const days = [
    [
      "2026-03-06T09:00:00Z",
      "2026-03-06T14:30:00Z",
      "2026-03-06T21:00:00Z",
      "2026-03-07T01:00:00Z",
    ],
    [
      "2026-03-09T08:00:00Z",
      "2026-03-09T13:30:00Z",
      "2026-03-09T20:00:00Z",
      "2026-03-10T00:00:00Z",
    ],
    [
      "2026-10-30T08:00:00Z",
      "2026-10-30T13:30:00Z",
      "2026-10-30T20:00:00Z",
      "2026-10-31T00:00:00Z",
    ],
    [
      "2026-11-02T09:00:00Z",
      "2026-11-02T14:30:00Z",
      "2026-11-02T21:00:00Z",
      "2026-11-03T01:00:00Z",
    ],
  ];
  for (const day of days) {
    const timestamps = day.map(time);
    const windows = sessionWindows(timestamps[0]);
    assert.deepEqual(
      windows.map((window) => window.start),
      timestamps.slice(0, 3),
    );
    assert.equal(windows[2].end, timestamps[3]);
  }
});

test("published holidays and early closes retain their regular and late-session boundaries", () => {
  for (const day of ["2026-11-27", "2026-12-24", "2027-11-26", "2028-11-24"]) {
    assert.equal(sessionAt(time(`${day}T17:59:59Z`)), "regular");
    assert.equal(sessionAt(time(`${day}T18:00:00Z`)), "postmarket");
    assert.equal(sessionAt(time(`${day}T22:00:00Z`)), undefined);
  }
  assert.equal(sessionAt(time("2028-07-03T17:00:00Z")), "postmarket");
  assert.equal(sessionAt(time("2028-07-03T21:00:00Z")), undefined);
  for (const day of [
    "2026-07-03",
    "2026-09-07",
    "2026-11-26",
    "2027-12-24",
    "2028-07-04",
  ]) {
    assert.deepEqual(sessionWindows(time(`${day}T14:00:00Z`)), []);
  }
  assert.equal(sessionAt(time("2027-12-31T19:00:00Z")), "regular");
  const windows = sessionWindows(regular);
  windows[0].end = 0;
  assert.equal(sessionWindows(regular)[0].end, regular);
});

test("hourly and two-hourly regular bars begin at 09:30 and retain the final 30 minutes", () => {
  const source = bars(regular, 390);
  for (const interval of [60, 120]) {
    const result = aggregateMinutes(
      source,
      interval,
      regular + 390 * minute,
      false,
    );
    assert.equal(result.length, interval === 60 ? 7 : 4);
    assert.deepEqual(result[0], {
      time: regular,
      open: 100,
      high: 100 + interval,
      low: 99,
      close: 100 + interval - 0.5,
      volume: interval * 100,
    });
    assert.deepEqual(result.at(-1), {
      time: regular + 360 * minute,
      open: 460,
      high: 490,
      low: 459,
      close: 489.5,
      volume: 3_000,
    });
    assert.equal(
      result.reduce((sum, bar) => sum + bar.volume!, 0),
      39_000,
    );
  }
});

test("extended aggregation defaults on and never combines premarket, regular, and postmarket", () => {
  const source = [
    ...bars(time("2026-09-04T08:00:00Z"), 330),
    ...bars(regular, 390),
    ...bars(time("2026-09-04T20:00:00Z"), 240),
  ];
  for (const interval of [60, 120]) {
    const result = aggregateMinutes(
      source,
      interval,
      time("2026-09-05T00:00:00Z"),
    );
    const counts = ["premarket", "regular", "postmarket"].map(
      (session) =>
        result.filter((bar) => sessionAt(bar.time) === session).length,
    );
    assert.deepEqual(counts, interval === 60 ? [6, 7, 4] : [3, 4, 2]);
    assert.equal(
      result.reduce((sum, bar) => sum + bar.volume!, 0),
      96_000,
    );
    assert.equal(result.find((bar) => bar.time === regular)?.open, 100);
  }
});

test("sparse extended buckets retain only observed prices, volume, and first observed timestamp", () => {
  const times = [
    "2026-09-04T08:05:00Z",
    "2026-09-04T08:37:00Z",
    "2026-09-04T09:04:00Z",
    "2026-09-04T13:29:00Z",
    "2026-09-04T20:01:00Z",
    "2026-09-04T20:43:00Z",
    "2026-09-04T22:31:00Z",
  ].map(time);
  const source = times.map((at, index) => ({
    time: at,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
  }));
  const asOf = time("2026-09-05T00:00:00Z");
  const hourly = aggregateMinutes([...source].reverse(), 60, asOf);
  assert.deepEqual(
    hourly.map((bar) => bar.time),
    [times[0], times[2], times[3], times[4], times[6]],
  );
  assert.deepEqual(
    hourly.map((bar) => bar.volume),
    [21, 12, 13, 29, 16],
  );
  assert.deepEqual(hourly[0], {
    time: times[0],
    open: 100,
    high: 103,
    low: 99,
    close: 102,
    volume: 21,
  });
  assert.deepEqual(
    aggregateMinutes(source, 120, asOf).map((bar) => bar.volume),
    [33, 13, 29, 16],
  );
  assert.deepEqual(aggregateMinutes(source, 60, asOf, false), []);
});

test("extended opt-in never relaxes missing-minute checks in the regular session", () => {
  const incomplete = bars(regular, 60).filter((_, index) => index !== 20);
  const source = [
    ...bars(time("2026-09-04T08:10:00Z"), 1),
    ...incomplete,
    ...bars(time("2026-09-04T20:10:00Z"), 1),
  ];
  const result = aggregateMinutes(source, 60, time("2026-09-05T00:00:00Z"));
  assert.deepEqual(
    result.map((bar) => sessionAt(bar.time)),
    ["premarket", "postmarket"],
  );
});

test("forming buckets include completed source minutes only and preserve completeness", () => {
  const source = bars(regular, 390);
  const asOf = regular + 63 * minute + 30_000;
  const result = aggregateMinutes(source, 60, asOf);
  assert.equal(result.length, 2);
  assert.equal(result[1].close, 162.5);
  assert.equal(result[1].volume, 300);
  assert.equal(
    aggregateMinutes(
      source.filter((_, index) => index !== 61),
      60,
      asOf,
    ).length,
    1,
  );
  assert.deepEqual(aggregateMinutes(source, 60, regular + 59_000), []);
  const extended = bars(time("2026-09-04T08:05:00Z"), 1);
  assert.deepEqual(
    aggregateMinutes(extended, 60, extended[0].time + 59_000),
    [],
  );
  assert.equal(
    aggregateMinutes(extended, 60, extended[0].time + minute)[0].volume,
    100,
  );
});

test("each missing regular minute removes only its own bucket, without synthetic fills", () => {
  for (const interval of [60, 120]) {
    for (const missing of [0, 23, 59, 120, 389]) {
      const source = bars(regular, 390).filter((_, index) => index !== missing);
      const result = aggregateMinutes(source, interval, regular + 390 * minute);
      const bucket = Math.floor(missing / interval) * interval;
      const expected = Array.from(
        { length: Math.ceil(390 / interval) },
        (_, index) => index * interval,
      ).filter((offset) => offset !== bucket);
      assert.deepEqual(
        result.map((bar) => bar.time),
        expected.map((offset) => regular + offset * minute),
      );
    }
  }
});

test("historical truncated data is not interpreted as an early market close", () => {
  const result = aggregateMinutes(
    bars(regular, 210),
    60,
    time("2026-09-08T20:00:00Z"),
  );
  assert.equal(result.length, 3);
  const early = time("2026-11-27T14:30:00Z");
  const scheduled = aggregateMinutes(
    bars(early, 210),
    60,
    time("2026-11-27T22:00:00Z"),
  );
  assert.equal(scheduled.length, 4);
  assert.equal(scheduled.at(-1)?.volume, 3_000);
});

test("the last valid duplicate minute wins once, even with unsorted input", () => {
  const source = bars(regular, 60).reverse();
  source.push({
    time: regular + 59 * minute,
    open: 159,
    high: 1_000,
    low: 1,
    close: 80,
    volume: 7,
  });
  source.push({ ...source.at(-1)!, high: NaN });
  const result = aggregateMinutes(source, 60, regular + 60 * minute);
  assert.deepEqual(result, [
    { time: regular, open: 100, high: 1_000, low: 1, close: 80, volume: 5_907 },
  ]);
});

test("unknown and overflowing volume leave OHLC intact without inventing volume", () => {
  for (const volume of [undefined, -1, NaN, Infinity]) {
    const source = bars(regular, 120);
    source[20] = { ...source[20], volume };
    const result = aggregateMinutes(source, 60, regular + 120 * minute);
    assert.equal(result[0].volume, undefined);
    assert.equal(result[0].close, 159.5);
    assert.equal(result[1].volume, 6_000);
  }
  const source = bars(regular, 60).map((bar) => ({ ...bar, volume: 0 }));
  assert.equal(
    aggregateMinutes(source, 60, regular + 60 * minute)[0].volume,
    0,
  );
  source[0].volume = Number.MAX_VALUE;
  source[1].volume = Number.MAX_VALUE;
  assert.equal(
    aggregateMinutes(source, 60, regular + 60 * minute)[0].volume,
    undefined,
  );
});

test("invalid OHLC, timestamps, and off-minute observations do not become regular constituents", () => {
  for (const replacement of [
    { high: NaN },
    { open: -1 },
    { low: 500 },
    { close: Infinity },
    { time: regular + 0.5 },
  ]) {
    const source = bars(regular, 60);
    source[20] = { ...source[20], ...replacement };
    assert.deepEqual(aggregateMinutes(source, 60, regular + 60 * minute), []);
  }
  for (const interval of [-1, 0, 2, 10, 45, 240, Infinity])
    assert.deepEqual(
      aggregateMinutes(bars(regular, 60), interval, regular + 60 * minute),
      [],
    );
  for (const asOf of [NaN, Infinity, -1, 32_503_680_000_000])
    assert.deepEqual(aggregateMinutes(bars(regular, 60), 60, asOf), []);
});

test("all supported small intervals preserve complete regular source coverage", () => {
  for (const interval of [1, 5, 15, 30]) {
    const result = aggregateMinutes(
      bars(regular, 390),
      interval,
      regular + 390 * minute,
    );
    assert.equal(result.length, 390 / interval);
    assert.equal(
      result.reduce((sum, bar) => sum + bar.volume!, 0),
      39_000,
    );
  }
});

test("moving averages need complete windows and use full history before visible slicing", () => {
  const source = bars(regular, 200);
  for (const period of [5, 10, 20, 30]) {
    const values = movingAverage(source, period);
    assert.ok(
      values.slice(0, period - 1).every((value) => value === undefined),
    );
    near(
      values[period - 1],
      source.slice(0, period).reduce((sum, bar) => sum + bar.close, 0) / period,
    );
    assert.notEqual(values.slice(-120)[0], undefined);
  }
  const invalid = [
    flat(10, regular),
    flat(NaN, regular + minute),
    flat(12, regular + 2 * minute),
    flat(14, regular + 3 * minute),
  ];
  assert.deepEqual(movingAverage(invalid, 2), [
    undefined,
    undefined,
    undefined,
    13,
  ]);
  for (const period of [-1, 0, 1.5, 5])
    assert.ok(
      movingAverage(invalid, period).every((value) => value === undefined),
    );
});

test("estimated VWAP weights typical prices and resets by New York date rather than UTC", () => {
  const values = sessionAverage([
    { time: regular, open: 10, high: 14, low: 8, close: 11, volume: 100 },
    {
      time: regular + minute,
      open: 11,
      high: 20,
      low: 10,
      close: 15,
      volume: 300,
    },
  ]);
  near(values[0], 11);
  near(values[1], 14);
  const source = [
    flat(10, time("2026-09-01T23:59:00Z")),
    flat(20, time("2026-09-02T00:01:00Z")),
    flat(30, time("2026-09-02T13:30:00Z")),
  ];
  assert.deepEqual(
    source.map((bar) => newYorkDateKey(bar.time)),
    ["2026-09-01", "2026-09-01", "2026-09-02"],
  );
  assert.deepEqual(sessionAverage(source), [10, 15, 30]);
});

test("missing volume suppresses subsequent VWAP estimates until the next New York date", () => {
  for (const volume of [undefined, -1, NaN, Infinity]) {
    const source = [
      flat(10, regular),
      { ...flat(20, regular + minute), volume },
      flat(30, regular + 2 * minute),
      flat(40, time("2026-09-08T13:30:00Z")),
    ];
    assert.deepEqual(sessionAverage(source), [10, undefined, undefined, 40]);
  }
  assert.deepEqual(
    sessionAverage([
      flat(9, regular, 0),
      flat(10, regular + minute),
      flat(20, regular + 2 * minute, 0),
    ]),
    [undefined, 10, 10],
  );
  assert.deepEqual(
    sessionAverage([
      { ...flat(10, regular), high: 9 },
      flat(11, regular + minute),
    ]),
    [undefined, undefined],
  );
});

test("viewport starts at the latest 120 bars and obeys safe minimum and maximum sizes", () => {
  assert.deepEqual(createViewport(3_900), {
    start: 3_780,
    count: 120,
    totalCount: 3_900,
  });
  assert.deepEqual(createViewport(5), { start: 0, count: 5, totalCount: 5 });
  assert.deepEqual(createViewport(0), { start: 0, count: 0, totalCount: 0 });
  assert.equal(createViewport(1_000, 5).count, 12);
  assert.deepEqual(createViewport(1_000, 1_000), {
    start: 400,
    count: 600,
    totalCount: 1_000,
  });
});

test("horizontal pan uses the initial gesture viewport and clamps at loaded history boundaries", () => {
  const start = createViewport(1_000);
  const older = panViewport(start, 100, 300);
  near(older.start, 840);
  assert.equal(older.count, start.count);
  assert.equal(panViewport(start, 10_000, 300).start, 0);
  assert.equal(panViewport(start, -100, 300).start, 880);
  assert.deepEqual(panViewport(start, NaN, 300), start);
  assert.deepEqual(panViewport(start, 100, 0), start);
});

test("pinch preserves its anchored candle while changing density and respecting limits", () => {
  const viewport = panViewport(createViewport(1_000), 300, 300);
  const zoomed = zoomViewport(viewport, 2, 0.25);
  near(zoomed.count, 60);
  near(
    zoomed.start + zoomed.count * 0.25,
    viewport.start + viewport.count * 0.25,
  );
  assert.equal(zoomViewport(viewport, 100, 0.5).count, 12);
  assert.equal(zoomViewport(viewport, 0.01, 0.5).count, 600);
  for (const scale of [0, -1, NaN, Infinity])
    assert.deepEqual(zoomViewport(viewport, scale, 0.5), viewport);
});

test("appended candles follow only a viewport already at the latest; resize needs no viewport mutation", () => {
  const latest = createViewport(1_000);
  assert.equal(reconcileViewport(latest, 1_010).start, 890);
  const older = panViewport(latest, 200, 300);
  assert.equal(reconcileViewport(older, 1_010).start, older.start);
  assert.deepEqual(reconcileViewport(older, 1_000), older);
  assert.deepEqual(visibleRange(panViewport(latest, 1, 300)), {
    first: 879,
    end: 1_000,
  });
});
