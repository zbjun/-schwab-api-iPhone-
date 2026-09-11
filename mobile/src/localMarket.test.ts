import test from "node:test";
import assert from "node:assert/strict";
import { executeLocalMarket, quoteMidpoint, validateLocalMarketSettings, type LocalMarketSettings } from "./localMarket.ts";
import { TradingError } from "./orderRules.ts";
import type { Draft, Order, Prepared, Quote } from "./types.ts";

const defaults: LocalMarketSettings = { boundaryPercent: 0.5, durationSeconds: 10, startSpreadPercent: 25, repriceIntervalSeconds: 5, minRepriceTicks: 2, jumpPercent: 0.5, maxSpreadPercent: 1 };

function fixture() {
  let time = 1_000_000;
  let current = true;
  let stop = false;
  let quotePrice = 100;
  let halfSpread = 0;
  let quoteTime: number | undefined;
  let realtime = true;
  const drafts: Draft[] = [];
  const submitted: Prepared[] = [];
  const canceled: string[] = [];
  const orders = new Map<string, Order>();
  const messages: string[] = [];
  let reads = 0;
  const quote = (): Quote => ({ symbol: "QQQ", bidPrice: quotePrice - halfSpread, askPrice: quotePrice + halfSpread, quoteTime: quoteTime ?? time, isRealtime: realtime });
  const broker = {
    async quotes(_symbols: string[], options?: { fundamentals?: boolean }) {
      assert.equal(options?.fundamentals, false);
      return [quote()];
    },
    async prepare(accountID: string, draft: Draft): Promise<Prepared> {
      drafts.push(draft);
      return Object.freeze({ id: "review", draft, accountID, accountDisplay: "test", quote: quote(), availableShares: 100, isDemo: false, preparedAt: time });
    },
    async submit(prepared: Prepared): Promise<{ orderID?: string }> {
      submitted.push(prepared);
      const id = String(submitted.length);
      orders.set(id, { id, symbol: "QQQ", side: prepared.draft.side, quantity: prepared.draft.quantity, kind: "LIMIT", filledQuantity: 0, remainingQuantity: prepared.draft.quantity, status: "WORKING", cancelable: true, editable: false, isSimpleEquity: true });
      return { orderID: id };
    },
    async orderDetail(_accountID: string, id: string): Promise<Order> {
      reads++;
      return { ...orders.get(id)! };
    },
    async cancel(_accountID: string, id: string): Promise<void> {
      canceled.push(id);
      orders.get(id)!.status = "CANCELED";
    },
  };
  const request: Parameters<typeof executeLocalMarket>[0] = {
    broker, accountID: "account", symbol: "QQQ", side: "BUY", quantity: 10, session: "PM",
    settings: { ...defaults }, isDemo: false,
    isCurrent: () => current, shouldStop: () => stop,
    onProgress: (message) => messages.push(message), now: () => time,
    sleep: async (ms) => { time += ms; },
  };
  return { broker, request, drafts, submitted, canceled, orders, messages, quote,
    setTime: (value: number) => { time = value; }, time: () => time,
    setCurrent: (value: boolean) => { current = value; }, setStop: () => { stop = true; },
    setPrice: (value: number) => { quotePrice = value; },
    setHalfSpread: (value: number) => { halfSpread = value; },
    setQuoteTime: (value: number) => { quoteTime = value; },
    setRealtime: (value: boolean) => { realtime = value; }, reads: () => reads,
  };
}

test("local market settings allow zero boundary and custom duration but reject non-finite and unbounded settings", () => {
  validateLocalMarketSettings({ ...defaults, boundaryPercent: 0, durationSeconds: 3600 });
  for (const boundaryPercent of [-1, 100, Infinity, NaN])
    assert.throws(() => validateLocalMarketSettings({ ...defaults, boundaryPercent }));
  for (const durationSeconds of [0, 0.5, 3601, Infinity, NaN])
    assert.throws(() => validateLocalMarketSettings({ ...defaults, durationSeconds }));
});

