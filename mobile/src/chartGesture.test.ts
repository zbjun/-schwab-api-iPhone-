import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chartDragIntent, chartInteractionActive } from "./chartGesture.ts";

test("initial diagonal jitter does not steal a subsequent horizontal chart drag", () => {
  let intent = chartDragIntent("undecided", 5, 7);
  assert.equal(intent, "undecided");
  intent = chartDragIntent(intent, 12, 8);
  assert.equal(intent, "horizontal");
  assert.equal(chartDragIntent(intent, 14, 40), "horizontal");
  assert.equal(chartDragIntent("undecided", -12, -8), "horizontal");
});

test("clear vertical swipes yield to page scrolling and remain vertical", () => {
  const intent = chartDragIntent("undecided", 3, 12);
  assert.equal(intent, "vertical");
  assert.equal(chartDragIntent(intent, 50, 20), "vertical");
  assert.equal(chartDragIntent("undecided", 17, 18), "vertical");
  assert.equal(chartDragIntent("undecided", 18, 17), "horizontal");
  assert.equal(chartDragIntent("undecided", 2, 2), "undecided");
  assert.equal(chartDragIntent("undecided", NaN, 10), "undecided");
});

test("canceling crosshair inspection during a pan or pinch must not unlock the page", () => {
  assert.equal(chartInteractionActive(true, false), true);
  assert.equal(chartInteractionActive(false, true), true);
  assert.equal(chartInteractionActive(true, true), true);
  assert.equal(chartInteractionActive(false, false), false);
});

test("every page with a draggable chart stops its own scrolling during the drag", () => {
  for (const file of ["StockDetail.tsx", "mexc/MexcMarkets.tsx"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /onInspectChange=\{setInspecting\}/, file);
    assert.match(source, /scrollEnabled=\{[^}]*!inspecting\}/, file);
    assert.match(source, /directionalLockEnabled/, file);
  }
});
