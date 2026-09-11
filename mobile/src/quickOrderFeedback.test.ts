import test from "node:test";
import assert from "node:assert/strict";
import { completeQuickOrder, type QuickOrderFeedback } from "./quickOrderFeedback.ts";
import type { Prepared } from "./types.ts";

const snapshot: Prepared = {
  id: "review", accountID: "account", accountDisplay: "fixture", isDemo: false,
  preparedAt: Date.now(), quote: { symbol: "SNDQ" }, availableShares: 10,
  draft: { symbol: "SNDQ", side: "BUY", kind: "LIMIT", quantity: 2, limitPrice: "10", duration: "DAY" },
};

test("quick submit retains accepted order ID when the subsequent read fails", async () => {
  const feedback: QuickOrderFeedback[] = [];
  let submits = 0, clears = 0, refreshes = 0;
  await completeQuickOrder({
    submit: async () => { submits++; return { snapshot, result: { orderID: "12345" } }; },
    onAccepted: () => { clears++; },
    refresh: async () => { refreshes++; throw new Error("network unavailable"); },
    onFeedback: (value) => feedback.push(value),
  });
  assert.deepEqual({ submits, clears, refreshes }, { submits: 1, clears: 1, refreshes: 1 });
  assert.deepEqual(feedback.map((value) => value.phase), ["pending", "accepted", "accepted"]);
  assert.match(feedback.at(-1)!.message, /订单已提交 #12345.*刷新失败.*勿重复提交/);
});

test("failed or unknown quick submission preserves form and shows error without refresh or retry", async () => {
  for (const message of ["订单核对已失效", "交易结果未知，请先核实"]) {
    const failure = new Error(message);
    const feedback: QuickOrderFeedback[] = [];
    let submits = 0, clears = 0, refreshes = 0;
    await assert.rejects(completeQuickOrder({
      submit: async () => { submits++; throw failure; },
      onAccepted: () => { clears++; },
      refresh: async () => { refreshes++; },
      onFeedback: (value) => feedback.push(value),
    }), (error) => error === failure);
    assert.deepEqual({ submits, clears, refreshes }, { submits: 1, clears: 0, refreshes: 0 });
    assert.deepEqual(feedback.map((value) => value.phase), ["pending", "error"]);
    assert.equal(feedback.at(-1)!.message, message);
  }
});

test("quick submit clears inputs before refreshing and reports submission rather than execution", async () => {
  const feedback: QuickOrderFeedback[] = [];
  let quantity = "2", budget = "20";
  await completeQuickOrder({
    submit: async () => ({ snapshot, result: { orderID: "67890" } }),
    onAccepted: () => { quantity = ""; budget = ""; },
    refresh: async () => {
      assert.equal(quantity, "");
      assert.equal(budget, "");
      assert.match(feedback.at(-1)!.message, /订单已提交 #67890/);
    },
    onFeedback: (value) => feedback.push(value),
  });
  assert.equal(feedback.at(-1)!.phase, "accepted");
  assert.match(feedback.at(-1)!.message, /请在订单页查看成交状态/);
  assert.doesNotMatch(feedback.at(-1)!.message, /已成交/);
});
