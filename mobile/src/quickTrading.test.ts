import test from "node:test";
import assert from "node:assert/strict";
import { submitQuickOrder } from "./quickTrading.ts";
import type { Broker, Draft, Prepared } from "./types.ts";

const draft: Draft = {
  symbol: "AAPL", side: "BUY", kind: "LIMIT", quantity: 2,
  limitPrice: "100", duration: "DAY",
};
function fixture() {
  let prepares = 0;
  let submits = 0;
  let submitted: Prepared | undefined;
  const snapshot: Prepared = Object.freeze({
    id: "fixture-review", draft: Object.freeze({ ...draft }),
    accountID: "fixture-account", accountDisplay: "fixture", isDemo: true,
    quote: { symbol: "AAPL" }, availableShares: 10, preparedAt: Date.now(),
  });
  const broker: Pick<Broker, "prepare" | "submit"> = {
    async prepare(accountID, value) {
      prepares++;
      assert.equal(accountID, snapshot.accountID);
      assert.deepEqual(value, draft);
      assert.ok(Object.isFrozen(value));
      return snapshot;
    },
    async submit(value) {
      submits++;
      submitted = value;
      return { orderID: "fixture-order" };
    },
  };
  return {
    broker, snapshot,
    request: { broker, draft, accountID: snapshot.accountID, isDemo: true, isCurrent: () => true },
    counts: () => ({ prepares, submits }),
    submitted: () => submitted,
  };
}

test("quick order submits the exact broker-frozen snapshot once", async () => {
  const f = fixture();
  const result = await submitQuickOrder(f.request);
  assert.equal(result.snapshot, f.snapshot);
  assert.equal(f.submitted(), f.snapshot);
  assert.equal(result.result.orderID, "fixture-order");
  assert.deepEqual(f.counts(), { prepares: 1, submits: 1 });
});

test("failed broker preparation never submits or retries", async () => {
  const f = fixture();
  let attempts = 0;
  f.broker.prepare = async () => { attempts++; throw new Error("insufficient buying power"); };
  await assert.rejects(submitQuickOrder(f.request), /insufficient buying power/);
  assert.equal(attempts, 1);
  assert.equal(f.counts().submits, 0);
});

test("context change while prepare is pending prevents submission", async () => {
  const f = fixture();
  let current = true;
  let finish!: (value: Prepared) => void;
  f.broker.prepare = () => new Promise((resolve) => { finish = resolve; });
  const pending = submitQuickOrder({ ...f.request, isCurrent: () => current });
  current = false;
  finish(f.snapshot);
  await assert.rejects(pending, /已变化/);
  assert.equal(f.counts().submits, 0);
});

test("invalid initial context prevents even preparing", async () => {
  const f = fixture();
  await assert.rejects(submitQuickOrder({ ...f.request, isCurrent: () => false }), /已变化/);
  assert.deepEqual(f.counts(), { prepares: 0, submits: 0 });
});

test("wrong account or demo identity and expired review cannot submit", async () => {
  for (const changes of [
    { accountID: "other-account" }, { isDemo: false },
    { preparedAt: Date.now() - 61_000 }, { preparedAt: Number.NaN },
  ]) {
    const f = fixture();
    f.broker.prepare = async () => ({ ...f.snapshot, ...changes });
    await assert.rejects(submitQuickOrder(f.request), /已变化|已失效/);
    assert.equal(f.counts().submits, 0);
  }
});

test("unknown submission outcome propagates without resubmitting", async () => {
  const f = fixture();
  let attempts = 0;
  f.broker.submit = async () => { attempts++; throw new Error("orderOutcomeUnknown"); };
  await assert.rejects(submitQuickOrder(f.request), /orderOutcomeUnknown/);
  assert.equal(attempts, 1);
  assert.equal(f.counts().prepares, 1);
});

test("live atomic broker uses one call and preserves receipt after context changes", async () => {
  const f = fixture();
  let current = true, calls = 0;
  const snapshot = { ...f.snapshot, isDemo: false };
  const broker = { ...f.broker, async submitQuick(accountID: string, value: Draft) {
    calls++;
    assert.equal(accountID, snapshot.accountID);
    assert.deepEqual(value, draft);
    assert.ok(Object.isFrozen(value));
    current = false;
    return { snapshot, result: { orderID: "atomic-order" } };
  } };
  const result = await submitQuickOrder({ ...f.request, broker, isDemo: false, isCurrent: () => current });
  assert.equal(result.result.orderID, "atomic-order");
  assert.equal(calls, 1);
  assert.deepEqual(f.counts(), { prepares: 0, submits: 0 });
});

test("atomic errors do not fall back to a second submission and demo keeps review path", async () => {
  const f = fixture();
  let atomicCalls = 0;
  const broker = { ...f.broker, async submitQuick(): Promise<never> { atomicCalls++; throw new Error("uncertain"); } };
  await assert.rejects(submitQuickOrder({ ...f.request, broker, isDemo: false }), /uncertain/);
  assert.deepEqual(f.counts(), { prepares: 0, submits: 0 });
  await submitQuickOrder({ ...f.request, broker });
  assert.equal(atomicCalls, 1);
  assert.deepEqual(f.counts(), { prepares: 1, submits: 1 });
});
