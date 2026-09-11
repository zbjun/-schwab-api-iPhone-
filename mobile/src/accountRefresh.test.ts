import assert from "node:assert/strict";
import test from "node:test";
import { createAccountReader } from "./accountRefresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("simultaneous account refreshes share one read and subsequent polls request fresh funds", async () => {
  const reader = createAccountReader<number>();
  const pending = deferred<number>();
  const generation = {};
  let calls = 0;
  const load = () => { calls++; return pending.promise; };
  const first = reader.read(generation, load);
  const duplicate = reader.read(generation, load);
  await settle();
  assert.equal(calls, 1);
  pending.resolve(50);
  assert.deepEqual(await Promise.all([first, duplicate]), [50, 50]);
  assert.equal(await reader.read(generation, async () => { calls++; return 70; }), 70);
  assert.equal(calls, 2);
});

test("post-trade refresh waits for a pre-trade read and never consumes its stale balance", async () => {
  const reader = createAccountReader<number>();
  const beforeTrade = deferred<number>();
  const afterTrade = deferred<number>();
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const load = async (pending: ReturnType<typeof deferred<number>>) => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    try { return await pending.promise; } finally { active--; }
  };
  const old = reader.read({}, () => load(beforeTrade));
  const generation = {}; // User operation invalidates the earlier snapshot.
  const fresh = reader.read(generation, () => load(afterTrade));
  const duplicate = reader.read(generation, () => load(afterTrade));
  await settle();
  assert.equal(calls, 1);
  beforeTrade.resolve(100);
  await settle();
  assert.equal(calls, 2);
  afterTrade.resolve(40);
  assert.equal(await old, 100);
  assert.deepEqual(await Promise.all([fresh, duplicate]), [40, 40]);
  assert.equal(maxActive, 1);
});

test("a failed old broker read does not prevent a newer broker from refreshing", async () => {
  const reader = createAccountReader<string>();
  const oldBroker = deferred<string>();
  const old = reader.read({}, () => oldBroker.promise);
  const oldFailure = assert.rejects(old, /offline/);
  const next = reader.read({}, async () => "new account");
  oldBroker.reject(new Error("offline"));
  await oldFailure;
  assert.equal(await next, "new account");
});
