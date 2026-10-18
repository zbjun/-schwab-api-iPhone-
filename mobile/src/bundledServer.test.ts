import test from "node:test";
import assert from "node:assert/strict";
import { parseBundledServer, seedBundledServer } from "./bundledServer.ts";

const config = { version: 2, mode: "server", origin: "https://example.test", deviceKey: "a".repeat(43) };
function fixture() {
  const store = new Map<string, string>();
  let saved: { origin: string } | null = null, calls = 0, fail = false;
  return {
    vault: { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: string) => { store.set(key, value); } },
    broker: {
      configuration: async () => saved,
      configureServer: async (origin: string, key: string) => {
        if (fail) throw new Error("storage failure");
        assert.equal(key, config.deviceKey); saved = { origin }; calls++;
      },
    },
    read: async () => JSON.stringify(config),
    reset: () => { saved = null; },
    manual: () => { saved = { origin: "https://manual.test" }; },
    fail: (value: boolean) => { fail = value; },
    calls: () => calls,
  };
}
test("server package seeds locally once, never needs Schwab auth, and respects disconnect", async () => {
  const f = fixture();
  assert.equal(await seedBundledServer(f.broker, f.vault, f.read), true);
  assert.equal((await f.broker.configuration())?.origin, config.origin);
  assert.equal(await seedBundledServer(f.broker, f.vault, f.read), false);
  f.reset();
  assert.equal(await seedBundledServer(f.broker, f.vault, f.read), false);
  assert.equal(f.calls(), 1);
});
test("existing server identity survives package upgrade; failed writes can retry", async () => {
  const f = fixture(); f.manual();
  assert.equal(await seedBundledServer(f.broker, f.vault, f.read), true);
  assert.equal((await f.broker.configuration())?.origin, "https://manual.test");
  assert.equal(f.calls(), 0);
  const g = fixture(); g.fail(true);
  await assert.rejects(seedBundledServer(g.broker, g.vault, g.read));
  g.fail(false);
  assert.equal(await seedBundledServer(g.broker, g.vault, g.read), true);
});
test("public and legacy bundles do not activate server mode; private fields are rejected", async () => {
  const f = fixture();
  assert.equal(await seedBundledServer(f.broker, f.vault, async () => undefined), false);
  assert.equal(await seedBundledServer(f.broker, f.vault, async () => '{"version":1}'), false);
  for (const raw of ["bad", "x".repeat(16385), JSON.stringify({ ...config, accessToken: "secret" }),
    JSON.stringify({ ...config, origin: "http://example.test" }), JSON.stringify({ ...config, deviceKey: "short" })])
    assert.throws(() => parseBundledServer(raw));
});
test("failed mode persistence retries activation without replacing the stored device key", async () => {
  const f = fixture();
  await assert.rejects(seedBundledServer(f.broker, f.vault, f.read, async () => { throw new Error("mode write failed"); }));
  let activated = false;
  assert.equal(await seedBundledServer(f.broker, f.vault, f.read, async () => { activated = true; }), true);
  assert.equal(activated, true);
  assert.equal(f.calls(), 1);
});

test("explicit recovery restores a missing connection after the one-time import", async () => {
  const f = fixture();
  await seedBundledServer(f.broker, f.vault, f.read);
  f.reset();
  assert.equal(await seedBundledServer(f.broker, f.vault, f.read), false);
  assert.equal(await seedBundledServer(f.broker, f.vault, f.read, undefined, { restoreMissing: true }), true);
  assert.equal((await f.broker.configuration())?.origin, config.origin);
  assert.equal(f.calls(), 2);
});

test("explicit recovery preserves an existing identity and can retry a failed restore", async () => {
  const f = fixture();
  await seedBundledServer(f.broker, f.vault, f.read);
  f.manual();
  assert.equal(await seedBundledServer(f.broker, f.vault, f.read, undefined, { restoreMissing: true }), false);
  assert.equal((await f.broker.configuration())?.origin, "https://manual.test");
  f.reset(); f.fail(true);
  await assert.rejects(seedBundledServer(f.broker, f.vault, f.read, undefined, { restoreMissing: true }));
  f.fail(false);
  assert.equal(await seedBundledServer(f.broker, f.vault, f.read, undefined, { restoreMissing: true }), true);
});
