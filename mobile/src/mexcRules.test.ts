import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFINITE_REJECTIONS, cancelOutcome, canonicalDecimal, classifyMexcResponse, createdOrderID, decodeMexcHistory, decodeMexcOrder,
  decodeMexcPositions, encodeMexcCancel, encodeMexcOrder, freezeMexcDraft, isMultipleOf, mexcClosable, mexcHistoryRequest, mexcKeyProblem, mexcLiveRequest,
  parseLossless, planMexcOrder, plainNumber, toTick, validateMexcDraft, validateMexcLimits,
  LEVERAGE_REJECTIONS, encodeMexcLeverage, freezeMexcLeverageDraft, isLeverageDraft, planMexcLeverage, validateMexcLeverageDraft,
  STOP_REJECTIONS, decodeMexcStopOrders, encodeMexcStop, freezeMexcStopDraft, isStopDraft, mexcStopPath, orderStopReferences, planMexcStop, planMexcStopCancel, stopOutcome, validateMexcStopDraft,
} from "./mexcRules.ts";
import type { MexcContract, MexcDraft, MexcLeverageContext, MexcLeverageDraft, MexcOrderContext, MexcPosition, MexcStopContext, MexcStopDraft, MexcStopOrder, MexcTicker } from "./mexcRules.ts";

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
    2040, 2041, 2043, 2051, 2057, 6001, 6005, 7002, 7008, 8930, 9070, 9071, 9073, 300002,
  ]);
  // Only a leverage change may be unlocked by these. Each says in MEXC's documentation that it was refused.
  assert.deepEqual(Object.keys(LEVERAGE_REJECTIONS).map(Number).filter(key => !Object.hasOwn(DEFINITE_REJECTIONS, key)).sort((a, b) => a - b),
    [2019, 2026, 2038, 2044, 8815, 8816, 8818, 8819, 8821, 8931]);
  assert.deepEqual(Object.keys(STOP_REJECTIONS).map(Number).filter(key => !Object.hasOwn(DEFINITE_REJECTIONS, key)).sort((a, b) => a - b),
    [5001, 5002, 5003, 5004, 5005, 5006]);
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
  const live = mexcLiveRequest("minute15", NOW);
  assert.equal(live.interval, "Min15");
  assert.equal(live.end - live.start, 2250); // Enough for the last two bars, not the whole chart.
  assert.equal(mexcLiveRequest("daily", NOW).interval, "Day1");
  // Every range asks for at least two bars of its own length.
  const bars = { intraday: 60, fiveDay: 300, minute1: 60, minute5: 300, minute15: 900, minute30: 1800, minute60: 3600, daily: 86_400, weekly: 604_800, monthly: 2_678_400 };
  for (const [range, seconds] of Object.entries(bars)) {
    const window = mexcLiveRequest(range as never, NOW);
    assert.ok(window.end - window.start >= 2 * seconds, range);
    assert.ok(window.end - window.start <= 3 * seconds, range);
  }
  code(() => mexcLiveRequest("constructor" as never, NOW), "invalidRange");
  code(() => mexcHistoryRequest("constructor" as never, NOW), "invalidRange");
  code(() => mexcHistoryRequest("__proto__" as never, NOW), "invalidRange");
});

const leverageDraft: MexcLeverageDraft = { kind: "LEVERAGE", symbol: "QQQSTOCK_USDT", positionId: "1109973831", leverage: 3 };
const leverageContext = (overrides: Partial<MexcLeverageContext> = {}): MexcLeverageContext => ({
  draft: leverageDraft, contract, positions: [long], availableOpen: 500, positionMode: 1,
  limits: { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 }, ...overrides,
});

test("a leverage change names the position as the server found it", () => {
  assert.deepEqual(planMexcLeverage(leverageContext()), {
    direction: "LONG", previousLeverage: 5, holdVol: 10, averagePrice: 690, margin: undefined, liquidatePrice: undefined, available: 500,
  });
});

