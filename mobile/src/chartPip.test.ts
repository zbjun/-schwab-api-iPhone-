import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { MexcClient } from "./MexcClient.ts";
import type { Vault } from "./types.ts";

const KEY = "a".repeat(64), ORIGIN = "https://fixture.example.test", STORED = "mexc.ths.server.connection.v1";
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const session = source("../modules/ths-chart-pip/ios/PipSession.swift");

test("the floating chart's price tag fits its text and leaves the rest to the chart", () => {
  assert.doesNotMatch(session, /width - 16 - 150/);
  assert.match(session, /let plot = CGRect\(x: 16, y: 134, width: width - 16 - \(longest \+ 24\)/);
  for (const measured of [/textWidth\(priceText\(\$0\), size: 22\)/, /textWidth\(priceText\(price\), size: 24, weight: \.bold\)/, /textWidth\(left, size: 24\)/])
    assert.match(session, measured);
});
const nativeModule = source("../modules/ths-chart-pip/ios/ThsChartPipModule.swift");

test("the floating chart's connection is absent until set, and a tampered one is refused without showing the key", async () => {
  const data = new Map<string, string>();
  const store: Vault = {
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async remove(key) { data.delete(key); },
  };
  const client = new MexcClient(store, { fetch: async () => { throw new Error("no request expected"); } });
  assert.equal(await client.liveConnection(), null);
  await client.configureServer(ORIGIN, KEY);
  assert.deepEqual(await client.liveConnection(), { origin: ORIGIN, deviceKey: KEY });
  for (const tampered of [
    { origin: "http://fixture.example.test", deviceKey: KEY },
    { origin: `${ORIGIN}/elsewhere`, deviceKey: KEY },
    { origin: ORIGIN, deviceKey: "short" },
  ]) {
    data.set(STORED, JSON.stringify(tampered));
    await assert.rejects(client.liveConnection(), (error: Error & { code?: string }) => {
      assert.equal(error.code, "serverConfiguration");
      assert.ok(!error.message.includes(KEY));
      return true;
    });
  }
});

test("only the floating chart takes the device key out of the client", () => {
  const users = readdirSync(new URL(".", import.meta.url), { recursive: true, encoding: "utf8" })
    .map(name => name.replaceAll("\\", "/"))
    .filter(name => /\.tsx?$/.test(name) && !name.includes(".test.") && source(name).includes("liveConnection"));
  assert.deepEqual(users.sort(), ["MexcClient.ts", "mexc/useChartPip.ts"]);
});

test("the floating chart's native code asks for market data and nothing else", () => {
  assert.equal(session.match(/\.dataTask\(/g)?.length, 1);
  assert.equal(session.match(/"method":/g)?.length, 1);
  assert.match(session, /"method": "live"/);
  assert.equal(session.match(/"\/rpc"/g)?.length, 1);
  assert.doesNotMatch(nativeModule, /URLRequest|URLSession|"method"/);
});

test("the floating chart's native code keeps the device key to one request header", () => {
  assert.equal(session.match(/config\.deviceKey/g)?.length, 2);
  assert.match(session, /gatewayEndpoint\(origin: config\.origin, deviceKey: config\.deviceKey\)/);
  assert.match(session, /"Bearer \\\(config\.deviceKey\)", forHTTPHeaderField: "Authorization"/);
  assert.match(session, /delegate: RefuseRedirects\(\)/);
  assert.match(session, /completionHandler\(nil\)/);
  for (const text of [session, nativeModule]) assert.doesNotMatch(text, /\bprint\(|NSLog|os_log|Logger\(|UserDefaults|FileManager|SecItem/);
});

test("a floating chart does not take the app's possibly old candles, and an old price is judged by time", () => {
  assert.match(session, /if !floating \{\s+let incoming = PipSession\.bars\(from: candles\)/);
  assert.match(session, /let stale = floating && \(keyRefused \|\| now - repliedAt > unansweredAfter \|\| now - movedAt > stalledAfter\)/);
  assert.match(session, /lastPrice\.isFinite, lastPrice > 0/);
  assert.match(session, /timeoutIntervalForResource = 5/);
});
