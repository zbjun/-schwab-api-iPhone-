import assert from "node:assert/strict";
import test from "node:test";
import { createLocalMarketPreferenceWriter, decodeLocalMarketPreferences, emptyLocalMarketPreferences,
  readLocalMarketSettings } from "./localMarketPreferences.ts";

const valid = { ...emptyLocalMarketPreferences, boundaryPercent: "0.5", durationSeconds: "10" };

test("migration preserves old limits without reinterpreting stock-price slippage as spread fraction", () => {
  const restored = decodeLocalMarketPreferences(JSON.stringify({ boundaryPercent: "0.5", durationSeconds: "10", slippagePercent: "0.1" }));
  assert.deepEqual(restored, valid);
  assert.equal(readLocalMarketSettings(restored).startSpreadPercent, 25);
  assert.equal("slippagePercent" in restored, false);
});

test("fresh installation requires limits and saved parameter precision is preserved", () => {
  assert.deepEqual(decodeLocalMarketPreferences(null), emptyLocalMarketPreferences);
  assert.throws(() => readLocalMarketSettings(decodeLocalMarketPreferences(null)), /填写/);
  const saved = { ...valid, boundaryPercent: "0.50", startSpreadPercent: "20.10" };
  assert.deepEqual(decodeLocalMarketPreferences(JSON.stringify(saved)), saved);
  assert.equal(readLocalMarketSettings(saved).startSpreadPercent, 20.1);
});

test("preference validation uses the same ranges as the execution engine", () => {
  for (const invalid of [
    { startSpreadPercent: " " }, { startSpreadPercent: "51" }, { startSpreadPercent: "-1" },
    { boundaryPercent: "100" }, { durationSeconds: "0" }, { durationSeconds: "3601" },
    { durationSeconds: "1.5" }, { durationSeconds: "NaN" },
    { repriceIntervalSeconds: "1" }, { repriceIntervalSeconds: "61" },
    { minRepriceTicks: "0" }, { minRepriceTicks: "1.5" }, { minRepriceTicks: "101" },
    { jumpPercent: "0" }, { jumpPercent: "100" }, { maxSpreadPercent: "0" }, { maxSpreadPercent: "100" },
  ]) assert.throws(() => readLocalMarketSettings({ ...valid, ...invalid }));
  assert.throws(() => decodeLocalMarketPreferences("[]"));
  assert.throws(() => decodeLocalMarketPreferences("broken"));
  assert.equal(decodeLocalMarketPreferences('{"startSpreadPercent":0}').startSpreadPercent, "");
});

test("rapid preference edits save in order without an earlier write overwriting the last value", async () => {
  let release!: () => void;
  const firstPending = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  let stored = "";
  const write = createLocalMarketPreferenceWriter(async raw => {
    seen.push(raw);
    if (seen.length === 1) await firstPending;
    stored = raw;
  });
  const first = write({ ...valid, startSpreadPercent: "0", durationSeconds: "1" });
  const last = write({ ...valid, startSpreadPercent: "25", durationSeconds: "10" });
  await Promise.resolve();
  assert.equal(seen.length, 1);
  release();
  await Promise.all([first, last]);
  assert.equal(seen.length, 2);
  assert.equal(JSON.parse(stored).durationSeconds, "10");
  assert.equal(JSON.parse(stored).startSpreadPercent, "25");
});

test("a failed preference write reports failure without preventing a later edit from persisting", async () => {
  let calls = 0;
  const write = createLocalMarketPreferenceWriter(async () => {
    if (++calls === 1) throw new Error("storage failed");
  });
  const first = write({ ...emptyLocalMarketPreferences, startSpreadPercent: "20" });
  const next = write({ ...emptyLocalMarketPreferences, startSpreadPercent: "25" });
  await assert.rejects(first, /storage failed/);
  await next;
  assert.equal(calls, 2);
});
