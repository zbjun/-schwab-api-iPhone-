import test from "node:test";
import assert from "node:assert/strict";
import { MexcController } from "./mexc/mexcController.ts";
import { MexcDemo, DEMO_UNKNOWN_VOL } from "./mexc/mexcDemo.ts";
import { lockUnconfirmed, orderEntryBlocked, orderStateLabel, parseQuickMode, tradingLocked } from "./mexc/mexcView.ts";
import { MexcClient } from "./MexcClient.ts";
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

test("a phone with no saved connection reads no account and shows no outage, until one is saved", async () => {
  const { api, calls } = wrap(new MexcDemo(() => T0));
  let saved: { origin: string } | null = null;
  const c = new MexcController(new Proxy(api, {
    get: (target, key) => (key === "configuration" ? async () => saved : Reflect.get(target, key)),
  }));
  await c.refresh();
  assert.equal(c.getSnapshot().configured, false);
  assert.equal(c.getSnapshot().offline, false);
  assert.equal(c.getSnapshot().message, "");
  assert.equal(calls.account, undefined);
  saved = { origin: "https://gateway.test" };
  await c.refresh();
  assert.equal(c.getSnapshot().configured, true);
  assert.equal(calls.account, 1);
  assert.ok(c.getSnapshot().account);
  assert.ok(c.getSnapshot().updatedAt);
});

const OPERATION = "mexc.ths.server.operation.v1", CONNECTION = "mexc.ths.server.connection.v1";
const fakeVault = (entries: Record<string, string>) => {
  const data = new Map(Object.entries(entries));
  return { get: async (key: string) => data.get(key) ?? null, set: async (key: string, value: string) => { data.set(key, value); }, remove: async (key: string) => { data.delete(key); } };
};
const offlineClient = (entries: Record<string, string>) =>
  new MexcClient(fakeVault(entries) as never, { fetch: (async () => { throw new Error("no network in this test"); }) as never });
const MARKER = JSON.stringify({ method: "submit", time: 1 });

test("an unknown outcome still locks and shows on a phone with no connection", async () => {
  const c = new MexcController(offlineClient({ [OPERATION]: MARKER }));
  await c.refresh();
  const { status, sawUnknown, sending, configured, offline } = c.getSnapshot();
  assert.equal(configured, false);
  assert.equal(offline, false);
  assert.equal(tradingLocked(status, sawUnknown), true);
  assert.equal(lockUnconfirmed(status, sawUnknown, sending), true);
});

test("an unknown outcome still locks and shows when the saved connection cannot be read", async () => {
  const c = new MexcController(offlineClient({ [OPERATION]: MARKER, [CONNECTION]: "{bad" }));
  await c.refresh();
  const { status, sawUnknown, sending } = c.getSnapshot();
  assert.equal(tradingLocked(status, sawUnknown), true);
  assert.equal(lockUnconfirmed(status, sawUnknown, sending), true);
});

test("forgetting the connection does not clear an unknown outcome", async () => {
  const client = offlineClient({ [OPERATION]: MARKER });
  const c = new MexcController(client);
  await c.refresh();
  await client.disconnect();
  c.reset();
  await c.refresh();
  const { status, sawUnknown, sending } = c.getSnapshot();
  assert.equal(tradingLocked(status, sawUnknown), true);
  assert.equal(lockUnconfirmed(status, sawUnknown, sending), true);
});

test("no connection and no unknown outcome is not a lock, an outage or a message", async () => {
  const c = new MexcController(offlineClient({}));
  await c.refresh();
  const { status, sawUnknown, sending, configured, offline, message } = c.getSnapshot();
  assert.equal(configured, false);
  assert.equal(offline, false);
  assert.equal(message, "");
  assert.equal(tradingLocked(status, sawUnknown), false);
  assert.equal(lockUnconfirmed(status, sawUnknown, sending), false);
});

test("the demo has no connection to save and counts as configured", async () => {
  const c = new MexcController(new MexcDemo(() => T0));
  await c.refresh();
  assert.equal(c.getSnapshot().configured, true);
});

