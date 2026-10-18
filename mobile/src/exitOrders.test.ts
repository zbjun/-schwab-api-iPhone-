import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeOrders,
  encodeDraft,
  freezeDraft,
  maximumSell,
  TradingError,
  validateDraft,
  validateExitAgainstQuote,
} from "./orderRules.ts";
import type { Account, Draft, Quote } from "./types.ts";

const account: Account = {
  id: "1",
  displayNumber: "•••• 0001",
  accountType: "CASH",
  buyingPower: 100_000,
  positions: [{ symbol: "AAPL", assetType: "EQUITY", quantity: 40 }],
};
const quote: Quote = { symbol: "AAPL", bidPrice: 234.84, askPrice: 234.86, lastPrice: 234.85, assetMainType: "EQUITY" };
const exitDraft = (exit: Draft["exit"], extra: Partial<Draft> = {}): Draft => ({
  symbol: "AAPL", side: "SELL", kind: "EXIT", quantity: 10, duration: "GOOD_TILL_CANCEL", exit, ...extra,
});
const rejects = (draft: Draft, code: string) =>
  assert.throws(() => validateDraft(draft), (e: TradingError) => e.code === code);

test("an exit-only order becomes an OCO pair of sells sharing the same shares", () => {
  const body = JSON.parse(encodeDraft(exitDraft({
    takeProfit: "250", stopLoss: { mode: "PRICE", value: "220.5" }, duration: "GOOD_TILL_CANCEL",
  })));
  assert.equal(body.orderStrategyType, "OCO");
  assert.equal(body.childOrderStrategies.length, 2);
  const [take, stop] = body.childOrderStrategies;
  for (const leg of [take, stop]) {
    assert.equal(leg.orderStrategyType, "SINGLE");
    assert.equal(leg.session, "NORMAL");
    assert.equal(leg.duration, "GOOD_TILL_CANCEL");
    assert.deepEqual(leg.orderLegCollection, [
      { instruction: "SELL", quantity: 10, instrument: { symbol: "AAPL", assetType: "EQUITY" } },
    ]);
  }
  assert.equal(take.orderType, "LIMIT");
  assert.equal(take.price, "250");
  assert.equal(stop.orderType, "STOP");
  assert.equal(stop.stopPrice, "220.5");
});

test("a single exit leg is sent alone and trailing stops follow the bid", () => {
  const percent = JSON.parse(encodeDraft(exitDraft({
    stopLoss: { mode: "TRAIL_PERCENT", value: "5" }, duration: "DAY",
  }, { duration: "DAY" })));
  assert.equal(percent.orderStrategyType, "SINGLE");
  assert.equal(percent.orderType, "TRAILING_STOP");
  assert.equal(percent.stopPriceLinkBasis, "BID");
  assert.equal(percent.stopPriceLinkType, "PERCENT");
  assert.equal(percent.stopPriceOffset, 5);
  const value = JSON.parse(encodeDraft(exitDraft({
    takeProfit: "260", stopLoss: { mode: "TRAIL_VALUE", value: "2.50" }, duration: "GOOD_TILL_CANCEL",
  })));
  assert.equal(value.childOrderStrategies[1].stopPriceLinkType, "VALUE");
  assert.equal(value.childOrderStrategies[1].stopPriceOffset, 2.5);
});

test("a buy with exits becomes a trigger whose OCO starts after the entry fills", () => {
  const body = JSON.parse(encodeDraft({
    symbol: "AAPL", side: "BUY", kind: "LIMIT", quantity: 10, limitPrice: "230", duration: "DAY",
    exit: { takeProfit: "250", stopLoss: { mode: "PRICE", value: "220" }, duration: "GOOD_TILL_CANCEL" },
  }));
  assert.equal(body.orderStrategyType, "TRIGGER");
  assert.equal(body.orderType, "LIMIT");
  assert.equal(body.price, "230");
  assert.equal(body.orderLegCollection[0].instruction, "BUY");
  assert.equal(body.childOrderStrategies.length, 1);
  assert.equal(body.childOrderStrategies[0].orderStrategyType, "OCO");
  // Without exits the ordinary single order is unchanged.
  const plain = JSON.parse(encodeDraft({
    symbol: "AAPL", side: "BUY", kind: "LIMIT", quantity: 10, limitPrice: "230", duration: "DAY",
  }));
  assert.equal(plain.orderStrategyType, "SINGLE");
  assert.equal(plain.childOrderStrategies, undefined);
});

