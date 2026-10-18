import type {
  Account,
  Broker,
  Candle,
  Draft,
  History,
  HistoryRange,
  Order,
  Prepared,
  Quote,
} from "./types.ts";
import {
  maximumBuy,
  maximumSell,
  referencePrice,
  validateDraft,
  validateReplacement,
} from "./orderRules.ts";
import {
  aggregateMinutes,
  minuteInterval,
  sessionWindows,
} from "./chartData.ts";
import type { SessionWindow } from "./chartData.ts";

const stockNames: Record<string, [string, number, number]> = {
  AAPL: ["Apple 苹果", 234.85, 1.32],
  NVDA: ["NVIDIA 英伟达", 178.42, 2.81],
  TSLA: ["Tesla 特斯拉", 328.6, -1.47],
  MSFT: ["Microsoft 微软", 512.3, 0.68],
  AMZN: ["Amazon 亚马逊", 229.8, -0.94],
  GOOGL: ["Alphabet 谷歌", 208.12, 1.04],
  SPY: ["SPDR 标普 500 ETF", 648.5, 0.52],
  QQQ: ["Invesco 纳指 100 ETF", 578.2, 0.87],
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const snapshotDay = Date.UTC(2026, 8, 4, 16);
const dayLength = 86_400_000;
interface DemoDay {
  date: number;
  windows: SessionWindow[];
  minutes: number;
}
const tradingDays: DemoDay[] = [];
let dayCursor = snapshotDay;

function dayAt(index: number): DemoDay {
  while (tradingDays.length <= index) {
    const date = dayCursor;
    dayCursor -= dayLength;
    const windows = sessionWindows(date);
    if (windows.length)
      tradingDays.push({
        date,
        windows,
        minutes: windows.reduce(
          (sum, window) => sum + (window.end - window.start) / 60000,
          0,
        ),
      });
  }
  return tradingDays[index];
}

function seededRandom(key: string): () => number {
  let seed = 1;
  for (const character of key)
    seed = (seed * 31 + character.charCodeAt(0)) % 2147483647;
  if (seed === 0) seed = 1;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/** Fixed synthetic snapshot. Every range shares its day OHLC and closing price.
 * Demo day OHLC/volume intentionally cover the full displayed extended session. */
class DemoMarketData {
  private profiles = new Map<number, Candle>();
  private minutes = new Map<number, Candle[]>();
  private histories = new Map<HistoryRange, History>();
  private readonly description: string;
  private readonly lastPrice: number;
  private readonly previousClose: number;
  private readonly phase: number;
  private readonly symbol: string;

  constructor(symbol: string) {
    this.symbol = symbol;
    const [description, lastPrice, change] = stockNames[symbol] ?? [
      `${symbol} 演示行情`,
      100,
      0.5,
    ];
    this.description = description;
    this.lastPrice = lastPrice;
    this.previousClose = lastPrice / (1 + change / 100);
    this.phase = seededRandom(symbol)() * Math.PI * 2;
  }

  private closeAt(index: number): number {
    if (index === 0) return this.lastPrice;
    const age = index - 1;
    return (
      this.previousClose *
      Math.exp(
        -0.0005 * age +
          0.11 * Math.sin(age / 63) +
          0.035 * (Math.sin(age / 11 + this.phase) - Math.sin(this.phase)),
      )
    );
  }

  private profile(index: number): Candle {
    const cached = this.profiles.get(index);
    if (cached) return cached;
    const day = dayAt(index),
      random = seededRandom(`${this.symbol}:${day.date}`);
    const open = this.closeAt(index + 1) * (1 + (random() - 0.5) * 0.006);
    const close = this.closeAt(index);
    const candle = {
      time: day.windows[0].start,
      open,
      close,
      high: Math.max(open, close) * (1.004 + random() * 0.008),
      low: Math.min(open, close) * (0.988 + random() * 0.008),
      volume: Math.floor(8_000_000 + random() * 14_000_000),
    };
    this.profiles.set(index, candle);
    return candle;
  }

  private minuteDay(index: number): Candle[] {
    const cached = this.minutes.get(index);
    if (cached) return cached;
    const day = dayAt(index),
      daily = this.profile(index),
      random = seededRandom(`${this.symbol}:minutes:${day.date}`);
    const rising = daily.close >= daily.open;
    const anchors = [
      { offset: 0, price: daily.open },
      {
        offset: Math.floor(day.minutes * 0.24),
        price: rising ? daily.low : daily.high,
      },
      {
        offset: Math.floor(day.minutes * 0.69),
        price: rising ? daily.high : daily.low,
      },
      { offset: day.minutes, price: daily.close },
    ];
    const weights = Array.from(
      { length: day.minutes },
      () => 50 + Math.floor(random() * 150),
    );
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    const result: Candle[] = [];
    const range = daily.high - daily.low;
    let previous = daily.open,
      position = 0,
      anchor = 1,
      allocated = 0;
    for (const window of day.windows)
      for (let time = window.start; time < window.end; time += 60000) {
        const step = position + 1;
        while (step > anchors[anchor].offset) anchor++;
        const from = anchors[anchor - 1],
          to = anchors[anchor];
        const interpolated =
          from.price +
          ((to.price - from.price) * (step - from.offset)) /
            (to.offset - from.offset);
        const close =
          step === to.offset
            ? to.price
            : Math.min(
                daily.high,
                Math.max(
                  daily.low,
                  interpolated + (random() - 0.5) * range * 0.025,
                ),
              );
        const volume =
          step === day.minutes
            ? daily.volume! - allocated
            : Math.floor((daily.volume! * weights[position]) / weightTotal);
        result.push({
          time,
          open: previous,
          close,
          high: Math.min(
            daily.high,
            Math.max(previous, close) + random() * range * 0.012,
          ),
          low: Math.max(
            daily.low,
            Math.min(previous, close) - random() * range * 0.012,
          ),
          volume,
        });
        previous = close;
        allocated += volume;
        position++;
      }
    this.minutes.set(index, result);
    return result;
  }

  quote(): Quote {
    const daily = this.profile(0),
      day = dayAt(0);
    return {
      symbol: this.symbol,
      description: this.description,
      lastPrice: daily.close,
      bidPrice: daily.close - 0.01,
      askPrice: daily.close + 0.01,
      netChange: daily.close - this.previousClose,
      netPercentChange: (daily.close / this.previousClose - 1) * 100,
      quoteTime: day.windows.at(-1)!.end - 1,
      isRealtime: false,
      assetMainType: "EQUITY",
      openPrice: daily.open,
      highPrice: daily.high,
      lowPrice: daily.low,
      closePrice: this.previousClose,
      totalVolume: daily.volume,
      marketCap: daily.close * 15_200_000_000,
      peRatio: 31.2,
      sharesOutstanding: 15_200_000_000,
    };
  }

  history(range: HistoryRange): History {
    let history = this.histories.get(range);
    if (!history) {
      let candles: Candle[];
      if (range === "intraday") candles = this.minuteDay(0);
      else if (range === "minute1")
        candles = Array.from({ length: 10 }, (_, index) =>
          this.minuteDay(9 - index),
        ).flat();
      else if (range === "fiveDay") {
        candles = this.cachedHistory("minute5").candles.filter(
          (candle) => candle.time >= dayAt(4).windows[0].start,
        );
      } else if (minuteInterval(range) !== undefined) {
        candles = aggregateMinutes(
          this.cachedHistory("minute1").candles,
          minuteInterval(range)!,
          dayAt(0).windows.at(-1)!.end,
          true,
        );
      } else {
        const count = range === "daily" ? 181 : range === "weekly" ? 550 : 1380;
        const daily = Array.from({ length: count }, (_, index) =>
          this.profile(count - index - 1),
        );
        if (range === "daily") candles = daily;
        else {
          const periods = new Map<number, Candle>();
          for (const candle of daily) {
            // A displayed session's 04:00 NY open is always on the same UTC calendar date.
            const date = new Date(candle.time);
            const midnight = Date.UTC(
              date.getUTCFullYear(),
              date.getUTCMonth(),
              date.getUTCDate(),
            );
            const key =
              range === "monthly"
                ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
                : midnight - ((date.getUTCDay() + 6) % 7) * dayLength;
            const existing = periods.get(key);
            if (existing) {
              existing.high = Math.max(existing.high, candle.high);
              existing.low = Math.min(existing.low, candle.low);
              existing.close = candle.close;
              existing.volume! += candle.volume!;
            } else periods.set(key, { ...candle });
          }
          candles = [...periods.values()].slice(
            range === "weekly" ? -104 : -60,
          );
        }
      }
      history = {
        symbol: this.symbol,
        candles,
        previousClose: this.previousClose,
      };
      this.histories.set(range, history);
    }
    return {
      ...history,
      candles: history.candles.map((candle) => ({ ...candle })),
    };
  }

  private cachedHistory(range: HistoryRange): History {
    if (!this.histories.has(range)) this.history(range);
    return this.histories.get(range)!;
  }
}

export class DemoBroker implements Broker {
  private sequence = 1000;
  private prepared = new Map<string, Prepared>();
  private market = new Map<string, DemoMarketData>();
  private list: Order[] = [
    {
      id: "901",
      symbol: "AAPL",
      side: "BUY",
      kind: "LIMIT",
      quantity: 5,
      filledQuantity: 0,
      remainingQuantity: 5,
      limitPrice: 230,
      duration: "DAY",
      status: "WORKING",
      enteredAt: Date.now() - 1800000,
      cancelable: true,
      editable: true,
      isSimpleEquity: true,
    },
    {
      id: "900",
      symbol: "NVDA",
      side: "BUY",
      kind: "MARKET",
      quantity: 10,
      filledQuantity: 10,
      remainingQuantity: 0,
      duration: "DAY",
      status: "FILLED",
      enteredAt: Date.now() - 86400000,
      cancelable: false,
      editable: false,
      isSimpleEquity: true,
    },
  ];
  private account: Account = {
    id: "demo-account",
    displayNumber: "演示 •• 2026",
    accountType: "CASH",
    liquidationValue: 48652.4,
    cashBalance: 21850,
    buyingPower: 20700,
    positions: [
      {
        symbol: "AAPL",
        description: "Apple 苹果",
        assetType: "EQUITY",
        quantity: 40,
        averagePrice: 221.3,
        marketValue: 9394,
        dayProfitLoss: 122.4,
      },
      {
        symbol: "NVDA",
        description: "NVIDIA 英伟达",
        assetType: "EQUITY",
        quantity: 60,
        averagePrice: 152,
        marketValue: 10705.2,
        dayProfitLoss: 292.8,
      },
      {
        symbol: "QQQ",
        description: "纳指 100 ETF",
        assetType: "EQUITY",
        quantity: 12,
        averagePrice: 534,
        marketValue: 6938.4,
        dayProfitLoss: 59.8,
      },
    ],
  };
  constructor() {
    // Explicit simulated fills for previewing both B and S; never used by the real broker.
    const candles = this.marketFor("AAPL").history("intraday").candles;
    for (const [offset, side] of [
      [0.4, "BUY"],
      [0.7, "SELL"],
    ] as const) {
      const candle = candles[Math.floor((candles.length - 1) * offset)];
      if (!candle) continue;
      const id = side === "BUY" ? "898" : "899";
      this.list.push({
        id,
        symbol: "AAPL",
        side,
        kind: "MARKET",
        quantity: 5,
        filledQuantity: 5,
        remainingQuantity: 0,
        duration: "DAY",
        status: "FILLED",
        enteredAt: candle.time,
        cancelable: false,
        editable: false,
        isSimpleEquity: true,
        executions: [
          {
            id: `demo-${id}`,
            symbol: "AAPL",
            side,
            time: candle.time,
            price: candle.close,
            quantity: 5,
          },
        ],
      });
    }
  }
  async status() {
    return {
      configured: true,
      authenticated: true,
      unresolvedOperation: false,
    };
  }
  async configure() {
    throw new Error("请切换到真实连接后设置。");
  }
  async authorizationURL(): Promise<string> {
    throw new Error("演示模式无需授权。");
  }
  async completeAuthorization() {
    throw new Error("演示模式无需授权。");
  }
  async disconnect() {
    this.prepared.clear();
  }
  async acknowledgeReconciliation() {}
  private availableAccount(excludingOrderID?: string): Account {
    const reserved = this.list
      .filter(
        (o) => o.side === "BUY" && o.cancelable && o.id !== excludingOrderID,
      )
      .reduce(
        (sum, o) =>
          sum +
          (o.remainingQuantity ?? 0) *
            (o.limitPrice ??
              o.stopPrice ??
              (stockNames[o.symbol]?.[1] ?? 100) + 0.01),
        0,
      );
    return {
      ...this.account,
      buyingPower: Math.max(0, (this.account.cashBalance ?? 0) - reserved),
    };
  }
  async accounts() {
    return [clone(this.availableAccount())];
  }
  async quotes(symbols: string[]): Promise<Quote[]> {
    return symbols.map((symbol) => this.marketFor(symbol).quote());
  }
  async history(symbol: string, range: HistoryRange): Promise<History> {
    return this.marketFor(symbol).history(range);
  }
  private marketFor(symbol: string): DemoMarketData {
    const existing = this.market.get(symbol);
    if (existing) {
      this.market.delete(symbol);
      this.market.set(symbol, existing);
      return existing;
    }
    if (this.market.size >= 64)
      this.market.delete(this.market.keys().next().value!);
    const market = new DemoMarketData(symbol);
    this.market.set(symbol, market);
    return market;
  }
  async orders(accountID: string) {
    this.requireAccount(accountID);
    return clone(this.list);
  }
  async orderHistory(accountID: string, from: number, to: number) {
    this.requireAccount(accountID);
    return clone(this.list.filter((o) =>
      o.enteredAt === undefined || (o.enteredAt >= from && o.enteredAt <= to)));
  }
  async orderDetail(accountID: string, id: string) {
    this.requireAccount(accountID);
    const order = this.list.find((o) => o.id === id);
    if (!order) throw new Error("订单不存在。");
    return clone(order);
  }
  async prepare(accountID: string, draft: Draft, replacementID?: string) {
    this.requireAccount(accountID);
    validateDraft(draft);
    if (replacementID)
      validateReplacement(
        await this.orderDetail(accountID, replacementID),
        draft,
      );
    const quote = (await this.quotes([draft.symbol]))[0];
    const price = referencePrice(draft, quote)!;
    const account = this.availableAccount(replacementID);
    const available =
      draft.side === "BUY"
        ? maximumBuy(account, price)
        : maximumSell(account, draft.symbol, this.list, true, replacementID);
    if (available === undefined || draft.quantity > available)
      throw new Error("数量超出当前可用资金或可卖持仓。");
    const value: Prepared = Object.freeze({
      id: `review-${++this.sequence}`,
      draft: Object.freeze(clone(draft)),
      accountID,
      accountDisplay: this.account.displayNumber,
      quote,
      estimatedValue: price * draft.quantity,
      availableShares: available,
      buyingPower: account.buyingPower,
      preparedAt: Date.now(),
      replacementOrderID: replacementID,
      isDemo: true,
    });
    this.prepared.clear();
    this.prepared.set(value.id, value);
    return value;
  }
  async submit(prepared: Prepared) {
    if (
      this.prepared.get(prepared.id) !== prepared ||
      Date.now() - prepared.preparedAt > 60000
    )
      throw new Error("订单预览已失效，请重新预览。");
    this.prepared.delete(prepared.id);
    const account = this.availableAccount(prepared.replacementOrderID);
    const limit =
      prepared.draft.side === "BUY"
        ? maximumBuy(account, referencePrice(prepared.draft, prepared.quote))
        : maximumSell(
            account,
            prepared.draft.symbol,
            this.list,
            true,
            prepared.replacementOrderID,
          );
    if (limit === undefined || prepared.draft.quantity > limit)
      throw new Error("账户可用额度已变化，请重新预览。");
    if (prepared.replacementOrderID) {
      const old = this.list.find((o) => o.id === prepared.replacementOrderID)!;
      validateReplacement(old, prepared.draft);
      old.status = "REPLACED";
      old.cancelable = false;
      old.editable = false;
    }
    const draft = prepared.draft,
      id = String(++this.sequence);
    this.list.unshift({
      id,
      ...draft,
      limitPrice:
        draft.limitPrice === undefined ? undefined : Number(draft.limitPrice),
      stopPrice:
        draft.stopPrice === undefined ? undefined : Number(draft.stopPrice),
      status: "WORKING",
      enteredAt: Date.now(),
      filledQuantity: 0,
      remainingQuantity: draft.quantity,
      cancelable: true,
      editable: (draft.session ?? "NORMAL") === "NORMAL",
      isSimpleEquity: true,
    });
    return { orderID: id };
  }
  async cancel(accountID: string, id: string) {
    this.requireAccount(accountID);
    const order = this.list.find((o) => o.id === id);
    if (!order?.cancelable) throw new Error("此订单目前不可撤销。");
    order.status = "CANCELED";
    order.cancelable = false;
    order.editable = false;
    this.prepared.clear();
  }
  private requireAccount(id: string) {
    if (id !== this.account.id) throw new Error("请选择有效账户。");
  }
}
