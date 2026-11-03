import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MexcBroker } from "./mexcBroker.ts";
import type { MexcDraft, MexcLeverageDraft, MexcLeveragePrepared, MexcPrepared, MexcStopDraft, MexcStopPrepared } from "../mobile/src/mexcRules.ts";
import type { Vault } from "../mobile/src/types.ts";

// Fictional credentials and data only. This suite never reaches a network.
const API_KEY = "fictional-access-key", SECRET = "fictional-secret";
const NOW = 1_800_000_000_000;
const MARKER = "ths.mexc.operation.v1";
const SYMBOL = "QQQSTOCK_USDT";
const ORDER_ID = "739113577038255616";
const KEY_CHECK_EXPIRED = 10 * 60_000 + 1;
const openDraft: MexcDraft = { symbol: SYMBOL, action: "OPEN_LONG", kind: "LIMIT", vol: "10", price: "700", leverage: 5 };
const closeDraft: MexcDraft = { symbol: SYMBOL, action: "CLOSE_LONG", kind: "MARKET", vol: "4" };
const leverageDraft: MexcLeverageDraft = { kind: "LEVERAGE", symbol: SYMBOL, positionId: "1109973831", leverage: 3 };
const ok = (data: unknown) => JSON.stringify({ success: true, code: 0, data });

class MemoryVault implements Vault {
  values = new Map<string, string>();
  events: string[];
  failSet = false; failRemove = false; failGet = false;
  constructor(events: string[]) { this.events = events; }
  async get(key: string) { if (this.failGet) throw new Error("vault"); return this.values.get(key) ?? null; }
  async set(key: string, value: string) { if (this.failSet) throw new Error("vault"); this.events.push("marker:set"); this.values.set(key, value); }
  async remove(key: string) { if (this.failRemove) throw new Error("vault"); this.events.push("marker:remove"); this.values.delete(key); }
}
interface Call { url: string; init: RequestInit }
function fixture(overrides: { keyCheck?: boolean; keyInfo?: unknown; keyStatus?: number; positions?: unknown[]; positionMode?: number; create?: () => Promise<Response> | Response; cancel?: () => Promise<Response> | Response; changeLeverage?: () => Promise<Response> | Response; stopWrite?: () => Promise<Response> | Response; stops?: unknown[]; marketDown?: boolean; detail?: unknown; state?: number } = {}) {
  const events: string[] = [], calls: Call[] = [];
  const vault = new MemoryVault(events);
  let now = NOW;
  const keyInfo = overrides.keyInfo ?? { status: "VALID", ipWhiteList: "<gateway-host>", permissions: "SPOT_ACCOUNT_READ,CONTRACT_ACCOUNT_READ,CONTRACT_DEAL_READ,CONTRACT_DEAL_WRITE", remainingValidity: -999 };
  const routes: [RegExp, () => Response | Promise<Response>][] = [
    ...(overrides.marketDown ? [[/contract\/(ticker|detail)|position_mode/, () => new Response("down", { status: 500 })] as [RegExp, () => Response]] : []),
    [/\/api\/v3\/apiKeyInfo/, () => new Response(JSON.stringify(keyInfo), { status: overrides.keyStatus ?? 200 })],
    [/\/api\/v1\/contract\/detail\?symbol=/, () => new Response(ok(overrides.detail ?? { symbol: SYMBOL, displayNameEn: "QQQ_USDT PERPETUAL", baseCoin: "QQQSTOCK", settleCoin: "USDT", futureType: 1, state: 0, apiAllowed: true, contractSize: 0.01, priceUnit: 0.01, volUnit: 1, minVol: 1, maxVol: 28000, minLeverage: 1, maxLeverage: 100, positionOpenType: 3, takerFeeRate: 0.0002, makerFeeRate: 0 }))],
    [/\/api\/v1\/contract\/kline\//, () => new Response(ok({ time: [1, 2], open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], vol: [1, 2] }))],
    [/\/api\/v1\/contract\/ticker\?symbol=/, () => new Response(ok({ symbol: SYMBOL, lastPrice: 700, bid1: 699.9, ask1: 700.1, fairPrice: 700, maxBidPrice: 840, minAskPrice: 560, fundingRate: 0.0005, timestamp: now }))],
    [/position_mode/, () => new Response(ok(overrides.positionMode ?? 1))],
    [/open_positions/, () => new Response(ok(overrides.positions ?? [{ positionId: 1109973831, symbol: SYMBOL, positionType: 1, openType: 1, holdVol: 10, frozenVol: 0, holdAvgPrice: 690, leverage: 5 }]))],
    [/account\/asset\/USDT/, () => new Response(ok({ currency: "USDT", equity: 1000, availableBalance: 900, availableOpen: 900, positionMargin: 100, frozenBalance: 0, unrealized: 0 }))],
    [/stoporder\/open_orders/, () => new Response(ok(overrides.stops ?? []))],
    [/stoporder\/(place|change_plan_price|cancel)/, overrides.stopWrite ?? (() => new Response(ok(357859177)))],
    [/open_orders/, () => new Response(ok({ resultList: [] }))],
    [/position\/change_leverage/, overrides.changeLeverage ?? (() => new Response(JSON.stringify({ success: true, code: 0 })))],
    [/order\/create/, overrides.create ?? (() => new Response(ok({ orderId: ORDER_ID, ts: NOW })))],
    [/order\/cancel/, overrides.cancel ?? (() => new Response(`{"success":true,"code":0,"data":[{"orderId":${ORDER_ID},"errorCode":0,"errorMsg":"success"}]}`))],
    [/order\/get\//, () => new Response(`{"success":true,"code":0,"data":{"orderId":${ORDER_ID},"symbol":"${SYMBOL}","side":1,"price":700,"vol":10,"state":${overrides.state ?? 2}}}`)],
    [/order\/external\//, () => new Response(`{"success":true,"code":0,"data":{"orderId":${ORDER_ID},"symbol":"${SYMBOL}","side":1,"price":700,"vol":10,"state":2}}`)],
  ];
  const transport = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (/order\/(create|cancel)/.test(url)) events.push("send:" + (url.includes("create") ? "create" : "cancel"));
    if (url.includes("change_leverage")) events.push("send:leverage");
    if (/stoporder\/(place|change_plan_price|cancel)/.test(url)) events.push("send:stop");
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) throw new Error("Unexpected request " + url);
    return route[1]();
  };
  const broker = new MexcBroker(vault, { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, keyCheck: overrides.keyCheck, fetch: transport, now: () => now });
  const writes = () => calls.filter(call => call.init.method === "POST");
  return { broker, vault, calls, events, writes, advance: (ms: number) => { now += ms; } };
}
const code = async (work: Promise<unknown>, expected: string) => assert.rejects(work, (error: { code?: string }) => error.code === expected);
const prepared = (context: ReturnType<typeof fixture>, draft = openDraft) => context.broker.prepare("USDT", draft) as Promise<MexcPrepared>;

test("refuses to start without a real key or with bad limits", () => {
  const vault = new MemoryVault([]);
  const limits = { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 };
  assert.throws(() => new MexcBroker(vault, { apiKey: "REPLACE_ON_SERVER", apiSecret: "x", limits }));
  assert.throws(() => new MexcBroker(vault, { apiKey: "x", apiSecret: "", limits }));
  assert.throws(() => new MexcBroker(vault, { apiKey: "x", apiSecret: "y", limits: { ...limits, maxLeverage: 0 } }));
});

test("signs private requests the documented way", async () => {
  const context = fixture();
  await context.broker.orders("USDT");
  const call = context.calls.find(item => item.url.includes("open_orders"))!, headers = call.init.headers as Record<string, string>;
  const query = "page_num=1&page_size=100";
  assert.equal(new URL(call.url).search, "?" + query);
  assert.equal(headers.ApiKey, API_KEY);
  assert.equal(headers["Request-Time"], String(NOW));
  assert.equal(headers.Signature, createHmac("sha256", SECRET).update(API_KEY + NOW + query).digest("hex"));
  assert.equal(call.init.redirect, "error");
});

test("a successful order writes the marker first, sends once and clears it", async () => {
  const context = fixture({ positions: [] });
  const review = await prepared(context);
  assert.equal(review.orderPrice, "700");
  assert.equal(review.leverage, 5);
  assert.deepEqual(await context.broker.submit(review), { orderID: ORDER_ID });
  assert.deepEqual(context.events, ["marker:set", "send:create", "marker:remove"]);
  assert.equal(context.writes().length, 1);
  const call = context.writes()[0], body = call.init.body as string, headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Signature, createHmac("sha256", SECRET).update(API_KEY + NOW + body).digest("hex"));
  assert.deepEqual(JSON.parse(body), { symbol: SYMBOL, price: 700, vol: 10, side: 1, sideType: "buy", type: 1, openType: 1, positionType: "long", positionMode: 1, externalOid: review.externalOid, leverage: 5 });
  assert.equal(context.vault.values.has(MARKER), false);
  assert.equal((await context.broker.status()).unresolvedOperation, false);
});