test("exit prices must be ordered and only ordinary entries may carry them", () => {
  const buy = (exit: Draft["exit"], extra: Partial<Draft> = {}): Draft => ({
    symbol: "AAPL", side: "BUY", kind: "LIMIT", quantity: 1, limitPrice: "230", duration: "DAY", exit, ...extra,
  });
  const gtc = "GOOD_TILL_CANCEL" as const;
  rejects(exitDraft({ takeProfit: "220", stopLoss: { mode: "PRICE", value: "220" }, duration: gtc }), "exitOrder");
  rejects(buy({ takeProfit: "229", duration: gtc }), "takeProfit");
  rejects(buy({ stopLoss: { mode: "PRICE", value: "230" }, duration: gtc }), "stopLoss");
  rejects(buy({ takeProfit: "250", duration: gtc }, { kind: "STOP", limitPrice: undefined, stopPrice: "231" }), "exitEntry");
  rejects(buy({ takeProfit: "250", duration: "DAY" }, { session: "SEAMLESS" }), "exitSession");
  rejects(exitDraft({ duration: gtc }), "exitMissing");
  rejects(exitDraft(undefined), "exitMissing");
  rejects(exitDraft({ takeProfit: "250", duration: gtc }, { side: "BUY" }), "exitSide");
  rejects(exitDraft({ takeProfit: "250", duration: "DAY" }), "exitDuration");
  rejects(exitDraft({ stopLoss: { mode: "TRAIL_PERCENT", value: "60" }, duration: gtc }), "stopLoss");
  rejects(exitDraft({ stopLoss: { mode: "TRAIL_PERCENT", value: "1.234" }, duration: gtc }), "stopLoss");
  rejects(exitDraft({ stopLoss: { mode: "TRAIL_VALUE", value: "0" }, duration: gtc }), "stopLoss");
  rejects(exitDraft({ takeProfit: "250", duration: gtc }, { limitPrice: "1" }), "unexpectedPrice");
  validateDraft(buy({ takeProfit: "250", stopLoss: { mode: "TRAIL_PERCENT", value: "3.5" }, duration: gtc }));
  validateDraft(buy({ takeProfit: "250", duration: gtc }, { kind: "MARKET", limitPrice: undefined }));
});

test("exits the current quote would trigger immediately are rejected", () => {
  const gtc = "GOOD_TILL_CANCEL" as const;
  assert.throws(() => validateExitAgainstQuote(exitDraft({ takeProfit: "234.80", duration: gtc }), quote),
    (e: TradingError) => e.code === "takeProfit");
  assert.throws(() => validateExitAgainstQuote(exitDraft({ stopLoss: { mode: "PRICE", value: "235" }, duration: gtc }), quote),
    (e: TradingError) => e.code === "stopLoss");
  validateExitAgainstQuote(exitDraft({ takeProfit: "240", stopLoss: { mode: "PRICE", value: "230" }, duration: gtc }), quote);
  // A market buy compares with the ask it will pay.
  assert.throws(() => validateExitAgainstQuote({
    symbol: "AAPL", side: "BUY", kind: "MARKET", quantity: 1, duration: "DAY",
    exit: { takeProfit: "234.85", duration: gtc },
  }, quote), (e: TradingError) => e.code === "takeProfit");
  assert.throws(() => validateExitAgainstQuote(exitDraft({ takeProfit: "240", duration: gtc }), { ...quote, bidPrice: undefined }),
    (e: TradingError) => e.code === "exitQuote");
});

test("reviews keep a deep-frozen copy of the exit plan", () => {
  const draft = exitDraft({ takeProfit: "250", stopLoss: { mode: "PRICE", value: "220" }, duration: "GOOD_TILL_CANCEL" });
  const copy = freezeDraft(draft);
  assert.ok(Object.isFrozen(copy) && Object.isFrozen(copy.exit) && Object.isFrozen(copy.exit!.stopLoss));
  draft.exit!.stopLoss!.value = "1";
  assert.equal(copy.exit!.stopLoss!.value, "220");
  assert.equal(freezeDraft({ ...draft, exit: undefined }).exit, undefined);
});

// Broker DTO fixtures for linked orders.
const leg = (orderId: number, extra: Record<string, unknown> = {}) => ({
  orderId, status: "WORKING", orderType: "LIMIT", session: "NORMAL", duration: "GOOD_TILL_CANCEL",
  orderStrategyType: "SINGLE", quantity: 10, filledQuantity: 0, remainingQuantity: 10, price: 250,
  cancelable: true, editable: false, enteredTime: "2026-10-16T14:00:00Z",
  orderLegCollection: [{ legId: 1, instruction: "SELL", quantity: 10, instrument: { symbol: "AAPL", assetType: "EQUITY" } }],
  ...extra,
});
const stopLeg = (orderId: number, extra: Record<string, unknown> = {}) =>
  leg(orderId, { orderType: "STOP", price: undefined, stopPrice: 220, ...extra });
const oco = (orderId: number | undefined, children: unknown[], extra: Record<string, unknown> = {}) => ({
  ...(orderId === undefined ? {} : { orderId }), status: "WORKING", orderStrategyType: "OCO",
  cancelable: true, enteredTime: "2026-10-16T14:00:00Z", childOrderStrategies: children, ...extra,
});
const trigger = (status: string, filledQuantity: number, children: unknown[]) => ({
  ...leg(50, { status, filledQuantity, remainingQuantity: 10 - filledQuantity, price: 230, duration: "DAY" }),
  orderStrategyType: "TRIGGER",
  orderLegCollection: [{ legId: 1, instruction: "BUY", quantity: 10, instrument: { symbol: "AAPL", assetType: "EQUITY" } }],
  childOrderStrategies: children,
});