test("invalid quantities and sessions never access broker", async () => {
  const f = fixture();
  for (const quantity of [0, -1, 1.5, Infinity, NaN])
    await assert.rejects(executeLocalMarket({ ...f.request, quantity }));
  await assert.rejects(executeLocalMarket({ ...f.request, session: "NIGHT" as never }));
  assert.equal(f.drafts.length, 0);
});

test("a filled order uses exact prepared snapshot and explicit LIMIT DAY session", async () => {
  const f = fixture();
  const original = f.broker.submit;
  let prepared!: Prepared;
  const prepare = f.broker.prepare;
  f.broker.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  f.broker.submit = async (snapshot) => {
    assert.equal(snapshot, prepared);
    const result = await original(snapshot);
    Object.assign(f.orders.get(result.orderID!)!, { status: "FILLED", filledQuantity: 10, remainingQuantity: 0 });
    return result;
  };
  const result = await executeLocalMarket(f.request);
  assert.equal(result.filledQuantity, 10);
  assert.deepEqual(result.orderIDs, ["1"]);
  assert.deepEqual(f.drafts[0], { symbol: "QQQ", side: "BUY", quantity: 10, kind: "LIMIT", limitPrice: "100.00", duration: "DAY", session: "PM" });
  assert.equal(f.canceled.length, 0);
});

test("chasing waits for confirmed cancellation and includes partial fills during cancel", async () => {
  const f = fixture();
  let pendingReads = 0;
  const read = f.broker.orderDetail;
  f.broker.orderDetail = async (...args) => {
    const order = f.orders.get(args[1])!;
    if (order.id === "1" && order.status === "PENDING_CANCEL" && ++pendingReads >= 3)
      Object.assign(order, { status: "CANCELED", filledQuantity: 4, remainingQuantity: 6 });
    if (order.id === "2") Object.assign(order, { status: "FILLED", filledQuantity: 6, remainingQuantity: 0 });
    return read(...args);
  };
  f.broker.cancel = async (_account, id) => {
    f.canceled.push(id);
    Object.assign(f.orders.get(id)!, { status: "PENDING_CANCEL", filledQuantity: 2, remainingQuantity: 8 });
  };
  f.request.sleep = async (ms) => { f.setTime(f.time() + ms); f.setPrice(100.2); };
  const submit = f.broker.submit;
  f.broker.submit = async (snapshot) => {
    if (f.submitted.length) assert.equal(f.orders.get("1")!.status, "CANCELED");
    return submit(snapshot);
  };
  const result = await executeLocalMarket(f.request);
  assert.equal(result.filledQuantity, 10);
  assert.equal(f.drafts[1].quantity, 6);
  assert.equal(f.drafts[1].limitPrice, "100.20");
  assert.deepEqual(f.canceled, ["1"]);
});

test("deadline cancels once and cancellation acknowledgment alone cannot authorize another order", async () => {
  const f = fixture();
  f.request.settings.durationSeconds = 2;
  f.broker.cancel = async (_account, id) => { f.canceled.push(id); };
  const result = await executeLocalMarket(f.request);
  assert.equal(f.submitted.length, 1);
  assert.deepEqual(f.canceled, ["1"]);
  assert.match(result.message, /撤单结果仍待核对/);
  assert.doesNotMatch(result.message, /已确认撤销/);
  assert.ok(f.reads() <= 20);
});

test("buy boundary remains based on first quote after a confirmed chase", async () => {
  const f = fixture();
  f.request.sleep = async (ms) => { f.setTime(f.time() + ms); f.setPrice(f.submitted.length < 2 ? 100.4 : 100.7); };
  const result = await executeLocalMarket(f.request);
  assert.equal(f.submitted.length, 2);
  assert.equal(f.drafts[1].limitPrice, "100.40");
  assert.deepEqual(f.canceled, ["1", "2"]);
  assert.match(result.message, /价格边界/);
});