test("a leverage change stops on every rule before anything could be sent", () => {
  const draft = (leverage: number) => ({ ...leverageDraft, leverage });
  code(() => planMexcLeverage(leverageContext({ positionMode: 2 })), "positionMode");
  code(() => planMexcLeverage(leverageContext({ contract: { ...contract, state: 1 } })), "contractUnavailable");
  code(() => planMexcLeverage(leverageContext({ contract: { ...contract, apiAllowed: false } })), "contractUnavailable");
  // The server cap and the contract's own range.
  code(() => planMexcLeverage(leverageContext({ draft: draft(6) })), "leverageLimit");
  code(() => planMexcLeverage(leverageContext({ draft: draft(3), contract: { ...contract, maxLeverage: 2 } })), "leverageLimit");
  code(() => planMexcLeverage(leverageContext({ draft: draft(1), contract: { ...contract, minLeverage: 2 } })), "leverageLimit");
  // Nothing to change, or nothing to change it on.
  code(() => planMexcLeverage(leverageContext({ draft: draft(5) })), "leverageUnchanged");
  code(() => planMexcLeverage(leverageContext({ positions: [] })), "positionChanged");
  code(() => planMexcLeverage(leverageContext({ positions: [{ ...long, id: "1" }] })), "positionChanged");
  code(() => planMexcLeverage(leverageContext({ positions: [{ ...long, holdVol: 0 }] })), "positionChanged");
  code(() => planMexcLeverage(leverageContext({ positions: [{ ...long, symbol: "OTHER_USDT" }] })), "positionChanged");
  code(() => planMexcLeverage(leverageContext({ positions: [{ ...long, openType: 2 }] })), "leverageCross");
});

test("a position above the server cap can come down to it", () => {
  const plan = planMexcLeverage(leverageContext({ draft: { ...leverageDraft, leverage: 5 }, positions: [{ ...long, leverage: 20 }] }));
  assert.equal(plan.previousLeverage, 20);
});

test("a leverage draft is strict and is never an order", () => {
  validateMexcLeverageDraft(leverageDraft);
  assert.equal(isLeverageDraft(leverageDraft), true);
  assert.equal(isLeverageDraft(openDraft), false);
  assert.equal(isLeverageDraft(null), false);
  assert.ok(Object.isFrozen(freezeMexcLeverageDraft(leverageDraft)));
  const row = leverageDraft as unknown as Record<string, unknown>;
  code(() => validateMexcLeverageDraft({ ...row, vol: "1" } as unknown as MexcLeverageDraft), "invalidDraft");
  code(() => validateMexcLeverageDraft({ ...row, kind: "LIMIT" } as unknown as MexcLeverageDraft), "invalidDraft");
  code(() => validateMexcLeverageDraft({ ...leverageDraft, symbol: "a/b" }), "invalidSymbol");
  code(() => validateMexcLeverageDraft({ ...leverageDraft, positionId: "12x" }), "positionChanged");
  for (const leverage of [0, -1, 2.5, NaN]) code(() => validateMexcLeverageDraft({ ...leverageDraft, leverage }), "leverageLimit");
  // The order path refuses it outright.
  code(() => validateMexcDraft(leverageDraft as unknown as MexcDraft), "invalidDraft");
});

test("a leverage change is sent with its full-length id and nothing else", () => {
  assert.equal(encodeMexcLeverage({ ...leverageDraft, positionId: "739113577038255616", leverage: 10 }), '{"positionId":739113577038255616,"leverage":10}');
  assert.throws(() => encodeMexcLeverage({ ...leverageDraft, positionId: '1,"leverage":100' }));
  assert.throws(() => encodeMexcLeverage({ ...leverageDraft, leverage: 2.5 }));
});