test("a review works once, only as the original object, and only for 60 seconds", async () => {
  const context = fixture({ positions: [] });
  const review = await prepared(context);
  await code(context.broker.submit({ ...review }), "reviewExpired");
  assert.equal(context.writes().length, 0);
  const second = await prepared(context);
  await context.broker.submit(second);
  await code(context.broker.submit(second), "reviewExpired");
  assert.equal(context.writes().length, 1);
  const late = await prepared(context);
  context.advance(60_001);
  await code(context.broker.submit(late), "reviewExpired");
  assert.equal(context.writes().length, 1);
  const replaced = await prepared(context);
  await prepared(context);
  await code(context.broker.submit(replaced), "reviewExpired");
  assert.equal(context.writes().length, 1);
});

for (const [name, create] of [
  ["a lost connection", () => Promise.reject(new Error("socket hang up"))],
  ["an HTTP 502", () => new Response("bad gateway", { status: 502 })],
  ["an internal error code", () => new Response(JSON.stringify({ success: false, code: 500, message: "internal" }))],
  ["a repeated request code", () => new Response(JSON.stringify({ success: false, code: 603 }))],
  ["an unknown code", () => new Response(JSON.stringify({ success: false, code: 77777 }))],
  ["an unreadable body", () => new Response("<html>")],
  ["a success without an id", () => new Response(ok({ ts: NOW }))],
  ["an HTTP 400 whose body says the order exists", () => new Response(ok({ orderId: ORDER_ID, ts: NOW }), { status: 400 })],
  ["an HTTP 400 naming an internal error", () => new Response(JSON.stringify({ code: 500, msg: "x" }), { status: 400 })],
  ["a proxy's HTTP 499", () => new Response("", { status: 499 })],
  ["an HTTP 404", () => new Response("<html>", { status: 404 })],
  ["an HTTP 409", () => new Response("", { status: 409 })],
] as [string, () => Promise<Response> | Response][]) {
  test(`${name} leaves the outcome unknown, never retries, and locks every write`, async () => {
    const context = fixture({ positions: [], create });
    const review = await prepared(context);
    await code(context.broker.submit(review), "orderOutcomeUnknown");
    assert.equal(context.writes().length, 1);
    assert.deepEqual(context.events, ["marker:set", "send:create"]);
    const stored = JSON.parse(context.vault.values.get(MARKER)!);
    assert.equal(stored.operation, "create");
    assert.equal(stored.externalOid, review.externalOid);
    assert.equal(stored.symbol, SYMBOL);
    assert.equal((await context.broker.status()).unresolvedOperation, true);
    await code(context.broker.prepare("USDT", openDraft), "orderOutcomeUnknown");
    await code(context.broker.cancel("USDT", ORDER_ID), "orderOutcomeUnknown");
    assert.equal(context.writes().length, 1);
  });
}

test("the lock survives a restart and only the offline acknowledgement clears it", async () => {
  const context = fixture({ positions: [], create: () => Promise.reject(new Error("timeout")) });
  await code(context.broker.submit(await prepared(context)), "orderOutcomeUnknown");
  const restarted = new MexcBroker(context.vault, { apiKey: API_KEY, apiSecret: SECRET, limits: context.broker.limits, now: () => NOW,
    fetch: async () => { throw new Error("A locked broker must not reach the network"); } });
  await code(restarted.prepare("USDT", openDraft), "orderOutcomeUnknown");
  await restarted.acknowledgeReconciliation();
  assert.equal(context.vault.values.has(MARKER), false);
});

test("the recovery lookup finds the locked order by its own id", async () => {
  const context = fixture({ positions: [], create: () => Promise.reject(new Error("timeout")) });
  const review = await prepared(context);
  await code(context.broker.submit(review), "orderOutcomeUnknown");
  const pending = await context.broker.pendingOperation();
  assert.equal(pending?.lookup, "found");
  assert.equal(pending?.order?.id, ORDER_ID);
  assert.ok(context.calls.some(call => call.url.endsWith(`/order/external/${SYMBOL}/${review.externalOid}`)));
  assert.equal(context.vault.values.has(MARKER), true, "looking up must not unlock");
  assert.equal(await fixture().broker.pendingOperation(), null);
});

test("the recovery lookup separates a missing order from a failed lookup", async () => {
  const lookup = async (answer: () => Response | Promise<Response>) => {
    const events: string[] = [], vault = new MemoryVault(events);
    await vault.set(MARKER, JSON.stringify({ version: 1, pending: true, createdAt: NOW, operation: "create", symbol: SYMBOL, externalOid: "ths0123456789abcdef" }));
    const broker = new MexcBroker(vault, { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, fetch: async () => answer(), now: () => NOW });
    const result = await broker.pendingOperation();
    assert.equal(vault.values.has(MARKER), true, "looking up must not unlock");
    return result?.lookup;
  };
  assert.equal(await lookup(() => new Response(JSON.stringify({ success: false, code: 2040 }))), "notFound");
  assert.equal(await lookup(() => new Response(ok(null))), "notFound");
  assert.equal(await lookup(() => new Response(JSON.stringify({ success: false, code: 602 }))), "failed");
  assert.equal(await lookup(() => new Response("bad gateway", { status: 502 })), "failed");
  assert.equal(await lookup(() => Promise.reject(new Error("offline"))), "failed");
  assert.equal(await lookup(() => new Response(ok({ orderId: "abc" }))), "failed");
});

test("a proven refusal unlocks and reports only controlled text", async () => {
  const context = fixture({ positions: [], create: () => new Response(JSON.stringify({ success: false, code: 2005, message: "upstream secret text" })) });
  await assert.rejects(context.broker.submit(await prepared(context)), (error: Error & { code?: string }) => {
    assert.equal(error.code, "insufficientFunds");
    assert.doesNotMatch(error.message, /upstream/);
    return true;
  });
  assert.deepEqual(context.events, ["marker:set", "send:create", "marker:remove"]);
  assert.equal((await context.broker.status()).unresolvedOperation, false);
});

test("no request leaves when the marker cannot be stored", async () => {
  const context = fixture({ positions: [] });
  const review = await prepared(context);
  context.vault.failSet = true;
  await code(context.broker.submit(review), "secureStorage");
  assert.equal(context.writes().length, 0);
  context.vault.failSet = false;
  await code(context.broker.prepare("USDT", openDraft), "orderOutcomeUnknown");
});

test("an order that cannot clear its marker stays locked", async () => {
  const context = fixture({ positions: [] });
  const review = await prepared(context);
  context.vault.failRemove = true;
  await code(context.broker.submit(review), "orderOutcomeUnknown");
  assert.equal(context.writes().length, 1);
  assert.equal(context.vault.values.has(MARKER), true);
});

test("an unreadable marker fails closed", async () => {
  const context = fixture({ positions: [] });
  context.vault.failGet = true;
  await code(context.broker.prepare("USDT", openDraft), "orderOutcomeUnknown");
});

test("expiring while the marker is stored sends nothing and unlocks", async () => {
  const context = fixture({ positions: [] });
  const review = await prepared(context);
  context.advance(59_000);
  const set = context.vault.set.bind(context.vault);
  context.vault.set = async (key, value) => { context.advance(2_000); await set(key, value); };
  await code(context.broker.submit(review), "reviewExpired");
  assert.equal(context.writes().length, 0);
  assert.equal(context.vault.values.has(MARKER), false);
});

test("submit re-checks fresh state instead of trusting the review", async () => {
  const positions: unknown[] = [];
  const context = fixture({ positions });
  const review = await prepared(context);
  positions.push({ positionId: 1, symbol: SYMBOL, positionType: 1, openType: 2, holdVol: 1, frozenVol: 0, holdAvgPrice: 1, leverage: 5 });
  await code(context.broker.submit(review), "positionCross");
  assert.equal(context.writes().length, 0);
  assert.equal(context.vault.values.has(MARKER), false);
});