test("sell uses a fixed lower boundary", async () => {
  const f = fixture();
  f.request.side = "SELL";
  f.request.settings.jumpPercent = 5;
  f.request.sleep = async (ms) => { f.setTime(f.time() + ms); f.setPrice(99.4); };
  const result = await executeLocalMarket(f.request);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.drafts[0].side, "SELL");
  assert.match(result.message, /价格边界/);
  assert.match(f.messages[0], /最低卖价 99.5000/);
});

test("stale, future, delayed or missing executable quotes never submit", async () => {
  for (const mode of ["stale", "future", "delayed", "missing"] as const) {
    const f = fixture();
    if (mode === "stale") f.setQuoteTime(f.time() - 10001);
    if (mode === "future") f.setQuoteTime(f.time() + 2001);
    if (mode === "delayed") f.setRealtime(false);
    if (mode === "missing") f.broker.quotes = async () => [{ symbol: "QQQ", lastPrice: 100 }];
    const result = await executeLocalMarket(f.request);
    assert.equal(f.submitted.length, 0);
    assert.match(result.message, /报价/);
  }
});

test("prepared quote or identity changes and expiry prevent a write", async () => {
  for (const mode of ["account", "demo", "draft", "quote", "expiry", "context", "deadline"] as const) {
    const f = fixture();
    const prepare = f.broker.prepare;
    f.broker.prepare = async (...args) => {
      const value = await prepare(...args);
      if (mode === "account") return { ...value, accountID: "other" };
      if (mode === "demo") return { ...value, isDemo: true };
      if (mode === "draft") return { ...value, draft: { ...value.draft, quantity: 100 } };
      if (mode === "quote") return { ...value, quote: { ...value.quote, askPrice: 200 } };
      if (mode === "expiry") return { ...value, preparedAt: f.time() - 60001 };
      if (mode === "context") f.setCurrent(false);
      if (mode === "deadline") f.setTime(f.time() + 10000);
      return value;
    };
    await executeLocalMarket(f.request);
    assert.equal(f.submitted.length, 0, mode);
  }
});

test("ambiguous submission and missing IDs never retry", async () => {
  for (const missing of [false, true]) {
    const f = fixture();
    let writes = 0;
    f.broker.submit = async () => {
      writes++;
      if (missing) return {};
      throw new TradingError("orderOutcomeUnknown", "提交结果不确定");
    };
    const result = await executeLocalMarket(f.request);
    assert.equal(writes, 1);
    assert.equal(f.canceled.length, 0);
    assert.match(result.message, /勿重复提交/);
  }
});

test("an ambiguous cancellation cannot chase even after terminal read", async () => {
  const f = fixture();
  f.request.sleep = async (ms) => { f.setTime(f.time() + ms); f.setPrice(100.2); };
  f.broker.cancel = async (_account, id) => {
    f.canceled.push(id);
    f.orders.get(id)!.status = "CANCELED";
    throw new TradingError("orderOutcomeUnknown", "撤单结果不确定");
  };
  const result = await executeLocalMarket(f.request);
  assert.equal(f.submitted.length, 1);
  assert.deepEqual(f.canceled, ["1"]);
  assert.match(result.message, /待核对/);
});

test("a definite cancel rejection that raced with fill resolves through a read", async () => {
  const f = fixture();
  f.request.sleep = async (ms) => { f.setTime(f.time() + ms); f.setPrice(100.2); };
  f.broker.cancel = async (_account, id) => {
    f.canceled.push(id);
    Object.assign(f.orders.get(id)!, { status: "FILLED", filledQuantity: 10, remainingQuantity: 0 });
    throw new TradingError("httpError", "已不可撤", 400);
  };
  const result = await executeLocalMarket(f.request);
  assert.equal(result.filledQuantity, 10);
  assert.equal(f.submitted.length, 1);
  assert.match(result.message, /全部成交/);
});

