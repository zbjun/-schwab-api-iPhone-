import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeLiveCandles, batches, blockMessage, clampLeverage, closableOf, closedOrderWindow, closeActionFor, confirmArmed, draftIssueOf, leverageChoice, marginOf,
  notionalOf, parseVenue, reviewExpired, reviewRemainingSeconds, snapToTick, sortContracts, stepDecimal, tradingLocked,
  MAX_FAVORITES, favoriteContracts, fractionOfCapacity, openCapacity, parseFavorites, ticketBlocked, toggleFavorite, valuationPrice, volForFraction,
} from "./mexc/mexcView.ts";
import { planMexcOrder, validateMexcDraft } from "./mexcRules.ts";
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

test("live candles replace the same bar, append newer ones and mark only the last as forming", () => {
  const bar = (time: number, close: number, provisional?: boolean) => ({ time, open: 10, high: 20, low: 5, close, provisional });
  const history = { symbol: "QQQSTOCK_USDT", candles: [bar(1000, 11), bar(2000, 12), bar(3000, 13, true)] };
  const same = mergeLiveCandles(history, [bar(2000, 12.5), bar(3000, 13.5)]);
  assert.deepEqual(same.candles.map(c => [c.time, c.close, !!c.provisional]), [[1000, 11, false], [2000, 12.5, false], [3000, 13.5, true]]);
  const next = mergeLiveCandles(same, [bar(3000, 14), bar(4000, 15)]);
  assert.deepEqual(next.candles.map(c => [c.time, c.close, !!c.provisional]), [[1000, 11, false], [2000, 12.5, false], [3000, 14, false], [4000, 15, true]]);
  // Older than anything shown, unsorted or malformed input cannot disturb the chart.
  const old = mergeLiveCandles(history, [bar(500, 1)]);
  assert.deepEqual(old.candles.map(c => c.time), [1000, 2000, 3000]);
  const unsorted = mergeLiveCandles(history, [bar(4000, 15), bar(3000, 14)]);
  assert.deepEqual(unsorted.candles.map(c => [c.time, c.close]), [[1000, 11], [2000, 12], [3000, 14], [4000, 15]]);
  const broken = mergeLiveCandles(history, [{ ...bar(4000, 15), high: Number.NaN }]);
  assert.equal(broken.candles.length, 3);
  // The loaded chart object is never changed in place.
  assert.equal(history.candles[2].close, 13);
  assert.equal(mergeLiveCandles({ symbol: "X", candles: [] }, []).candles.length, 0);
  // Nothing new: the same object comes back, and a closed bar is not relabelled as forming.
  const closed = { symbol: "X", candles: [bar(1000, 11)] };
  assert.equal(mergeLiveCandles(closed, []), closed);
  assert.equal(closed.candles[0].provisional, undefined);
  const forming = mergeLiveCandles(closed, [bar(1000, 11)]);
  assert.equal(forming.candles[0].provisional, true);
  const repeat = { symbol: "X", candles: [{ ...bar(1000, 11), provisional: true }] };
  assert.equal(mergeLiveCandles(repeat, [bar(1000, 11)]), repeat);
  assert.notEqual(mergeLiveCandles(repeat, [bar(1000, 12)]), repeat);
});

test("orders are valued at the price the server uses", () => {
  const ticker = { symbol: "A_USDT", lastPrice: 10, bid1: 9.9, ask1: 10.1, timestamp: 1 };
  assert.equal(valuationPrice("LIMIT", true, "9", ticker, 0.01), 10.1);
  assert.equal(valuationPrice("LIMIT", true, "11", ticker, 0.01), 11);
  assert.equal(valuationPrice("LIMIT", false, "9", ticker, 0.01), 9.9);
  assert.ok(Math.abs(valuationPrice("MARKET", true, "", ticker, 0.01)! - 10.201) < 1e-9);
  assert.equal(valuationPrice("MARKET", false, "", ticker, 0.01), 9.9);
  assert.equal(valuationPrice("LIMIT", true, "", ticker, 0.01), undefined);
  assert.equal(valuationPrice("LIMIT", true, "abc", ticker, 0.01), undefined);
  assert.equal(valuationPrice("MARKET", true, "", undefined, 0.01), undefined);
  assert.equal(valuationPrice("LIMIT", true, "9", undefined, 0.01), 9);
});

