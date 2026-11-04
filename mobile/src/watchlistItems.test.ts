import assert from "node:assert/strict";
import test from "node:test";
import type { MexcContract } from "./mexcRules.ts";
import {
  allContractItems, contractChange, createLimiter, filterItems, heldContracts, itemCounts, itemKey, searchContracts, trendOf, watchlistItems,
} from "./watchlistItems.ts";

const contract = (symbol: string, over: Partial<MexcContract> = {}): MexcContract => ({
  symbol, displayName: `${symbol.split("_")[0]}_USDT PERPETUAL`, baseCoin: symbol.split("_")[0], settleCoin: "USDT", futureType: 1, state: 0,
  apiAllowed: true, contractSize: 1, priceUnit: 0.01, volUnit: 1, minVol: 1, maxVol: 100, minLeverage: 1, maxLeverage: 10,
  positionOpenType: 3, takerFeeRate: 0, makerFeeRate: 0, ...over,
});
const contracts = [contract("AAA_USDT"), contract("BBB_USDT"), contract("CCC_USDT")];

test("the limiter runs a few reads at once, and a failed one does not hold up the rest", async () => {
  const limit = createLimiter(4);
  let running = 0, most = 0;
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => limit(async () => {
    running++;
    most = Math.max(most, running);
    await new Promise(resolve => setTimeout(resolve, 1));
    running--;
    if (index === 3) throw new Error("failed");
    return index;
  })));
  assert.equal(most, 4);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 19);
  assert.equal(results[3].status, "rejected");
});

test("stocks come first, then favourite contracts, each in its own order", () => {
  const items = watchlistItems(["QQQ", "SPY"], ["CCC_USDT", "AAA_USDT", "GONE_USDT"], contracts, true);
  assert.deepEqual(items.map(itemKey), ["s:QQQ", "s:SPY", "c:CCC_USDT", "c:AAA_USDT"]);
});

test("without a MEXC connection no contract appears", () => {
  const items = watchlistItems(["QQQ"], ["AAA_USDT"], contracts, false);
  assert.deepEqual(items.map(itemKey), ["s:QQQ"]);
  assert.deepEqual(allContractItems(contracts, false), []);
  assert.deepEqual(searchContracts(contracts, "AAA", false), []);
  assert.equal(watchlistItems(["QQQ"], ["AAA_USDT"], contracts, undefined).length, 2);
});

test("filters and counts", () => {
  const items = watchlistItems(["QQQ", "SPY"], ["AAA_USDT"], contracts, true);
  assert.deepEqual(itemCounts(items), { all: 3, stock: 2, contract: 1 });
  assert.deepEqual(filterItems(items, "stock").map(itemKey), ["s:QQQ", "s:SPY"]);
  assert.deepEqual(filterItems(items, "contract").map(itemKey), ["c:AAA_USDT"]);
  assert.equal(filterItems(items, "all").length, 3);
  assert.deepEqual(itemCounts([]), { all: 0, stock: 0, contract: 0 });
});

test("search results are capped and matched", () => {
  const many = Array.from({ length: 20 }, (_, i) => contract(`X${String(i).padStart(2, "0")}_USDT`));
  assert.equal(searchContracts(many, "X", true).length, 8);
  assert.deepEqual(searchContracts(contracts, "bbb", true).map(c => c.symbol), ["BBB_USDT"]);
  assert.deepEqual(searchContracts(contracts, "  ", true), []);
});

test("held contracts need an open volume", () => {
  const held = heldContracts([{ symbol: "AAA_USDT", holdVol: 2 }, { symbol: "BBB_USDT", holdVol: 0 }]);
  assert.ok(held.has("AAA_USDT"));
  assert.ok(!held.has("BBB_USDT"));
  assert.equal(heldContracts(undefined).size, 0);
});

test("change is worked back from the rate", () => {
  assert.equal(contractChange({ lastPrice: 110, riseFallRate: 0.1 })?.toFixed(6), "10.000000");
  assert.equal(contractChange({ lastPrice: 90, riseFallRate: -0.1 })?.toFixed(6), "-10.000000");
  assert.equal(contractChange({ lastPrice: 90 }), undefined);
  assert.equal(contractChange(undefined), undefined);
  assert.equal(contractChange({ lastPrice: 5, riseFallRate: -1 }), undefined);
  assert.equal(trendOf(1), "up");
  assert.equal(trendOf(-1), "down");
  assert.equal(trendOf(0), "flat");
  assert.equal(trendOf(undefined), "flat");
});