test("external replacements and terminal rejections never spawn another order", async () => {
  for (const status of ["REPLACED", "REJECTED", "EXPIRED", "CANCELED"]) {
    const f = fixture();
    const submit = f.broker.submit;
    f.broker.submit = async (snapshot) => {
      const value = await submit(snapshot);
      f.orders.get(value.orderID!)!.status = status;
      return value;
    };
    const result = await executeLocalMarket(f.request);
    assert.equal(f.submitted.length, 1);
    assert.equal(f.canceled.length, 0);
    assert.match(result.message, new RegExp(status));
  }
});

test("stop and context changes clean up the owned order and preserve receipts", async () => {
  for (const mode of ["stop", "context", "stale"]) {
    const f = fixture();
    f.request.sleep = async (ms) => {
      f.setTime(f.time() + ms);
      if (mode === "stop") f.setStop();
      if (mode === "context") f.setCurrent(false);
      if (mode === "stale") f.setQuoteTime(f.time() - 10001);
    };
    const result = await executeLocalMarket(f.request);
    assert.equal(f.submitted.length, 1);
    assert.deepEqual(f.canceled, ["1"]);
    assert.deepEqual(result.orderIDs, ["1"]);
    assert.match(result.message, /已确认撤销/);
  }
});

test("inconsistent order identity cannot cancel a different order or chase", async () => {
  const f = fixture();
  const detail = f.broker.orderDetail;
  f.broker.orderDetail = async (...args) => ({ ...await detail(...args), symbol: "OTHER" });
  const result = await executeLocalMarket(f.request);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.canceled.length, 0);
  assert.match(result.message, /身份无法核对/);
  assert.match(result.message, /#1/);
});

test("decreasing or incomplete fill counts cannot cause another submission", async () => {
  for (const mode of ["missing", "inconsistent", "decreasing"]) {
    const f = fixture();
    const detail = f.broker.orderDetail;
    let count = 0;
    f.broker.orderDetail = async (...args) => {
      const value = await detail(...args);
      count++;
      if (mode === "missing") return { ...value, filledQuantity: undefined };
      if (mode === "inconsistent") return { ...value, filledQuantity: 3, remainingQuantity: 10 };
      return { ...value, filledQuantity: count === 1 ? 3 : 2, remainingQuantity: count === 1 ? 7 : 8 };
    };
    const result = await executeLocalMarket(f.request);
    assert.equal(f.submitted.length, 1);
    assert.match(result.message, /数量无法核对/);
  }
});

test("preparation failure after confirmed partial cancellation retains fills and IDs", async () => {
  const f = fixture();
  f.request.sleep = async (ms) => { f.setTime(f.time() + ms); f.setPrice(100.2); };
  f.broker.cancel = async (_account, id) => {
    f.canceled.push(id);
    Object.assign(f.orders.get(id)!, { status: "CANCELED", filledQuantity: 4, remainingQuantity: 6 });
  };
  const prepare = f.broker.prepare;
  f.broker.prepare = async (...args) => {
    if (f.submitted.length) throw new TradingError("insufficientFunds", "购买力不足");
    return prepare(...args);
  };
  const result = await executeLocalMarket(f.request);
  assert.equal(result.filledQuantity, 4);
  assert.deepEqual(result.orderIDs, ["1"]);
  assert.match(result.message, /购买力不足/);
});

test("clock rollback stops chasing and cleanup polling remains bounded", async () => {
  const f = fixture();
  f.request.sleep = async () => { f.setTime(f.time() - 1000); };
  f.broker.cancel = async (_account, id) => { f.canceled.push(id); };
  const result = await executeLocalMarket(f.request);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.canceled.length, 1);
  assert.ok(f.reads() <= 17);
  assert.match(result.message, /设备时间/);
});

