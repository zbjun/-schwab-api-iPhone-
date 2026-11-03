import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createGateway } from "./gateway.mjs";
import { MexcBroker } from "./mexcBroker.ts";
import { MexcClient } from "../mobile/src/MexcClient.ts";
import type { MexcDraft } from "../mobile/src/mexcRules.ts";
import type { Vault } from "../mobile/src/types.ts";

// App client, real gateway and real broker together, with a fictional exchange behind them.
const SYMBOL = "QQQSTOCK_USDT", ORDER_ID = "739113577038255616";
const TOKEN = "a".repeat(64), OTHER = "b".repeat(64), ORIGIN = "https://fixture.example.test";
const draft: MexcDraft = { symbol: SYMBOL, action: "OPEN_LONG", kind: "LIMIT", vol: "10", price: "700", leverage: 5 };
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, code: 0, data }));
const memory = (): Vault & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, async get(key) { return data.get(key) ?? null; }, async set(key, value) { data.set(key, value); }, async remove(key) { data.delete(key); } };
};
const contractRow = { symbol: SYMBOL, displayNameEn: "QQQ_USDT PERPETUAL", baseCoin: "QQQSTOCK", settleCoin: "USDT", futureType: 1, state: 0, apiAllowed: true, contractSize: 0.01, priceUnit: 0.01, volUnit: 1, minVol: 1, maxVol: 28000, minLeverage: 1, maxLeverage: 100, positionOpenType: 3, takerFeeRate: 0.0002, makerFeeRate: 0 };