test("a close never lands on a position the user did not review", async () => {
  const positions = [{ positionId: 1109973831, symbol: SYMBOL, positionType: 1, openType: 1, holdVol: 10, frozenVol: 0, holdAvgPrice: 690, leverage: 5 }];
  const context = fixture({ positions });
  const review = await prepared(context, closeDraft);
  positions[0] = { ...positions[0], positionId: 1109973999 };
  await code(context.broker.submit(review), "reviewExpired");
  assert.equal(context.writes().length, 0);
  assert.equal(context.vault.values.has(MARKER), false);
});

test("a submit running out of time stops before sending", async () => {
  const context = fixture({ positions: [] });
  const review = await prepared(context);
  const set = context.vault.set.bind(context.vault);
  context.vault.set = async (key, value) => { context.advance(12_001); await set(key, value); };
  await code(context.broker.submit(review), "reviewExpired");
  assert.equal(context.writes().length, 0);
  assert.equal(context.vault.values.has(MARKER), false);
});

test("hanging reads during a submit end without sending anything", async () => {
  const vault = new MemoryVault([]);
  let hang = false, writes = 0;
  const broker = new MexcBroker(vault, {
    apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, timeoutMilliseconds: 20, now: () => NOW,
    fetch: async (url, init) => {
      if (init.method === "POST") writes++;
      if (hang) return new Promise((_, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("aborted"))); });
      if (url.includes("apiKeyInfo")) return new Response(JSON.stringify({ status: "VALID", ipWhiteList: "<gateway-host>", permissions: "SPOT_ACCOUNT_READ,CONTRACT_ACCOUNT_READ,CONTRACT_DEAL_READ,CONTRACT_DEAL_WRITE" }));
      if (url.includes("/contract/detail")) return new Response(ok({ symbol: SYMBOL, baseCoin: "QQQSTOCK", settleCoin: "USDT", futureType: 1, state: 0, apiAllowed: true, contractSize: 0.01, priceUnit: 0.01, volUnit: 1, minVol: 1, maxVol: 28000, minLeverage: 1, maxLeverage: 100, positionOpenType: 3, takerFeeRate: 0.0002, makerFeeRate: 0 }));
      if (url.includes("/contract/ticker")) return new Response(ok({ symbol: SYMBOL, lastPrice: 700, bid1: 699.9, ask1: 700.1, fairPrice: 700, timestamp: NOW }));
      if (url.includes("position_mode")) return new Response(ok(1));
      if (url.includes("open_positions")) return new Response(ok([]));
      return new Response(ok({ currency: "USDT", equity: 1000, availableBalance: 900, availableOpen: 900, positionMargin: 0, frozenBalance: 0, unrealized: 0 }));
    },
  });
  const review = await broker.prepare("USDT", openDraft);
  hang = true;
  await code(broker.submit(review), "exchangeUnavailable");
  assert.equal(writes, 0);
  assert.equal(vault.values.has(MARKER), false);
});

test("the market protected price approved in the review is what gets sent", async () => {
  const context = fixture();
  const review = await prepared(context, closeDraft);
  assert.equal(review.orderPrice, "692.91");
  await context.broker.submit(review);
  const body = JSON.parse(context.writes()[0].init.body as string);
  assert.equal(body.type, 3);
  assert.equal(body.price, 692.91);
  assert.equal(body.side, 4);
  assert.equal(body.positionId, 1109973831);
  assert.equal(body.leverage, undefined);
});

for (const [problem, keyInfo] of [
  ["keyNotBound", { status: "VALID", ipWhiteList: "", permissions: "CONTRACT_ACCOUNT_READ,CONTRACT_DEAL_READ,CONTRACT_DEAL_WRITE" }],
  ["keyMovesMoney", { status: "VALID", ipWhiteList: "x", permissions: "CONTRACT_ACCOUNT_READ,CONTRACT_DEAL_READ,CONTRACT_DEAL_WRITE,SPOT_TRANSFER_WRITE" }],
  ["keyPermissions", { status: "VALID", ipWhiteList: "x", permissions: "CONTRACT_DEAL_READ" }],
  ["keyInvalid", { status: "FROZEN", ipWhiteList: "x", permissions: "" }],
] as [string, unknown][]) {
  test(`a key with ${problem} cannot reach the order path but can still read`, async () => {
    const context = fixture({ keyInfo });
    await code(context.broker.prepare("USDT", openDraft), problem);
    const status = await context.broker.status();
    assert.equal(status.authenticated, false);
    assert.equal(status.tradingBlocked, problem);
    assert.equal((await context.broker.accounts()).length, 1);
    assert.equal(context.writes().length, 0);
  });
}

test("with the key check off, no lookup is made and orders go through the same path", async () => {
  // This key would be refused if it were looked at, which proves the lookup is really skipped.
  const context = fixture({ keyCheck: false, positions: [], keyInfo: { status: "VALID", ipWhiteList: "", permissions: "SPOT_TRANSFER_WRITE" } });
  const status = await context.broker.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.tradingBlocked, undefined);
  assert.deepEqual(await context.broker.submit(await prepared(context)), { orderID: ORDER_ID });
  assert.equal(context.calls.filter(call => call.url.includes("apiKeyInfo")).length, 0);
  assert.deepEqual(context.events, ["marker:set", "send:create", "marker:remove"]);
});

test("with the key check off, every other protection still holds", async () => {
  const context = fixture({ keyCheck: false, positions: [], create: () => Promise.reject(new Error("timeout")) });
  await code(context.broker.prepare("USDT", { ...openDraft, leverage: 6 }), "leverageLimit");
  await code(context.broker.prepare("USDT", { ...openDraft, vol: "200" }), "notionalLimit");
  await code(fixture({ keyCheck: false, positionMode: 2 }).broker.prepare("USDT", openDraft), "positionMode");
  await code(context.broker.submit(await prepared(context)), "orderOutcomeUnknown");
  assert.equal(context.writes().length, 1);
  assert.equal(context.vault.values.has(MARKER), true);
  await code(context.broker.prepare("USDT", openDraft), "orderOutcomeUnknown");
  assert.equal((await context.broker.status()).unresolvedOperation, true);
});

test("a rejected key still shows up when the check is off", async () => {
  const broker = new MexcBroker(new MemoryVault([]), { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, keyCheck: false, now: () => NOW,
    fetch: async () => new Response(JSON.stringify({ success: false, code: 402, message: "API Key expired" }), { status: 401 }) });
  await code(broker.prepare("USDT", openDraft), "apiKeyRejected");
  await code(broker.accounts(), "apiKeyRejected");
});

test("the key check is on unless the setting is exactly false", async () => {
  const limits = { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 };
  for (const value of ["false", 0, null, "off"])
    assert.throws(() => new MexcBroker(new MemoryVault([]), { apiKey: "x", apiSecret: "y", limits, keyCheck: value as never }), String(value));
  for (const keyCheck of [undefined, true]) {
    const context = fixture({ keyCheck, keyInfo: { status: "VALID", ipWhiteList: "", permissions: "" } });
    assert.equal((await context.broker.status()).tradingBlocked, "keyNotBound");
    await code(context.broker.prepare("USDT", openDraft), "keyNotBound");
  }
});

test("a failed key lookup closes trading and is asked again", async () => {
  let attempts = 0;
  const vault = new MemoryVault([]);
  const broker = new MexcBroker(vault, {
    apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, now: () => NOW,
    fetch: async url => { if (url.includes("apiKeyInfo")) attempts++; throw new Error("offline"); },
  });
  await code(broker.prepare("USDT", openDraft), "keyCheckFailed");
  await code(broker.prepare("USDT", openDraft), "keyCheckFailed");
  assert.equal(attempts, 2);
});

test("key lookups are cached and refreshed after ten minutes", async () => {
  const context = fixture({ positions: [] });
  const lookups = () => context.calls.filter(call => call.url.includes("apiKeyInfo")).length;
  await context.broker.status();
  await context.broker.status();
  assert.equal(lookups(), 1);
  context.advance(10 * 60_000);
  await context.broker.status();
  assert.equal(lookups(), 2);
  const key = context.calls.find(call => call.url.includes("apiKeyInfo"))!;
  const url = new URL(key.url), signature = url.searchParams.get("signature")!;
  url.searchParams.delete("signature");
  assert.equal(signature, createHmac("sha256", SECRET).update(url.search.slice(1)).digest("hex"));
  assert.equal((key.init.headers as Record<string, string>)["X-MEXC-APIKEY"], API_KEY);
});

