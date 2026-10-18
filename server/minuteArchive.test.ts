import test from "node:test";
import assert from "node:assert/strict";
import { MinuteArchive } from "./minuteArchive.ts";

const now = Date.parse("2026-09-10T12:00:00Z");
const time = Date.parse("2026-09-10T06:00:00Z"); // Actual observed 02:00 ET night minute.
const bar = { time, open: 10, high: 12, low: 9, close: 11, volume: 25 };
function storage() {
  const values = new Map<string, string>();
  return { values, get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); }, remove: async (key: string) => { values.delete(key); } };
}

test("saved real night minutes survive restart and fill missing history without overwriting REST", async () => {
  const vault = storage();
  const archive = new MinuteArchive(vault, { now: () => now });
  await archive.load();
  archive.observe("QQQ", bar);
  await archive.flush();
  const restored = new MinuteArchive(vault, { now: () => now });
  await restored.load();
  const morning = { ...bar, time: time + 6 * 3600_000, close: 10 };
  const result = restored.merge({ symbol: "QQQ", candles: [morning] }, "minute1");
  assert.equal(result.candles.length, 2);
  assert.equal(result.candles[0].retained, true);
  assert.equal(result.retainedCoverage?.decoded.days[0].night, 1);
  // The fresh morning REST bar is newly observed and still awaits persistence.
  assert.equal(result.retainedCoverage?.persistence, "memory");
  await restored.flush();
  assert.equal(restored.merge({ symbol: "QQQ", candles: [morning] }, "minute1").retainedCoverage?.persistence, "saved");
  assert.equal(restored.merge({ symbol: "QQQ", candles: [{ ...bar, close: 9 }] }, "minute1").candles[0].close, 9);
  assert.deepEqual(restored.merge({ symbol: "QQQ", candles: [] }, "daily").candles, []);
});

test("partial quote observations stay provisional, never overwrite a complete candle, and no absent minutes are generated", async () => {
  const archive = new MinuteArchive(storage(), { now: () => now });
  await archive.load();
  archive.observe("QQQ", { ...bar, provisional: true });
  archive.observe("QQQ", { ...bar, time: time + 120_000, provisional: true });
  const result = archive.merge({ symbol: "QQQ", candles: [] }, "minute1");
  assert.equal(result.candles.length, 2);
  assert.equal(result.candles[0].provisional, true);
  assert.equal(result.candles[0].volume, undefined);
  archive.observe("QQQ", bar);
  archive.observe("QQQ", { ...bar, close: 10, provisional: true });
  assert.equal(archive.merge({ symbol: "QQQ", candles: [] }, "minute1").candles[0].close, 11);
  const grouped = archive.merge({ symbol: "QQQ", candles: [] }, "minute5");
  assert.equal(grouped.candles.length, 1);
  assert.equal(grouped.candles[0].provisional, true);
  assert.equal(grouped.candles[0].volume, undefined);
});

test("invalid, future and expired observations are ignored; persistence is bounded and failures preserve memory", async () => {
  const vault = storage();
  const archive = new MinuteArchive(vault, { now: () => now, maxSymbols: 2, maxBars: 2 });
  await archive.load();
  archive.observe("QQQ", { ...bar, time: now + 60_000 });
  archive.observe("QQQ", { ...bar, time: now - 11 * 86400_000 });
  archive.observe("QQQ", { ...bar, volume: -1 });
  archive.observe("QQQ", { ...bar, volume: NaN });
  archive.observe("../../secret", bar);
  assert.equal(archive.merge({ symbol: "QQQ", candles: [] }, "minute1").candles.length, 0);
  for (let i = 0; i < 4; i++) archive.observe("QQQ", { ...bar, time: time + i * 60_000 });
  await archive.flush();
  assert.equal(archive.merge({ symbol: "QQQ", candles: [] }, "minute1").candles.length, 2);
  archive.observe("SPY", bar); archive.observe("SNDK", bar);
  assert.equal(archive.merge({ symbol: "QQQ", candles: [] }, "minute1").candles.length, 0);
  vault.set = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(archive.flush(), /disk/);
  assert.equal(archive.merge({ symbol: "SNDK", candles: [] }, "minute1").retainedCoverage?.persistence, "memory");
});

test("cross-midnight observations supplement intraday without discarding the successful REST window", async () => {
  const archive = new MinuteArchive(storage(), { now: () => now });
  await archive.load(); archive.observe("QQQ", bar);
  const priorPost = { ...bar, time: Date.parse("2026-09-09T23:00Z") };
  const merged = archive.merge({ symbol: "QQQ", candles: [priorPost] }, "intraday");
  assert.deepEqual(merged.candles.map(c => c.time), [priorPost.time, bar.time]);
  assert.equal(merged.candles[0].retained, undefined);
  assert.equal(merged.candles[1].retained, true);
});

test("intraday includes observations from the previous evening's overnight session", async () => {
  const friday = Date.parse("2026-10-16T12:00:00Z"); // Fri 08:00 New York
  const archive = new MinuteArchive(storage(), { now: () => friday });
  await archive.load();
  const candle = (iso: string, close: number) => ({ time: Date.parse(iso), open: close, high: close, low: close, close, volume: 1 });
  const evening = candle("2026-10-16T01:00:00Z", 1); // Thu 21:00, opens Friday's day
  const earlier = candle("2026-10-15T23:00:00Z", 2); // Thu 19:00, Thursday's postmarket
  archive.observe("QQQ", evening);
  archive.observe("QQQ", earlier);
  const rest = candle("2026-10-16T11:00:00Z", 3); // Fri 07:00
  const merged = archive.merge({ symbol: "QQQ", candles: [rest] }, "intraday");
  assert.deepEqual(merged.candles.map((c) => c.time), [evening.time, rest.time]);
});