test("repricing in either direction requires both a resting interval and minimum ticks", async () => {
  for (const side of ["BUY", "SELL"] as const) for (const direction of [-1, 1]) {
    const f = fixture();
    f.request.side = side;
    const placements: number[] = [];
    const submit = f.broker.submit;
    f.broker.submit = async value => { placements.push(f.time()); return submit(value); };
    f.request.sleep = async ms => {
      f.setTime(f.time() + ms);
      f.setPrice(100 + direction * (f.time() < 1_006_000 ? 0.01 : 0.03));
    };
    await executeLocalMarket(f.request);
    assert.deepEqual(placements, [1_000_000, 1_006_000]);
    assert.equal(f.drafts[1].limitPrice, direction === 1 ? "100.03" : "99.97");
  }
});

test("zero boundary refuses any adverse move and sub-dollar prices retain four digits", async () => {
  const f = fixture();
  f.request.settings.boundaryPercent = 0;
  f.setPrice(0.1234);
  f.request.sleep = async (ms) => { f.setTime(f.time() + ms); f.setPrice(0.1235); };
  const result = await executeLocalMarket(f.request);
  assert.equal(f.drafts[0].limitPrice, "0.1234");
  assert.equal(f.submitted.length, 1);
  assert.match(result.message, /价格边界/);
});

test("tick rounding protects the midpoint for both sides, including sub-dollar quotes", async () => {
  for (const side of ["BUY", "SELL"] as const) for (const midpoint of [100.005, 0.12345]) {
    const f = fixture();
    f.request.side = side;
    f.request.settings.boundaryPercent = 0;
    f.setPrice(midpoint);
    await executeLocalMarket(f.request);
    assert.equal(f.drafts[0].limitPrice, midpoint > 1 ? (side === "BUY" ? "100.00" : "100.01") : (side === "BUY" ? "0.1234" : "0.1235"));
  }
});

test("fractional fills after cancellation stop instead of rounding into excess shares", async () => {
  const f = fixture();
  f.request.sleep = async (ms) => { f.setTime(f.time() + ms); f.setPrice(100.2); };
  f.broker.cancel = async (_account, id) => {
    f.canceled.push(id);
    Object.assign(f.orders.get(id)!, { status: "CANCELED", filledQuantity: 4.5, remainingQuantity: 5.5 });
  };
  const result = await executeLocalMarket(f.request);
  assert.equal(f.submitted.length, 1);
  assert.equal(result.filledQuantity, 4.5);
  assert.match(result.message, /不是整股/);
});

test("midpoint requires valid two-sided quotes and accepts a locked book", () => {
  assert.equal(quoteMidpoint({ symbol: "QQQ", bidPrice: 99, askPrice: 101 }), 100);
  assert.equal(quoteMidpoint({ symbol: "QQQ", bidPrice: 100, askPrice: 100 }), 100);
  assert.equal(quoteMidpoint(), undefined);
  for (const pair of [[undefined, 101], [99, undefined], [0, 1], [-1, 1], [101, 99], [NaN, 100], [99, Infinity]]) {
    assert.equal(quoteMidpoint({ symbol: "QQQ", bidPrice: pair[0], askPrice: pair[1], lastPrice: 100 }), undefined);
  }
});

test("every strategy parameter is explicit and bounded", () => {
  const invalid = {
    startSpreadPercent: [undefined, NaN, Infinity, -1, 50.1],
    repriceIntervalSeconds: [undefined, NaN, Infinity, 1, 2.5, 61],
    minRepriceTicks: [undefined, NaN, Infinity, 0, 1.5, 101],
    jumpPercent: [undefined, NaN, Infinity, 0, -1, 100],
    maxSpreadPercent: [undefined, NaN, Infinity, 0, -1, 100],
  };
  for (const [key, values] of Object.entries(invalid)) for (const value of values)
    assert.throws(() => validateLocalMarketSettings({ ...defaults, [key]: value }), key);
  validateLocalMarketSettings({ ...defaults, startSpreadPercent: 0 });
  validateLocalMarketSettings({ ...defaults, startSpreadPercent: 50 });
});