test("one-way mode and server limits stop the order before anything is written", async () => {
  await code(fixture({ positionMode: 2 }).broker.prepare("USDT", openDraft), "positionMode");
  const context = fixture({ positions: [] });
  await code(context.broker.prepare("USDT", { ...openDraft, leverage: 6 }), "leverageLimit");
  await code(context.broker.prepare("USDT", { ...openDraft, vol: "200" }), "notionalLimit");
  await code(context.broker.prepare("OTHER", openDraft), "invalidAccount");
  await code(context.broker.prepare("USDT", openDraft, "replace-me"), "invalidDraft");
  assert.equal(context.writes().length, 0);
});

test("only one write runs at a time", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const context = fixture({ positions: [], create: async () => { await gate; return new Response(ok({ orderId: ORDER_ID })); } });
  const review = await prepared(context);
  const first = context.broker.submit(review);
  await new Promise(done => setTimeout(done, 10));
  await code(context.broker.prepare("USDT", openDraft), "operationBusy");
  await code(context.broker.cancel("USDT", ORDER_ID), "operationBusy");
  release();
  await first;
  assert.equal(context.writes().length, 1);
});

test("closing still works when only the key lookup failed, but opening does not", async () => {
  const vault = new MemoryVault([]);
  let writes = 0;
  const broker = new MexcBroker(vault, {
    apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, now: () => NOW,
    fetch: async (url, init) => {
      if (url.includes("apiKeyInfo")) throw new Error("spot API is down");
      if (init.method === "POST") { writes++; return new Response(ok({ orderId: ORDER_ID })); }
      if (url.includes("/contract/detail")) return new Response(ok({ symbol: SYMBOL, baseCoin: "QQQSTOCK", settleCoin: "USDT", futureType: 1, state: 0, apiAllowed: true, contractSize: 0.01, priceUnit: 0.01, volUnit: 1, minVol: 1, maxVol: 28000, minLeverage: 1, maxLeverage: 100, positionOpenType: 3, takerFeeRate: 0.0002, makerFeeRate: 0 }));
      if (url.includes("/contract/ticker")) return new Response(ok({ symbol: SYMBOL, lastPrice: 700, bid1: 699.9, ask1: 700.1, fairPrice: 700, timestamp: NOW }));
      if (url.includes("position_mode")) return new Response(ok(1));
      if (url.includes("open_positions")) return new Response(ok([{ positionId: 1109973831, symbol: SYMBOL, positionType: 1, openType: 1, holdVol: 10, frozenVol: 0, holdAvgPrice: 690, leverage: 5 }]));
      return new Response(ok({ currency: "USDT", equity: 1000, availableBalance: 900, availableOpen: 900, positionMargin: 0, frozenBalance: 0, unrealized: 0 }));
    },
  });
  await code(broker.prepare("USDT", openDraft), "keyCheckFailed");
  assert.deepEqual(await broker.submit(await broker.prepare("USDT", closeDraft)), { orderID: ORDER_ID });
  assert.equal(writes, 1);
});

test("a key that can move money cannot close either", async () => {
  await code(fixture({ keyInfo: { status: "VALID", ipWhiteList: "x", permissions: "CONTRACT_ACCOUNT_READ,CONTRACT_DEAL_READ,CONTRACT_DEAL_WRITE,SPOT_TRANSFER_WRITE" } }).broker.prepare("USDT", closeDraft), "keyMovesMoney");
});

test("refusals of reads and cancels never claim that an order did not fill", async () => {
  const blocked = fixture({ cancel: () => new Response("waf", { status: 403 }) });
  await assert.rejects(blocked.broker.cancel("USDT", ORDER_ID), (error: Error & { code?: string }) => {
    assert.equal(error.code, "cancelRejected");
    assert.doesNotMatch(error.message, /未成交/);
    return true;
  });
  assert.equal(blocked.vault.values.has(MARKER), false);
  const refused = fixture({ cancel: () => new Response(JSON.stringify({ success: false, code: 600 })) });
  await code(refused.broker.cancel("USDT", ORDER_ID), "cancelRejected");
  const denied = fixture({ cancel: () => new Response(JSON.stringify({ success: false, code: 406 })) });
  await code(denied.broker.cancel("USDT", ORDER_ID), "ipRejected");
  const gone = fixture({ cancel: () => new Response(JSON.stringify({ success: false, code: 2040 })) });
  await code(gone.broker.cancel("USDT", ORDER_ID), "orderChanged");
  const reader = new MexcBroker(new MemoryVault([]), { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, now: () => NOW, fetch: async () => new Response("waf", { status: 403 }) });
  await assert.rejects(reader.orderDetail("USDT", ORDER_ID), (error: Error & { code?: string }) => {
    assert.equal(error.code, "exchangeUnavailable");
    assert.doesNotMatch(error.message, /未成交/);
    return true;
  });
});

test("one contract with no price does not hide the other quotes", async () => {
  const broker = new MexcBroker(new MemoryVault([]), { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, now: () => NOW,
    fetch: async () => new Response(ok([{ symbol: SYMBOL, lastPrice: 700, timestamp: NOW }, { symbol: "NEW_USDT", lastPrice: 0, timestamp: NOW }])) });
  assert.deepEqual((await broker.quotes([SYMBOL, "NEW_USDT"])).map(ticker => ticker.symbol), [SYMBOL]);
});

test("while a submit is checking, status stays locked even before the marker exists", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const context = fixture({ positions: [] });
  const review = await prepared(context);
  const get = context.vault.get.bind(context.vault);
  context.vault.get = async key => { await gate; return get(key); };
  const running = context.broker.submit(review);
  context.vault.get = get;
  const during = await context.broker.status();
  assert.equal(during.unresolvedOperation, true);
  assert.equal(during.writeInProgress, true);
  assert.equal(context.vault.values.has(MARKER), false);
  release();
  await running;
  const after = await context.broker.status();
  assert.equal(after.unresolvedOperation, false);
  assert.equal(after.writeInProgress, undefined);
});

test("status reports the lock as it is when it answers, even after a slow key lookup", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let holdLookup = false;
  const vault = new MemoryVault([]);
  const keyInfo = JSON.stringify({ status: "VALID", ipWhiteList: "<gateway-host>", permissions: "SPOT_ACCOUNT_READ,CONTRACT_ACCOUNT_READ,CONTRACT_DEAL_READ,CONTRACT_DEAL_WRITE" });
  let now = NOW;
  const broker = new MexcBroker(vault, { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, now: () => now,
    fetch: async url => {
      if (url.includes("apiKeyInfo")) {
        if (holdLookup) { holdLookup = false; await gate; }
        return new Response(keyInfo);
      }
      if (url.includes("/contract/detail")) return new Response(ok({ symbol: SYMBOL, baseCoin: "QQQSTOCK", settleCoin: "USDT", futureType: 1, state: 0, apiAllowed: true, contractSize: 0.01, priceUnit: 0.01, volUnit: 1, minVol: 1, maxVol: 28000, minLeverage: 1, maxLeverage: 100, positionOpenType: 3, takerFeeRate: 0.0002, makerFeeRate: 0 }));
      if (url.includes("/contract/ticker")) return new Response(ok({ symbol: SYMBOL, lastPrice: 700, bid1: 699.9, ask1: 700.1, fairPrice: 700, timestamp: now }));
      if (url.includes("position_mode")) return new Response(ok(1));
      if (url.includes("open_positions")) return new Response(ok([]));
      if (url.includes("account/asset")) return new Response(ok({ currency: "USDT", equity: 1000, availableBalance: 900, availableOpen: 900, positionMargin: 0, frozenBalance: 0, unrealized: 0 }));
      throw new Error("timeout"); // The send: its outcome stays unknown.
    } });
  const review = await broker.prepare("USDT", openDraft);
  // Past the key cache, so this status has to look the key up, and that lookup hangs.
  now += KEY_CHECK_EXPIRED;
  holdLookup = true;
  const slowStatus = broker.status();
  await new Promise(done => setTimeout(done, 5));
  now -= KEY_CHECK_EXPIRED; // Back inside the cache and the review window, so the submit proceeds and sends.
  const submit = broker.submit(review).catch((error: { code?: string }) => error.code);
  await new Promise(done => setTimeout(done, 5));
  release();
  const answer = await slowStatus;
  assert.equal(answer.unresolvedOperation, true);
  assert.equal(await submit, "orderOutcomeUnknown");
});

