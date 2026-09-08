import test from "node:test";
import assert from "node:assert/strict";
import { selectedActivity, selectedChangePercent, selectedReferencePrice, volumeRatio } from "./marketStatistics.ts";
const candle = (time: string, volume: number | undefined) => ({
  time: Date.parse(time),
  open: 1,
  high: 2,
  low: 1,
  close: 2,
  volume,
});

test("selected activity follows the selected bar volume rather than a daily quote", () => {
  const first = { time: 1, open: 10, high: 14, low: 8, close: 12, volume: 100 };
  const second = { time: 2, open: 12, high: 16, low: 10, close: 14, volume: 250 };
  assert.deepEqual(selectedActivity(first, 10000), { volume: 100, turnoverPercent: 1, amountEstimate: 1100 });
  assert.deepEqual(selectedActivity(second, 10000), { volume: 250, turnoverPercent: 2.5, amountEstimate: 3250 });
  assert.deepEqual(selectedActivity(undefined, 10000), { volume: undefined, turnoverPercent: undefined, amountEstimate: undefined });
});

test("missing forming volume and unknown shares stay unknown, real zero stays zero", () => {
  const bar = { time: 1, open: 10, high: 14, low: 8, close: 12 };
  for (const volume of [undefined, -1, NaN, Infinity]) {
    assert.deepEqual(selectedActivity({ ...bar, volume, provisional: true }, 10000), {
      volume: undefined, turnoverPercent: undefined, amountEstimate: undefined,
    });
  }
  assert.deepEqual(selectedActivity({ ...bar, volume: 0 }, 10000), {
    volume: 0, turnoverPercent: 0, amountEstimate: 0,
  });
  for (const shares of [undefined, 0, -1, NaN, Infinity]) {
    assert.equal(selectedActivity({ ...bar, volume: 100 }, shares).turnoverPercent, undefined);
  }
  assert.equal(selectedActivity({ ...bar, high: NaN, volume: 100 }, 10000).amountEstimate, undefined);
});

test("selected OHLC color baseline and percent both use the prior displayed period", () => {
  const before = { time: 1, open: 9, high: 10, low: 8, close: 10 };
  const selected = { time: 2, open: 11, high: 14, low: 10, close: 12 };
  const history = { symbol: "AAPL", previousClose: 8, candles: [before, selected] };
  for (const range of ["daily", "weekly", "monthly", "minute1", "minute5", "minute15", "minute30", "minute60", "minute120"] as const) {
    assert.equal(selectedReferencePrice(history, selected, range), 10);
    assert.ok(Math.abs(selectedChangePercent(history, selected, range)! - 20) < 1e-9);
  }
  assert.equal(selectedReferencePrice(history, selected, "intraday"), 8);
});
const daily = {
  symbol: "AAPL",
  candles: [
    "2026-08-28",
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
  ].map((d) => candle(d + "T16:00:00Z", 3900)),
};
const intra = {
  symbol: "AAPL",
  candles: [
    candle("2026-09-04T13:30:00Z", 20),
    candle("2026-09-04T13:31:00Z", 20),
  ],
};
test("volume ratio uses completed regular bars and five prior sessions", () =>
  assert.equal(
    volumeRatio(intra, daily, Date.parse("2026-09-04T14:00:00Z")),
    2,
  ));
test("missing, duplicated, forming or foreign-symbol observations cannot create a volume ratio", () => {
  assert.equal(
    volumeRatio({ ...intra, candles: intra.candles.slice(1) }, daily),
    undefined,
  );
  assert.equal(
    volumeRatio(
      { ...intra, candles: [...intra.candles, intra.candles[1]] },
      daily,
    ),
    undefined,
  );
  assert.equal(volumeRatio(intra, { ...daily, symbol: "SPY" }), undefined);
  assert.equal(
    volumeRatio(intra, daily, Date.parse("2026-09-04T13:30:10Z")),
    undefined,
  );
  assert.equal(
    volumeRatio(
      { ...intra, candles: [candle("2026-09-04T13:30:00Z", undefined)] },
      daily,
    ),
    undefined,
  );
});

test("selected percentage uses the line baseline and the prior candle for K lines", () => {
  const before = { time: 1, open: 90, high: 100, low: 90, close: 100 };
  const selected = { time: 2, open: 109, high: 110, low: 105, close: 110 };
  const later = { time: 3, open: 110, high: 200, low: 110, close: 200 };
  const history = {
    symbol: "AAPL",
    previousClose: 125,
    candles: [later, selected, before],
  };
  for (const range of ["intraday", "fiveDay"] as const) {
    assert.ok(
      Math.abs(selectedChangePercent(history, selected, range)! + 12) < 1e-9,
    );
  }
  for (const range of [
    "daily",
    "weekly",
    "monthly",
    "minute1",
    "minute120",
  ] as const) {
    assert.ok(
      Math.abs(selectedChangePercent(history, selected, range)! - 10) < 1e-9,
    );
  }
  assert.equal(
    selectedChangePercent(
      { ...history, previousClose: 110 },
      selected,
      "intraday",
    ),
    0,
  );
});

test("selected percentage leaves missing or invalid reference prices unavailable", () => {
  const selected = { time: 1, open: 10, high: 10, low: 10, close: 10 };
  const history = { symbol: "AAPL", candles: [selected] };
  assert.equal(
    selectedChangePercent(undefined, selected, "intraday"),
    undefined,
  );
  assert.equal(
    selectedChangePercent(history, undefined, "intraday"),
    undefined,
  );
  assert.equal(selectedChangePercent(history, selected, "daily"), undefined);
  for (const previousClose of [undefined, 0, -1, NaN, Infinity]) {
    assert.equal(
      selectedChangePercent(
        { ...history, previousClose },
        selected,
        "intraday",
      ),
      undefined,
    );
  }
});
