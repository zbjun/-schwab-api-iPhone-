import test from "node:test";
import assert from "node:assert/strict";
import { createCandleMotion, type CandleGeometry } from "./candleMotion.ts";
import { mergeFormingCandle } from "./liveHistory.ts";

function fixture() {
  let serial = 0;
  const pending = new Map<number, (time: number) => void>();
  const paints: CandleGeometry[] = [];
  const motion = createCandleMotion(
    { open: 100, high: 90, low: 110, close: 105 },
    (value) => paints.push(value),
    {
      request: (callback) => {
        pending.set(++serial, callback);
        return serial;
      },
      cancel: (id) => {
        pending.delete(id);
      },
    },
  );
  const tick = (time: number) => {
    const tasks = [...pending.values()];
    pending.clear();
    tasks.forEach((task) => task(time));
  };
  return { motion, pending, paints, tick };
}
test("a forming candle moves within one minute, preserves open and wick bounds, then becomes idle", () => {
  const f = fixture();
  f.motion.move({ open: 100, high: 80, low: 110, close: 85 }, true);
  f.tick(0);
  f.tick(70);
  assert.ok(f.paints.at(-1)!.close < 105 && f.paints.at(-1)!.close > 85);
  assert.equal(f.paints.at(-1)!.open, 100);
  f.tick(140);
  assert.deepEqual(f.paints.at(-1), {
    open: 100,
    high: 80,
    low: 110,
    close: 85,
  });
  assert.equal(f.pending.size, 0);
});
test("new ticks retarget from the displayed value, cancellation and reduced motion leave no animation loop", () => {
  const f = fixture();
  f.motion.move({ open: 100, high: 80, low: 110, close: 85 }, true);
  f.tick(0);
  f.tick(60);
  const displayed = f.paints.at(-1)!.close;
  f.motion.move({ open: 100, high: 80, low: 120, close: 115 }, true);
  f.tick(61);
  assert.equal(f.paints.at(-1)!.close, displayed);
  f.motion.stop();
  assert.equal(f.pending.size, 0);
  const target = { open: 100, high: 80, low: 120, close: 115 };
  f.motion.move(target, false);
  assert.deepEqual(f.paints.at(-1), target);
  assert.equal(f.pending.size, 0);
});
test("minute aggregation fixes first observed open and accumulates highs and lows across paint batches", () => {
  const start = Date.parse("2026-09-08T13:30:00Z");
  let bars = mergeFormingCandle(
    [],
    {
      time: start,
      open: 100,
      high: 110,
      low: 98,
      close: 103,
      provisional: true,
    },
    start + 500,
  );
  bars = mergeFormingCandle(
    bars,
    {
      time: start,
      open: 103,
      high: 106,
      low: 95,
      close: 99,
      provisional: true,
    },
    start + 1000,
  );
  assert.deepEqual(bars[0], {
    time: start,
    open: 100,
    high: 110,
    low: 95,
    close: 99,
    provisional: true,
  });
  bars = mergeFormingCandle(
    bars,
    {
      time: start + 60000,
      open: 99,
      high: 101,
      low: 99,
      close: 101,
      provisional: true,
    },
    start + 61000,
  );
  assert.equal(bars.length, 2);
  assert.equal(bars[1].open, 99);
  assert.equal(bars[0].close, 99);
  const final = [
    { time: start, open: 100, high: 112, low: 94, close: 98, volume: 500 },
  ];
  assert.equal(mergeFormingCandle(final, bars[0], start + 61000), final);
});