test("a key known to move money stays blocked when a later lookup fails", async () => {
  const events: string[] = [], calls: string[] = [];
  let now = NOW, lookupFails = false;
  const broker = new MexcBroker(new MemoryVault(events), { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, now: () => now,
    fetch: async (url, init) => {
      if (init.method === "POST") { calls.push(url); return new Response(ok({ orderId: ORDER_ID })); }
      if (url.includes("apiKeyInfo")) {
        if (lookupFails) throw new Error("spot API is down");
        return new Response(JSON.stringify({ status: "VALID", ipWhiteList: "x", permissions: "CONTRACT_ACCOUNT_READ,CONTRACT_DEAL_READ,CONTRACT_DEAL_WRITE,SPOT_TRANSFER_WRITE" }));
      }
      throw new Error("A blocked key must not get this far: " + url);
    } });
  await code(broker.prepare("USDT", closeDraft), "keyMovesMoney");
  now += KEY_CHECK_EXPIRED;
  lookupFails = true;
  await code(broker.prepare("USDT", closeDraft), "keyMovesMoney");
  assert.equal((await broker.status()).tradingBlocked, "keyMovesMoney");
  assert.equal(calls.length, 0);
});

test("an error reply from the key lookup is retried instead of being remembered", async () => {
  let attempts = 0;
  const broker = new MexcBroker(new MemoryVault([]), { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, now: () => NOW,
    fetch: async () => { attempts++; return new Response(JSON.stringify({ code: 500, msg: "busy" })); } });
  assert.equal((await broker.status()).tradingBlocked, "keyCheckFailed");
  await broker.status();
  assert.equal(attempts, 2);
});

test("a hanging lookup during a cancel ends without sending anything", async () => {
  const vault = new MemoryVault([]);
  let writes = 0;
  const broker = new MexcBroker(vault, { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, timeoutMilliseconds: 20, now: () => NOW,
    fetch: async (_, init) => {
      if (init.method === "POST") writes++;
      return new Promise((_, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("aborted"))); });
    } });
  await code(broker.cancel("USDT", ORDER_ID), "exchangeUnavailable");
  assert.equal(writes, 0);
  assert.equal(vault.values.has(MARKER), false);
});

test("cancel sends the full-length id once and clears the marker", async () => {
  const context = fixture();
  await context.broker.cancel("USDT", ORDER_ID);
  assert.deepEqual(context.events, ["marker:set", "send:cancel", "marker:remove"]);
  assert.equal(context.writes()[0].init.body, `[${ORDER_ID}]`);
});

test("cancel refuses finished orders and handles every answer", async () => {
  const finished = fixture({ state: 3 });
  await code(finished.broker.cancel("USDT", ORDER_ID), "orderChanged");
  assert.equal(finished.writes().length, 0);
  await code(fixture().broker.cancel("USDT", "12,13"), "invalidOrderIdentifier");
  const gone = fixture({ cancel: () => new Response(`{"success":true,"code":0,"data":[{"orderId":${ORDER_ID},"errorCode":2041}]}`) });
  await code(gone.broker.cancel("USDT", ORDER_ID), "orderChanged");
  assert.equal(gone.vault.values.has(MARKER), false);
  const lost = fixture({ cancel: () => Promise.reject(new Error("timeout")) });
  await code(lost.broker.cancel("USDT", ORDER_ID), "orderOutcomeUnknown");
  assert.equal(JSON.parse(lost.vault.values.get(MARKER)!).orderID, ORDER_ID);
  assert.equal(lost.writes().length, 1);
  const odd = fixture({ cancel: () => new Response(`{"success":true,"code":0,"data":[{"orderId":${ORDER_ID},"errorCode":9}]}`) });
  await code(odd.broker.cancel("USDT", ORDER_ID), "orderOutcomeUnknown");
});

test("cancel still works when the key check would block new orders", async () => {
  const context = fixture({ keyInfo: { status: "VALID", ipWhiteList: "", permissions: "" } });
  await context.broker.cancel("USDT", ORDER_ID);
  assert.equal(context.writes().length, 1);
});

test("live candles use only public reads, stay small and are shared between devices", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  let now = NOW, fail = false;
  const broker = new MexcBroker(new MemoryVault([]), { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, now: () => now,
    fetch: async (url, init) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      if (fail) throw new Error("offline");
      if (url.includes("/contract/kline/")) return new Response(ok({ time: [1, 2, 3], open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], vol: [1, 2, 3] }));
      return new Response(ok({ symbol: SYMBOL, lastPrice: 700, timestamp: now }));
    } });
  const [a, b] = await Promise.all([broker.live(SYMBOL, "minute1"), broker.live(SYMBOL, "minute1")]);
  assert.equal(a.candles.length, 2);
  assert.deepEqual(a.candles.map(c => c.time), [2000, 3000]);
  assert.equal(a.ticker.lastPrice, 700);
  assert.equal(b, a);
  assert.equal(seen.length, 2, "two devices at once cost one pair of reads");
  assert.ok(seen.every(call => !call.headers.ApiKey && !call.headers.Signature), "no key on public reads");
  await broker.live(SYMBOL, "minute5");
  assert.equal(seen.length, 4, "another interval is its own entry");
  now += 801;
  await broker.live(SYMBOL, "minute1");
  assert.equal(seen.length, 6, "refreshed after the short cache");
  // A failure is not remembered.
  now += 801; fail = true;
  await code(broker.live(SYMBOL, "minute1"), "exchangeUnavailable");
  fail = false;
  assert.equal((await broker.live(SYMBOL, "minute1")).candles.length, 2);
  await code(broker.live("bad", "minute1"), "invalidSymbol");
  await code(broker.live(SYMBOL, "constructor" as never), "invalidRange");
  // The cache cannot grow without limit.
  for (let i = 0; i < 100; i++) await broker.live(`S${i}_USDT`, "minute1").catch(() => undefined);
  assert.ok((broker as unknown as { liveCache: Map<string, unknown> }).liveCache.size <= 32);
});

test("live candles do not disturb a locked broker", async () => {
  const context = fixture({ positions: [], create: () => Promise.reject(new Error("timeout")) });
  await code(context.broker.submit(await prepared(context)), "orderOutcomeUnknown");
  assert.equal((await context.broker.live(SYMBOL, "minute1")).candles.length, 2);
  assert.equal((await context.broker.status()).unresolvedOperation, true);
  assert.equal(context.writes().length, 1);
});

for (const [name, answer] of [
  ["HTTP 429", () => new Response("slow down", { status: 429 })],
  ["code 510", () => new Response(JSON.stringify({ success: false, code: 510 }))],
  ["HTTP 403", () => new Response("waf", { status: 403 })],
] as [string, () => Response][]) {
  test(`after ${name} live candles stop calling MEXC, while orders keep working`, async () => {
    let now = NOW, limited = true, liveCalls = 0, writes = 0;
    const vault = new MemoryVault([]);
    const broker = new MexcBroker(vault, { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, keyCheck: false, now: () => now,
      fetch: async (url, init) => {
        if (init.method === "POST") { writes++; return new Response(ok({ orderId: ORDER_ID })); }
        const signed = !!(init.headers as Record<string, string>).Signature;
        if (!signed && url.includes("/contract/kline/")) { liveCalls++; return limited ? answer() : new Response(ok({ time: [1, 2], open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], vol: [1, 2] })); }
        if (url.includes("/contract/detail")) return new Response(ok({ symbol: SYMBOL, baseCoin: "QQQSTOCK", settleCoin: "USDT", futureType: 1, state: 0, apiAllowed: true, contractSize: 0.01, priceUnit: 0.01, volUnit: 1, minVol: 1, maxVol: 28000, minLeverage: 1, maxLeverage: 100, positionOpenType: 3, takerFeeRate: 0.0002, makerFeeRate: 0 }));
        if (url.includes("/contract/ticker")) return new Response(ok({ symbol: SYMBOL, lastPrice: 700, bid1: 699.9, ask1: 700.1, fairPrice: 700, timestamp: now }));
        if (url.includes("position_mode")) return new Response(ok(1));
        if (url.includes("open_positions")) return new Response(ok([]));
        return new Response(ok({ currency: "USDT", equity: 1000, availableBalance: 900, availableOpen: 900, positionMargin: 0, frozenBalance: 0, unrealized: 0 }));
      } });
    await code(broker.live(SYMBOL, "minute1"), "rateLimited");
    assert.equal(liveCalls, 1);
    await new Promise(done => setImmediate(done));
    for (let second = 0; second < 9; second++) {
      now += 1000;
      await code(broker.live(SYMBOL, "minute1"), "rateLimited");
    }
    assert.equal(liveCalls, 1, "no call inside the first ten seconds");
    // The pause applies only to this path: a review and an order go straight through.
    assert.deepEqual(await broker.submit(await broker.prepare("USDT", openDraft)), { orderID: ORDER_ID });
    assert.equal(writes, 1);
    // Still limited after the pause: it asks once more, then waits twice as long.
    now += 1001;
    await code(broker.live(SYMBOL, "minute1"), "rateLimited");
    assert.equal(liveCalls, 2);
    await new Promise(done => setImmediate(done));
    now += 19_000;
    await code(broker.live(SYMBOL, "minute1"), "rateLimited");
    assert.equal(liveCalls, 2, "the second pause is twenty seconds");
    // Recovered: it works again and the next pause starts from the beginning.
    limited = false; now += 1_001;
    assert.equal((await broker.live(SYMBOL, "minute1")).candles.length, 2);
    await new Promise(done => setImmediate(done));
    assert.equal((broker as unknown as { livePause: number }).livePause, 0);
    // A clock that jumped backwards cannot stretch a pause past its limit.
    limited = true; now += 801;
    await code(broker.live(SYMBOL, "minute1"), "rateLimited");
    await new Promise(done => setImmediate(done));
    now -= 3_600_000; limited = false;
    assert.equal((await broker.live(SYMBOL, "minute1")).candles.length, 2);
  });
}

