import assert from "node:assert/strict";
import test from "node:test";
import { latestSessionLocation, sessionViewport } from "./chartSessions.ts";
import { visibleRange } from "./chartData.ts";

const times = (...values: string[]) => values.map(Date.parse);

test("locating overnight jumps away from the default latest 120 bars and includes both sides of midnight", () => {
  const night = Array.from({ length: 480 }, (_, i) => Date.parse("2026-09-09T00:00:00Z") + i * 60_000);
  const all = [...night, ...Array.from({ length: 800 }, (_, i) => Date.parse("2026-09-09T08:00:00Z") + i * 60_000)];
  const location = latestSessionLocation(all, "overnight")!;
  assert.equal(location.count, 480);
  const bounds = visibleRange(sessionViewport(all.length, location));
  assert.equal(bounds.first, 0);
  assert.ok(bounds.end > location.last);
  assert.ok(bounds.end < all.length - 120);
});

test("missing recent night does not invent bars or merge separate observed nights", () => {
  const data = times("2026-09-02T00:10:00Z", "2026-09-03T01:10:00Z", "2026-09-03T06:10:00Z", "2026-09-09T13:30:00Z");
  const location = latestSessionLocation(data, "overnight")!;
  assert.deepEqual([location.first, location.last, location.count], [1, 2, 2]);
  assert.equal(location.lastTime, Date.parse("2026-09-03T06:10:00Z"));
  assert.equal(latestSessionLocation(data, "premarket"), undefined);
  assert.equal(latestSessionLocation([], "overnight"), undefined);
});

test("winter night boundaries and sparse observations are classified in New York time", () => {
  const data = times("2026-11-04T00:59:00Z", "2026-11-04T01:01:00Z", "2026-11-04T05:59:00Z", "2026-11-04T06:01:00Z", "2026-11-04T08:59:00Z", "2026-11-04T09:00:00Z");
  assert.equal(latestSessionLocation(data, "overnight")!.count, 4);
  assert.equal(latestSessionLocation(data, "postmarket")!.count, 1);
  assert.equal(latestSessionLocation(data, "premarket")!.first, 5);
  const bounds = visibleRange(sessionViewport(data.length, latestSessionLocation(data, "overnight")!));
  assert.deepEqual(bounds, { first: 0, end: data.length });
});
