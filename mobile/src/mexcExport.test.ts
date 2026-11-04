import assert from "node:assert/strict";
import test from "node:test";
import { mexcExportFileName, mexcOrdersCSV } from "./mexc/mexcExport.ts";
import { closedOrderSymbols, contractShort, contractTitle, demoBadge, demoNotice, noteRecentContracts, orderGroup, parseRecentContracts, venueDemoNotice } from "./mexc/mexcView.ts";
import type { MexcOrder } from "./mexcRules.ts";

const T0 = Date.UTC(2026, 10, 4, 8);
const order = (over: Partial<MexcOrder>): MexcOrder => ({
  id: "1", symbol: "SOXL_USDT", action: "OPEN_LONG", orderType: 1, price: 70, vol: 10, dealVol: 10, dealAvgPrice: 70.5, state: 3, updatedAt: T0, ...over,
} as MexcOrder);

test("the MEXC export has one row per order with a fill, newest first, each once", () => {
  const { csv, rows } = mexcOrdersCSV([
    order({ id: "old", updatedAt: T0 - 1000 }),
    order({ id: "new", fee: 0.0123, profit: -1.5 }),
    order({ id: "new" }),
    order({ id: "none", dealVol: 0, state: 4 }),
  ], "UTC");
  assert.equal(rows, 2);
  assert.ok(csv.startsWith("﻿时间(UTC),UTC时间,合约,方向"));
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[1].endsWith(",new"));
  assert.ok(lines[2].endsWith(",old"));
});

test("the MEXC export leaves no market price and neutralises a formula in a cell", () => {
  const { csv } = mexcOrdersCSV([order({ id: "=1+1", orderType: 5, price: 0 })], "UTC");
  const cells = csv.trim().split("\r\n")[1].split(",");
  assert.equal(cells[4], "市价");
  assert.equal(cells[5], "");
  assert.equal(cells.at(-1), "'=1+1");
  assert.equal(mexcExportFileName(T0 - 86_400_000, T0), "ths-mexc-orders-20261103-20261104.csv");
});

test("a real account never reads as practice because the other venue is a demo", () => {
  // Schwab simulated and MEXC real is what a phone with no Schwab connection has.
  assert.ok(demoNotice(true, false, true)?.includes("MEXC 合约是真实账户"));
  assert.ok(!demoNotice(true, false, true)?.includes("所有交易均为模拟"));
  assert.equal(demoBadge(true, false, true), "Schwab 模拟");
  assert.ok(demoNotice(false, true, true)?.includes("Schwab 股票是真实账户"));
  assert.equal(demoBadge(false, true, true), "MEXC 模拟");
  // Both simulated, or only one venue on the page.
  assert.equal(demoNotice(true, true, true), "演示模式 · 所有交易均为模拟");
  assert.equal(demoBadge(true, true, true), "模拟");
  assert.equal(demoNotice(true, false, false), "演示模式 · 所有交易均为模拟");
  assert.equal(demoBadge(true, false, false), "模拟");
  // A page showing one venue names it, so "all trades" cannot take in a real account on the other.
  assert.ok(!venueDemoNotice("schwab").includes("所有"));
  assert.ok(venueDemoNotice("schwab").startsWith("Schwab"));
  assert.ok(venueDemoNotice("mexc").startsWith("MEXC"));
  // Both real.
  assert.equal(demoNotice(false, false, true), undefined);
  assert.equal(demoBadge(false, false, true), undefined);
  assert.equal(demoNotice(false, false, false), undefined);
});

test("contracts read the same way wherever they appear", () => {
  assert.equal(contractTitle({ displayName: "SOXL_USDT PERPETUAL", symbol: "SOXL_USDT" }), "SOXL 永续");
  assert.equal(contractTitle({ displayName: "QQQ_USDT PERPETUAL", symbol: "QQQSTOCK_USDT" }), "QQQ 永续");
  assert.equal(contractTitle({ displayName: "", symbol: "BTC_USDT" }), "BTC 永续");
  assert.equal(contractShort("SOXL_USDT"), "SOXL");
});

test("a MEXC order sorts under the same filters as a Schwab one", () => {
  assert.equal(orderGroup({ state: 1 }), "待成交");
  assert.equal(orderGroup({ state: 2 }), "待成交");
  assert.equal(orderGroup({ state: 3 }), "已成交");
  assert.equal(orderGroup({ state: 4 }), "已结束");
  assert.equal(orderGroup({ state: 5 }), "已结束");
});

test("closed orders are asked for on what is current, then recent, then favourite, each once and within the limit", () => {
  const recent = [{ symbol: "B_USDT", at: T0 }, { symbol: "A_USDT", at: T0 }];
  assert.deepEqual(closedOrderSymbols(["A_USDT", "A_USDT"], recent, ["C_USDT", "B_USDT"]), ["A_USDT", "B_USDT", "C_USDT"]);
  const many = Array.from({ length: 30 }, (_, index) => `C${index}_USDT`);
  assert.equal(closedOrderSymbols([], [], many).length, 20);
});

test("a contract is remembered for as long as its closed orders can be listed", () => {
  const eightDays = 8 * 86_400_000;
  const next = noteRecentContracts([{ symbol: "OLD_USDT", at: T0 - eightDays }, { symbol: "KEPT_USDT", at: T0 - 1000 }, { symbol: "SEEN_USDT", at: T0 - 1000 }], ["SEEN_USDT"], T0);
  assert.deepEqual(next, [{ symbol: "SEEN_USDT", at: T0 }, { symbol: "KEPT_USDT", at: T0 - 1000 }]);
  assert.deepEqual(parseRecentContracts(JSON.stringify(next)), next);
  assert.deepEqual(parseRecentContracts("not json"), []);
  assert.deepEqual(parseRecentContracts(JSON.stringify([{ symbol: "bad symbol", at: 1 }, { symbol: "OK_USDT" }, null])), []);
});
