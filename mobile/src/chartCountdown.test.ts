import assert from "node:assert/strict";
import test from "node:test";
import { barMilliseconds, candleCountdown, chartHeightFor, priceAxisWidth } from "./chartCountdown.ts";

const start = 1_700_000_000_000;

test("bar periods", () => {
  assert.equal(barMilliseconds("minute1"), 60_000);
  assert.equal(barMilliseconds("minute15"), 900_000);
  assert.equal(barMilliseconds("minute120"), 7_200_000);
  assert.equal(barMilliseconds("intraday"), 60_000);
  assert.equal(barMilliseconds("fiveDay"), 300_000);
  assert.equal(barMilliseconds("daily"), undefined);
  assert.equal(barMilliseconds("weekly"), undefined);
  assert.equal(barMilliseconds("monthly"), undefined);
});

test("countdown formats minutes and hours", () => {
  assert.equal(candleCountdown(start, "minute1", start + 29_000), "00:31");
  assert.equal(candleCountdown(start, "minute5", start), "05:00");
  assert.equal(candleCountdown(start, "minute5", start + 500), "05:00");
  const aligned = 900_000 * 7_200_000;
  assert.equal(candleCountdown(aligned, "minute60", aligned + 1000), "59:59");
  assert.equal(candleCountdown(aligned, "minute120", aligned + 1000), "1:59:59");
  assert.equal(candleCountdown(aligned, "minute120", aligned), "2:00:00");
});

test("long bars that do not start on their boundary show no countdown", () => {
  const aligned = 900_000 * 7_200_000;
  assert.equal(candleCountdown(aligned + 180_000, "minute60", aligned + 240_000), undefined);
  assert.equal(candleCountdown(aligned + 180_000, "minute120", aligned + 240_000), undefined);
  // Shorter bars are the source's own, so any start is their real start.
  assert.equal(candleCountdown(aligned + 180_000, "minute30", aligned + 240_000), "29:00");
});

test("countdown is undefined when not applicable", () => {
  assert.equal(candleCountdown(start, "daily", start + 1000), undefined);
  assert.equal(candleCountdown(start, "minute1", start + 60_000), undefined);
  assert.equal(candleCountdown(start, "minute1", start + 3_600_000), undefined);
  assert.equal(candleCountdown(start, "minute1", start - 1000), undefined);
  assert.equal(candleCountdown(NaN, "minute1", start), undefined);
  assert.equal(candleCountdown(start, "minute1", NaN), undefined);
});

test("chart height scales with the window and is bounded", () => {
  assert.equal(chartHeightFor(812), 503);
  assert.ok(chartHeightFor(812) / 812 >= 0.6 && chartHeightFor(812) / 812 <= 0.66);
  assert.equal(chartHeightFor(300), 260);
  assert.equal(chartHeightFor(3000), 680);
  assert.equal(chartHeightFor(NaN), 434);
});

test("price axis fits its longest label and keeps room for the countdown", () => {
  assert.equal(priceAxisWidth(["716.45"]), 35);
  assert.equal(priceAxisWidth(["96,000.00", "118,345.10"]), 55);
  assert.equal(priceAxisWidth(["1.23M"]), 34);
  assert.equal(priceAxisWidth(["1.23"]), 34);
  assert.equal(priceAxisWidth([]), 34);
});
