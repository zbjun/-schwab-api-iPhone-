import test from "node:test";
import assert from "node:assert/strict";
import {
  batches, blockMessage, clampLeverage, closableOf, closedOrderWindow, closeActionFor, estimatePrice, leverageChoice, marginOf,
  notionalOf, parseVenue, reviewExpired, reviewRemainingSeconds, snapToTick, sortContracts, stepDecimal, tradingLocked,
} from "./mexc/mexcView.ts";
import { validateMexcDraft } from "./mexcRules.ts";
import type { MexcContract, MexcPosition } from "./mexcRules.ts";

const contract = (symbol: string, rest: Partial<MexcContract> = {}): MexcContract => ({
  symbol, displayName: symbol.replace("_USDT", "") + " PERPETUAL", baseCoin: symbol.replace("_USDT", ""), settleCoin: "USDT",
  futureType: 1, state: 0, apiAllowed: true, contractSize: 0.01, priceUnit: 0.01, volUnit: 1, minVol: 1, maxVol: 1000,
  minLeverage: 1, maxLeverage: 100, positionOpenType: 3, takerFeeRate: 0.0002, makerFeeRate: 0, ...rest,
});
const position = (rest: Partial<MexcPosition> = {}): MexcPosition => ({
  id: "1", symbol: "QQQSTOCK_USDT", direction: "LONG", openType: 1, holdVol: 10, frozenVol: 3, averagePrice: 690, leverage: 4, ...rest,
});

test("stock-style contracts sort first, then query matches, then by code", () => {
  const list = [contract("ETH_USDT"), contract("TSLASTOCK_USDT"), contract("BTC_USDT"), contract("AAPLSTOCK_USDT")];
  assert.deepEqual(sortContracts(list).map(c => c.symbol), ["AAPLSTOCK_USDT", "TSLASTOCK_USDT", "BTC_USDT", "ETH_USDT"]);
  assert.deepEqual(sortContracts(list, "btc").map(c => c.symbol), ["BTC_USDT"]);
  assert.deepEqual(sortContracts(list, "zzz"), []);
  // A prefix match outranks a substring match inside the same group.
  const mixed = [contract("XBTC_USDT"), contract("BTC_USDT")];
  assert.deepEqual(sortContracts(mixed, "BTC").map(c => c.symbol), ["BTC_USDT", "XBTC_USDT"]);
  assert.equal(list[0].symbol, "ETH_USDT", "input is not reordered in place");
});

test("leverage cap is the smaller of the server and contract limits, and a held side pins it", () => {
  const c = contract("QQQSTOCK_USDT", { maxLeverage: 100, minLeverage: 2 });
  assert.deepEqual(leverageChoice(c, { maxLeverage: 10 }, [], "OPEN_LONG"), { min: 2, max: 10, fixed: undefined });
  assert.equal(leverageChoice(contract("X_USDT", { maxLeverage: 5 }), { maxLeverage: 10 }, [], "OPEN_LONG").max, 5);
  const pinned = leverageChoice(c, { maxLeverage: 10 }, [position()], "OPEN_LONG");
  assert.equal(pinned.fixed, 4);
  assert.equal(leverageChoice(c, { maxLeverage: 10 }, [position()], "OPEN_SHORT").fixed, undefined, "other side is free");
  assert.equal(clampLeverage(50, { min: 2, max: 10 }), 10);
  assert.equal(clampLeverage(0, { min: 2, max: 10 }), 2);
  assert.equal(clampLeverage(7, { min: 2, max: 10, fixed: 4 }), 4);
});