test("ordinary live failures do not pause anything", async () => {
  let calls = 0, now = NOW;
  const broker = new MexcBroker(new MemoryVault([]), { apiKey: API_KEY, apiSecret: SECRET, limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, now: () => now,
    fetch: async url => { if (url.includes("kline")) calls++; return new Response("bad gateway", { status: 502 }); } });
  await code(broker.live(SYMBOL, "minute1"), "exchangeUnavailable");
  await new Promise(done => setImmediate(done));
  now += 1000;
  await code(broker.live(SYMBOL, "minute1"), "exchangeUnavailable");
  assert.equal(calls, 2);
});

test("closed-order queries validate their range", async () => {
  const context = fixture();
  await code(context.broker.closedOrders("bad", 0, 1), "invalidSymbol");
  await code(context.broker.closedOrders(SYMBOL, 5, 1), "invalidRange");
  await code(context.broker.closedOrders(SYMBOL, 0, 91 * 86_400_000), "invalidRange");
  await code(context.broker.quotes(["bad"]), "invalidSymbol");
  await code(context.broker.authorizationURL(), "methodNotAllowed");
});

const leverageReview = (context: ReturnType<typeof fixture>, draft = leverageDraft) => context.broker.prepare("USDT", draft) as Promise<MexcLeveragePrepared>;
const held = { positionId: 1109973831, symbol: SYMBOL, positionType: 1, openType: 1, holdVol: 10, frozenVol: 0, holdAvgPrice: 690, leverage: 5, im: 13.8, liquidatePrice: 560 };

test("a leverage change writes the marker first, sends once and clears it", async () => {
  const context = fixture({ positions: [held] });
  const review = await leverageReview(context);
  assert.equal(review.previousLeverage, 5);
  assert.equal(review.direction, "LONG");
  assert.equal(review.holdVol, 10);
  assert.equal(review.margin, 13.8);
  assert.equal(review.liquidatePrice, 560);
  assert.equal(review.available, 900);
  assert.equal(context.writes().length, 0, "a review sends nothing");
  assert.deepEqual(await context.broker.submit(review), { leverage: 3 });
  assert.deepEqual(context.events, ["marker:set", "send:leverage", "marker:remove"]);
  assert.equal(context.writes().length, 1);
  const call = context.writes()[0], body = call.init.body as string, headers = call.init.headers as Record<string, string>;
  assert.match(call.url, /\/api\/v1\/private\/position\/change_leverage$/);
  assert.equal(body, '{"positionId":1109973831,"leverage":3}');
  assert.equal(headers.Signature, createHmac("sha256", SECRET).update(API_KEY + NOW + body).digest("hex"));
  assert.equal((await context.broker.status()).unresolvedOperation, false);
});

test("a leverage review works once, only as the original object, and only for 60 seconds", async () => {
  const context = fixture();
  const review = await leverageReview(context);
  await code(context.broker.submit({ ...review }), "reviewExpired");
  await code(context.broker.submit(review), "reviewExpired");
  const again = await leverageReview(context);
  await context.broker.submit(again);
  await code(context.broker.submit(again), "reviewExpired");
  assert.equal(context.writes().length, 1);
  const late = await leverageReview(fixture());
  const stale = fixture();
  const old = await leverageReview(stale);
  stale.advance(60_001);
  await code(stale.broker.submit(old), "reviewExpired");
  assert.equal(stale.writes().length, 0);
  assert.equal(late.isDemo, false);
});

test("a newer review of either kind replaces a leverage review, and the other way round", async () => {
  const context = fixture();
  const first = await leverageReview(context);
  const order = await prepared(context);
  await code(context.broker.submit(first), "reviewExpired");
  assert.equal(context.writes().length, 0);
  const newer = await prepared(context);
  await leverageReview(context);
  await code(context.broker.submit(order), "reviewExpired");
  await code(context.broker.submit(newer), "reviewExpired");
  assert.equal(context.writes().length, 0);
});

test("a leverage change stops on the server's rules before anything is written", async () => {
  await code(leverageReview(fixture(), { ...leverageDraft, leverage: 6 }), "leverageLimit");
  await code(leverageReview(fixture(), { ...leverageDraft, leverage: 5 }), "leverageUnchanged");
  await code(leverageReview(fixture({ positions: [] })), "positionChanged");
  await code(leverageReview(fixture({ positions: [{ ...held, openType: 2 }] })), "leverageCross");
  await code(leverageReview(fixture({ positionMode: 2 })), "positionMode");
  await code(leverageReview(fixture(), { ...leverageDraft, positionId: "1" }), "positionChanged");
  await code(leverageReview(fixture(), { ...leverageDraft, vol: "1" } as unknown as MexcLeverageDraft), "invalidDraft");
  await code(fixture().broker.prepare("OTHER", leverageDraft), "invalidAccount");
  await code(fixture().broker.prepare("USDT", leverageDraft, "extra"), "invalidDraft");
});

test("submit re-checks the position instead of trusting the leverage review", async () => {
  for (const change of [{ leverage: 4 }, { holdVol: 12 }, { positionType: 2 }]) {
    const positions = [{ ...held }];
    const context = fixture({ positions });
    const review = await leverageReview(context);
    Object.assign(positions[0], change);
    await code(context.broker.submit(review), "reviewExpired");
    assert.equal(context.writes().length, 0, JSON.stringify(change));
    assert.equal(context.vault.values.has(MARKER), false);
  }
  const positions = [{ ...held }];
  const closed = fixture({ positions });
  const review = await leverageReview(closed);
  positions.length = 0;
  await code(closed.broker.submit(review), "positionChanged");
  assert.equal(closed.writes().length, 0);
});

test("a proven refusal of a leverage change unlocks and says what happened", async () => {
  for (const [exchange, expected] of [[2019, "leverageOrdersOpen"], [2044, "leverageMargin"], [2005, "leverageMargin"], [2009, "positionChanged"], [2026, "leverageCross"],
    [8821, "leverageSizeLimit"], [2006, "leverageLimit"], [9073, "marketClosed"], [1000, "leverageRejected"], [2001, "leverageRejected"]] as const) {
    const context = fixture({ changeLeverage: () => new Response(JSON.stringify({ success: false, code: exchange, message: "internal text" })) });
    await code(context.broker.submit(await leverageReview(context)), expected);
    assert.equal(context.vault.values.has(MARKER), false, String(exchange));
    assert.equal((await context.broker.status()).unresolvedOperation, false);
    assert.equal(context.writes().length, 1);
  }
});

test("anything short of proof leaves a leverage change locked, and orders with it", async () => {
  const answers: (() => Response | Promise<Response>)[] = [
    () => new Response(JSON.stringify({ success: false, code: 9999 })),
    () => new Response(JSON.stringify({ success: false, code: 603 })),
    () => new Response("bad gateway", { status: 502 }),
    () => new Response("<html>"),
    () => new Response(JSON.stringify({ success: true, code: 1 })),
    () => { throw new Error("connection lost"); },
  ];
  for (const answer of answers) {
    const context = fixture({ changeLeverage: answer });
    await code(context.broker.submit(await leverageReview(context)), "orderOutcomeUnknown");
    assert.equal(context.writes().length, 1, "never sent twice");
    assert.ok(context.vault.values.has(MARKER));
    assert.equal(JSON.parse(context.vault.values.get(MARKER)!).operation, "leverage");
    assert.equal((await context.broker.status()).unresolvedOperation, true);
    await code(prepared(context), "orderOutcomeUnknown");
    await code(leverageReview(context), "orderOutcomeUnknown");
    assert.equal(context.writes().length, 1);
  }
});

