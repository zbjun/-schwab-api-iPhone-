import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_UNKNOWN_VOL, MexcDemo } from "./mexc/mexcDemo.ts";
import type { MexcDraft } from "./mexcRules.ts";

const T0 = 1_800_000_000_000;
const make = () => {
  const clock = { now: T0 };
  return { demo: new MexcDemo(() => clock.now), clock };
};
const open: MexcDraft = { symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", kind: "MARKET", vol: "5", leverage: 5 };
const code = (work: Promise<unknown>, expected: string) =>
  assert.rejects(work, (error: { code?: string }) => error.code === expected);

test("demo is marked as demo and exposes fictional contracts, an account and orders", async () => {
  const { demo } = make();
  assert.equal(demo.isDemo, true);
  const symbols = (await demo.contracts()).map(c => c.symbol);
  assert.ok(symbols.includes("QQQSTOCK_USDT") && symbols.includes("BTC_USDT"));
  const account = await demo.account();
  assert.equal(account.positions.length, 1);
  assert.ok(account.asset.equity > 0 && account.asset.availableBalance > 0);
  assert.equal((await demo.openOrders()).length, 1);
  assert.equal((await demo.status()).unresolvedOperation, false);
  const history = await demo.chart("BTC_USDT", "minute15");
  assert.equal(history.candles.length, 240);
  assert.ok(history.candles.every(c => c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)));
  assert.deepEqual(history, await demo.chart("BTC_USDT", "minute15"), "chart data is deterministic");
  assert.equal((await demo.tickers(["BTC_USDT", "NOPE_USDT"])).length, 1);
});

test("review uses the real order rules: leverage and notional limits", async () => {
  const { demo } = make();
  await code(demo.review({ ...open, leverage: 50 }), "leverageLimit"); // Server cap is 10x.
  await code(demo.review({ ...open, kind: "LIMIT", price: "700", vol: "2000" }), "notionalLimit");
  await code(demo.review({ ...open, kind: "LIMIT", price: "700.005" }), "priceTick");
  await code(demo.review({ ...open, action: "CLOSE_SHORT", leverage: undefined } as MexcDraft), "insufficientPosition");
  await code(demo.review({ ...open, leverage: 3 }), "leverageMismatch"); // Existing long is 5x.
  const prepared = await demo.review(open);
  assert.equal(prepared.isDemo, true);
  assert.equal(prepared.preparedAt, T0);
  assert.equal(prepared.leverage, 5);
  assert.ok(prepared.margin! > 0 && prepared.notional > 0);
});

test("a review can be confirmed once only", async () => {
  const { demo } = make();
  const prepared = await demo.review(open);
  const { orderID } = await demo.place(prepared);
  assert.match(orderID, /^\d+$/);
  await code(demo.place(prepared), "reviewExpired");
  const position = (await demo.account()).positions.find(p => p.symbol === "QQQSTOCK_USDT")!;
  assert.equal(position.holdVol, 25);
});

test("a newer review replaces the older one", async () => {
  const { demo } = make();
  const first = await demo.review(open);
  await demo.review({ ...open, vol: "6" });
  await code(demo.place(first), "reviewExpired");
});

test("a review expires after 60 seconds", async () => {
  const { demo, clock } = make();
  const prepared = await demo.review(open);
  clock.now = T0 + 60_001;
  await code(demo.place(prepared), "reviewExpired");
  const again = await demo.review(open);
  clock.now += 59_000;
  await demo.place(again); // Still inside the window.
});

test("an unconfirmed outcome locks trading until acknowledged, and applies nothing", async () => {
  const { demo } = make();
  const prepared = await demo.review({ ...open, vol: DEMO_UNKNOWN_VOL });
  await code(demo.place(prepared), "orderOutcomeUnknown");
  assert.equal((await demo.status()).unresolvedOperation, true);
  assert.equal((await demo.account()).positions[0].holdVol, 20, "the order was not applied");
  const next = await demo.review(open); // Reviewing stays possible; sending does not.
  await code(demo.place(next), "orderOutcomeUnknown");
  await code(demo.cancelOrder("8000000000001"), "orderOutcomeUnknown");
  await demo.acknowledgeReconciliation();
  assert.equal((await demo.status()).unresolvedOperation, false);
  await demo.place(await demo.review(open));
});

test("limit orders rest and can be cancelled; closing reserves contracts once", async () => {
  const { demo } = make();
  const ticker = (await demo.tickers(["QQQSTOCK_USDT"]))[0];
  const close = await demo.review({ symbol: "QQQSTOCK_USDT", action: "CLOSE_LONG", kind: "LIMIT", vol: "8", price: (ticker.ask1! + 20).toFixed(2) });
  assert.equal(close.closable, 20);
  const { orderID } = await demo.place(close);
  assert.equal((await demo.account()).positions[0].frozenVol, 8);
  // Only 12 contracts remain closable.
  await code(demo.review({ symbol: "QQQSTOCK_USDT", action: "CLOSE_LONG", kind: "MARKET", vol: "13" }), "insufficientPosition");
  assert.ok((await demo.openOrders()).some(o => o.id === orderID && o.cancelable));
  await demo.cancelOrder(orderID);
  assert.equal((await demo.account()).positions[0].frozenVol, 0);
  await code(demo.cancelOrder(orderID), "orderChanged");
});

test("closing at market reduces the position and closed orders are queryable by contract and window", async () => {
  const { demo } = make();
  const prepared = await demo.review({ symbol: "QQQSTOCK_USDT", action: "CLOSE_LONG", kind: "MARKET", vol: "20" });
  await demo.place(prepared);
  assert.equal((await demo.account()).positions.length, 0);
  const rows = await demo.closedOrders("QQQSTOCK_USDT", T0 - 7 * 86_400_000, T0);
  assert.ok(rows.length >= 3);
  assert.equal((await demo.closedOrders("BTC_USDT", T0 - 7 * 86_400_000, T0)).length, 0);
  await code(demo.closedOrders("bad", 0, 1), "invalidSymbol");
});

test("demo quotes are fresh and sit near the fair price, so a market order passes the shared checks", async () => {
  const { demo, clock } = make();
  for (const t of await demo.tickers(["BTC_USDT", "QQQSTOCK_USDT", "TSLASTOCK_USDT"])) {
    assert.equal(t.timestamp, clock.now);
    assert.ok(t.fairPrice && Math.abs(t.ask1! - t.fairPrice) / t.fairPrice < 0.01 && Math.abs(t.bid1! - t.fairPrice) / t.fairPrice < 0.01);
  }
  await demo.place(await demo.review({ symbol: "BTC_USDT", action: "OPEN_LONG", kind: "MARKET", vol: "1", leverage: 5 }));
});