test("notional, margin and closable amounts", () => {
  assert.equal(notionalOf("10", 0.01, "700"), 70);
  assert.equal(notionalOf("", 0.01, "700"), undefined);
  assert.equal(notionalOf("10", 0.01, undefined), undefined);
  assert.equal(notionalOf("abc", 0.01, "700"), undefined);
  assert.equal(marginOf(70, 5), 14);
  assert.equal(marginOf(undefined, 5), undefined);
  assert.equal(closableOf(position()), "7");
  assert.equal(closableOf(position({ frozenVol: 99 })), "0");
  assert.equal(closeActionFor(position()), "CLOSE_LONG");
  assert.equal(closeActionFor(position({ direction: "SHORT" })), "CLOSE_SHORT");
  const ticker = { symbol: "A_USDT", lastPrice: 10, bid1: 9.9, ask1: 10.1, timestamp: 1 };
  assert.equal(estimatePrice("MARKET", true, "", ticker), 10.1);
  assert.equal(estimatePrice("MARKET", false, "", ticker), 9.9);
  assert.equal(estimatePrice("LIMIT", true, "9", ticker), "9");
});

test("steppers follow the contract's own tick", () => {
  assert.equal(stepDecimal("1", 1, 1), "2");
  assert.equal(stepDecimal("1", 1, -1, 1), "1", "never below the minimum");
  assert.equal(stepDecimal("700.00", 0.01, 1), "700.01");
  assert.equal(stepDecimal("0.7", 0.1, 1), "0.8");
  assert.equal(stepDecimal("700.005", 0.01, 1), "700.01", "off-grid values snap to the next tick up");
  assert.equal(stepDecimal("700.005", 0.01, -1), "700.00");
  assert.equal(stepDecimal("", 1, 1), "1");
  assert.equal(snapToTick(100000.04, 0.1), "100000.0");
});

test("review countdown runs from the preparation time and expires exactly at 60 seconds", () => {
  const at = 1_000_000;
  assert.equal(reviewRemainingSeconds(at, at), 60);
  assert.equal(reviewRemainingSeconds(at, at + 1), 60);
  assert.equal(reviewRemainingSeconds(at, at + 30_000), 30);
  assert.equal(reviewRemainingSeconds(at, at + 59_001), 1);
  assert.equal(reviewExpired(at, at + 59_999), false);
  assert.equal(reviewExpired(at, at + 60_000), true);
  assert.equal(reviewRemainingSeconds(at, at + 500_000), 0);
  assert.equal(reviewRemainingSeconds(at, at - 500_000), 60, "a clock moving back never extends the window");
});

test("locking comes from the server flag or an unknown outcome seen here", () => {
  assert.equal(tradingLocked(undefined, false), false);
  assert.equal(tradingLocked({ unresolvedOperation: false }, false), false);
  assert.equal(tradingLocked({ unresolvedOperation: true }, false), true);
  assert.equal(tradingLocked({ unresolvedOperation: false }, true), true);
  assert.equal(blockMessage(undefined), undefined);
  assert.match(blockMessage("keyMovesMoney")!, /转账或提现/);
  assert.ok(blockMessage("somethingNew"), "an unknown reason still blocks with text");
});

test("venue choice, ticker batches and the closed-order window", () => {
  assert.equal(parseVenue("mexc"), "mexc");
  assert.equal(parseVenue("schwab"), "schwab");
  assert.equal(parseVenue(null), "schwab");
  assert.equal(parseVenue("garbage"), "schwab");
  const symbols = Array.from({ length: 230 }, (_, i) => "S" + i);
  assert.deepEqual(batches(symbols).map(b => b.length), [100, 100, 30]);
  assert.deepEqual(batches([]), []);
  const { from, to } = closedOrderWindow(1_800_000_000_000);
  assert.equal(to - from, 7 * 86_400_000);
});

test("closable amount is exact text, and that text is a valid close size", () => {
  const text = closableOf(position({ holdVol: 0.3, frozenVol: 0.1 }));
  assert.equal(text, "0.2");
  assert.doesNotThrow(() => validateMexcDraft({ symbol: "QQQSTOCK_USDT", action: "CLOSE_LONG", kind: "LIMIT", vol: text, price: "690" }));
  assert.equal(closableOf(position({ holdVol: Number.NaN, frozenVol: 0 })), "0", "unusable numbers close nothing");
});
