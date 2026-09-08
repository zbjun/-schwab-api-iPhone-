import assert from "node:assert/strict";
import { test } from "node:test";
import { createChartPress } from "./chartPress.ts";

test("long press activates at 450ms using the latest position within tolerance", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selections: number[] = [];
  const press = createChartPress((x) => selections.push(x));
  press.start(100, 200, 20);
  t.mock.timers.tick(449);
  press.move(103, 204, 23);
  assert.equal(press.active, false);
  assert.deepEqual(selections, []);
  t.mock.timers.tick(1);
  assert.equal(press.active, true);
  assert.deepEqual(selections, [23]);
});

test("motion beyond 7px cancels activation and tap selection even when returning", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selections: number[] = [];
  const press = createChartPress((x) => selections.push(x));
  press.start(100, 200, 20);
  press.move(105, 205, 25);
  press.move(100, 200, 20);
  t.mock.timers.tick(500);
  press.end();
  assert.equal(press.active, false);
  assert.deepEqual(selections, []);
});

test("active dragging follows every position and leaves clamping to the chart", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selections: number[] = [];
  const press = createChartPress((x) => selections.push(x));
  press.start(100, 200, 20);
  t.mock.timers.tick(450);
  press.move(200, 210, 120);
  press.move(50, 300, -30);
  press.move(2000, 300, 1920);
  assert.equal(press.active, true);
  assert.deepEqual(selections, [20, 120, -30, 1920]);
  press.end();
  press.move(150, 200, 70);
  t.mock.timers.tick(1000);
  assert.equal(press.active, false);
  assert.deepEqual(selections, [20, 120, -30, 1920]);
});

test("short release selects once and cannot activate later", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selections: number[] = [];
  const press = createChartPress((x) => selections.push(x));
  press.start(100, 200, 20);
  press.move(107, 200, 27);
  t.mock.timers.tick(100);
  press.end();
  press.end();
  press.move(120, 200, 40);
  t.mock.timers.tick(1000);
  assert.equal(press.active, false);
  assert.deepEqual(selections, [27]);
});

test("multitouch or termination cancellation suppresses pending and active selection", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selections: number[] = [];
  const press = createChartPress((x) => selections.push(x));
  press.start(100, 200, 20);
  t.mock.timers.tick(200);
  press.cancel();
  press.end();
  t.mock.timers.tick(1000);
  assert.deepEqual(selections, []);
  assert.equal(press.active, false);
  press.start(100, 200, 30);
  t.mock.timers.tick(450);
  press.cancel();
  press.move(200, 200, 130);
  press.end();
  assert.deepEqual(selections, [30]);
  assert.equal(press.active, false);
});

test("restart replaces the earlier deadline and selection position", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selections: number[] = [];
  const press = createChartPress((x) => selections.push(x));
  press.start(100, 200, 20);
  t.mock.timers.tick(300);
  press.start(200, 200, 120);
  t.mock.timers.tick(150);
  assert.equal(press.active, false);
  assert.deepEqual(selections, []);
  t.mock.timers.tick(300);
  assert.equal(press.active, true);
  assert.deepEqual(selections, [120]);
});

test("tap dismisses a retained crosshair while hold release keeps it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let selected: number | undefined;
  let tapCount = 0;
  const press = createChartPress(
    (x) => {
      selected = x;
    },
    (x) => {
      tapCount++;
      selected = selected === undefined ? x : undefined;
    },
  );
  press.start(100, 200, 20);
  t.mock.timers.tick(450);
  press.move(120, 200, 40);
  press.end();
  assert.equal(selected, 40);
  assert.equal(tapCount, 0);
  press.start(140, 200, 60);
  t.mock.timers.tick(100);
  press.end();
  press.end();
  t.mock.timers.tick(1000);
  assert.equal(selected, undefined);
  assert.equal(tapCount, 1);
});

test("a renewed long hold moves an existing crosshair instead of dismissing it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let selected: number | undefined = 20;
  const press = createChartPress(
    (x) => {
      selected = x;
    },
    () => {
      selected = undefined;
    },
  );
  press.start(150, 200, 70);
  t.mock.timers.tick(450);
  press.move(160, 200, 80);
  press.end();
  assert.equal(selected, 80);
});
