import test from "node:test";
import assert from "node:assert/strict";
import { easternClock, easternDate, easternEpoch } from "./easternTime.ts";

test("Eastern wall-clock times convert across daylight saving", () => {
  assert.equal(easternEpoch("2026-10-19", "09:30:00"), Date.parse("2026-10-19T13:30:00Z"));
  assert.equal(easternEpoch("2026-12-01", "09:30"), Date.parse("2026-12-01T14:30:00Z"));
  // The day clocks fall back: 01:30 occurs twice; the later (standard-time) instant is used.
  assert.equal(easternEpoch("2026-11-01", "01:30:00"), Date.parse("2026-11-01T06:30:00Z"));
  // The day clocks spring forward: 02:30 never happens.
  assert.equal(easternEpoch("2026-03-08", "02:30:00"), undefined);
  assert.equal(easternEpoch("2026-03-08", "03:30:00"), Date.parse("2026-03-08T07:30:00Z"));
});

test("invalid dates and times are rejected", () => {
  for (const [date, time] of [["2026-13-01", "09:30"], ["2026-10-19", "24:00"], ["2026/10/19", "09:30"], ["2026-10-19", "9:3"]])
    assert.equal(easternEpoch(date, time), undefined);
});

test("Eastern clock and calendar days are read in New York time", () => {
  const instant = Date.parse("2026-10-20T02:15:07Z"); // 22:15:07 on the 19th in New York
  assert.deepEqual(easternClock(instant), { date: "2026-10-19", time: "22:15:07" });
  assert.equal(easternDate(instant), "2026-10-19");
  assert.equal(easternDate(instant, 1), "2026-10-20");
  assert.equal(easternDate(Date.parse("2026-12-31T15:00:00Z"), 1), "2027-01-01");
});