test("refusals only a leverage change can get unlock only a leverage change", () => {
  const refused = (exchange: number, table?: Record<number, string>) => classifyMexcResponse(200, JSON.stringify({ success: false, code: exchange }), table);
  for (const [exchange, expected] of [[2019, "leverageOrdersOpen"], [2044, "leverageMargin"], [2026, "leverageCross"], [8815, "leverageSizeLimit"], [8821, "leverageSizeLimit"], [8931, "leverageLimit"]] as const) {
    assert.deepEqual(refused(exchange, LEVERAGE_REJECTIONS), { kind: "rejected", code: expected, exchangeCode: exchange });
    // The order path stays as strict as before.
    assert.deepEqual(refused(exchange), { kind: "unknown" });
  }
  // Anything not listed could mean it applied, there as well.
  for (const exchange of [500, 501, 603, 9999]) assert.deepEqual(refused(exchange, LEVERAGE_REJECTIONS), { kind: "unknown" });
  assert.deepEqual(classifyMexcResponse(502, "bad gateway", LEVERAGE_REJECTIONS), { kind: "unknown" });
  // A closed stock market is a documented refusal: nothing can open or close.
  assert.equal(DEFINITE_REJECTIONS[9073], "marketClosed");
});

const place: MexcStopDraft = { kind: "STOP_PLACE", symbol: "QQQSTOCK_USDT", positionId: "1109973831", takeProfitPrice: "720", stopLossPrice: "680" };
const waiting: MexcStopOrder = { id: "357859177", symbol: "QQQSTOCK_USDT", positionId: "1109973831", direction: "LONG", takeProfitPrice: 720, stopLossPrice: 680, vol: 8 };
const stopContext = (overrides: Partial<MexcStopContext> = {}): MexcStopContext => ({
  draft: place, contract, ticker, positions: [long], stopOrders: [], positionMode: 1, now: NOW, ...overrides,
});

test("setting a take-profit and stop-loss covers what can be closed and names the position as found", () => {
  const plan = planMexcStop(stopContext());
  assert.equal(plan.direction, "LONG");
  assert.equal(plan.holdVol, 10);
  assert.equal(plan.vol, "8", "held minus what resting closes already reserve");
  assert.equal(plan.existing, undefined);
  assert.ok(Math.abs(plan.atTakeProfit! - (720 - 690) * 8 * contract.contractSize) < 1e-9);
  assert.ok(Math.abs(plan.atStopLoss! - (680 - 690) * 8 * contract.contractSize) < 1e-9);
});

test("each price must be on its own side of the fair price, for either direction", () => {
  const draft = (takeProfitPrice?: string, stopLossPrice?: string): MexcStopDraft => ({ ...place, takeProfitPrice, stopLossPrice });
  const short: MexcPosition = { ...long, direction: "SHORT" };
  planMexcStop(stopContext({ draft: draft("701", undefined) }));
  planMexcStop(stopContext({ draft: draft(undefined, "699") }));
  for (const bad of [draft("700", undefined), draft("699", undefined), draft(undefined, "700"), draft(undefined, "701")])
    code(() => planMexcStop(stopContext({ draft: bad })), "stopPriceSide");
  planMexcStop(stopContext({ draft: draft("699", "701"), positions: [short] }));
  for (const bad of [draft("701", undefined), draft(undefined, "699")])
    code(() => planMexcStop(stopContext({ draft: bad, positions: [short] })), "stopPriceSide");
  code(() => planMexcStop(stopContext({ draft: draft("720.001", undefined) })), "priceTick");
});

test("setting stops on every rule before anything could be sent", () => {
  code(() => planMexcStop(stopContext({ positions: [] })), "positionChanged");
  code(() => planMexcStop(stopContext({ positions: [{ ...long, id: "1" }] })), "positionChanged");
  code(() => planMexcStop(stopContext({ positions: [{ ...long, holdVol: 0, frozenVol: 0 }] })), "positionChanged");
  code(() => planMexcStop(stopContext({ positionMode: 2 })), "positionMode");
  code(() => planMexcStop(stopContext({ contract: { ...contract, state: 1 } })), "contractUnavailable");
  code(() => planMexcStop(stopContext({ now: NOW + 120_000 })), "quoteStale");
  code(() => planMexcStop(stopContext({ ticker: { ...ticker, fairPrice: undefined } })), "quoteMissing");
  code(() => planMexcStop(stopContext({ stopOrders: [waiting] })), "stopExists");
  code(() => planMexcStop(stopContext({ positions: [{ ...long, frozenVol: 10 }] })), "insufficientPosition");
  assert.throws(() => planMexcStop(stopContext({ contract: { ...contract, symbol: "OTHER_USDT" } })));
});