const QUICK_DRAFT = { symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", kind: "LIMIT", vol: "5", price: "1.00", leverage: 5 } as const;
const current = () => true;

test("quick mode reviews and sends once, through the same send as a confirmed order", async () => {
  const { api, calls } = wrap(new MexcDemo());
  const c = new MexcController(api);
  const result = await c.quickPlace(QUICK_DRAFT, current);
  assert.ok(result.orderID);
  assert.equal(calls.review, 1);
  assert.equal(calls.place, 1);
  assert.equal(c.getSnapshot().sending, false);
});

test("two quick presses at once send one order", async () => {
  const { api, calls } = wrap(new MexcDemo());
  const c = new MexcController(api);
  const [first, second] = await Promise.all([c.quickPlace(QUICK_DRAFT, current), c.quickPlace(QUICK_DRAFT, current)]);
  assert.ok(first.orderID);
  assert.ok(second.error);
  assert.equal(calls.review, 1);
  assert.equal(calls.place, 1);
});

test("quick mode stays marked as sending from the first press, so the screen cannot be left", async () => {
  const gate = later<MexcPrepared>();
  const demo = new MexcDemo();
  const { api } = wrap(demo, { review: () => gate.promise });
  const c = new MexcController(api);
  const pending = c.quickPlace(QUICK_DRAFT, current);
  assert.equal(c.getSnapshot().sending, true);
  gate.resolve(await demo.review(QUICK_DRAFT));
  await pending;
  assert.equal(c.getSnapshot().sending, false);
});

test("quick mode sends nothing when locked or closed, and does not even ask for a review", async () => {
  const locked = wrap(new MexcDemo(), { status: () => Promise.resolve(ok({ unresolvedOperation: true })) });
  const a = new MexcController(locked.api);
  await a.refresh();
  assert.ok((await a.quickPlace(QUICK_DRAFT, current)).error);
  assert.equal(locked.calls.review, undefined);
  assert.equal(locked.calls.place, undefined);
  const closed = wrap(new MexcDemo(), { status: () => Promise.resolve(ok({ tradingBlocked: "keyHasWithdraw" })) });
  const b = new MexcController(closed.api);
  await b.refresh();
  assert.ok((await b.quickPlace(QUICK_DRAFT, current)).error);
  assert.equal(closed.calls.place, undefined);
});

test("a refused quick review sends nothing and is not tried again", async () => {
  const { api, calls } = wrap(new MexcDemo(), { review: () => Promise.reject(new TradingError("serverUnavailable", "服务器没有响应")) });
  const c = new MexcController(api);
  const result = await c.quickPlace(QUICK_DRAFT, current);
  assert.equal(result.error, "服务器没有响应");
  assert.equal(calls.review, 1);
  assert.equal(calls.place, undefined);
  assert.equal(c.getSnapshot().sending, false);
  assert.equal(c.getSnapshot().message, "服务器没有响应");
});

test("a form changed while the quick review was on its way sends nothing", async () => {
  const { api, calls } = wrap(new MexcDemo());
  const c = new MexcController(api);
  const result = await c.quickPlace(QUICK_DRAFT, () => false);
  assert.ok(result.error?.includes("没有发送"));
  assert.equal(calls.place, undefined);
  assert.equal(c.getSnapshot().sending, false);
});

test("a lock that arrives during the quick review sends nothing", async () => {
  const gate = later<MexcPrepared>();
  const demo = new MexcDemo();
  let status = ok();
  const { api, calls } = wrap(demo, { review: () => gate.promise, status: () => Promise.resolve(status) });
  const c = new MexcController(api);
  await c.refresh();
  const pending = c.quickPlace(QUICK_DRAFT, current);
  status = ok({ unresolvedOperation: true });
  await c.refresh();
  gate.resolve(await demo.review(QUICK_DRAFT));
  assert.ok((await pending).error?.includes("没有发送"));
  assert.equal(calls.place, undefined);
});

test("a quick review too old to use sends nothing", async () => {
  const demo = new MexcDemo();
  const old = { ...(await demo.review(QUICK_DRAFT)), preparedAt: Date.now() - 120_000 };
  const { api, calls } = wrap(demo, { review: () => Promise.resolve(old) });
  const c = new MexcController(api);
  assert.ok((await c.quickPlace(QUICK_DRAFT, current)).error?.includes("没有发送"));
  assert.equal(calls.place, undefined);
});

test("an unknown outcome from a quick send locks trading and is not sent again", async () => {
  const { api, calls } = wrap(new MexcDemo(), { place: () => Promise.reject(unknown()) });
  const c = new MexcController(api);
  const result = await c.quickPlace(QUICK_DRAFT, current);
  assert.equal(result.unknown, true);
  assert.equal(calls.place, 1);
  assert.equal(c.getSnapshot().sawUnknown, true);
  assert.ok((await c.quickPlace(QUICK_DRAFT, current)).error);
  assert.equal(calls.place, 1);
  assert.equal(calls.review, 1);
});

test("an unknown outcome from the quick review locks trading and sends nothing", async () => {
  const { api, calls } = wrap(new MexcDemo(), { review: () => Promise.reject(unknown()) });
  const c = new MexcController(api);
  const result = await c.quickPlace(QUICK_DRAFT, current);
  assert.equal(result.unknown, true);
  assert.equal(calls.place, undefined);
  assert.equal(c.getSnapshot().sawUnknown, true);
  assert.equal(c.getSnapshot().sending, false);
});

test("order entry closing during the quick review sends nothing", async () => {
  const gate = later<MexcPrepared>();
  const demo = new MexcDemo();
  let status = ok();
  const { api, calls } = wrap(demo, { review: () => gate.promise, status: () => Promise.resolve(status) });
  const c = new MexcController(api);
  await c.refresh();
  const pending = c.quickPlace(QUICK_DRAFT, current);
  status = ok({ tradingBlocked: "keyHasWithdraw" });
  await c.refresh();
  gate.resolve(await demo.review(QUICK_DRAFT));
  assert.ok((await pending).error?.includes("没有发送"));
  assert.equal(calls.place, undefined);
});

test("a form that changes only while the quick review is away sends nothing", async () => {
  const gate = later<MexcPrepared>();
  const demo = new MexcDemo();
  const { api, calls } = wrap(demo, { review: () => gate.promise });
  const c = new MexcController(api);
  let same = true;
  const pending = c.quickPlace(QUICK_DRAFT, () => same);
  same = false;
  gate.resolve(await demo.review(QUICK_DRAFT));
  assert.ok((await pending).error?.includes("没有发送"));
  assert.equal(calls.place, undefined);
});

test("a failed key check still lets quick mode close and stops it opening", async () => {
  const demo = new MexcDemo();
  const closing = { symbol: "QQQSTOCK_USDT", action: "CLOSE_LONG", kind: "LIMIT", vol: "1", price: "700.00" } as const;
  const { api, calls } = wrap(demo, { status: () => Promise.resolve(ok({ tradingBlocked: "keyCheckFailed" })) });
  const c = new MexcController(api);
  await c.refresh();
  assert.ok((await c.quickPlace(QUICK_DRAFT, current)).error);
  assert.equal(calls.review, undefined);
  assert.ok((await c.quickPlace(closing, current)).orderID);
  assert.equal(calls.place, 1);
});

test("a second press after an accepted cancel is not a second write, until the wait is over", async (t) => {
  const demo = new MexcDemo();
  const open = await demo.openOrders();
  // The list keeps showing the order, as it does for a moment after a cancel and for good if it never catches up.
  const { api, calls } = wrap(demo, { openOrders: () => Promise.resolve(open), cancelOrder: () => Promise.resolve() });
  const c = new MexcController(api);
  await c.refresh();
  const id = open[0].id;
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  assert.equal(await c.cancel(id), true);
  await c.refresh();
  assert.equal(c.cancelSent(id), true);
  assert.equal(await c.cancel(id), false);
  assert.equal(calls.cancelOrder, 1);
  t.mock.timers.tick(10_001);
  assert.equal(c.cancelSent(id), false);
  assert.equal(await c.cancel(id), true);
  assert.equal(calls.cancelOrder, 2);
});

test("the list catching up ends the wait after a cancel at once", async () => {
  const demo = new MexcDemo();
  const open = await demo.openOrders();
  let shown = open;
  const { api } = wrap(demo, { openOrders: () => Promise.resolve(shown), cancelOrder: () => Promise.resolve() });
  const c = new MexcController(api);
  await c.refresh();
  const id = open[0].id;
  assert.equal(await c.cancel(id), true);
  await c.refresh();
  assert.equal(c.cancelSent(id), true);
  shown = [];
  await c.refresh();
  assert.equal(c.cancelSent(id), false);
});

test("a cancel that failed can be pressed again", async () => {
  let attempts = 0;
  const { api, calls } = wrap(new MexcDemo(), {
    cancelOrder: () => (++attempts === 1 ? Promise.reject(new TradingError("serverUnavailable", "服务器没有响应")) : Promise.resolve()),
  });
  const c = new MexcController(api);
  await c.refresh();
  const id = c.getSnapshot().openOrders[0].id;
  assert.equal(await c.cancel(id), false);
  assert.equal(c.cancelSent(id), false);
  assert.equal(await c.cancel(id), true);
  assert.equal(calls.cancelOrder, 2);
});

const CONNECTED = JSON.stringify({ origin: "https://gateway.test", deviceKey: "k".repeat(43) });
/** The real client over a fake gateway: what the phone writes down and when, for quick mode as for a confirmed order. */
function gatewayClient(submit: () => Response | Promise<Response>) {
  const vault = fakeVault({ [CONNECTION]: CONNECTED });
  const seen: { method: string; marked: boolean }[] = [];
  const reply = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
  const fetch = async (_: string, init: { body?: string }) => {
    const { method, args } = JSON.parse(init.body ?? "{}");
    seen.push({ method, marked: !!(await vault.get(OPERATION)) });
    if (method === "prepare") {
      const draft = args[1];
      return reply({ id: "review-1", isDemo: false, draft, orderPrice: draft.price, notional: 7, leverage: draft.leverage, openType: 1, preparedAt: 1 });
    }
    if (method === "submit") return submit();
    if (method === "status") return reply({ configured: true, authenticated: true, unresolvedOperation: false });
    return new Response(JSON.stringify({ error: { code: "serverUnavailable" } }), { status: 200 });
  };
  return { client: new MexcClient(vault as never, { fetch: fetch as never }), vault, seen };
}

test("over the real client, quick mode marks the phone only around the send and clears it after", async () => {
  const { client, vault, seen } = gatewayClient(() => new Response(JSON.stringify({ result: { orderID: "8000000000001" } }), { status: 200 }));
  const c = new MexcController(client);
  const result = await c.quickPlace(QUICK_DRAFT, current);
  assert.equal(result.orderID, "8000000000001");
  assert.deepEqual(seen.filter(row => row.method === "prepare" || row.method === "submit"), [
    { method: "prepare", marked: false },
    { method: "submit", marked: true },
  ]);
  assert.equal(await vault.get(OPERATION), null);
});

test("over the real client, a lost reply to a quick send keeps the mark, locks trading and is not sent again", async () => {
  const { client, vault, seen } = gatewayClient(() => { throw new Error("connection lost"); });
  const c = new MexcController(client);
  const result = await c.quickPlace(QUICK_DRAFT, current);
  assert.equal(result.unknown, true);
  assert.ok(await vault.get(OPERATION));
  assert.equal(seen.filter(row => row.method === "submit").length, 1);
  assert.equal(c.getSnapshot().sawUnknown, true);
  assert.ok((await c.quickPlace(QUICK_DRAFT, current)).error);
  assert.equal(seen.filter(row => row.method === "submit").length, 1);
  assert.equal(seen.filter(row => row.method === "prepare").length, 1);
});

test("quick mode is off unless it was plainly turned on", () => {
  assert.equal(parseQuickMode("true"), true);
  for (const raw of ["false", "1", "TRUE", "", null, undefined]) assert.equal(parseQuickMode(raw), false);
});

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

const stopDraft = { kind: "STOP_PLACE" as const, symbol: "QQQSTOCK_USDT", positionId: "9000000000001", takeProfitPrice: "900.00", stopLossPrice: "500.00" };

test("a stop request is sent once, and an unknown outcome locks everything", async () => {
  const demo = new MexcDemo(() => T0);
  const gate = later<{ stopKind: "STOP_PLACE" }>();
  const { api, calls } = wrap(demo, { changeStop: () => gate.promise });
  const c = new MexcController(api);
  const prepared = await demo.reviewStop(stopDraft);
  const first = c.changeStop(prepared), second = c.changeStop(prepared);
  assert.ok((await second).error);
  gate.resolve({ stopKind: "STOP_PLACE" });
  assert.deepEqual(await first, { done: true });
  assert.equal(calls.changeStop, 1);

  const lost = wrap(demo, { changeStop: () => Promise.reject(unknown()) });
  const locked = new MexcController(lost.api);
  const result = await locked.changeStop(await demo.reviewStop(stopDraft));
  assert.equal(result.unknown, true);
  assert.equal(locked.locked, true);
  assert.ok((await locked.changeStop(await demo.reviewStop(stopDraft))).error);
  assert.ok((await locked.place(await reviewOf(demo))).error);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(lost.calls.changeStop, 1);
});

test("a failed key lookup lets stops through as it does a close, and a closed key stops them but not a cancel", async () => {
  const demo = new MexcDemo(() => T0);
  const failed = wrap(demo, { status: async () => ok({ tradingBlocked: "keyCheckFailed" }) });
  const lookup = new MexcController(failed.api);
  await lookup.refresh();
  assert.deepEqual(await lookup.changeStop(await demo.reviewStop(stopDraft)), { done: true });
  const id = (await demo.stopOrders())[0].id;
  const closed = wrap(demo, { status: async () => ok({ tradingBlocked: "keyMovesMoney" }) });
  const blocked = new MexcController(closed.api);
  await blocked.refresh();
  assert.ok((await blocked.changeStop(await demo.reviewStop({ ...stopDraft, kind: "STOP_CHANGE", stopOrderId: id }))).error);
  assert.equal(closed.calls.changeStop ?? 0, 0);
  assert.deepEqual(await blocked.changeStop(await demo.reviewStop({ kind: "STOP_CANCEL", symbol: stopDraft.symbol, positionId: stopDraft.positionId, stopOrderId: id })), { done: true });
});

test("the demo sets, changes and cancels through the same one-use review", async () => {
  const demo = new MexcDemo(() => T0);
  const placed = await demo.reviewStop(stopDraft);
  assert.equal(placed.vol, "20");
  assert.deepEqual(await demo.changeStop(placed), { stopKind: "STOP_PLACE" });
  await assert.rejects(demo.changeStop(placed), (error: { code?: string }) => error.code === "reviewExpired");
  const [row] = await demo.stopOrders("QQQSTOCK_USDT");
  assert.equal(row.takeProfitPrice, 900);
  assert.equal(row.stopLossPrice, 500);
  await assert.rejects(demo.reviewStop(stopDraft), (error: { code?: string }) => error.code === "stopExists");
  await demo.changeStop(await demo.reviewStop({ ...stopDraft, kind: "STOP_CHANGE", stopOrderId: row.id, stopLossPrice: "450.00" }));
  assert.equal((await demo.stopOrders())[0].stopLossPrice, 450);
  // A newer review of any kind replaces the older one.
  const older = await demo.reviewStop({ kind: "STOP_CANCEL", symbol: stopDraft.symbol, positionId: stopDraft.positionId, stopOrderId: row.id });
  await leverageReviewOf(demo);
  await assert.rejects(demo.changeStop(older), (error: { code?: string }) => error.code === "reviewExpired");
  await demo.changeStop(await demo.reviewStop({ kind: "STOP_CANCEL", symbol: stopDraft.symbol, positionId: stopDraft.positionId, stopOrderId: row.id }));
  assert.deepEqual(await demo.stopOrders(), []);
});

test("in the demo an opening order's stops attach once it fills, and leave with the position", async () => {
  const demo = new MexcDemo(() => T0);
  await demo.place(await demo.review({ symbol: "TSLASTOCK_USDT", action: "OPEN_SHORT", kind: "MARKET", vol: "4", leverage: 5, takeProfitPrice: "100.00", stopLossPrice: "400.00" }));
  const [row] = await demo.stopOrders("TSLASTOCK_USDT");
  assert.equal(row.direction, "SHORT");
  assert.equal(row.takeProfitPrice, 100);
  await demo.place(await demo.review({ symbol: "TSLASTOCK_USDT", action: "CLOSE_SHORT", kind: "MARKET", vol: "4" }));
  assert.deepEqual(await demo.stopOrders("TSLASTOCK_USDT"), []);
});

test("a position of the marked size simulates an unknown stop request", async () => {
  const demo = new MexcDemo(() => T0);
  await demo.place(await demo.review({ symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", kind: "MARKET", vol: "57", leverage: 5 }));
  const c = new MexcController(demo);
  const result = await c.changeStop(await demo.reviewStop(stopDraft));
  assert.equal(result.unknown, true);
  assert.equal(c.locked, true);
  assert.deepEqual(await demo.stopOrders(), []);
});