test("the slider's full size stays inside margin, the server cap and the contract maximum, on the step", () => {
  const c = contract("A_USDT", { contractSize: 1, volUnit: 1, maxVol: 1000, takerFeeRate: 0 });
  // Margin decides: 100 x 5 / 10 = 50, less the room for the quote to move.
  assert.equal(openCapacity(100, 5, 10, c, { maxOrderNotional: 1e9 }), 49);
  // The value cap decides.
  assert.equal(openCapacity(1e6, 5, 10, c, { maxOrderNotional: 200 }), 19);
  // The contract maximum decides.
  assert.equal(openCapacity(1e9, 5, 10, { ...c, maxVol: 7 }, { maxOrderNotional: 1e12 }), 7);
  // Fees come out of the margin.
  assert.equal(openCapacity(100, 5, 10, { ...c, takerFeeRate: 0.01 }, { maxOrderNotional: 1e9 }), 45);
  assert.equal(openCapacity(100, 5, 10, { ...c, volUnit: 0.1 }, { maxOrderNotional: 1e9 }), 49.7);
  assert.equal(openCapacity(0, 5, 10, c, { maxOrderNotional: 1e9 }), 0);
  for (const bad of [[undefined, 5, 10], [NaN, 5, 10], [-1, 5, 10], [100, 0, 10], [100, 5, undefined], [100, 5, 0], [100, 5, Infinity]] as const)
    assert.equal(openCapacity(bad[0], bad[1], bad[2], c, { maxOrderNotional: 1e9 }), undefined);
  // An old gateway or a broken limit must not read as a number of contracts.
  for (const cap of [NaN, undefined as unknown as number, 0, -1])
    assert.equal(openCapacity(100, 5, 10, c, { maxOrderNotional: cap }), undefined);
});

test("a size taken at 100% passes the server's own order check", () => {
  const limits = { maxLeverage: 10, maxOrderNotional: 1000, marketProtection: 0.01 };
  const now = 1_000_000;
  const ticker = { symbol: "A_USDT", lastPrice: 100, bid1: 99.9, ask1: 100.1, fairPrice: 100, timestamp: now };
  const c = contract("A_USDT", { contractSize: 0.01, volUnit: 1, minVol: 1, maxVol: 100_000, priceUnit: 0.1, takerFeeRate: 0.0006 });
  for (const available of [3, 40, 500, 1e6]) for (const leverage of [1, 5, 10])
    for (const action of ["OPEN_LONG", "OPEN_SHORT"] as const) for (const [kind, price] of [["MARKET", ""], ["LIMIT", "100.0"], ["LIMIT", "101.0"], ["LIMIT", "95.0"]] as const) {
      const buying = action === "OPEN_LONG";
      const capacity = openCapacity(available, leverage, valuationPrice(kind, buying, price, ticker, limits.marketProtection), c, limits);
      const vol = volForFraction(1, capacity, c);
      if (!vol) continue;
      const plan = planMexcOrder({
        draft: { symbol: "A_USDT", action, kind, vol, leverage, ...(kind === "LIMIT" ? { price } : {}) },
        contract: c, ticker, positions: [], availableOpen: available, positionMode: 1, limits, now,
      });
      assert.ok(plan.margin! <= available && plan.notional <= limits.maxOrderNotional, `${available} ${leverage} ${action} ${kind} ${price}`);
    }
});

test("a slider position becomes a valid size", () => {
  const c = { volUnit: 1, minVol: 1 };
  assert.equal(volForFraction(0.5, 100, c), "50");
  assert.equal(volForFraction(0.505, 100, c), "50");
  assert.equal(volForFraction(1, 100, c), "100");
  assert.equal(volForFraction(1.5, 100, c), "100");
  // Never below the minimum, and nothing when zero or when the minimum does not fit.
  assert.equal(volForFraction(0.001, 100, c), "1");
  assert.equal(volForFraction(0, 100, c), "");
  assert.equal(volForFraction(NaN, 100, c), "");
  assert.equal(volForFraction(0.5, undefined, c), "");
  assert.equal(volForFraction(1, 0, c), "");
  assert.equal(volForFraction(1, 0.5, c), "");
  // Binary rounding must not lose a step.
  assert.equal(volForFraction(1, 0.3, { volUnit: 0.1, minVol: 0.1 }), "0.3");
  assert.equal(volForFraction(0.5, 0.3, { volUnit: 0.1, minVol: 0.1 }), "0.1");
  // A full close sends the closable amount itself, whatever its digits.
  assert.equal(volForFraction(1, 2.5, c, "2.5"), "2.5");
  assert.equal(volForFraction(0.5, 10, c, "10"), "5");
});