test("a change needs the one it names, keeps its size and cannot silently drop a price", () => {
  const change: MexcStopDraft = { ...place, kind: "STOP_CHANGE", stopOrderId: waiting.id, takeProfitPrice: "730", stopLossPrice: "670" };
  const plan = planMexcStop(stopContext({ draft: change, stopOrders: [waiting] }));
  assert.equal(plan.vol, "8");
  assert.deepEqual(plan.existing, { takeProfitPrice: 720, stopLossPrice: 680, vol: 8 });
  code(() => planMexcStop(stopContext({ draft: change, stopOrders: [] })), "stopChanged");
  code(() => planMexcStop(stopContext({ draft: change, stopOrders: [{ ...waiting, positionId: "2" }] })), "stopChanged");
  code(() => planMexcStop(stopContext({ draft: { ...change, stopLossPrice: undefined }, stopOrders: [waiting] })), "stopSideRequired");
  code(() => planMexcStop(stopContext({ draft: { ...change, takeProfitPrice: undefined }, stopOrders: [waiting] })), "stopSideRequired");
  // A side it never had may be added.
  planMexcStop(stopContext({ draft: change, stopOrders: [{ ...waiting, stopLossPrice: undefined }] }));
});

test("cancelling takes no quote or contract at all, only what it names", () => {
  const cancel: MexcStopDraft = { kind: "STOP_CANCEL", symbol: place.symbol, positionId: place.positionId, stopOrderId: waiting.id };
  const plan = planMexcStopCancel(cancel, [long], [waiting]);
  assert.equal(plan.vol, "8");
  assert.equal(plan.fairPrice, undefined);
  assert.deepEqual(plan.existing, { takeProfitPrice: 720, stopLossPrice: 680, vol: 8 });
  code(() => planMexcStopCancel(cancel, [long], []), "stopChanged");
  code(() => planMexcStopCancel(cancel, [], [waiting]), "positionChanged");
  // Each draft keeps to its own plan.
  code(() => planMexcStopCancel(place, [long], []), "invalidDraft");
  code(() => planMexcStop(stopContext({ draft: cancel, stopOrders: [waiting] })), "invalidDraft");
});

test("an accepted answer must say what the request should", () => {
  const set = { kind: "STOP_PLACE" as const };
  for (const data of [357859177, "739113577038255616", { id: 1 }, { orderId: "739113577038255616" }, { stopPlanOrderId: 5 }, [{ id: 1, errorCode: 0 }], [{ id: 1, errorCode: null }], [357859177]])
    assert.equal(stopOutcome(set, data), "done", JSON.stringify(data));
  for (const data of [undefined, null, false, true, [], {}, [{}], { id: "1,2" }, 1.5, -1, 0, "0", { id: 0 }, [{ id: 1, errorCode: 5 }], [{ id: 1 }, { errorCode: 2 }]])
    assert.equal(stopOutcome(set, data), "unknown", JSON.stringify(data));
  for (const kind of ["STOP_CHANGE", "STOP_CANCEL"] as const) {
    const named = { kind, stopOrderId: "7" };
    for (const data of [undefined, null, true, [], [{ errorCode: 0 }], [{ stopPlanOrderId: 7, errorCode: 0 }], [{ stopPlanOrderId: "7" }]]) assert.equal(stopOutcome(named, data), "done", JSON.stringify(data));
    for (const data of [false, [{ stopPlanOrderId: 7, errorCode: 2041 }], { errorCode: 1 }, [{ stopPlanOrderId: 8, errorCode: 0 }]]) assert.equal(stopOutcome(named, data), "unknown", JSON.stringify(data));
  }
});

