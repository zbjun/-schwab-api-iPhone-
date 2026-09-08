import test from "node:test";
import assert from "node:assert/strict";
import { parsePersonalConfiguration, seedPersonalConfiguration } from "./personalConfiguration.ts";
import type { SessionStatus } from "./types.ts";

const raw = JSON.stringify({ version: 1, clientID: " fixture_client ", clientSecret: " fixture_secret " });
function fixture(configured = false) {
  const store = new Map<string, string>();
  const state = { configured, calls: 0, reads: 0, fail: false };
  const broker = {
    status: async (): Promise<SessionStatus> => ({ configured: state.configured, authenticated: state.configured, unresolvedOperation: false }),
    configure: async (id: string, secret: string) => {
      state.calls++;
      if (state.fail) throw new Error("fixture storage failure");
      assert.equal(id, "fixture_client");
      assert.equal(secret, "fixture_secret");
      state.configured = true;
    },
  };
  const vault = { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: string) => { store.set(key, value); } };
  const read = async () => { state.reads++; return raw; };
  return { state, store, broker, vault, read };
}

test("bundled config seeds once and never reapplies after explicit reset", async () => {
  const f = fixture();
  assert.equal(await seedPersonalConfiguration(f.broker, f.vault, f.read), true);
  assert.equal(f.state.calls, 1);
  assert.equal(await seedPersonalConfiguration(f.broker, f.vault, f.read), true);
  f.state.configured = false;
  assert.equal(await seedPersonalConfiguration(f.broker, f.vault, f.read), false);
  assert.equal(f.state.calls, 1);
  assert.equal(f.state.reads, 1);
});

test("existing credentials and authorization take priority over bundle, including later reset", async () => {
  const f = fixture(true);
  assert.equal(await seedPersonalConfiguration(f.broker, f.vault, f.read), true);
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.reads, 0);
  f.state.configured = false;
  assert.equal(await seedPersonalConfiguration(f.broker, f.vault, f.read), false);
  assert.equal(f.state.calls, 0);
});

test("public builds stay unconfigured; failed persistence can retry", async () => {
  const f = fixture();
  assert.equal(await seedPersonalConfiguration(f.broker, f.vault, async () => undefined), false);
  assert.equal(f.store.size, 0);
  f.state.fail = true;
  await assert.rejects(seedPersonalConfiguration(f.broker, f.vault, f.read));
  assert.equal(f.store.size, 0);
  f.state.fail = false;
  assert.equal(await seedPersonalConfiguration(f.broker, f.vault, f.read), true);
});

test("personal config parsing bounds and validates credentials without leaking input", () => {
  assert.deepEqual(parsePersonalConfiguration(raw), { clientID: "fixture_client", clientSecret: "fixture_secret" });
  for (const value of ["not-json-fixture_secret", "null", "[]", " ".repeat(16385),
    JSON.stringify({ version: 2, clientID: "client", clientSecret: "fixture_secret" }),
    JSON.stringify({ version: 1, clientID: "bad:id", clientSecret: "fixture_secret" }),
    JSON.stringify({ version: 1, clientID: "id", clientSecret: "bad secret" }),
    JSON.stringify({ version: 1, clientID: "id", clientSecret: "x".repeat(513) }),
  ]) {
    assert.throws(() => parsePersonalConfiguration(value), (error: Error) => {
      assert.equal(error.message.includes("fixture_secret"), false);
      return true;
    });
  }
});
