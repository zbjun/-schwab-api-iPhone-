import assert from "node:assert/strict";
import test from "node:test";
import { barMilliseconds, candleCountdown, chartHeightFor, priceAxisWidth } from "./chartCountdown.ts";
import { AXIS_TAG_HEIGHT, crosshairTagTop, LIVE_TAG_HEIGHT, lineLabelWidth, placeLineLabels } from "./chartLines.ts";

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

test("line labels stay on the plot and never cover each other", () => {
  assert.deepEqual(placeLineLabels([], 0, 100, 17), []);
  assert.deepEqual(placeLineLabels([40], 0, 100, 17), [40]);
  // Far apart: each stays where it wants to be.
  assert.deepEqual(placeLineLabels([60, 10], 0, 100, 17), [60, 10]);
  // Close together: pushed apart, in the same order and returned in the order given.
  assert.deepEqual(placeLineLabels([45, 40], 0, 100, 17), [57, 40]);
  // Off the chart: pinned to an edge without stacking.
  assert.deepEqual(placeLineLabels([-300, -200], 0, 100, 17), [0, 17]);
  assert.deepEqual(placeLineLabels([500, 400], 0, 100, 17), [83, 66]);
  // More than fit: they share the top edge rather than leave the plot.
  for (const top of placeLineLabels([0, 0, 0, 0], 0, 34, 17)) assert.ok(top >= 0 && top <= 17);
});

test("the crosshair's price sits level with its line and never covers the live price", () => {
  const top = 0, bottom = 400;
  const covers = (crosshair: number, liveY: number) => {
    const liveTop = Math.min(Math.max(liveY - LIVE_TAG_HEIGHT / 2, top), bottom - LIVE_TAG_HEIGHT);
    return crosshair < liveTop + LIVE_TAG_HEIGHT && crosshair + AXIS_TAG_HEIGHT > liveTop;
  };
  // Far apart, or no live price: level with the line.
  assert.equal(crosshairTagTop(100, 300, top, bottom), 93);
  assert.equal(crosshairTagTop(100, undefined, top, bottom), 93);
  // Off either end of the plot: held inside it.
  assert.equal(crosshairTagTop(-50, 300, top, bottom), 0);
  assert.equal(crosshairTagTop(500, 100, top, bottom), 386);
  // Close together: to the side of the live tag it was already on.
  assert.equal(crosshairTagTop(195, 200, top, bottom), 173.5);
  assert.equal(crosshairTagTop(205, 200, top, bottom), 212.5);
  // No room on that side: the other one.
  assert.equal(crosshairTagTop(2, 5, top, bottom), 25);
  assert.equal(crosshairTagTop(398, 395, top, bottom), 361);
  for (let liveY = 0; liveY <= 400; liveY += 7) {
    for (let y = 0; y <= 400; y += 3) {
      const placed = crosshairTagTop(y, liveY, top, bottom);
      assert.equal(covers(placed, liveY), false, `${y} beside ${liveY}`);
      assert.ok(placed >= top && placed + AXIS_TAG_HEIGHT <= bottom);
    }
  }
});

test("line label width leaves room for its text", () => {
  assert.ok(lineLabelWidth("成本 690.00") >= 50);
  assert.ok(lineLabelWidth("多止损 101,234.50") > lineLabelWidth("成本 690.00"));
});