test("a stop draft is strict and is never an order", () => {
  validateMexcStopDraft(place);
  assert.equal(isStopDraft(place), true);
  for (const other of [openDraft, null, { kind: "LIMIT" }, { kind: "LEVERAGE" }]) assert.equal(isStopDraft(other), false);
  const row = place as unknown as Record<string, unknown>;
  code(() => validateMexcStopDraft({ ...row, vol: "1" } as unknown as MexcStopDraft), "invalidDraft");
  code(() => validateMexcStopDraft({ ...place, stopOrderId: "1" }), "invalidDraft");
  code(() => validateMexcStopDraft({ ...place, kind: "STOP_CHANGE" }), "invalidDraft");
  code(() => validateMexcStopDraft({ ...place, kind: "STOP_CHANGE", stopOrderId: "1,2" }), "invalidDraft");
  code(() => validateMexcStopDraft({ kind: "STOP_CANCEL", symbol: place.symbol, positionId: place.positionId, stopOrderId: "1", stopLossPrice: "1" }), "invalidDraft");
  code(() => validateMexcStopDraft({ kind: "STOP_PLACE", symbol: place.symbol, positionId: place.positionId }), "stopPriceMissing");
  code(() => validateMexcStopDraft({ ...place, symbol: "a/b" }), "invalidSymbol");
  code(() => validateMexcStopDraft({ ...place, positionId: "12x" }), "positionChanged");
  for (const bad of ["0", "-1", "abc", "", "1e5"]) code(() => validateMexcStopDraft({ ...place, stopLossPrice: bad }), "stopPriceInvalid");
  assert.ok(Object.isFrozen(freezeMexcStopDraft(place)));
  assert.equal(freezeMexcStopDraft({ ...place, stopLossPrice: "680.50" }).stopLossPrice, "680.5");
  code(() => validateMexcDraft(place as unknown as MexcDraft), "invalidDraft");
});

test("stop requests carry exact values, a market exit and no reverse", () => {
  const plan = planMexcStop(stopContext());
  assert.equal(encodeMexcStop(place, plan),
    '{"positionId":1109973831,"vol":8,"volType":2,"profitLossVolType":"SAME","takeProfitType":0,"stopLossType":0,"lossTrend":2,"profitTrend":2,"takeProfitReverse":2,"stopLossReverse":2,"takeProfitPrice":720,"stopLossPrice":680}');
  const change: MexcStopDraft = { ...place, kind: "STOP_CHANGE", stopOrderId: "739113577038255616" };
  assert.equal(encodeMexcStop(change, plan), '{"stopPlanOrderId":739113577038255616,"lossTrend":2,"profitTrend":2,"takeProfitReverse":2,"stopLossReverse":2,"takeProfitPrice":720,"stopLossPrice":680}');
  const cancel: MexcStopDraft = { kind: "STOP_CANCEL", symbol: place.symbol, positionId: place.positionId, stopOrderId: "739113577038255616" };
  assert.equal(encodeMexcStop(cancel, plan), '[{"stopPlanOrderId":739113577038255616}]');
  assert.equal(encodeMexcStop({ ...place, stopLossPrice: undefined }, plan).includes("stopLossPrice"), false);
  assert.throws(() => encodeMexcStop({ ...place, positionId: '1,"vol":999' }, plan));
  assert.throws(() => encodeMexcStop({ ...cancel, stopOrderId: '1},{"stopPlanOrderId":2' }, plan));
  assert.equal(mexcStopPath("STOP_PLACE"), "/api/v1/private/stoporder/place");
  assert.equal(mexcStopPath("STOP_CHANGE"), "/api/v1/private/stoporder/change_plan_price");
  assert.equal(mexcStopPath("STOP_CANCEL"), "/api/v1/private/stoporder/cancel");
});

test("only what is still waiting comes back from the list", () => {
  const row = { id: 357859177, symbol: "QQQSTOCK_USDT", positionId: "1109973831", positionType: 1, state: 1, isFinished: 0, stopLossPrice: 680, takeProfitPrice: 0, vol: 8 };
  assert.deepEqual(decodeMexcStopOrders([row]), [{ id: "357859177", symbol: "QQQSTOCK_USDT", positionId: "1109973831", direction: "LONG", takeProfitPrice: undefined, stopLossPrice: 680, vol: 8 }]);
  for (const finished of [{ ...row, state: 3 }, { ...row, state: 2 }, { ...row, isFinished: 1 }]) assert.deepEqual(decodeMexcStopOrders([finished]), []);
  assert.deepEqual(decodeMexcStopOrders(null), []);
  assert.deepEqual(decodeMexcStopOrders({ resultList: [row] }).length, 1);
  assert.throws(() => decodeMexcStopOrders([{ ...row, positionType: 3 }]));
  assert.throws(() => decodeMexcStopOrders([{ ...row, id: "1,2" }]));
  assert.throws(() => decodeMexcStopOrders("no"));
});