test("linked orders decode as one group and repeated top-level legs are folded in", () => {
  const orders = decodeOrders([oco(9, [leg(10), stopLeg(11)]), leg(10), stopLeg(11)]);
  assert.equal(orders.length, 1);
  const [group] = orders;
  assert.equal(group.strategy, "OCO");
  assert.equal(group.symbol, "AAPL");
  assert.equal(group.side, "SELL");
  assert.deepEqual(group.children!.map((c) => [c.id, c.kind, c.stopPrice ?? c.limitPrice]), [["10", "LIMIT", 250], ["11", "STOP", 220]]);
  assert.equal(group.cancelable, true);
  // A wrapper without its own ID gets a synthetic one that can never be cancelled.
  const [unnamed] = decodeOrders([trigger("WORKING", 0, [oco(undefined, [leg(10), stopLeg(11)])])]);
  assert.equal(unnamed.children![0].id, "50-1");
  assert.equal(unnamed.children![0].cancelable, false);
});

test("trailing stop legs and child fills are decoded for display and export", () => {
  const fill = {
    activityType: "EXECUTION", executionType: "FILL", activityId: 77,
    executionLegs: [{ legId: 1, price: 250, quantity: 10, time: "2026-10-16T15:00:00Z" }],
  };
  const [group] = decodeOrders([oco(9, [
    leg(10, { status: "FILLED", filledQuantity: 10, remainingQuantity: 0, orderActivityCollection: [fill] }),
    leg(11, { orderType: "TRAILING_STOP", price: undefined, stopPriceLinkType: "PERCENT", stopPriceOffset: 5, status: "CANCELED" }),
  ], { status: "FILLED" })]);
  assert.deepEqual(group.children![1].trailing, { type: "PERCENT", offset: 5 });
  assert.equal(group.executions!.length, 1);
  assert.equal(group.executions![0].price, 250);
});

test("an open OCO reserves its shares once, not once per leg", () => {
  const orders = decodeOrders([oco(9, [leg(10), stopLeg(11)])]);
  assert.equal(maximumSell(account, "AAPL", orders, true, undefined, quote), 30);
  assert.equal(maximumSell(account, "MSFT", orders, true), 0);
  // Once one leg fills, nothing is reserved any more.
  const done = decodeOrders([oco(9, [
    leg(10, { status: "FILLED", filledQuantity: 10, remainingQuantity: 0 }),
    stopLeg(11, { status: "CANCELED" }),
  ], { status: "FILLED" })]);
  assert.equal(maximumSell(account, "AAPL", done, true, undefined, quote), 40);
});

test("bracket exits reserve shares only after the buy entry has filled", () => {
  const waiting = [oco(undefined, [leg(10, { status: "AWAITING_PARENT_ORDER" }), stopLeg(11, { status: "AWAITING_PARENT_ORDER" })])];
  assert.equal(maximumSell(account, "AAPL", decodeOrders([trigger("WORKING", 0, waiting)]), true, undefined, quote), 40);
  // A partial entry fill may activate exits for shares not yet reserved: sizing is withheld.
  assert.equal(maximumSell(account, "AAPL", decodeOrders([trigger("WORKING", 4, waiting)]), true, undefined, quote), undefined);
  const active = [oco(undefined, [leg(10), stopLeg(11)])];
  assert.equal(maximumSell(account, "AAPL", decodeOrders([trigger("FILLED", 10, active)]), true, undefined, quote), 30);
  // A cancelled entry must not leave live exits; if it does, sizing is withheld.
  const cancelledWaiting = [oco(undefined, [leg(10, { status: "CANCELED" }), stopLeg(11, { status: "CANCELED" })])];
  assert.equal(maximumSell(account, "AAPL", decodeOrders([trigger("CANCELED", 0, cancelledWaiting)]), true, undefined, quote), 40);
  assert.equal(maximumSell(account, "AAPL", decodeOrders([trigger("CANCELED", 0, active)]), true, undefined, quote), undefined);
});

test("unreadable or unfamiliar linked orders still block sell sizing", () => {
  const broken = oco(9, [{ status: "WORKING" }]);
  assert.equal(maximumSell(account, "AAPL", decodeOrders([broken]), true, undefined, quote), undefined);
  const sellEntry = { ...trigger("WORKING", 0, [oco(undefined, [leg(10), stopLeg(11)])]) };
  sellEntry.orderLegCollection = [{ legId: 1, instruction: "SELL", quantity: 10, instrument: { symbol: "AAPL", assetType: "EQUITY" } }];
  assert.equal(maximumSell(account, "AAPL", decodeOrders([sellEntry]), true, undefined, quote), undefined);
});
