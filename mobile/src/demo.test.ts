import test from "node:test";
import assert from "node:assert/strict";
import { DemoBroker } from "./demo.ts";
import {
  minuteRanges,
  primaryRanges,
  sessionAt,
  sessionWindows,
} from "./chartData.ts";
import type { Candle } from "./types.ts";
test("demo pending buys reserve funds, cancellations restore them, replacements reserve only the new value", async () => {
  const broker = new DemoBroker();
  const initial = (await broker.accounts())[0];
  assert.equal(initial.buyingPower, 20700);
  const draft = {
    symbol: "AAPL",
    side: "BUY" as const,
    kind: "LIMIT" as const,
    quantity: 100,
    limitPrice: "200",
    duration: "DAY" as const,
  };
  const snapshot = await broker.prepare(initial.id, draft);
  const receipt = await broker.submit(snapshot);
  assert.equal((await broker.accounts())[0].buyingPower, 700);
  await assert.rejects(() => broker.submit(snapshot));
  await assert.rejects(() => broker.prepare(initial.id, draft));
  const change = await broker.prepare(
    initial.id,
    { ...draft, quantity: 50 },
    receipt.orderID,
  );
  const changed = await broker.submit(change);
  assert.equal((await broker.accounts())[0].buyingPower, 10700);
  await broker.cancel(initial.id, changed.orderID!);
  assert.equal((await broker.accounts())[0].buyingPower, 20700);
});
test("demo sell orders reserve available long shares and cancel releases the reservation", async () => {
  const broker = new DemoBroker(),
    account = (await broker.accounts())[0];
  const draft = {
    symbol: "AAPL",
    side: "SELL" as const,
    kind: "LIMIT" as const,
    quantity: 40,
    limitPrice: "240",
    duration: "DAY" as const,
  };
  const receipt = await broker.submit(await broker.prepare(account.id, draft));
  await assert.rejects(() =>
    broker.prepare(account.id, { ...draft, quantity: 1 }),
  );
  await broker.cancel(account.id, receipt.orderID!);
  assert.equal((await broker.prepare(account.id, draft)).availableShares, 40);
});

test("demo market buys reserve their quoted ask estimate and release the full amount on cancellation", async () => {
  const broker = new DemoBroker(),
    account = (await broker.accounts())[0];
  const review = await broker.prepare(account.id, {
    symbol: "AAPL",
    side: "BUY",
    kind: "MARKET",
    quantity: 10,
    duration: "DAY",
  });
  const receipt = await broker.submit(review);
  assert.equal(
    (await broker.accounts())[0].buyingPower,
    account.buyingPower! - review.estimatedValue!,
  );
  await broker.cancel(account.id, receipt.orderID!);
  assert.equal((await broker.accounts())[0].buyingPower, account.buyingPower);
});

test("demo submit rechecks changed buying power and consumes the failed review once", async () => {
  const broker = new DemoBroker(),
    account = (await broker.accounts())[0];
  const draft = {
    symbol: "AAPL",
    side: "BUY" as const,
    kind: "LIMIT" as const,
    quantity: 10,
    limitPrice: "200",
    duration: "DAY" as const,
  };
  const review = await broker.prepare(account.id, draft);
  // Simulate funds changing between preview and submit without introducing a live transport.
  (
    broker as unknown as { account: { cashBalance: number } }
  ).account.cashBalance = 1500;
  await assert.rejects(() => broker.submit(review), /额度已变化/);
  await assert.rejects(() => broker.submit(review), /预览已失效/);
  assert.equal(
    (await broker.orders(account.id)).some((order) => Number(order.id) >= 1000),
    false,
  );
});

function summary(candles: Candle[]) {
  return {
    open: candles[0].open,
    high: Math.max(...candles.map((c) => c.high)),
    low: Math.min(...candles.map((c) => c.low)),
    close: candles.at(-1)!.close,
    volume: candles.reduce((sum, c) => sum + (c.volume ?? 0), 0),
  };
}