test("an opening order can carry a take-profit and stop-loss, and a close cannot", () => {
  const draft: MexcDraft = { ...openDraft, takeProfitPrice: "720", stopLossPrice: "680" };
  validateMexcDraft(draft);
  const frozen = freezeMexcDraft(draft);
  assert.equal(frozen.takeProfitPrice, "720");
  const plan = planMexcOrder(context({ draft: frozen, positions: [] }));
  const body = JSON.parse(encodeMexcOrder(frozen, plan, "ths0123456789abcdef"));
  assert.equal(body.takeProfitPrice, 720);
  assert.equal(body.profitTrend, 2);
  assert.equal(body.stopLossPrice, 680);
  assert.equal(body.lossTrend, 2);
  const plain = JSON.parse(encodeMexcOrder(openDraft, planMexcOrder(context()), "ths0123456789abcdef"));
  for (const field of ["takeProfitPrice", "stopLossPrice", "profitTrend", "lossTrend"]) assert.equal(Object.hasOwn(plain, field), false);
  code(() => validateMexcDraft({ symbol: draft.symbol, action: "CLOSE_LONG", kind: "MARKET", vol: "1", stopLossPrice: "680" }), "invalidDraft");
  for (const bad of ["0", "-1", "x"]) code(() => validateMexcDraft({ ...openDraft, stopLossPrice: bad }), "stopPriceInvalid");
});

test("what an order carries is measured from where it should fill", () => {
  const limit = (takeProfitPrice?: string, stopLossPrice?: string) => context({ draft: { ...openDraft, takeProfitPrice, stopLossPrice }, positions: [] });
  planMexcOrder(limit("701", "699"));
  for (const bad of [limit("700", undefined), limit(undefined, "700"), limit("699", undefined), limit(undefined, "701")])
    code(() => planMexcOrder(bad), "stopPriceSide");
  code(() => planMexcOrder(limit("720.001", undefined)), "priceTick");
  // A market buy's order price is only its protection limit, one percent up: a take-profit below that is still fine.
  const market: MexcDraft = { symbol: openDraft.symbol, action: "OPEN_LONG", kind: "MARKET", vol: "10", leverage: 5, takeProfitPrice: "703" };
  planMexcOrder(context({ draft: market, positions: [] }));
  code(() => planMexcOrder(context({ draft: { ...market, takeProfitPrice: "700" }, positions: [] })), "stopPriceSide");
  const short: MexcDraft = { ...openDraft, action: "OPEN_SHORT", takeProfitPrice: "680", stopLossPrice: "720" };
  planMexcOrder(context({ draft: short, positions: [] }));
  code(() => planMexcOrder(context({ draft: { ...short, takeProfitPrice: "720", stopLossPrice: "680" }, positions: [] })), "stopPriceSide");
});

