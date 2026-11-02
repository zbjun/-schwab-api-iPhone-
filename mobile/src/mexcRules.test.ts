import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFINITE_REJECTIONS, cancelOutcome, canonicalDecimal, classifyMexcResponse, createdOrderID, decodeMexcHistory, decodeMexcOrder,
  decodeMexcPositions, encodeMexcCancel, encodeMexcOrder, freezeMexcDraft, isMultipleOf, mexcClosable, mexcHistoryRequest, mexcKeyProblem,
  parseLossless, planMexcOrder, plainNumber, toTick, validateMexcDraft, validateMexcLimits,
} from "./mexcRules.ts";
import type { MexcContract, MexcDraft, MexcOrderContext, MexcPosition, MexcTicker } from "./mexcRules.ts";

const NOW = 1_800_000_000_000;
const contract: MexcContract = {
  symbol: "QQQSTOCK_USDT", displayName: "QQQ_USDT PERPETUAL", baseCoin: "QQQSTOCK", settleCoin: "USDT", futureType: 1, state: 0,
  apiAllowed: true, contractSize: 0.01, priceUnit: 0.01, volUnit: 1, minVol: 1, maxVol: 28000, minLeverage: 1, maxLeverage: 100,
  positionOpenType: 3, takerFeeRate: 0.0002, makerFeeRate: 0,
};
const ticker: MexcTicker = { symbol: "QQQSTOCK_USDT", lastPrice: 700, bid1: 699.9, ask1: 700.1, fairPrice: 700, maxBidPrice: 840, minAskPrice: 560, timestamp: NOW - 1000 };
const long: MexcPosition = { id: "1109973831", symbol: "QQQSTOCK_USDT", direction: "LONG", openType: 1, holdVol: 10, frozenVol: 2, averagePrice: 690, leverage: 5 };
const openDraft: MexcDraft = { symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", kind: "LIMIT", vol: "10", price: "700", leverage: 5 };
const context = (overrides: Partial<MexcOrderContext> = {}): MexcOrderContext => ({
  draft: openDraft, contract, ticker, positions: [], availableOpen: 1000, positionMode: 1,
  limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, now: NOW, ...overrides,
});
const code = (work: () => unknown, expected: string) => assert.throws(work, (error: { code?: string }) => error.code === expected);

test("decimal helpers use exact arithmetic", () => {
  assert.equal(isMultipleOf("0.3", 0.1), true); // 0.3 / 0.1 is not an integer in binary floats.
  assert.equal(isMultipleOf("1.005", 0.01), false);
  assert.equal(isMultipleOf("698.40", 0.01), true);
  assert.equal(isMultipleOf("1", 1e-7), true);
  assert.equal(plainNumber(1e-7), "0.0000001");
  assert.equal(plainNumber(1.5e-7), "0.00000015");
  assert.equal(canonicalDecimal("698.400"), "698.4");
  assert.equal(canonicalDecimal("700.00"), "700");
  assert.equal(toTick(707.101, 0.01, "down"), "707.1");
  assert.equal(toTick(692.901, 0.01, "up"), "692.91");
  assert.equal(toTick(100, 0.5, "down"), "100");
});

test("long order ids survive parsing as exact text", () => {
  const parsed = parseLossless('{"data":[{"orderId":101716841474621953,"price":109777.500000000000000000,"time":1609992674000}]}') as { data: Record<string, unknown>[] };
  assert.equal(parsed.data[0].orderId, "101716841474621953");
  assert.equal(parsed.data[0].price, 109777.5);
  assert.equal(parsed.data[0].time, 1609992674000);
  assert.equal(decodeMexcOrder({ orderId: "739106551624717312", symbol: "BTC_USDT", side: 1, price: 1, vol: 1, state: 2 }).id, "739106551624717312");
  assert.equal(encodeMexcCancel("101716841474621953"), "[101716841474621953]");
  code(() => encodeMexcCancel("1,2"), "invalidOrderIdentifier");
});

test("draft validation rejects malformed requests", () => {
  validateMexcDraft(openDraft);
  validateMexcDraft({ symbol: "QQQSTOCK_USDT", action: "CLOSE_LONG", kind: "MARKET", vol: "1" });
  code(() => validateMexcDraft({ ...openDraft, symbol: "qqq" }), "invalidSymbol");
  code(() => validateMexcDraft({ ...openDraft, symbol: "BTC_USD" }), "invalidSymbol");
  code(() => validateMexcDraft({ ...openDraft, vol: "0" }), "volumeInvalid");
  code(() => validateMexcDraft({ ...openDraft, vol: "1e3" }), "volumeInvalid");
  code(() => validateMexcDraft({ ...openDraft, price: undefined }), "priceInvalid");
  code(() => validateMexcDraft({ ...openDraft, kind: "MARKET" }), "invalidDraft");
  code(() => validateMexcDraft({ ...openDraft, leverage: undefined }), "leverageLimit");
  code(() => validateMexcDraft({ ...openDraft, leverage: 1.5 }), "leverageLimit");
  code(() => validateMexcDraft({ symbol: "QQQSTOCK_USDT", action: "CLOSE_LONG", kind: "MARKET", vol: "1", leverage: 5 }), "invalidDraft");
  code(() => validateMexcDraft({ ...openDraft, extra: true } as MexcDraft), "invalidDraft");
  assert.deepEqual(freezeMexcDraft({ ...openDraft, price: "700.00" }).price, "700");
});

test("limits configuration is validated", () => {
  validateMexcLimits({ maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 });
  assert.throws(() => validateMexcLimits({ maxLeverage: 0, maxOrderNotional: 1000, marketProtection: 0.01 }));
  assert.throws(() => validateMexcLimits({ maxLeverage: 5, maxOrderNotional: 0, marketProtection: 0.01 }));
  assert.throws(() => validateMexcLimits({ maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.5 }));
});

test("an opening order within limits gets a full plan", () => {
  const plan = planMexcOrder(context());
  assert.equal(plan.orderPrice, "700");
  assert.ok(Math.abs(plan.notional - 70.01) < 1e-9); // 10 x 0.01 x max(700, ask 700.1)
  assert.ok(Math.abs(plan.margin! - 14.002) < 1e-9);
  assert.equal(plan.openType, 1);
  assert.equal(plan.leverage, 5);
  assert.equal(plan.positionId, undefined);
});

test("server limits and contract rules stop an opening order", () => {
  code(() => planMexcOrder(context({ draft: { ...openDraft, leverage: 6 } })), "leverageLimit");
  code(() => planMexcOrder(context({ contract: { ...contract, maxLeverage: 3 } })), "leverageLimit");
  code(() => planMexcOrder(context({ draft: { ...openDraft, vol: "143" } })), "notionalLimit");
  code(() => planMexcOrder(context({ availableOpen: 14 })), "insufficientFunds");
  code(() => planMexcOrder(context({ positionMode: 2 })), "positionMode");
  code(() => planMexcOrder(context({ contract: { ...contract, apiAllowed: false } })), "contractUnavailable");
  code(() => planMexcOrder(context({ contract: { ...contract, state: 4 } })), "contractUnavailable");
  code(() => planMexcOrder(context({ contract: { ...contract, settleCoin: "USDC" } })), "contractUnavailable");
  code(() => planMexcOrder(context({ contract: { ...contract, positionOpenType: 2 } })), "isolatedUnavailable");
  code(() => planMexcOrder(context({ ticker: { ...ticker, timestamp: NOW - 61_000 } })), "quoteStale");
  code(() => planMexcOrder(context({ draft: { ...openDraft, price: "700.005" } })), "priceTick");
  code(() => planMexcOrder(context({ draft: { ...openDraft, vol: "1.5" } })), "volumeInvalid");
  code(() => planMexcOrder(context({ draft: { ...openDraft, vol: "28001" }, limits: { maxLeverage: 5, maxOrderNotional: 1e9, marketProtection: 0.01 } })), "volumeInvalid");
  code(() => planMexcOrder(context({ draft: { ...openDraft, price: "900" } })), "priceLimit");
  code(() => planMexcOrder(context({ positions: [{ ...long, openType: 2 }] })), "positionCross");
  code(() => planMexcOrder(context({ positions: [{ ...long, leverage: 3 }] })), "leverageMismatch");
});

test("a limit sell below the market is valued at the market, not its lower price", () => {
  const plan = planMexcOrder(context({ draft: { ...openDraft, action: "OPEN_SHORT", price: "600", vol: "142" } }));
  assert.equal(plan.referencePrice, 699.9);
  assert.ok(Math.abs(plan.notional - 142 * 0.01 * 699.9) < 1e-9);
  code(() => planMexcOrder(context({ draft: { ...openDraft, action: "OPEN_SHORT", price: "600", vol: "143" } })), "notionalLimit");
});

test("market orders become a protected price that is bounded on both sides", () => {
  const buy = planMexcOrder(context({ draft: { symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", kind: "MARKET", vol: "1", leverage: 5 } }));
  assert.equal(buy.orderPrice, "707.1"); // 700.1 x 1.01 = 707.101, snapped down.
  const sell = planMexcOrder(context({ draft: { symbol: "QQQSTOCK_USDT", action: "OPEN_SHORT", kind: "MARKET", vol: "1", leverage: 5 } }));
  assert.equal(sell.orderPrice, "692.91"); // 699.9 x 0.99 = 692.901, snapped up.
  code(() => planMexcOrder(context({ draft: { symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", kind: "MARKET", vol: "1", leverage: 5 }, ticker: { ...ticker, ask1: undefined } })), "quoteMissing");
  // On re-check the price the user approved is kept, not recomputed from the moved market.
  const again = planMexcOrder(context({ draft: { symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", kind: "MARKET", vol: "1", leverage: 5 }, ticker: { ...ticker, ask1: 705 }, reviewedPrice: "707.1" }));
  assert.equal(again.orderPrice, "707.1");
});

test("market orders need a fresh quote close to the mark price", () => {
  const market: MexcDraft = { symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", kind: "MARKET", vol: "1", leverage: 5 };
  code(() => planMexcOrder(context({ draft: market, ticker: { ...ticker, ask1: 707.1 } })), "quoteDeviation"); // 1.01% above the mark.
  code(() => planMexcOrder(context({ draft: market, ticker: { ...ticker, fairPrice: undefined } })), "quoteDeviation");
  code(() => planMexcOrder(context({ draft: market, ticker: { ...ticker, timestamp: NOW - 11_000 } })), "quoteStale");
  // On re-check the same limits apply, even though the approved price is kept.
  code(() => planMexcOrder(context({ draft: market, ticker: { ...ticker, ask1: 710 }, reviewedPrice: "707.1" })), "quoteDeviation");
  // A limit order is the way out: it needs neither.
  assert.equal(planMexcOrder(context({ ticker: { ...ticker, ask1: 800, fairPrice: undefined, timestamp: NOW - 30_000 } })).orderPrice, "700");
});

test("closing is limited by the closable position, not by the opening limits", () => {
  const close: MexcDraft = { symbol: "QQQSTOCK_USDT", action: "CLOSE_LONG", kind: "LIMIT", vol: "8", price: "700" };
  const plan = planMexcOrder(context({ draft: close, positions: [long], limits: { maxLeverage: 1, maxOrderNotional: 1, marketProtection: 0.01 }, availableOpen: 0 }));
  assert.equal(plan.closable, 8);
  assert.equal(plan.positionId, "1109973831");
  assert.equal(plan.leverage, undefined);
  code(() => planMexcOrder(context({ draft: { ...close, vol: "9" }, positions: [long] })), "insufficientPosition");
  code(() => planMexcOrder(context({ draft: close, positions: [] })), "insufficientPosition");
  // A long position cannot be closed by the short side's action.
  code(() => planMexcOrder(context({ draft: { ...close, action: "CLOSE_SHORT" }, positions: [long] })), "insufficientPosition");
  // Exact arithmetic: 0.3 - 0.1 is 0.2, not 0.19999999999999998.
  assert.equal(mexcClosable(0.3, 0.1), "0.2");
  assert.equal(mexcClosable(0.1 + 0.2, 0), "0.3");
  assert.equal(mexcClosable(5, 5), "0");
  assert.equal(mexcClosable(1, 2), "0");
  assert.throws(() => mexcClosable(Number.NaN, 0));
  const fractional = { ...contract, volUnit: 0.1, minVol: 0.1 };
  assert.equal(planMexcOrder(context({ contract: fractional, draft: { ...close, vol: "0.2" }, positions: [{ ...long, holdVol: 0.3, frozenVol: 0.1 }] })).closable, 0.2);
  code(() => planMexcOrder(context({ contract: fractional, draft: { ...close, vol: "0.3" }, positions: [{ ...long, holdVol: 0.3, frozenVol: 0.1 }] })), "insufficientPosition");
  // Cross positions can still be closed, with their own margin type.
  assert.equal(planMexcOrder(context({ draft: close, positions: [{ ...long, openType: 2, leverage: 50 }] })).openType, 2);
});

test("the order body carries exact values in the documented shape", () => {
  const plan = planMexcOrder(context());
  assert.deepEqual(JSON.parse(encodeMexcOrder(openDraft, plan, "ths0123456789abcdef")), {
    symbol: "QQQSTOCK_USDT", price: 700, vol: 10, side: 1, sideType: "buy", type: 1, openType: 1,
    positionType: "long", positionMode: 1, externalOid: "ths0123456789abcdef", leverage: 5,
  });
  const market = encodeMexcOrder({ symbol: "QQQSTOCK_USDT", action: "CLOSE_LONG", kind: "MARKET", vol: "8" },
    { orderPrice: "692.91", referencePrice: 699.9, notional: 55, openType: 1, closable: 8, positionId: "101716841474621953" }, "ths0123456789abcdef");
  assert.match(market, /"price":692\.91,/);
  assert.match(market, /"side":4,"sideType":"sell","type":3,/);
  assert.match(market, /"positionType":"long"/);
  assert.match(market, /"positionId":101716841474621953/);
  assert.doesNotMatch(market, /leverage/);
  assert.throws(() => encodeMexcOrder(openDraft, plan, 'x","vol":99,"a":"bbbbbb'));
});

test("only a proven refusal counts as rejected; everything else stays unknown", () => {
  const refused = (body: unknown, status = 200) => classifyMexcResponse(status, JSON.stringify(body));
  assert.deepEqual(refused({ success: true, code: 0, data: { orderId: "1", ts: 1 } }), { kind: "accepted", data: { orderId: "1", ts: 1 } });
  assert.equal(refused({ success: false, code: 2005 }).kind, "rejected");
  assert.deepEqual(refused({ success: false, code: 2005 }), { kind: "rejected", code: "insufficientFunds", exchangeCode: 2005 });
  assert.equal(refused({ success: false, code: 602 }).kind, "rejected");
  for (const ambiguous of [500, 501, 603, 604, 801, 2042, 6008, 9999, 12345])
    assert.deepEqual(refused({ success: false, code: ambiguous }), { kind: "unknown" }, String(ambiguous));
  assert.deepEqual(refused({ success: true }), { kind: "unknown" });
  assert.deepEqual(refused({ success: true, code: 7 }), { kind: "unknown" });
  assert.deepEqual(classifyMexcResponse(200, "<html>gateway</html>"), { kind: "unknown" });
  assert.deepEqual(classifyMexcResponse(502, "bad gateway"), { kind: "unknown" });
  assert.deepEqual(classifyMexcResponse(504, JSON.stringify({ success: false, code: 2005 })), { kind: "unknown" });
  assert.deepEqual(classifyMexcResponse(408, ""), { kind: "unknown" });
  assert.deepEqual(classifyMexcResponse(301, ""), { kind: "unknown" });
  assert.deepEqual(classifyMexcResponse(429, "slow down"), { kind: "rejected", code: "rateLimited" });
  assert.deepEqual(classifyMexcResponse(403, "waf"), { kind: "rejected", code: "exchangeRejected" });
  assert.deepEqual(classifyMexcResponse(401, ""), { kind: "rejected", code: "apiKeyRejected" });
  // A 4xx that names an ambiguous code is not treated as an edge refusal.
  assert.deepEqual(classifyMexcResponse(400, JSON.stringify({ success: false, code: 500 })), { kind: "unknown" });
});

test("a 4xx only unlocks when it proves the request stopped at the edge", () => {
  const cases: [number, string][] = [
    [400, JSON.stringify({ success: true, code: 0, data: { orderId: "1" } })],
    [400, JSON.stringify({ code: 500, msg: "x" })],
    [401, JSON.stringify({ code: 500 })],
    [403, JSON.stringify({ success: true })],
    [429, JSON.stringify({ success: true, code: 0, data: { orderId: "1" } })],
    [400, ""],
    [404, "<html>"],
    [409, ""],
    [460, ""],
    [499, ""],
  ];
  for (const [status, body] of cases)
    assert.deepEqual(classifyMexcResponse(status, body), { kind: "unknown" }, `${status} ${body}`);
  // A listed refusal still counts when it arrives on a 4xx.
  assert.deepEqual(classifyMexcResponse(400, JSON.stringify({ success: false, code: 2005 })), { kind: "rejected", code: "insufficientFunds", exchangeCode: 2005 });
  assert.deepEqual(classifyMexcResponse(400, JSON.stringify({ code: 2005 })), { kind: "rejected", code: "insufficientFunds", exchangeCode: 2005 });
});

test("the list of codes that may unlock trading only changes on purpose", () => {
  // Adding a code here means proving from MEXC's documentation that the order did not exist.
  assert.deepEqual(Object.keys(DEFINITE_REJECTIONS).map(Number).sort((a, b) => a - b), [
    401, 402, 406, 506, 510, 511, 513, 600, 601, 602, 701, 702, 703, 704, 1000, 1001, 1002, 1003, 1004,
    2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2011, 2015, 2021, 2022, 2027, 2028, 2029, 2032, 2033, 2035, 2036, 2037,
    2040, 2041, 2043, 2051, 2057, 6001, 6005, 7002, 7008, 8930, 9070, 9071, 300002,
  ]);
  for (const ambiguous of [0, 500, 501, 603, 604, 801, 2042, 6008, 9999]) assert.equal(Object.hasOwn(DEFINITE_REJECTIONS, ambiguous), false, String(ambiguous));
});

test("created order ids and cancel answers are checked strictly", () => {
  assert.equal(createdOrderID({ orderId: "739113577038255616", ts: 1 }), "739113577038255616");
  assert.equal(createdOrderID({ orderId: 739113577038255, ts: 1 }), "739113577038255");
  assert.equal(createdOrderID({ orderId: 1.5 }), undefined);
  assert.equal(createdOrderID({ ts: 1 }), undefined);
  assert.equal(createdOrderID({ orderId: "abc" }), undefined);
  assert.equal(createdOrderID(null), undefined);
  assert.equal(cancelOutcome([{ orderId: "5", errorCode: 0 }], "5"), "cancelled");
  assert.equal(cancelOutcome([{ orderId: "5", errorCode: 2040 }], "5"), "changed");
  assert.equal(cancelOutcome([{ orderId: "5", errorCode: 2041 }], "5"), "changed");
  assert.equal(cancelOutcome([{ orderId: "5", errorCode: 9 }], "5"), "unknown");
  assert.equal(cancelOutcome([{ orderId: "6", errorCode: 0 }], "5"), "unknown");
  assert.equal(cancelOutcome([], "5"), "unknown");
  assert.equal(cancelOutcome(null, "5"), "unknown");
});

test("the key must be bound to an IP, able to trade futures, and unable to move money", () => {
  const good = { status: "VALID", ipWhiteList: "<gateway-host>", permissions: "SPOT_ACCOUNT_READ,CONTRACT_ACCOUNT_READ,CONTRACT_DEAL_READ,CONTRACT_DEAL_WRITE", remainingValidity: -999 };
  assert.equal(mexcKeyProblem(good), undefined);
  assert.equal(mexcKeyProblem({ ...good, status: "FROZEN" }), "keyInvalid");
  // An error reply is not a verdict on the key, so it is not remembered as one.
  assert.equal(mexcKeyProblem({ code: 500, msg: "busy" }), "keyCheckFailed");
  assert.equal(mexcKeyProblem({ ...good, remainingValidity: 0 }), "keyInvalid");
  assert.equal(mexcKeyProblem({ ...good, ipWhiteList: "" }), "keyNotBound");
  assert.equal(mexcKeyProblem({ ...good, ipWhiteList: undefined }), "keyNotBound");
  assert.equal(mexcKeyProblem({ ...good, permissions: good.permissions + ",SPOT_TRANSFER_WRITE" }), "keyMovesMoney");
  assert.equal(mexcKeyProblem({ ...good, permissions: good.permissions + ",spot_withdraw_write" }), "keyMovesMoney");
  // Anything not on the list closes trading, including permissions MEXC adds later.
  for (const extra of ["SPOT_DEAL_WRITE", "SPOT_ACCOUNT_WRITE", "CONTRACT_ACCOUNT_WRITE", "SUB_ACCOUNT_WRITE", "NEW_PERMISSION"])
    assert.equal(mexcKeyProblem({ ...good, permissions: good.permissions + "," + extra }), "keyPermissions", extra);
  assert.equal(mexcKeyProblem({ ...good, permissions: good.permissions + ",CAPITAL_TRANSFER" }), "keyMovesMoney");
  for (const wildcard of ["*", "0.0.0.0", "0.0.0.0/0", "::", "::/0", " , ", "<gateway-host>,0.0.0.0/0"])
    assert.equal(mexcKeyProblem({ ...good, ipWhiteList: wildcard }), "keyNotBound", wildcard);
  assert.equal(mexcKeyProblem({ ...good, permissions: "SPOT_ACCOUNT_READ,CONTRACT_DEAL_READ" }), "keyPermissions");
  assert.equal(mexcKeyProblem({ ...good, permissions: undefined }), "keyPermissions");
  assert.throws(() => mexcKeyProblem([]));
});

test("exchange payloads decode strictly", () => {
  const positions = decodeMexcPositions([{ positionId: 1109973831, symbol: "BTC_USDT", positionType: 2, openType: 1, holdVol: 3, frozenVol: 0, holdAvgPrice: 10, leverage: 2, liquidatePrice: 12 }]);
  assert.equal(positions[0].direction, "SHORT");
  assert.equal(positions[0].id, "1109973831");
  assert.throws(() => decodeMexcPositions([{ positionId: 1, symbol: "BTC_USDT", positionType: 3, openType: 1, holdVol: 3, frozenVol: 0, holdAvgPrice: 10, leverage: 2 }]));
  assert.throws(() => decodeMexcOrder({ orderId: "1", symbol: "BTC_USDT", side: 9, price: 1, vol: 1, state: 2 }));
  const closed = decodeMexcOrder({ orderId: "1", symbol: "BTC_USDT", side: 4, price: 1, vol: 1, state: 3 });
  assert.equal(closed.cancelable, false);
  assert.equal(closed.action, "CLOSE_LONG");
  const history = decodeMexcHistory({ time: [200, 100], open: [1, 2], high: [3, 4], low: [0.5, 1], close: [2, 3], vol: [5, 6] }, "BTC_USDT");
  assert.deepEqual(history.candles.map(c => c.time), [100_000, 200_000]);
  assert.throws(() => decodeMexcHistory({ time: [1], open: [], high: [], low: [], close: [], vol: [] }, "BTC_USDT"));
  assert.equal(mexcHistoryRequest("minute1", NOW).interval, "Min1");
  assert.equal(mexcHistoryRequest("daily", NOW).interval, "Day1");
  code(() => mexcHistoryRequest("minute120", NOW), "invalidRange");
  code(() => mexcHistoryRequest("constructor" as never, NOW), "invalidRange");
  code(() => mexcHistoryRequest("__proto__" as never, NOW), "invalidRange");
});
