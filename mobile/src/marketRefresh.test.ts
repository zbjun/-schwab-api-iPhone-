import test from "node:test";
import assert from "node:assert/strict";
import { marketRefreshInterval, shareHistory } from "./marketRefresh.ts";
import type { History } from "./types.ts";

test("foreground market cadence covers extended sessions and slows outside trading hours", () => {
  for (const time of [
    "2026-09-08T08:30:00Z",
    "2026-09-08T14:00:00Z",
    "2026-09-08T22:00:00Z",
  ]) {
    const now = Date.parse(time);
    assert.equal(marketRefreshInterval("quote", "daily", now, false), 2000);
    assert.equal(
      marketRefreshInterval("history", "minute1", now, false),
      10000,
    );
    assert.equal(
      marketRefreshInterval("history", "monthly", now, false),
      30000,
    );
    assert.equal(
      marketRefreshInterval("statistics", "intraday", now, false),
      60000,
    );
    assert.equal(marketRefreshInterval("quote", "intraday", now, true), 60000);
  }
  for (const time of [
    "2026-09-06T14:00:00Z",
    "2026-09-07T14:00:00Z",
    "2026-09-08T06:00:00Z",
  ]) {
    assert.equal(
      marketRefreshInterval("quote", "intraday", Date.parse(time), false),
      60000,
    );
  }
});

test("unchanged history preserves array identity; corrected and appended bars update without dropping history", () => {
  const old: History = {
    symbol: "AAPL",
    previousClose: 99,
    candles: [
      { time: 1000, open: 100, high: 103, low: 99, close: 101, volume: 100 },
      { time: 2000, open: 101, high: 104, low: 100, close: 102, volume: 200 },
    ],
  };
  assert.equal(shareHistory(old, structuredClone(old)), old);
  const changed = structuredClone(old);
  changed.candles[1].close = 103;
  const result = shareHistory(old, changed);
  assert.notEqual(result, old);
  assert.equal(result.candles[0], old.candles[0]);
  assert.equal(result.candles[1].close, 103);
  const appended = {
    ...old,
    candles: [...old.candles, { ...old.candles[1], time: 3000 }],
  };
  assert.equal(shareHistory(old, appended).candles.length, 3);
  const priorClose = shareHistory(old, { ...old, previousClose: 98 });
  assert.equal(priorClose.previousClose, 98);
  assert.equal(priorClose.candles, old.candles);
});
