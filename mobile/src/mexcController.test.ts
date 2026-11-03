import test from "node:test";
import assert from "node:assert/strict";
import { MexcController } from "./mexc/mexcController.ts";
import { MexcDemo, DEMO_UNKNOWN_VOL } from "./mexc/mexcDemo.ts";
import { lockUnconfirmed, orderEntryBlocked, orderStateLabel } from "./mexc/mexcView.ts";
import type { MexcApi, MexcStatus } from "./MexcClient.ts";
import type { MexcAccount, MexcPrepared } from "./mexcRules.ts";
import { TradingError } from "./orderRules.ts";

const T0 = 1_800_000_000_000;
const unknown = () => new TradingError("orderOutcomeUnknown", "结果未确认");
const later = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

type Override = (...args: never[]) => unknown;
/** A demo whose calls are counted and whose methods can be replaced per test. */
function wrap(demo: MexcDemo, over: Record<string, Override> = {}) {
  const calls: Record<string, number> = {};
  const api = new Proxy(demo, {
    get(target, key: string) {
      const original = (target as unknown as Record<string, unknown>)[key];
      if (typeof original !== "function") return original;
      return (...args: unknown[]) => {
        calls[key] = (calls[key] ?? 0) + 1;
        const replace = over[key] as ((...a: unknown[]) => unknown) | undefined;
        return replace ? replace(...args) : (original as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as MexcApi;
  return { api, calls };
}
const reviewOf = (demo: MexcDemo, vol = "5"): Promise<MexcPrepared> =>
  demo.review({ symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", kind: "LIMIT", vol, price: "1.00", leverage: 5 });
const ok = (status: Partial<MexcStatus> = {}): MexcStatus => ({ configured: true, authenticated: true, unresolvedOperation: false, ...status });

test("two simultaneous places send once, and a failed place is not sent again", async () => {
  const demo = new MexcDemo(() => T0);
  const gate = later<{ orderID: string }>();
  const { api, calls } = wrap(demo, { place: () => gate.promise });
  const c = new MexcController(api);
  const prepared = await reviewOf(demo);
  const first = c.place(prepared), second = c.place(prepared);
  assert.ok((await second).error);
  assert.equal(c.getSnapshot().sending, true);
  gate.reject(new TradingError("serverUnavailable", "服务器没有响应"));
  assert.equal((await first).error, "服务器没有响应");
  assert.equal(calls.place, 1);
  assert.equal(c.getSnapshot().sending, false);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(calls.place, 1, "nothing retries in the background");
});

test("two simultaneous cancels send once", async () => {
  const demo = new MexcDemo(() => T0);
  const gate = later<void>();
  const { api, calls } = wrap(demo, { cancelOrder: () => gate.promise });
  const c = new MexcController(api);
  const id = (await demo.openOrders())[0].id;
  const a = c.cancel(id), b = c.cancel(id);
  assert.equal(await b, false);
  gate.reject(new TradingError("serverUnavailable", "没有响应"));
  assert.equal(await a, false);
  assert.equal(calls.cancelOrder, 1);
  assert.equal(c.getSnapshot().message, "没有响应");
});

test("an unknown outcome locks; polling cannot unlock; only a successful acknowledge does", async () => {
  const demo = new MexcDemo(() => T0);
  let failAck = true;
  const { api } = wrap(demo, {
    place: () => Promise.reject(unknown()),
    status: () => Promise.resolve(ok()),
    acknowledgeReconciliation: () => (failAck ? Promise.reject(new TradingError("serverUnavailable", "无法连接")) : Promise.resolve()),
  });
  const c = new MexcController(api);
  await c.place(await reviewOf(demo));
  assert.equal(c.locked, true);
  await c.refresh(); // The server says "no unresolved operation", yet this session saw one.
  assert.equal(c.locked, true);
  assert.equal((await c.place(await reviewOf(demo))).error, "交易已锁定，不能下单。");
  await c.acknowledge();
  assert.equal(c.locked, true, "a failed acknowledge keeps the lock");
  failAck = false;
  await c.acknowledge();
  assert.equal(c.locked, false);
});

test("a successful acknowledge also clears the note about the unconfirmed order", async () => {
  const demo = new MexcDemo(() => T0);
  const { api } = wrap(demo, { place: () => Promise.reject(unknown()), acknowledgeReconciliation: () => Promise.resolve() });
  const c = new MexcController(api);
  await c.place(await reviewOf(demo));
  assert.equal(c.getSnapshot().message, "结果未确认");
  assert.equal(c.getSnapshot().sawUnknown, true);
  await c.acknowledge();
  assert.equal(c.getSnapshot().message, "");
  assert.equal(c.getSnapshot().sawUnknown, false);
  // A failed acknowledge keeps the lock and says why.
  const failing = new MexcController(wrap(demo, { acknowledgeReconciliation: () => Promise.reject(unknown()) }).api);
  await failing.acknowledge();
  assert.equal(failing.getSnapshot().sawUnknown, true);
  assert.equal(failing.getSnapshot().message, "结果未确认");
});

test("a lock and a closure still show when account() fails", async () => {
  const demo = new MexcDemo(() => T0);
  const status = ok({ unresolvedOperation: true, tradingBlocked: "keyMovesMoney" });
  const { api } = wrap(demo, { status: () => Promise.resolve(status), account: () => Promise.reject(new Error("读取失败")) });
  const c = new MexcController(api);
  await c.refresh();
  const s = c.getSnapshot();
  assert.equal(s.offline, true);
  assert.equal(c.locked, true);
  assert.equal(s.status?.tradingBlocked, "keyMovesMoney");
  assert.equal(s.account, undefined);
});

test("a stale response never overwrites a newer one", async () => {
  const demo = new MexcDemo(() => T0);
  const slow = later<MexcAccount>();
  let n = 0;
  const real = await demo.account();
  const { api } = wrap(demo, { account: () => (++n === 1 ? slow.promise : Promise.resolve({ ...real, id: "newer" })) });
  const c = new MexcController(api);
  const older = c.refresh();
  await new Promise(r => setTimeout(r, 0)); // Let the first read reach account().
  const newer = c.refreshAfter(); // Supersedes the first.
  await newer;
  assert.equal(c.getSnapshot().account?.id, "newer");
  slow.resolve({ ...real, id: "older" });
  await older;
  assert.equal(c.getSnapshot().account?.id, "newer");
});

test("a refresh after a write reads the state after the write", async () => {
  const demo = new MexcDemo(() => T0);
  const c = new MexcController(demo);
  await c.refresh();
  assert.equal(c.getSnapshot().openOrders.length, 1);
  const prepared = await demo.review({ symbol: "BTC_USDT", action: "OPEN_LONG", kind: "LIMIT", vol: "1", price: "50000.0", leverage: 5 });
  const { orderID } = await c.place(prepared);
  assert.ok(orderID);
  await c.refreshAfter();
  assert.equal(c.getSnapshot().openOrders.length, 2);
  assert.equal(await c.cancel(orderID), true);
  await c.refreshAfter();
  assert.equal(c.getSnapshot().openOrders.length, 1);
});

test("while the server is writing, writes are disabled but no unconfirmed banner shows", async () => {
  const demo = new MexcDemo(() => T0);
  const status = ok({ unresolvedOperation: true, writeInProgress: true });
  const { api, calls } = wrap(demo, { status: () => Promise.resolve(status) });
  const c = new MexcController(api);
  await c.refresh();
  const s = c.getSnapshot();
  assert.equal(c.locked, true);
  assert.equal(lockUnconfirmed(s.status, s.sawUnknown, s.sending), false);
  assert.equal((await c.place(await reviewOf(demo))).orderID, undefined);
  assert.equal(await c.cancel("8000000000001"), false);
  assert.equal(calls.place ?? 0, 0);
  assert.equal(calls.cancelOrder ?? 0, 0);
  assert.equal(lockUnconfirmed({ unresolvedOperation: true }, false, false), true);
});

test("forgetting what was shown does not hide a lock the device still holds", async () => {
  const demo = new MexcDemo(() => T0);
  const { api } = wrap(demo, { status: () => Promise.resolve(ok({ unresolvedOperation: true })) });
  const c = new MexcController(api);
  c.reset();
  assert.equal(c.locked, false); // Nothing is known yet...
  await c.refresh();
  assert.equal(c.locked, true); // ...and the first read brings it back.
  const writing = new MexcController(wrap(demo, { status: () => Promise.resolve(ok({ writeInProgress: true })) }).api);
  await writing.refresh();
  assert.equal(writing.locked, true);
});

test("the demo's unknown outcome locks, and reset forgets what was shown", async () => {
  const demo = new MexcDemo(() => T0);
  const c = new MexcController(demo);
  await c.refresh();
  assert.ok(c.getSnapshot().account);
  const result = await c.place(await reviewOf(demo, DEMO_UNKNOWN_VOL));
  assert.ok(result.error);
  assert.equal(c.locked, true);
  c.reset();
  const s = c.getSnapshot();
  assert.equal(s.account, undefined);
  assert.equal(s.openOrders.length, 0);
});

test("an empty contract list is read again; a repeated poll error shows once", async () => {
  const demo = new MexcDemo(() => T0);
  let n = 0;
  const { api, calls } = wrap(demo, { contracts: () => Promise.resolve(++n === 1 ? [] : [{ symbol: "BTC_USDT" }]) });
  const c = new MexcController(api);
  await c.refresh(); await c.refresh();
  assert.equal(calls.contracts, 2);
  await c.refresh();
  assert.equal(calls.contracts, 2, "not read again once it has contracts");
  c.pollError("t", new Error("断线")); c.setMessage(""); c.pollError("t", new Error("断线"));
  assert.equal(c.getSnapshot().message, "", "dismissed, not shown again");
  c.pollOk("t"); c.pollError("t", new Error("断线"));
  assert.equal(c.getSnapshot().message, "断线");
});

test("only a failed key check lets a closing order through", () => {
  assert.equal(orderEntryBlocked(undefined, "OPEN_LONG"), false);
  assert.equal(orderEntryBlocked("keyCheckFailed", "CLOSE_LONG"), false);
  assert.equal(orderEntryBlocked("keyCheckFailed", "CLOSE_SHORT"), false);
  assert.equal(orderEntryBlocked("keyCheckFailed", "OPEN_SHORT"), true);
  assert.equal(orderEntryBlocked("keyMovesMoney", "CLOSE_LONG"), true);
  assert.equal(orderEntryBlocked("somethingNew", "OPEN_LONG"), true);
});

test("a partly filled resting order is labelled as such", () => {
  assert.equal(orderStateLabel({ state: 2, dealVol: 3 }), "部分成交");
  assert.equal(orderStateLabel({ state: 2, dealVol: 0 }), "未成交");
  assert.equal(orderStateLabel({ state: 3, dealVol: 3 }), "已成交");
});

const leverageReviewOf = (demo: MexcDemo, leverage = 3) =>
  demo.reviewLeverage({ kind: "LEVERAGE", symbol: "QQQSTOCK_USDT", positionId: "9000000000001", leverage });

test("a leverage change is sent once, refreshes, and a second press does nothing", async () => {
  const demo = new MexcDemo(() => T0);
  const gate = later<{ leverage: number }>();
  const { api, calls } = wrap(demo, { changeLeverage: () => gate.promise });
  const c = new MexcController(api);
  const prepared = await leverageReviewOf(demo);
  const first = c.changeLeverage(prepared), second = c.changeLeverage(prepared);
  assert.ok((await second).error);
  assert.equal(c.getSnapshot().sending, true);
  gate.resolve({ leverage: 3 });
  assert.deepEqual(await first, { leverage: 3 });
  assert.equal(calls.changeLeverage, 1);
  assert.equal(c.getSnapshot().sending, false);
  assert.match(c.getSnapshot().message, /3x/);
});

test("an unknown leverage change locks like an order, and nothing retries it", async () => {
  const demo = new MexcDemo(() => T0);
  const { api, calls } = wrap(demo, { changeLeverage: () => Promise.reject(unknown()) });
  const c = new MexcController(api);
  const result = await c.changeLeverage(await leverageReviewOf(demo));
  assert.ok(result.error);
  assert.equal(result.leverage, undefined);
  assert.equal(result.unknown, true);
  assert.equal(c.locked, true);
  assert.ok((await c.changeLeverage(await leverageReviewOf(demo))).error);
  assert.ok((await c.place(await reviewOf(demo))).error);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(calls.changeLeverage, 1);
  assert.equal(calls.place ?? 0, 0);
});

test("any closure of order entry stops a leverage change, even one that would let a close through", async () => {
  const demo = new MexcDemo(() => T0);
  const { api, calls } = wrap(demo, { status: async () => ok({ tradingBlocked: "keyCheckFailed" }) });
  const c = new MexcController(api);
  await c.refresh();
  assert.ok((await c.changeLeverage(await leverageReviewOf(demo))).error);
  assert.equal(calls.changeLeverage ?? 0, 0);
});

test("the demo changes leverage through the same one-use review", async () => {
  const demo = new MexcDemo(() => T0);
  const prepared = await leverageReviewOf(demo);
  assert.equal(prepared.previousLeverage, 5);
  assert.equal(prepared.direction, "LONG");
  assert.deepEqual(await demo.changeLeverage(prepared), { leverage: 3 });
  assert.equal((await demo.account()).positions[0].leverage, 3);
  await assert.rejects(demo.changeLeverage(prepared), (error: { code?: string }) => error.code === "reviewExpired");
  await assert.rejects(leverageReviewOf(demo, 3), (error: { code?: string }) => error.code === "leverageUnchanged");
  await assert.rejects(leverageReviewOf(demo, 11), (error: { code?: string }) => error.code === "leverageLimit");
  // A newer review of either kind replaces the older one.
  const older = await leverageReviewOf(demo, 4);
  await demo.review({ symbol: "QQQSTOCK_USDT", action: "OPEN_SHORT", kind: "LIMIT", vol: "1", price: "900.00", leverage: 5 });
  await assert.rejects(demo.changeLeverage(older), (error: { code?: string }) => error.code === "reviewExpired");
});

test("the demo refuses a leverage change the way MEXC documents", async () => {
  const demo = new MexcDemo(() => T0);
  // Lowering costs margin: 20 x 0.01 x 690 at 1x is 138, more than the account can add once a resting order holds it.
  const open = await demo.review({ symbol: "QQQSTOCK_USDT", action: "OPEN_SHORT", kind: "LIMIT", vol: "10", price: "900.00", leverage: 5 });
  await demo.place(open);
  await assert.rejects(demo.changeLeverage(await leverageReviewOf(demo)), (error: { code?: string }) => error.code === "leverageOrdersOpen");
  assert.equal((await demo.account()).positions[0].leverage, 5);
});

test("a position of the marked size simulates an unknown leverage change", async () => {
  const demo = new MexcDemo(() => T0);
  await demo.place(await demo.review({ symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", kind: "MARKET", vol: "57", leverage: 5 }));
  const c = new MexcController(demo);
  assert.equal((await demo.account()).positions[0].holdVol, 77);
  const result = await c.changeLeverage(await leverageReviewOf(demo));
  assert.ok(result.error);
  assert.equal(c.locked, true);
  assert.equal((await demo.status()).unresolvedOperation, true);
  assert.equal((await demo.account()).positions[0].leverage, 5);
});

test("only a write whose outcome is unknown says so", async () => {
  const demo = new MexcDemo(() => T0);
  const refused = wrap(demo, { place: () => Promise.reject(new TradingError("insufficientFunds", "可用保证金不足。")), changeLeverage: () => Promise.reject(new TradingError("leverageMargin", "可用保证金不够。")) });
  const c = new MexcController(refused.api);
  assert.equal((await c.place(await reviewOf(demo))).unknown, undefined);
  assert.equal((await c.changeLeverage(await leverageReviewOf(demo))).unknown, undefined);
  assert.equal(c.locked, false);
  const lost = wrap(demo, { place: () => Promise.reject(unknown()) });
  assert.equal((await new MexcController(lost.api).place(await reviewOf(demo))).unknown, true);
});