test("demo quote, intraday, and latest daily candle describe the same deterministic snapshot", async () => {
  const broker = new DemoBroker();
  for (const symbol of ["AAPL", "TSLA", "QQQ", "ZZZZ"]) {
    const [quote] = await broker.quotes([symbol]);
    const intraday = await broker.history(symbol, "intraday");
    const daily = await broker.history(symbol, "daily");
    const current = summary(intraday.candles),
      latestDay = daily.candles.at(-1)!;
    assert.equal(quote.lastPrice, current.close);
    assert.equal(quote.openPrice, current.open);
    assert.equal(quote.highPrice, current.high);
    assert.equal(quote.lowPrice, current.low);
    assert.equal(quote.totalVolume, current.volume);
    assert.deepEqual(summary([latestDay]), current);
    assert.equal(quote.closePrice, daily.candles.at(-2)!.close);
    assert.equal(intraday.previousClose, quote.closePrice);
    assert.equal(daily.previousClose, quote.closePrice);
    assert.ok(
      Math.abs(
        quote.netPercentChange! -
          (quote.lastPrice! / quote.closePrice! - 1) * 100,
      ) < 1e-10,
    );
    assert.equal(quote.netChange, quote.lastPrice! - quote.closePrice!);
    assert.ok(quote.quoteTime! >= intraday.candles.at(-1)!.time);
    assert.ok(quote.quoteTime! < intraday.candles.at(-1)!.time + 60000);
    assert.equal(quote.isRealtime, false);
  }
});

test("all demo chart periods end at the quoted price and keep prices inside their OHLC bounds", async () => {
  const broker = new DemoBroker(),
    [quote] = await broker.quotes(["AAPL"]);
  assert.equal(quote.lastPrice, 234.85);
  for (const range of [...primaryRanges, ...minuteRanges]) {
    const history = await broker.history("AAPL", range);
    assert.ok(history.candles.length >= 30, range);
    assert.equal(history.candles.at(-1)!.close, quote.lastPrice, range);
    assert.equal(history.previousClose, quote.closePrice, range);
    for (const candle of history.candles) {
      assert.ok(candle.low <= Math.min(candle.open, candle.close), range);
      assert.ok(candle.high >= Math.max(candle.open, candle.close), range);
      assert.ok(
        candle.volume! >= 0 && Number.isSafeInteger(candle.volume),
        range,
      );
    }
  }
});

test("daily demo candles skip weekends and known exchange closures rather than inventing sessions", async () => {
  const candles = (await new DemoBroker().history("AAPL", "daily")).candles;
  assert.ok(candles.length >= 180);
  const dates = new Set<string>();
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    dateStyle: "short",
  });
  for (const [index, candle] of candles.entries()) {
    assert.ok(sessionWindows(candle.time).length > 0);
    assert.notEqual(sessionAt(candle.time), undefined);
    const weekday = new Date(candle.time).getUTCDay();
    assert.ok(weekday !== 0 && weekday !== 6);
    dates.add(format.format(candle.time));
    if (index > 0) assert.ok(candle.time > candles[index - 1].time);
  }
  assert.equal(dates.size, candles.length);
  for (const holiday of [Date.UTC(2026, 5, 19, 16), Date.UTC(2026, 6, 3, 16)])
    assert.ok(!dates.has(format.format(holiday)));
});

test("latest weekly and monthly demo candles aggregate the same underlying daily sessions", async () => {
  const broker = new DemoBroker();
  const daily = (await broker.history("AAPL", "daily")).candles;
  for (const range of ["weekly", "monthly"] as const) {
    const period = (await broker.history("AAPL", range)).candles.at(-1)!;
    const children = daily.filter((c) => c.time >= period.time);
    assert.equal(children.length, range === "weekly" ? 5 : 4, range);
    assert.deepEqual(summary([period]), summary(children), range);
  }
});

test("intraday and five-day demo charts use exact subsets of the shared minute history", async () => {
  const broker = new DemoBroker();
  const minute = (await broker.history("MSFT", "minute1")).candles;
  const intraday = (await broker.history("MSFT", "intraday")).candles;
  assert.deepEqual(
    minute.filter((c) => c.time >= intraday[0].time),
    intraday,
  );
  const fiveMinute = (await broker.history("MSFT", "minute5")).candles;
  const fiveDay = (await broker.history("MSFT", "fiveDay")).candles;
  assert.deepEqual(
    fiveMinute.filter((c) => c.time >= fiveDay[0].time),
    fiveDay,
  );
});

test("cached demo histories remain deterministic and cannot be changed through returned objects", async () => {
  const broker = new DemoBroker();
  const before = await broker.history("AAPL", "intraday");
  const expected = await new DemoBroker().history("AAPL", "intraday");
  before.candles[0].close = 999999;
  before.candles.pop();
  before.previousClose = 1;
  assert.deepEqual(await broker.history("AAPL", "intraday"), expected);
  const [quote] = await broker.quotes(["AAPL"]);
  quote.lastPrice = 1;
  assert.equal((await broker.quotes(["AAPL"]))[0].lastPrice, 234.85);
});