async function setup(t: { after: (work: () => void) => void }, create: () => Response | Promise<Response> = () => ok({ orderId: ORDER_ID, ts: 1 }),
  positions: unknown[] = [], changeLeverage: () => Response | Promise<Response> = () => new Response(JSON.stringify({ success: true, code: 0 })),
  stops: unknown[] = [], stopWrite: () => Response | Promise<Response> = () => ok(357859177)) {
  const exchange: string[] = [];
  const exchangeFetch = async (url: string, init: RequestInit) => {
    if (init.method === "POST") exchange.push(url);
    if (url.includes("apiKeyInfo")) return new Response(JSON.stringify({ status: "VALID", ipWhiteList: "<gateway-host>", permissions: "SPOT_ACCOUNT_READ,CONTRACT_ACCOUNT_READ,CONTRACT_DEAL_READ,CONTRACT_DEAL_WRITE" }));
    if (url.includes("/contract/detail?symbol=")) return ok(contractRow);
    if (url.endsWith("/contract/detail")) return ok([contractRow, { ...contractRow, symbol: "HIDDEN_USDT", apiAllowed: false }, { broken: true }]);
    if (url.includes("/contract/kline/")) return ok({ time: [1, 2, 3], open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], vol: [1, 2, 3] });
    if (url.includes("/contract/ticker")) return ok({ symbol: SYMBOL, lastPrice: 700, bid1: 699.9, ask1: 700.1, fairPrice: 700, timestamp: Date.now() });
    if (url.includes("position_mode")) return ok(1);
    if (url.includes("stoporder/open_orders")) return ok(stops);
    if (url.includes("stoporder/")) return stopWrite();
    if (url.includes("open_positions")) return ok(positions);
    if (url.includes("change_leverage")) return changeLeverage();
    if (url.includes("account/asset/USDT")) return ok({ currency: "USDT", equity: 1000, availableBalance: 900, availableOpen: 900, positionMargin: 0, frozenBalance: 0, unrealized: 0 });
    if (url.includes("order/create")) return create();
    throw new Error("Unexpected exchange request " + url);
  };
  const broker = new MexcBroker(memory(), { apiKey: "fictional", apiSecret: "fictional", limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, fetch: exchangeFetch });
  const server = createGateway({ broker, devices: [{ id: "phone-a", token: TOKEN }, { id: "phone-b", token: OTHER }], extraReads: {
    contracts: () => broker.contracts(), limits: () => broker.limits, live: (...args: unknown[]) => (broker.live as (...a: unknown[]) => unknown)(...args), closedOrders: (...args: unknown[]) => (broker.closedOrders as (...a: unknown[]) => unknown)(...args),
    stopOrders: (...args: unknown[]) => (broker.stopOrders as (...a: unknown[]) => unknown)(...args),
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port;
  const client = async (token: string) => {
    const vault = memory();
    const app = new MexcClient(vault, { fetch: async (url, init) => {
      // Rewrites only the address: the app insists on HTTPS, the fixture listens locally.
      const response = await fetch(url.replace(ORIGIN, `http://127.0.0.1:${port}`), { ...init, redirect: "manual" });
      return new Response(await response.text(), { status: response.status });
    }, timeoutMilliseconds: 2000 });
    await app.configureServer(ORIGIN, token);
    return { app, vault };
  };
  return { client, exchange, broker };
}
const code = async (work: Promise<unknown>, expected: string) => assert.rejects(work, (error: { code?: string }) => error.code === expected);

test("an order goes from the app through the gateway to the exchange exactly once", async t => {
  const { client, exchange } = await setup(t);
  const { app, vault } = await client(TOKEN);
  const review = await app.review(draft);
  assert.equal(review.orderPrice, "700");
  assert.ok(Math.abs(review.notional - 70.01) < 1e-9);
  assert.deepEqual(await app.place(review), { orderID: ORDER_ID });
  assert.equal(exchange.length, 1);
  await code(app.place(review), "reviewExpired");
  assert.equal(exchange.length, 1);
  assert.equal(await vault.get("mexc.ths.server.operation.v1"), null);
});

test("the app reads live candles through the gateway without any write", async t => {
  const { client, exchange } = await setup(t);
  const { app, vault } = await client(TOKEN);
  const live = await app.live(SYMBOL, "minute1");
  assert.equal(live.candles.length, 2);
  assert.equal(live.ticker.symbol, SYMBOL);
  assert.equal(exchange.length, 0);
  assert.equal(await vault.get("mexc.ths.server.operation.v1"), null);
  await code(app.live("bad" as never, "minute1"), "invalidSymbol");
});

test("a review survives a stream of live reads, and the order goes out once", async t => {
  const { client, exchange } = await setup(t);
  const { app } = await client(TOKEN);
  const review = await app.review(draft);
  for (let index = 0; index < 20; index++) await app.live(SYMBOL, index % 2 ? "minute1" : "minute5");
  assert.deepEqual(await app.place(review), { orderID: ORDER_ID });
  assert.equal(exchange.length, 1);
});

test("device storage is namespaced so it cannot touch the Schwab connection", async t => {
  const { client } = await setup(t);
  const { app, vault } = await client(TOKEN);
  await vault.set("ths.server.operation.v1", "schwab-marker");
  assert.ok(vault.data.has("mexc.ths.server.connection.v1"));
  assert.equal(vault.data.has("ths.server.connection.v1"), false);
  assert.equal((await app.status()).unresolvedOperation, false);
});

test("an unknown outcome locks the server and both devices", async t => {
  const { client, exchange } = await setup(t, () => Promise.reject(new Error("timeout")));
  const a = await client(TOKEN), b = await client(OTHER);
  await code(a.app.place(await a.app.review(draft)), "orderOutcomeUnknown");
  assert.equal(exchange.length, 1);
  assert.ok(await a.vault.get("mexc.ths.server.operation.v1"), "the device keeps its own marker");
  await code(b.app.review(draft), "orderOutcomeUnknown");
  assert.equal((await b.app.status()).unresolvedOperation, true);
  await code(a.app.acknowledgeReconciliation(), "orderOutcomeUnknown");
  assert.equal(exchange.length, 1);
});

test("a review belongs to the device that made it", async t => {
  const { client, exchange } = await setup(t);
  const a = await client(TOKEN), b = await client(OTHER);
  const review = await a.app.review(draft);
  await code(b.app.place(review), "reviewExpired");
  assert.equal(exchange.length, 0);
});

test("limits, listings and refusals arrive as controlled values", async t => {
  const { client, exchange } = await setup(t);
  const { app } = await client(TOKEN);
  assert.deepEqual(await app.limits(), { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 });
  assert.deepEqual((await app.contracts()).map(contract => contract.symbol), [SYMBOL]);
  await assert.rejects(app.review({ ...draft, leverage: 6 }), (error: Error & { code?: string }) => {
    assert.equal(error.code, "leverageLimit");
    assert.match(error.message, /杠杆/);
    return true;
  });
  await code(app.review({ ...draft, vol: "200" }), "notionalLimit");
  assert.equal(exchange.length, 0);
});

test("a client cannot change server limits or call unlisted methods", async t => {
  const { client, exchange } = await setup(t);
  const { app } = await client(TOKEN);
  const rpc = (app as unknown as { rpc: (method: string, args: unknown[]) => Promise<unknown> }).rpc.bind(app);
  await code(rpc("submitQuick", ["USDT", draft, "a".repeat(20)]), "methodNotAllowed");
  await code(rpc("toString", []), "methodNotAllowed");
  await code(rpc("__proto__", []), "methodNotAllowed");
  await code(rpc("acknowledgeReconciliation", []), "methodNotAllowed");
  await code(rpc("schedule", ["USDT", draft, Date.now() + 60_000, "x"]), "methodNotAllowed");
  assert.equal(exchange.length, 0);
});

test("the client refuses a review that does not match what it asked for", async () => {
  const vault = memory();
  const app = new MexcClient(vault, { fetch: async () => new Response(JSON.stringify({ result: { id: "x", isDemo: false, orderPrice: "700", notional: 70, draft: { ...draft, vol: "99" } } })) });
  await app.configureServer(ORIGIN, TOKEN);
  await code(app.review(draft), "serverUnavailable");
});

test("a lost reply is reported as unknown, not as a connection problem", async () => {
  for (const [name, fetcher] of [
    ["connection refused", async () => { throw new Error("refused"); }],
    ["server failure", async () => new Response(JSON.stringify({ error: { code: "serverFailure", message: "x" } }), { status: 500 })],
    ["unreadable reply", async () => new Response("<html>", { status: 200 })],
  ] as [string, typeof fetch][]) {
    const vault = memory();
    const app = new MexcClient(vault, { fetch: fetcher });
    await app.configureServer(ORIGIN, TOKEN);
    await code(app.place({ id: "x" } as never), "orderOutcomeUnknown");
    assert.ok(await vault.get("mexc.ths.server.operation.v1"), name);
    // With the gateway unreachable the app must still know it is locked.
    const status = await new MexcClient(vault, { fetch: async () => { throw new Error("refused"); } }).status();
    assert.equal(status.unresolvedOperation, true, name);
    await code(app.cancelOrder("12345"), "orderOutcomeUnknown");
  }
});

test("a proven refusal leaves the device free, and a request that never started is not called unknown", async () => {
  const vault = memory();
  const refused = new MexcClient(vault, { fetch: async () => new Response(JSON.stringify({ error: { code: "reviewExpired", message: "x" } }), { status: 400 }) });
  await refused.configureServer(ORIGIN, TOKEN);
  await code(refused.place({ id: "x" } as never), "reviewExpired");
  assert.equal(await vault.get("mexc.ths.server.operation.v1"), null);
  let release!: (value: Response) => void;
  const pending = new Promise<Response>(done => { release = done; });
  const slow = new MexcClient(memory(), { fetch: async () => pending });
  await slow.configureServer(ORIGIN, TOKEN);
  const first = slow.place({ id: "x" } as never);
  await new Promise(done => setTimeout(done, 5));
  await code(slow.place({ id: "y" } as never), "operationBusy");
  release(new Response(JSON.stringify({ result: { orderID: ORDER_ID } })));
  assert.deepEqual(await first, { orderID: ORDER_ID });
  // Unreachable with nothing pending: a plain connection error, because nothing can be locked.
  const idle = new MexcClient(memory(), { fetch: async () => { throw new Error("refused"); } });
  await idle.configureServer(ORIGIN, TOKEN);
  await code(idle.status(), "serverUnavailable");
});

test("nothing can unlock a device while the server is still sending", async t => {
  let release!: (value: Response) => void;
  const gate = new Promise<Response>(done => { release = done; });
  const { client } = await setup(t, () => gate);
  const { app, vault } = await client(TOKEN);
  const sending = app.place(await app.review(draft));
  await new Promise(done => setTimeout(done, 30));
  // As if the app was killed and reopened: a new client over the same device storage.
  const reopened = new MexcClient(vault, { fetch: (app as unknown as { transport: typeof fetch }).transport });
  const status = await reopened.status();
  assert.equal(status.unresolvedOperation, true);
  assert.equal(status.writeInProgress, true);
  await code(reopened.acknowledgeReconciliation(), "orderOutcomeUnknown");
  assert.ok(await vault.get("mexc.ths.server.operation.v1"));
  release(ok({ orderId: ORDER_ID, ts: 1 }));
  assert.deepEqual(await sending, { orderID: ORDER_ID });
});

test("device storage failures: an unreadable marker is unknown, an unwritable one sends nothing", async () => {
  const unreadable = memory();
  const reader = new MexcClient(unreadable, { fetch: async () => { throw new Error("must not send"); } });
  await reader.configureServer(ORIGIN, TOKEN);
  unreadable.get = async () => { throw new Error("keychain"); };
  await code(reader.place({ id: "x" } as never), "orderOutcomeUnknown");
  const unwritable = memory();
  let sent = 0;
  const writer = new MexcClient(unwritable, { fetch: async () => { sent++; return new Response("{}"); } });
  await writer.configureServer(ORIGIN, TOKEN);
  unwritable.set = async () => { throw new Error("keychain"); };
  await assert.rejects(writer.place({ id: "x" } as never), (error: { code?: string }) => error.code !== "orderOutcomeUnknown");
  assert.equal(sent, 0);
});

test("a gateway answering busy clears the device marker and stays busy", async () => {
  const vault = memory();
  const app = new MexcClient(vault, { fetch: async () => new Response(JSON.stringify({ error: { code: "operationBusy", message: "x" } }), { status: 400 }) });
  await app.configureServer(ORIGIN, TOKEN);
  await code(app.place({ id: "x" } as never), "operationBusy");
  assert.equal(await vault.get("mexc.ths.server.operation.v1"), null);
});

test("a review that changes the price or leverage it shows is refused", async () => {
  const base = { id: "x", isDemo: false, draft, orderPrice: "700", notional: 70, leverage: 5, openType: 1 };
  for (const changed of [{ orderPrice: "701" }, { leverage: 6 }, { openType: 2 }]) {
    const app = new MexcClient(memory(), { fetch: async () => new Response(JSON.stringify({ result: { ...base, ...changed } })) });
    await app.configureServer(ORIGIN, TOKEN);
    await code(app.review(draft), "serverUnavailable");
  }
  const app = new MexcClient(memory(), { fetch: async () => new Response(JSON.stringify({ result: base })) });
  await app.configureServer(ORIGIN, TOKEN);
  assert.equal((await app.review(draft)).orderPrice, "700");
});

test("a place answer without an order id stays locked on the device", async () => {
  const vault = memory();
  const app = new MexcClient(vault, { fetch: async () => new Response(JSON.stringify({ result: { orderID: "not-an-id" } })) });
  await app.configureServer(ORIGIN, TOKEN);
  await code(app.place({ id: "x" } as never), "orderOutcomeUnknown");
  assert.ok(await vault.get("mexc.ths.server.operation.v1"));
});

const heldPosition = { positionId: 1109973831, symbol: SYMBOL, positionType: 2, openType: 1, holdVol: 10, frozenVol: 0, holdAvgPrice: 690, leverage: 5 };
const leverage = { kind: "LEVERAGE" as const, symbol: SYMBOL, positionId: "1109973831", leverage: 3 };

test("a leverage change goes from the app through the gateway to the exchange exactly once", async t => {
  const { client, exchange } = await setup(t, undefined, [heldPosition]);
  const { app, vault } = await client(TOKEN);
  const review = await app.reviewLeverage(leverage);
  assert.equal(review.previousLeverage, 5);
  assert.equal(review.direction, "SHORT");
  assert.equal(exchange.length, 0);
  assert.deepEqual(await app.changeLeverage(review), { leverage: 3 });
  assert.equal(exchange.length, 1);
  assert.ok(exchange[0].endsWith("/api/v1/private/position/change_leverage"));
  await code(app.changeLeverage(review), "reviewExpired");
  assert.equal(exchange.length, 1);
  assert.equal(await vault.get("mexc.ths.server.operation.v1"), null);
});

test("another device cannot use a leverage review, and only its id ever crosses the gateway", async t => {
  const { client, exchange } = await setup(t, undefined, [heldPosition]);
  const { app } = await client(TOKEN);
  const { app: other } = await client(OTHER);
  const review = await app.reviewLeverage(leverage);
  await code(other.changeLeverage(review), "reviewExpired");
  assert.equal(exchange.length, 0);
});

test("a lost reply to a leverage change locks both the device and the server", async t => {
  const { client, exchange, broker } = await setup(t, undefined, [heldPosition], () => { throw new Error("connection lost"); });
  const { app } = await client(TOKEN);
  const review = await app.reviewLeverage(leverage);
  await code(app.changeLeverage(review), "orderOutcomeUnknown");
  assert.equal(exchange.length, 1);
  assert.equal((await broker.status()).unresolvedOperation, true);
  await code(app.reviewLeverage(leverage), "orderOutcomeUnknown");
  await code(app.review(draft), "orderOutcomeUnknown");
  assert.equal(exchange.length, 1);
});

const stop = { kind: "STOP_PLACE" as const, symbol: SYMBOL, positionId: "1109973831", takeProfitPrice: "600", stopLossPrice: "800" };

test("a stop request goes from the app through the gateway to the exchange exactly once", async t => {
  const { client, exchange } = await setup(t, undefined, [heldPosition]);
  const { app, vault } = await client(TOKEN);
  const review = await app.reviewStop(stop);
  assert.equal(review.direction, "SHORT");
  assert.equal(review.vol, "10");
  assert.equal(exchange.length, 0);
  assert.deepEqual(await app.changeStop(review), { stopKind: "STOP_PLACE" });
  assert.equal(exchange.length, 1);
  assert.ok(exchange[0].endsWith("/api/v1/private/stoporder/place"));
  await code(app.changeStop(review), "reviewExpired");
  assert.equal(exchange.length, 1);
  assert.equal(await vault.get("mexc.ths.server.operation.v1"), null);
});

test("another device cannot use a stop review, and a lost reply locks both sides", async t => {
  const { client, exchange, broker } = await setup(t, undefined, [heldPosition], undefined, [], () => { throw new Error("connection lost"); });
  const { app } = await client(TOKEN);
  const { app: other } = await client(OTHER);
  const review = await app.reviewStop(stop);
  await code(other.changeStop(review), "reviewExpired");
  assert.equal(exchange.length, 0);
  const again = await app.reviewStop(stop);
  await code(app.changeStop(again), "orderOutcomeUnknown");
  assert.equal(exchange.length, 1);
  assert.equal((await broker.status()).unresolvedOperation, true);
  await code(app.reviewStop(stop), "orderOutcomeUnknown");
  await code(app.review(draft), "orderOutcomeUnknown");
  assert.equal(exchange.length, 1);
});

test("the waiting list reaches the app through the gateway", async t => {
  const { client } = await setup(t, undefined, [heldPosition], undefined, [{ id: 7, symbol: SYMBOL, positionId: 1109973831, positionType: 2, state: 1, stopLossPrice: 800, vol: 10 }]);
  const { app } = await client(TOKEN);
  const rows = await app.stopOrders(SYMBOL);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stopLossPrice, 800);
  assert.equal((await app.stopOrders()).length, 1);
});