test("a leverage change waits behind an unresolved order, and no request leaves without the marker", async () => {
  const locked = fixture({ create: () => { throw new Error("connection lost"); }, positions: [] });
  await code(locked.broker.submit(await prepared(locked)), "orderOutcomeUnknown");
  await code(leverageReview(locked), "orderOutcomeUnknown");
  const unstorable = fixture();
  const review = await leverageReview(unstorable);
  unstorable.vault.failSet = true;
  await code(unstorable.broker.submit(review), "secureStorage");
  assert.equal(unstorable.writes().length, 0);
});

test("a failed key lookup stops a leverage change, as it stops an opening order", async () => {
  const context = fixture({ keyStatus: 500 });
  await code(leverageReview(context), "keyCheckFailed");
  assert.equal(context.writes().length, 0);
  const off = fixture({ keyCheck: false, keyStatus: 500 });
  assert.deepEqual(await off.broker.submit(await leverageReview(off)), { leverage: 3 });
  assert.equal(off.calls.filter(call => call.url.includes("apiKeyInfo")).length, 0);
});

test("the recovery lookup reports the locked position's leverage", async () => {
  const positions = [{ ...held }];
  const context = fixture({ positions, changeLeverage: () => { throw new Error("connection lost"); } });
  await code(context.broker.submit(await leverageReview(context)), "orderOutcomeUnknown");
  const found = await context.broker.pendingOperation();
  assert.equal(found?.lookup, "found");
  assert.equal(found?.position?.leverage, 5);
  assert.equal(found?.marker.leverage, 3);
  assert.equal(found?.marker.positionId, "1109973831");
  assert.equal(found?.marker.previousLeverage, 5);
  positions.length = 0;
  assert.equal((await context.broker.pendingOperation())?.lookup, "notFound");
  assert.ok(context.vault.values.has(MARKER), "looking up never clears the lock");
});

test("a closed stock market refuses orders and cancels, and neither stays locked", async () => {
  const closed = () => new Response(JSON.stringify({ success: false, code: 9073 }));
  const order = fixture({ positions: [], create: closed });
  await code(order.broker.submit(await prepared(order)), "marketClosed");
  assert.deepEqual(order.events, ["marker:set", "send:create", "marker:remove"]);
  assert.equal((await order.broker.status()).unresolvedOperation, false);
  const cancel = fixture({ cancel: closed });
  await code(cancel.broker.cancel("USDT", ORDER_ID), "cancelRejected");
  assert.deepEqual(cancel.events, ["marker:set", "send:cancel", "marker:remove"]);
  assert.equal((await cancel.broker.status()).unresolvedOperation, false);
});

const stopPlace: MexcStopDraft = { kind: "STOP_PLACE", symbol: SYMBOL, positionId: "1109973831", takeProfitPrice: "720", stopLossPrice: "680" };
const stopWaiting = { id: 357859177, symbol: SYMBOL, positionId: 1109973831, positionType: 1, state: 1, isFinished: 0, takeProfitPrice: 720, stopLossPrice: 680, vol: 10 };
const stopChange: MexcStopDraft = { ...stopPlace, kind: "STOP_CHANGE", stopOrderId: "357859177", takeProfitPrice: "730", stopLossPrice: "670" };
const stopCancel: MexcStopDraft = { kind: "STOP_CANCEL", symbol: SYMBOL, positionId: "1109973831", stopOrderId: "357859177" };
const stopReview = (context: ReturnType<typeof fixture>, draft = stopPlace) => context.broker.prepare("USDT", draft) as Promise<MexcStopPrepared>;

test("setting a take-profit and stop-loss writes the marker first, sends once and clears it", async () => {
  const context = fixture({ positions: [held] });
  const review = await stopReview(context);
  assert.equal(review.vol, "10");
  assert.equal(review.direction, "LONG");
  assert.equal(context.writes().length, 0, "a review sends nothing");
  assert.deepEqual(await context.broker.submit(review), { stopKind: "STOP_PLACE" });
  assert.deepEqual(context.events, ["marker:set", "send:stop", "marker:remove"]);
  const call = context.writes()[0], body = call.init.body as string, headers = call.init.headers as Record<string, string>;
  assert.match(call.url, /\/api\/v1\/private\/stoporder\/place$/);
  assert.equal(body, '{"positionId":1109973831,"vol":10,"volType":2,"profitLossVolType":"SAME","takeProfitType":0,"stopLossType":0,"lossTrend":2,"profitTrend":2,"takeProfitReverse":2,"stopLossReverse":2,"takeProfitPrice":720,"stopLossPrice":680}');
  assert.equal(headers.Signature, createHmac("sha256", SECRET).update(API_KEY + NOW + body).digest("hex"));
  assert.equal((await context.broker.status()).unresolvedOperation, false);
});

test("changing and cancelling reach their own endpoints with the id they named", async () => {
  const changing = fixture({ positions: [held], stops: [stopWaiting], stopWrite: () => new Response(JSON.stringify({ success: true, code: 0 })) });
  const change = await stopReview(changing, stopChange);
  assert.deepEqual(change.existing, { takeProfitPrice: 720, stopLossPrice: 680, vol: 10 });
  assert.deepEqual(await changing.broker.submit(change), { stopKind: "STOP_CHANGE" });
  assert.match(changing.writes()[0].url, /stoporder\/change_plan_price$/);
  assert.equal(changing.writes()[0].init.body, '{"stopPlanOrderId":357859177,"lossTrend":2,"profitTrend":2,"takeProfitReverse":2,"stopLossReverse":2,"takeProfitPrice":730,"stopLossPrice":670}');
  const cancelling = fixture({ positions: [held], stops: [stopWaiting], stopWrite: () => new Response(JSON.stringify({ success: true, code: 0 })) });
  assert.deepEqual(await cancelling.broker.submit(await stopReview(cancelling, stopCancel)), { stopKind: "STOP_CANCEL" });
  assert.match(cancelling.writes()[0].url, /stoporder\/cancel$/);
  assert.equal(cancelling.writes()[0].init.body, '[{"stopPlanOrderId":357859177}]');
});

test("a stop review works once, only as the original object, and only for 60 seconds", async () => {
  const context = fixture();
  const review = await stopReview(context);
  await code(context.broker.submit({ ...review }), "reviewExpired");
  await code(context.broker.submit(review), "reviewExpired");
  const again = await stopReview(context);
  await context.broker.submit(again);
  await code(context.broker.submit(again), "reviewExpired");
  assert.equal(context.writes().length, 1);
  const stale = fixture();
  const old = await stopReview(stale);
  stale.advance(60_001);
  await code(stale.broker.submit(old), "reviewExpired");
  assert.equal(stale.writes().length, 0);
});

test("a newer review of any kind replaces a stop review, and the other way round", async () => {
  const context = fixture();
  const stop = await stopReview(context);
  const order = await prepared(context);
  await code(context.broker.submit(stop), "reviewExpired");
  const next = await stopReview(context);
  await code(context.broker.submit(order), "reviewExpired");
  await leverageReview(context);
  await code(context.broker.submit(next), "reviewExpired");
  assert.equal(context.writes().length, 0);
});

test("the server's rules stop a stop request before anything is written", async () => {
  await code(stopReview(fixture(), { ...stopPlace, takeProfitPrice: "690" }), "stopPriceSide");
  await code(stopReview(fixture({ positions: [] })), "positionChanged");
  await code(stopReview(fixture({ positionMode: 2 })), "positionMode");
  await code(stopReview(fixture({ stops: [stopWaiting] })), "stopExists");
  await code(stopReview(fixture(), stopChange), "stopChanged");
  await code(stopReview(fixture({ stops: [stopWaiting] }), { ...stopChange, stopLossPrice: undefined }), "stopSideRequired");
  await code(stopReview(fixture(), { ...stopPlace, vol: "1" } as unknown as MexcStopDraft), "invalidDraft");
  await code(fixture().broker.prepare("OTHER", stopPlace), "invalidAccount");
});