test("a stop-loss must clear the worst place an order could fill, and the fair price it watches", () => {
  const order = (rest: Partial<MexcDraft>, tick: Partial<MexcTicker> = {}) => context({ draft: { ...openDraft, ...rest }, positions: [], ticker: { ...ticker, ...tick } });
  // These fill near the quote, past a stop measured only from the limit.
  code(() => planMexcOrder(order({ price: "800", stopLossPrice: "750" })), "stopPriceSide");
  code(() => planMexcOrder(order({ action: "OPEN_SHORT", price: "600", stopLossPrice: "650" })), "stopPriceSide");
  planMexcOrder(order({ price: "800", stopLossPrice: "699" }));
  planMexcOrder(order({ action: "OPEN_SHORT", price: "600", stopLossPrice: "701" }));
  // Waiting below the market for a dip is fine: only the limit counts for a take-profit.
  planMexcOrder(order({ price: "650", takeProfitPrice: "690", stopLossPrice: "640" }));
  // A market order's stops watch the fair price, so they must clear that as well.
  const market = { kind: "MARKET" as const, price: undefined };
  code(() => planMexcOrder(order({ ...market, stopLossPrice: "699.5" }, { fairPrice: 699 })), "stopPriceSide");
  planMexcOrder(order({ ...market, stopLossPrice: "698.5" }, { fairPrice: 699 }));
  code(() => planMexcOrder(order({ ...market, action: "OPEN_SHORT", stopLossPrice: "700.5" }, { fairPrice: 701 })), "stopPriceSide");
  code(() => planMexcOrder(order({ ...market, takeProfitPrice: "700.5" }, { fairPrice: 701 })), "stopPriceSide");
  // A limit that crosses the book fills at once, so it must clear the fair price too. One still waiting is not held to that.
  assert.deepEqual(orderStopReferences("LIMIT", "LONG", 110, 100, 98), { takeProfit: 110, stopLoss: 98 });
  assert.deepEqual(orderStopReferences("LIMIT", "SHORT", 90, 100, 102), { takeProfit: 90, stopLoss: 102 });
  assert.deepEqual(orderStopReferences("LIMIT", "LONG", 90, 100, 80), { takeProfit: 90, stopLoss: 90 });
  assert.deepEqual(orderStopReferences("LIMIT", "SHORT", 110, 100, 120), { takeProfit: 110, stopLoss: 110 });
  code(() => planMexcOrder(order({ price: "800", stopLossPrice: "699.5" }, { fairPrice: 699 })), "stopPriceSide");
  planMexcOrder(order({ price: "650", stopLossPrice: "640" }, { fairPrice: 630 }));
  assert.deepEqual(orderStopReferences("MARKET", "LONG", undefined, 100, 99), { takeProfit: 100, stopLoss: 99 });
  assert.deepEqual(orderStopReferences("MARKET", "SHORT", undefined, 100, 99), { takeProfit: 99, stopLoss: 100 });
  // A blank limit or a missing quote judges nothing rather than the wrong thing.
  assert.deepEqual(orderStopReferences("LIMIT", "LONG", 0, undefined, undefined), { takeProfit: undefined, stopLoss: undefined });
});

test("an order cannot carry a take-profit or stop-loss onto a position already held", () => {
  code(() => planMexcOrder(context({ draft: { ...openDraft, stopLossPrice: "680" }, positions: [long] })), "stopOnHeldPosition");
  // The other direction is a separate position in hedge mode.
  planMexcOrder(context({ draft: { ...openDraft, action: "OPEN_SHORT", stopLossPrice: "720" }, positions: [long] }));
});

test("what an order carries is read back from its details", () => {
  const row = { orderId: "1", symbol: "QQQSTOCK_USDT", side: 1, price: 700, vol: 1, state: 2 };
  const plain = decodeMexcOrder(row);
  assert.equal(Object.hasOwn(plain, "takeProfitPrice"), false);
  const carried = decodeMexcOrder({ ...row, takeProfitPrice: 720, stopLossPrice: 0 });
  assert.equal(carried.takeProfitPrice, 720);
  assert.equal(carried.stopLossPrice, undefined);
});

test("refusals of a stop request unlock only a stop request", () => {
  const refused = (exchange: number, table?: Record<number, string>) => classifyMexcResponse(200, JSON.stringify({ success: false, code: exchange }), table);
  for (const [exchange, expected] of [[5001, "stopPriceMissing"], [5002, "stopChanged"], [5003, "stopPriceInvalid"], [5004, "stopVolume"], [5005, "stopExists"], [5006, "stopRejected"]] as const) {
    assert.deepEqual(refused(exchange, STOP_REJECTIONS), { kind: "rejected", code: expected, exchangeCode: exchange });
    assert.deepEqual(refused(exchange), { kind: "unknown" });
  }
  assert.equal(STOP_REJECTIONS[2009], "positionChanged");
  for (const exchange of [500, 603, 9999]) assert.deepEqual(refused(exchange, STOP_REJECTIONS), { kind: "unknown" });
});
