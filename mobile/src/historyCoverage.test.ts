import assert from "node:assert/strict";
import test from "node:test";
import { decodeHistory } from "./orderRules.ts";
import { historyCoverage, historyCoverageReport } from "./historyCoverage.ts";
import { shareHistory } from "./marketRefresh.ts";

test("raw-response coverage distinguishes deduplication, absent night and cached plotted night", () => {
  const raw = (date: string) => ({ datetime: Date.parse(date), open: 710, high: 712, low: 709, close: 711 });
  const night = raw("2026-09-10T01:00Z"), post = raw("2026-09-09T23:59Z"), pre = raw("2026-09-10T11:04Z");
  const capture = { receivedAt: Date.parse("2026-09-10T15:15Z"), range: "minute1" as const };
  const previous = decodeHistory({ symbol: "QQQ", candles: [post, night, pre] }, "QQQ", capture);
  const next = decodeHistory({ symbol: "QQQ", candles: [post, post, pre] }, "QQQ", capture);
  assert.equal(next.sourceCoverage?.rawBars, 3);
  assert.equal(next.sourceCoverage?.decoded.total, 2);
  assert.equal(next.sourceCoverage?.decoded.days.reduce((n, d) => n + d.night, 0), 0);
  const merged = shareHistory(previous, next, { now: capture.receivedAt, range: capture.range });
  assert.equal(merged.sourceCoverage, next.sourceCoverage);
  const report = historyCoverageReport(merged, "minute1");
  assert.match(report, /原始3根 → 解码2根/);
  assert.match(report, /缓存1根/);
  assert.match(report, /2026-09-09：夜0/);
  assert.match(report, /2026-09-09：夜1/);
  assert.equal(JSON.stringify(merged.sourceCoverage).includes("710"), false, "only dates/counts, no prices or credentials");
});

test("NY coverage splits overnight across natural days and follows winter offset", () => {
  const candles = ["2026-11-04T01:00Z", "2026-11-04T06:00Z", "2026-11-04T09:00Z"].map(s =>
    ({ time: Date.parse(s), open: 1, high: 1, low: 1, close: 1 }));
  const data = historyCoverage(candles);
  assert.equal(data.days[0].date, "2026-11-03");
  assert.equal(data.days[0].night, 1);
  assert.equal(data.days[1].night, 1);
  assert.equal(data.days[1].pre, 1);
  assert.equal(historyCoverage([{ ...candles[0], high: -1 }]).total, 0);
});

test("unchanged candles still update the source evidence after a refresh", () => {
  const capture = { receivedAt: Date.parse("2026-09-10T15:15Z"), range: "minute1" as const };
  const old = decodeHistory({ symbol: "QQQ", candles: [] }, "QQQ", capture);
  const next = decodeHistory({ symbol: "QQQ", candles: [] }, "QQQ", { ...capture, receivedAt: capture.receivedAt + 60000 });
  const merged = shareHistory(old, next);
  assert.equal(merged.sourceCoverage?.receivedAt, capture.receivedAt + 60000);
  assert.equal(merged.candles, old.candles);
});

test("calendar candles at midnight never claim overnight coverage", () => {
  for (const range of ["daily", "weekly", "monthly"] as const) {
    const h = decodeHistory({ symbol: "QQQ", candles: [{ datetime: Date.parse("2026-09-10T04:00Z"), open: 1, high: 1, low: 1, close: 1 }] }, "QQQ",
      { receivedAt: Date.parse("2026-09-10T20:00Z"), range });
    assert.deepEqual(h.sourceCoverage?.decoded.days, []);
    assert.equal(h.sourceCoverage?.decoded.total, 1);
    assert.doesNotMatch(historyCoverageReport(h, range), /：夜1/);
    assert.match(historyCoverageReport(h, range), /不作夜盘覆盖判断/);
  }
});