test("submit re-checks the position and the prices instead of trusting the stop review", async () => {
  for (const change of [{ holdVol: 12 }, { positionType: 2 }]) {
    const positions = [{ ...held }];
    const context = fixture({ positions });
    const review = await stopReview(context);
    Object.assign(positions[0], change);
    await assert.rejects(context.broker.submit(review));
    assert.equal(context.writes().length, 0, JSON.stringify(change));
    assert.equal(context.vault.values.has(MARKER), false);
  }
  const stops = [{ ...stopWaiting }];
  const moved = fixture({ stops });
  const review = await stopReview(moved, stopChange);
  stops[0].stopLossPrice = 675;
  await code(moved.broker.submit(review), "reviewExpired");
  assert.equal(moved.writes().length, 0);
  // It triggered in the meantime, so there is nothing left to change.
  const triggered = [{ ...stopWaiting }];
  const gone = fixture({ stops: triggered });
  const late = await stopReview(gone, stopChange);
  triggered[0].state = 3;
  await code(gone.broker.submit(late), "stopChanged");
  assert.equal(gone.writes().length, 0);
});

test("a proven refusal of a stop request unlocks and says what happened", async () => {
  for (const [exchange, expected] of [[5001, "stopPriceMissing"], [5002, "stopChanged"], [5003, "stopPriceInvalid"], [5004, "stopVolume"], [5005, "stopExists"], [5006, "stopRejected"],
    [2009, "positionChanged"], [9073, "marketClosed"], [1000, "stopRejected"]] as const) {
    const context = fixture({ stopWrite: () => new Response(JSON.stringify({ success: false, code: exchange, message: "internal text" })) });
    await code(context.broker.submit(await stopReview(context)), expected);
    assert.equal(context.vault.values.has(MARKER), false, String(exchange));
    assert.equal(context.writes().length, 1);
  }
});

test("anything short of proof leaves a stop request locked, and orders with it", async () => {
  const answers: (() => Response | Promise<Response>)[] = [
    () => new Response(JSON.stringify({ success: false, code: 9999 })),
    () => new Response("bad gateway", { status: 502 }),
    () => new Response("<html>"),
    () => new Response(JSON.stringify({ success: true, code: 1 })),
    () => { throw new Error("connection lost"); },
  ];
  for (const answer of answers) {
    const context = fixture({ stopWrite: answer });
    await code(context.broker.submit(await stopReview(context)), "orderOutcomeUnknown");
    assert.equal(context.writes().length, 1, "never sent twice");
    assert.equal(JSON.parse(context.vault.values.get(MARKER)!).operation, "stop");
    await code(prepared(context), "orderOutcomeUnknown");
    await code(stopReview(context), "orderOutcomeUnknown");
    await code(leverageReview(context), "orderOutcomeUnknown");
    assert.equal(context.writes().length, 1);
  }
});

test("an accepted answer only counts when it says what the request should", async () => {
  for (const data of [357859177, "739113577038255616", { id: 1 }, [{ id: 1, errorCode: 0 }]]) {
    const context = fixture({ stopWrite: () => new Response(ok(data)) });
    assert.deepEqual(await context.broker.submit(await stopReview(context)), { stopKind: "STOP_PLACE" });
    assert.equal(context.vault.values.has(MARKER), false);
  }
  for (const data of [null, [], {}, 0, [{ id: 1, errorCode: 5 }]]) {
    const context = fixture({ stopWrite: () => new Response(ok(data)) });
    await code(context.broker.submit(await stopReview(context)), "orderOutcomeUnknown");
    assert.ok(context.vault.values.has(MARKER), JSON.stringify(data));
    assert.equal(context.writes().length, 1);
  }
  const partly = fixture({ stops: [stopWaiting], stopWrite: () => new Response(ok([{ stopPlanOrderId: 357859177, errorCode: 2041 }])) });
  await code(partly.broker.submit(await stopReview(partly, stopCancel)), "orderOutcomeUnknown");
  assert.ok(partly.vault.values.has(MARKER));
  const other = fixture({ stops: [stopWaiting], stopWrite: () => new Response(ok([{ stopPlanOrderId: 2, errorCode: 0 }])) });
  await code(other.broker.submit(await stopReview(other, stopCancel)), "orderOutcomeUnknown");
  assert.ok(other.vault.values.has(MARKER));
});

test("a market data outage cannot hold up cancelling, and does hold up setting", async () => {
  const context = fixture({ marketDown: true, stops: [stopWaiting], stopWrite: () => new Response(JSON.stringify({ success: true, code: 0 })) });
  const review = await stopReview(context, stopCancel);
  assert.equal(review.displayName, SYMBOL);
  assert.deepEqual(await context.broker.submit(review), { stopKind: "STOP_CANCEL" });
  await assert.rejects(stopReview(fixture({ marketDown: true })));
});

test("a failed key lookup lets stops through as it does a close, and a bad key does not", async () => {
  const lookup = fixture({ keyStatus: 500 });
  assert.deepEqual(await lookup.broker.submit(await stopReview(lookup)), { stopKind: "STOP_PLACE" });
  const moves = { status: "VALID", ipWhiteList: "<gateway-host>", permissions: "CONTRACT_DEAL_WRITE,SPOT_WITHDRAW", remainingValidity: -999 };
  const bad = fixture({ keyInfo: moves, stops: [stopWaiting] });
  await assert.rejects(stopReview(bad, stopChange));
  assert.equal(bad.writes().length, 0);
  // A cancel is never held back by the key.
  const cancel = fixture({ keyInfo: moves, stops: [stopWaiting] });
  assert.deepEqual(await cancel.broker.submit(await stopReview(cancel, stopCancel)), { stopKind: "STOP_CANCEL" });
});

test("reading stops needs a real symbol and returns only what is waiting", async () => {
  const context = fixture({ stops: [stopWaiting, { ...stopWaiting, id: 2, state: 3 }] });
  const rows = await context.broker.stopOrders(SYMBOL);
  assert.deepEqual(rows.map(row => row.id), ["357859177"]);
  assert.match(context.calls.at(-1)!.url, /stoporder\/open_orders\?symbol=QQQSTOCK_USDT$/);
  assert.equal((await context.broker.stopOrders()).length, 1);
  await code(context.broker.stopOrders("a/b"), "invalidSymbol");
  assert.equal(context.writes().length, 0);
});

test("an opening order's take-profit and stop-loss reach the exchange in the order itself", async () => {
  const context = fixture({ positions: [] });
  const review = await prepared(context, { ...openDraft, takeProfitPrice: "720", stopLossPrice: "680" });
  assert.equal(review.draft.takeProfitPrice, "720");
  await context.broker.submit(review);
  const body = JSON.parse(context.writes()[0].init.body as string);
  assert.equal(body.takeProfitPrice, 720);
  assert.equal(body.profitTrend, 2);
  assert.equal(body.stopLossPrice, 680);
  assert.equal(body.lossTrend, 2);
  await code(prepared(fixture({ positions: [] }), { ...openDraft, takeProfitPrice: "690" }), "stopPriceSide");
  // MEXC's wording does not prove the order was not created, so this stays locked.
  const refused = fixture({ positions: [], create: () => new Response(JSON.stringify({ success: false, code: 5003 })) });
  await code(refused.broker.submit(await prepared(refused, { ...openDraft, stopLossPrice: "680" })), "orderOutcomeUnknown");
  assert.ok(refused.vault.values.has(MARKER));
  // Nothing is sent when a position already held would make MEXC refuse it that way.
  const onHeld = fixture({ positions: [held] });
  await code(prepared(onHeld, { ...openDraft, stopLossPrice: "680" }), "stopOnHeldPosition");
  assert.equal(onHeld.writes().length, 0);
});

test("the recovery lookup reports what is waiting and never clears the lock", async () => {
  const stops = [{ ...stopWaiting }];
  const context = fixture({ stops, stopWrite: () => { throw new Error("connection lost"); } });
  await code(context.broker.submit(await stopReview(context, stopChange)), "orderOutcomeUnknown");
  const found = await context.broker.pendingOperation();
  assert.equal(found?.lookup, "found");
  assert.equal(found?.marker.stopKind, "STOP_CHANGE");
  assert.equal(found?.marker.takeProfitPrice, "730");
  assert.equal(found?.stopOrders?.[0].takeProfitPrice, 720);
  stops.length = 0;
  assert.equal((await context.broker.pendingOperation())?.lookup, "notFound");
  assert.ok(context.vault.values.has(MARKER));
});
