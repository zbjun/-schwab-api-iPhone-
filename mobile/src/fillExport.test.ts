import test from "node:test";
import assert from "node:assert/strict";
import { collectOrderHistory, exportFileName, fillsCSV } from "./fillExport.ts";
import { TradingError } from "./orderRules.ts";
import type { Order, TradeExecution } from "./types.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-18T12:00:00.000Z");

function order(id: string, extra: Partial<Order> = {}): Order {
  return {
    id, status: "FILLED", symbol: "AAPL", side: "BUY", kind: "LIMIT", quantity: 10,
    limitPrice: 234.85, duration: "DAY", session: "NORMAL",
    cancelable: false, editable: false, isSimpleEquity: true, ...extra,
  };
}
function fill(id: string, time: number, extra: Partial<TradeExecution> = {}): TradeExecution {
  return { id, symbol: "AAPL", side: "BUY", time, price: 234.85, quantity: 10, ...extra };
}

test("history is read newest first in contiguous windows of at most 15 days", async () => {
  const calls: [number, number][] = [];
  const result = await collectOrderHistory({
    orders: async () => assert.fail("fallback must not be used"),
    orderHistory: async (_, from, to) => { calls.push([from, to]); return []; },
  }, "acct", 60, NOW);
  assert.equal(result.limited, false);
  assert.equal(result.complete, true);
  assert.equal(calls[0][1], NOW);
  assert.equal(calls.at(-1)![0], NOW - 60 * DAY);
  for (const [i, [from, to]] of calls.entries()) {
    assert.ok(to - from <= 15 * DAY && to > from);
    if (i) assert.equal(to, calls[i - 1][0]);
  }
});

test("a full page is split until each window fits, and orders are deduplicated", async () => {
  const busyFrom = NOW - 2 * DAY;
  const full = Array.from({ length: 200 }, (_, i) => order(`b${i}`, { enteredAt: busyFrom + i * 60_000 }));
  const calls: [number, number][] = [];
  const result = await collectOrderHistory({
    orders: async () => [],
    orderHistory: async (_, from, to) => {
      calls.push([from, to]);
      const inside = full.filter((o) => o.enteredAt! >= from && o.enteredAt! <= to);
      return to - from > DAY ? full : inside;
    },
  }, "acct", 7, NOW);
  assert.equal(result.complete, true);
  assert.equal(result.orders.length, 200);
  assert.ok(calls.length > 1);
});

test("a full one-hour window marks the export incomplete instead of looping", async () => {
  const full = Array.from({ length: 200 }, (_, i) => order(String(i)));
  const result = await collectOrderHistory({
    orders: async () => [],
    orderHistory: async () => full,
  }, "acct", 1, NOW);
  assert.equal(result.complete, false);
  assert.equal(result.orders.length, 200);
});

test("an older server without orderHistory falls back to the 30-day order list", async () => {
  const result = await collectOrderHistory({
    orders: async () => [order("1")],
    orderHistory: async () => { throw new TradingError("methodNotAllowed", "x"); },
  }, "acct", 60, NOW);
  assert.equal(result.limited, true);
  assert.equal(result.from, NOW - 30 * DAY);
  assert.deepEqual(result.orders.map((o) => o.id), ["1"]);
});

test("other failures propagate and invalid ranges are rejected before any request", async () => {
  const broker = {
    orders: async () => [],
    orderHistory: async () => { throw new TradingError("network", "offline"); },
  };
  await assert.rejects(collectOrderHistory(broker, "acct", 7, NOW), (e: TradingError) => e.code === "network");
  for (const days of [0, 61, 1.5]) await assert.rejects(collectOrderHistory(broker, "acct", days, NOW));
});

test("CSV lists fills in time order with market and local times", () => {
  const t1 = Date.parse("2026-10-16T19:39:02.123Z"), t2 = t1 + 5_000;
  const orders = [
    order("200", { side: "SELL", executions: [fill("200:a", t2, { side: "SELL", price: 0.1 + 0.2, quantity: 3 })] }),
    order("100", {
      enteredAt: t1 - 60_000,
      executions: [fill("100:a", t1), fill("100:a", t1), fill("old", t1 - 40 * DAY)],
    }),
    order("300", { status: "CANCELED", enteredAt: t1, filledQuantity: 0 }),
  ];
  const { csv, fills, withoutDetail } = fillsCSV(orders, t1 - DAY, t2 + DAY, "Asia/Shanghai");
  assert.equal(fills, 2);
  assert.equal(withoutDetail, 0);
  assert.ok(csv.startsWith("﻿成交时间(美东),成交时间(Asia/Shanghai),UTC时间,代码,方向,成交价"));
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1],
    "2026-10-16 15:39:02,2026-10-17 03:39:02,2026-10-16T19:39:02.123Z,AAPL,买入,234.85,10,2348.5,100,2026-10-16 15:38:02,限价,234.85,,10,当日有效,常规时段,已成交,");
  assert.match(lines[2], /^2026-10-16 15:39:07,.*,AAPL,卖出,0\.3,3,0\.9,200,,/);
});

test("filled orders without execution legs still appear, flagged and unpriced", () => {
  const t = Date.parse("2026-10-16T19:39:02Z");
  const { csv, fills, withoutDetail } = fillsCSV(
    [order("9", { side: "SELL", kind: "MARKET", limitPrice: undefined, enteredAt: t, filledQuantity: 4 })],
    t - DAY, t + DAY, "UTC",
  );
  assert.equal(fills, 0);
  assert.equal(withoutDetail, 1);
  const row = csv.trimEnd().split("\r\n")[1];
  assert.equal(row, ",,,AAPL,卖出,,4,,9,2026-10-16 15:39:02,市价,,,10,当日有效,常规时段,已成交,券商未返回逐笔成交明细，数量为订单已成交合计");
});

test("CSV text cells are quoted and cannot start a spreadsheet formula", () => {
  const t = Date.parse("2026-10-16T19:39:02Z");
  const { csv } = fillsCSV([order("1", { status: '=HYPERLINK("x"),1', executions: [fill("f", t)] })], t - 1, t + 1, "UTC");
  assert.match(csv, /,"'=HYPERLINK\(""x""\),1",\r\n$/);
});

test("export file names carry only the date range", () => {
  assert.equal(exportFileName(NOW - 60 * DAY, NOW), "ths-fills-20260819-20261018.csv");
});
