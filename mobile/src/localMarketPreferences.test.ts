import assert from "node:assert/strict";
import test from "node:test";
import { createLocalMarketPreferenceWriter, decodeLocalMarketPreferences, emptyLocalMarketPreferences,
  readLocalMarketSettings } from "./localMarketPreferences.ts";

test("previously saved boundary and duration require explicit slippage before trading", () => {
  const restored = decodeLocalMarketPreferences(JSON.stringify({ boundaryPercent: "0.5", durationSeconds: "10" }));
  assert.deepEqual(restored, { boundaryPercent: "0.5", durationSeconds: "10", slippagePercent: "" });
  assert.throws(() => readLocalMarketSettings(restored), /设置/);
  assert.deepEqual(readLocalMarketSettings({ ...restored, slippagePercent: "0" }), {
    boundaryPercent: 0.5, durationSeconds: 10, slippagePercent: 0,
  });
});

test("fresh installation leaves all parameters unset and restored strings retain precision", () => {
  assert.deepEqual(decodeLocalMarketPreferences(null), emptyLocalMarketPreferences);
  assert.throws(() => readLocalMarketSettings(decodeLocalMarketPreferences(null)), /填写/);
  const saved = { boundaryPercent: "0.50", slippagePercent: "0.10", durationSeconds: "15" };
  assert.deepEqual(decodeLocalMarketPreferences(JSON.stringify(saved)), saved);
});

test("preference validation uses the same ranges as the execution engine", () => {
  const valid = { boundaryPercent: "0.5", slippagePercent: "0.1", durationSeconds: "10" };
  for (const invalid of [
    { slippagePercent: " " }, { slippagePercent: "0.6" }, { slippagePercent: "-0.1" },
    { boundaryPercent: "100" }, { durationSeconds: "0" }, { durationSeconds: "3601" },
    { durationSeconds: "1.5" }, { durationSeconds: "NaN" },
  ]) assert.throws(() => readLocalMarketSettings({ ...valid, ...invalid }));
  assert.throws(() => decodeLocalMarketPreferences("[]"));
  assert.throws(() => decodeLocalMarketPreferences("broken"));
  assert.equal(decodeLocalMarketPreferences('{"slippagePercent":0}').slippagePercent, "");
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
  const first = write({ boundaryPercent: "0.5", slippagePercent: "0", durationSeconds: "1" });
  const last = write({ boundaryPercent: "0.5", slippagePercent: "0.1", durationSeconds: "10" });
  await Promise.resolve();
  assert.equal(seen.length, 1);
  release();
  await Promise.all([first, last]);
  assert.equal(seen.length, 2);
  assert.equal(JSON.parse(stored).durationSeconds, "10");
  assert.equal(JSON.parse(stored).slippagePercent, "0.1");
});

test("a failed preference write reports failure without preventing a later edit from persisting", async () => {
  let calls = 0;
  const write = createLocalMarketPreferenceWriter(async () => {
    if (++calls === 1) throw new Error("storage failed");
  });
  const first = write({ ...emptyLocalMarketPreferences, slippagePercent: "0.1" });
  const next = write({ ...emptyLocalMarketPreferences, slippagePercent: "0.2" });
  await assert.rejects(first, /storage failed/);
  await next;
  assert.equal(calls, 2);
});