test("both sides start at 25 percent of spread then permanently move to midpoint", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    const f = fixture();
    f.request.side = side;
    f.request.settings.durationSeconds = 16;
    f.setHalfSpread(0.2);
    const placements: number[] = [];
    const submit = f.broker.submit;
    f.broker.submit = async value => { placements.push(f.time()); return submit(value); };
    f.request.sleep = async ms => {
      f.setTime(f.time() + ms);
      if (f.time() >= 1_008_000) f.setPrice(100.1);
    };
    await executeLocalMarket(f.request);
    assert.deepEqual(f.drafts.map(d => d.limitPrice), side === "BUY" ? ["99.90", "100.00", "100.10"] : ["100.10", "100.00", "100.10"]);
    assert.deepEqual(placements, [1_000_000, 1_005_000, 1_010_000]);
  }
});

test("spread guard prevents initial submission and cancels on widening", async () => {
  for (const initial of [false, true]) {
    const f = fixture();
    if (initial) f.setHalfSpread(0.51);
    else f.request.sleep = async ms => { f.setTime(f.time() + ms); f.setHalfSpread(0.51); };
    const result = await executeLocalMarket(f.request);
    assert.equal(f.submitted.length, initial ? 0 : 1);
    assert.deepEqual(f.canceled, initial ? [] : ["1"]);
    assert.match(result.message, /价差超过/);
  }
});

test("rolling three-second midpoint guard catches cumulative moves, then stops without restarting", async () => {
  const f = fixture();
  f.request.settings.boundaryPercent = 5;
  f.request.sleep = async ms => {
    f.setTime(f.time() + ms);
    f.setPrice(100 + (f.time() - 1_000_000) / 1000 * 0.2);
  };
  const result = await executeLocalMarket(f.request);
  assert.equal(f.time(), 1_003_000);
  assert.equal(f.submitted.length, 1);
  assert.deepEqual(f.canceled, ["1"]);
  assert.match(result.message, /3 秒内突变/);
});

test("slow cumulative drift beyond the jump threshold does not trip the rolling window", async () => {
  const f = fixture();
  f.request.settings.boundaryPercent = 5;
  f.request.sleep = async ms => { f.setTime(f.time() + ms); f.setPrice(100 + (f.time() - 1_000_000) / 10000); };
  const result = await executeLocalMarket(f.request);
  assert.doesNotMatch(result.message, /突变/);
  assert.equal(f.submitted.length, 2);
});

test("prepared quotes are checked for spread, sudden movement and stale aggressive targets", async () => {
  for (const side of ["BUY", "SELL"] as const) for (const mode of ["spread", "jump", "target"] as const) {
    const f = fixture();
    f.request.side = side;
    f.request.settings.boundaryPercent = 5;
    const prepare = f.broker.prepare;
    f.broker.prepare = async (...args) => {
      const value = await prepare(...args);
      if (mode === "spread") f.setHalfSpread(0.6);
      else f.setPrice(100 + (side === "BUY" ? -1 : 1) * (mode === "jump" ? 0.6 : 0.1));
      return { ...value, quote: f.quote() };
    };
    const result = await executeLocalMarket(f.request);
    assert.equal(f.submitted.length, 0, `${side} ${mode}`);
    assert.match(result.message, mode === "spread" ? /价差超过/ : mode === "jump" ? /突变/ : /当前目标/);
  }
});

test("missing or crossed two-sided quotes stop a resting strategy and confirm cancellation", async () => {
  for (const invalid of ["missing", "crossed"] as const) {
    const f = fixture();
    const quotes = f.broker.quotes;
    f.broker.quotes = async (...args) => {
      if (!f.submitted.length) return quotes(...args);
      return [{ ...f.quote(), bidPrice: invalid === "crossed" ? 101 : undefined, askPrice: 100 }];
    };
    const result = await executeLocalMarket(f.request);
    assert.equal(f.submitted.length, 1);
    assert.deepEqual(f.canceled, ["1"]);
    assert.match(result.message, /双边报价/);
    assert.match(result.message, /已确认撤销/);
  }
});
