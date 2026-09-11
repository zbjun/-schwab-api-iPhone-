import test from "node:test";
import assert from "node:assert/strict";
import { marketRefreshInterval, shareHistory } from "./marketRefresh.ts";
import type { History } from "./types.ts";
import { decodeHistory } from "./orderRules.ts";
import { overlayLiveHistory } from "./liveHistory.ts";
import { validCandle } from "./chartData.ts";
import { latestSessionLocation } from "./chartSessions.ts";

test("QQQ night survives a sparse REST refresh through the rendering pipeline and accepts corrections", () => {
  const times = ["2026-09-09T23:59Z", "2026-09-10T01:00Z", "2026-09-10T06:00Z", "2026-09-10T11:04Z"].map(Date.parse);
  const raw = times.map(datetime => ({ datetime, open: 710, high: 712, low: 709, close: 711, volume: 20 }));
  const first = decodeHistory({ symbol: "QQQ", candles: raw }, "QQQ");
  const sparse = decodeHistory({ symbol: "QQQ", candles: [raw[0], raw[3]] }, "QQQ");
  const options = { range: "minute1" as const, now: Date.parse("2026-09-10T15:15Z") };
  const merged = shareHistory(first, sparse, options);
  assert.equal(merged.candles.length, 4);
  assert.equal(merged.candles.filter(c => c.retained).length, 2);
  const chart = overlayLiveHistory(merged, "minute1", [], undefined, options.now)!;
  assert.equal(latestSessionLocation(chart.candles.filter(validCandle).map(c => c.time), "overnight")?.count, 2);
  const corrected = decodeHistory({ symbol: "QQQ", candles: raw.map(c => ({ ...c, close: 710.5 })) }, "QQQ");
  const restored = shareHistory(merged, corrected, options);
  assert.equal(restored.candles.filter(c => c.retained).length, 0);
  assert.equal(restored.candles[1].close, 710.5);
  assert.equal(shareHistory(undefined, sparse, options).candles.length, 2, "never invent a missing first-load night");
});

test("retention respects source, range, response window, provisional data and age limits", () => {
  const now = Date.parse("2026-09-10T15:15Z");
  const c = (time: number) => ({ time, open: 10, high: 11, low: 9, close: 10 });
  const previous: History = { symbol: "QQQ", candles: [c(now - 12 * 86400000), c(now - 500000), { ...c(now - 400000), provisional: true }, c(now - 300000), c(now - 100000)] };
  const next: History = { symbol: "QQQ", candles: [c(now - 600000), c(now - 200000)] };
  const options = { range: "minute1" as const, now };
  const result = shareHistory(previous, next, options);
  assert.deepEqual(result.candles.map(c => c.time), [now - 600000, now - 500000, now - 300000, now - 200000]);
  assert.deepEqual(shareHistory(previous, { ...next, symbol: "SPY" }, options).candles, next.candles);
  assert.deepEqual(shareHistory(previous, next, { ...options, range: "daily" }).candles, next.candles);
  assert.deepEqual(shareHistory(previous, { ...next, candles: [] }, options).candles, []);
});

test("cached additions respect 15000-bar budget and ten-day age without trimming fresh responses", () => {
  const now = Date.parse("2026-09-10T15:15Z");
  const c = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1 });
  const old: History = { symbol: "QQQ", candles: Array.from({ length: 16000 }, (_, i) => c(now - 16001 * 1000 + i * 1000)) };
  const next: History = { symbol: "QQQ", candles: [c(now - 11 * 86400000), c(now)] };
  const result = shareHistory(old, next, { now, range: "minute1" });
  assert.equal(result.candles.length, 15000);
  assert.equal(result.candles[0].time, next.candles[0].time, "current authoritative response retained");
  const ancient: History = { symbol: "QQQ", candles: [c(now - 10.5 * 86400000)] };
  assert.equal(shareHistory(ancient, next, { now, range: "minute1" }).candles.length, 2);
  assert.equal(shareHistory(next, old, { now, range: "minute1" }).candles.length, 16000);
});

test("cached history from another period cannot enter the new period", () => {
  const now = Date.parse("2026-09-10T15:15Z");
  const raw = (time: number) => ({ datetime: time, open: 1, high: 1, low: 1, close: 1 });
  const old = decodeHistory({ symbol: "QQQ", candles: [raw(now - 120000)] }, "QQQ", { receivedAt: now, range: "daily" });
  const next = decodeHistory({ symbol: "QQQ", candles: [raw(now - 180000), raw(now - 60000)] }, "QQQ", { receivedAt: now, range: "minute1" });
  assert.equal(shareHistory(old, next, { now, range: "minute1" }).candles.length, 2);
  const minuteOld = { ...old, sourceCoverage: { ...old.sourceCoverage!, range: "minute1" as const } };
  assert.equal(shareHistory(minuteOld, { ...next, sourceCoverage: { ...next.sourceCoverage!, range: "minute5" } }, { now, range: "minute1" }).candles.length, 2);
});

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