test("the slider position follows the size", () => {
  assert.equal(fractionOfCapacity("25", 100), 0.25);
  assert.equal(fractionOfCapacity("100", 100), 1);
  assert.equal(fractionOfCapacity("500", 100), 1);
  for (const [vol, capacity] of [["", 100], ["abc", 100], ["-1", 100], ["0", 100], ["5", 0], ["5", undefined]] as const)
    assert.equal(fractionOfCapacity(vol, capacity), 0);
});

test("a closing size at any slider position passes the server's own order check", () => {
  const limits = { maxLeverage: 10, maxOrderNotional: 1000, marketProtection: 0.01 };
  const now = 1_000_000;
  const ticker = { symbol: "A_USDT", lastPrice: 100, bid1: 99.9, ask1: 100.1, fairPrice: 100, timestamp: now };
  const c = contract("A_USDT", { contractSize: 1, volUnit: 0.1, minVol: 0.1, priceUnit: 0.1 });
  const held = position({ symbol: "A_USDT", holdVol: 0.3, frozenVol: 0.1 });
  const closable = closableOf(held);
  assert.equal(closable, "0.2");
  assert.equal(volForFraction(1, Number(closable), c, closable), "0.2");
  for (const fraction of [0.01, 0.25, 0.5, 0.75, 1]) {
    const vol = volForFraction(fraction, Number(closable), c, closable);
    const plan = planMexcOrder({
      draft: { symbol: "A_USDT", action: "CLOSE_LONG", kind: "LIMIT", vol, price: "100.0" },
      contract: c, ticker, positions: [held], availableOpen: 0, positionMode: 1, limits, now,
    });
    assert.equal(plan.positionId, held.id);
  }
});

test("every gate alone turns the review button off", () => {
  const open = {
    locked: false, entryBlocked: false, draftIssue: "", reviewing: false, hasContract: true, limitsMissing: false, leverageEmpty: false, sending: false,
  };
  assert.equal(ticketBlocked(open), false);
  for (const change of [{ locked: true }, { entryBlocked: true }, { draftIssue: "x" }, { reviewing: true }, { hasContract: false }, { limitsMissing: true }, { leverageEmpty: true }, { sending: true }])
    assert.equal(ticketBlocked({ ...open, ...change }), true, JSON.stringify(change));
});

test("a form with a problem says so", () => {
  const good = { symbol: "A_USDT", action: "OPEN_LONG", kind: "LIMIT", vol: "1", price: "10", leverage: 5 } as const;
  assert.equal(draftIssueOf(good, "0"), "");
  assert.notEqual(draftIssueOf({ ...good, vol: "" }, "0"), "");
  assert.notEqual(draftIssueOf({ ...good, price: "" }, "0"), "");
  const close = { symbol: "A_USDT", action: "CLOSE_LONG", kind: "MARKET", vol: "1" } as const;
  assert.equal(draftIssueOf(close, "5"), "");
  assert.equal(draftIssueOf(close, "0"), "该方向没有可平的持仓。");
});

test("confirm is off right after the review appears, and stays off if the clock moved back", () => {
  assert.equal(confirmArmed(1000, 1000), false);
  assert.equal(confirmArmed(1000, 1799), false);
  assert.equal(confirmArmed(1000, 1800), true);
  assert.equal(confirmArmed(1000, 500), false);
});

test("favourites read back safely, newest first, and only as real symbols", () => {
  for (const bad of [null, undefined, "", "not json", "{}", "3", "null"]) assert.deepEqual(parseFavorites(bad), []);
  assert.deepEqual(parseFavorites(JSON.stringify(["BTC_USDT", "BTC_USDT", 3, "a/b", null, "QQQSTOCK_USDT"])), ["BTC_USDT", "QQQSTOCK_USDT"]);
  const many = Array.from({ length: MAX_FAVORITES + 5 }, (_, i) => `C${i}_USDT`);
  assert.equal(parseFavorites(JSON.stringify(many)).length, MAX_FAVORITES);
  assert.deepEqual(toggleFavorite(["A_USDT"], "B_USDT"), ["B_USDT", "A_USDT"]);
  assert.deepEqual(toggleFavorite(["B_USDT", "A_USDT"], "B_USDT"), ["A_USDT"]);
  const full = many.slice(0, MAX_FAVORITES);
  assert.deepEqual(toggleFavorite(full, "NEW_USDT"), full);
});

test("favourites keep their order and skip anything no longer listed", () => {
  const listed = [contract("A_USDT"), contract("B_USDT"), contract("C_USDT")];
  assert.deepEqual(favoriteContracts(["C_USDT", "GONE_USDT", "A_USDT"], listed).map(c => c.symbol), ["C_USDT", "A_USDT"]);
  assert.deepEqual(favoriteContracts([], listed), []);
});
