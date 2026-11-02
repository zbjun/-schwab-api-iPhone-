import { TradingError } from "../orderRules.ts";
import {
  MEXC_ACCOUNT, MEXC_MESSAGES, MEXC_REVIEW_TTL, freezeMexcDraft, isBuying, isOpening, mexcError, planMexcOrder,
  validMexcSymbol, validateMexcDraft,
} from "../mexcRules.ts";
import type {
  MexcAccount, MexcContract, MexcDraft, MexcLimits, MexcOrder, MexcOrderPlan, MexcPosition, MexcPrepared, MexcTicker,
} from "../mexcRules.ts";
import type { MexcApi, MexcStatus } from "../MexcClient.ts";
import type { Candle, History, HistoryRange } from "../types.ts";

/**
 * Placing an order of exactly this many contracts simulates "the exchange never answered":
 * the order is not applied, trading locks and `status().unresolvedOperation` turns true until
 * `acknowledgeReconciliation()`. Used to exercise the lock banner without a real account.
 */
export const DEMO_UNKNOWN_VOL = "77";

const DAY = 86_400_000;
const WALLET = 1200;
const LIMITS: MexcLimits = { maxLeverage: 10, maxOrderNotional: 5000, marketProtection: 0.01 };
const base = (symbol: string, displayName: string, baseCoin: string, rest: Partial<MexcContract>): MexcContract => ({
  symbol, displayName, baseCoin, settleCoin: "USDT", futureType: 1, state: 0, apiAllowed: true, contractSize: 0.01,
  priceUnit: 0.01, volUnit: 1, minVol: 1, maxVol: 28000, minLeverage: 1, maxLeverage: 100, positionOpenType: 3,
  takerFeeRate: 0.0002, makerFeeRate: 0, ...rest,
});
// All fictional: names, sizes and prices only resemble real contracts.
const CONTRACTS: MexcContract[] = [
  base("BTC_USDT", "BTC_USDT PERPETUAL", "BTC", { contractSize: 0.0001, priceUnit: 0.1, maxVol: 100000, maxLeverage: 200, takerFeeRate: 0.0004, makerFeeRate: 0.0001 }),
  base("QQQSTOCK_USDT", "QQQ_USDT PERPETUAL", "QQQSTOCK", {}),
  base("TSLASTOCK_USDT", "TSLA_USDT PERPETUAL", "TSLASTOCK", { maxLeverage: 50 }),
];
const BASE_PRICE: Record<string, number> = { BTC_USDT: 100000, QQQSTOCK_USDT: 700, TSLASTOCK_USDT: 250 };
const INTERVAL_SECONDS: Record<string, number> = {
  intraday: 60, fiveDay: 300, minute1: 60, minute5: 300, minute15: 900, minute30: 1800, minute60: 3600,
  minute120: 7200, daily: 86_400, weekly: 604_800, monthly: 2_592_000,
};
const seedOf = (symbol: string) => [...symbol].reduce((sum, c) => sum + c.charCodeAt(0), 0);
const noise = (seed: number, index: number) => {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const round = (value: number, unit: number) => Math.round(value / unit) * unit;
const direction = (action: MexcOrder["action"]) => (action === "OPEN_LONG" || action === "CLOSE_LONG" ? 1 : -1);

interface Reviewed { prepared: MexcPrepared; draft: MexcDraft }

/** In-memory MEXC account. Orders go through the same `planMexcOrder` as the real server. */
export class MexcDemo implements MexcApi {
  readonly isDemo = true;
  private readonly clock: () => number;
  private readonly started: number;
  private wallet = WALLET;
  private sequence = 0;
  private unresolved = false;
  private positions: MexcPosition[];
  private open: MexcOrder[];
  private closed: MexcOrder[];
  private readonly reviews = new Map<string, Reviewed>();

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.started = clock();
    this.positions = [{
      id: "9000000000001", symbol: "QQQSTOCK_USDT", direction: "LONG", openType: 1, holdVol: 20, frozenVol: 0,
      averagePrice: 690, liquidatePrice: 560, leverage: 5, margin: (20 * 0.01 * 690) / 5,
    }];
    this.open = [{
      id: "8000000000001", symbol: "BTC_USDT", action: "OPEN_LONG", orderType: 1, price: 90000, vol: 10, dealVol: 0,
      leverage: 10, openType: 1, state: 2, cancelable: true, createdAt: this.started - 3_600_000, updatedAt: this.started - 3_600_000,
    }];
    this.closed = [
      { id: "8000000000002", symbol: "QQQSTOCK_USDT", action: "OPEN_LONG", orderType: 1, price: 690, vol: 20, dealVol: 20,
        dealAvgPrice: 690, leverage: 5, openType: 1, state: 3, cancelable: false, fee: 0.03, createdAt: this.started - 2 * DAY, updatedAt: this.started - 2 * DAY },
      { id: "8000000000003", symbol: "QQQSTOCK_USDT", action: "OPEN_SHORT", orderType: 1, price: 760, vol: 5, dealVol: 0,
        leverage: 5, openType: 1, state: 4, cancelable: false, fee: 0, createdAt: this.started - 3 * DAY, updatedAt: this.started - 3 * DAY },
    ];
  }

  private contract(symbol: string): MexcContract {
    if (!validMexcSymbol(symbol)) throw mexcError("invalidSymbol");
    const found = CONTRACTS.find(c => c.symbol === symbol);
    if (!found) throw mexcError("contractUnavailable");
    return found;
  }
  private ticker(symbol: string): MexcTicker {
    const contract = this.contract(symbol), now = this.clock(), start = BASE_PRICE[symbol];
    const last = round(start * (1 + 0.004 * Math.sin(now / 420_000 + seedOf(symbol))), contract.priceUnit);
    return {
      symbol, lastPrice: last, bid1: last - contract.priceUnit, ask1: last + contract.priceUnit,
      fairPrice: last, indexPrice: last, fundingRate: 0.0001, riseFallRate: (last - start) / start,
      amount24: 1_000_000, high24Price: last * 1.01, lower24Price: last * 0.99,
      maxBidPrice: round(last * 1.2, contract.priceUnit), minAskPrice: round(last * 0.8, contract.priceUnit), timestamp: now,
    };
  }
  /** Cash not locked by positions or by the margin of resting open orders. */
  private availableOpen(): number {
    const positionMargin = this.positions.reduce((sum, p) => sum + (p.margin ?? 0), 0);
    const reserved = this.open.filter(o => o.action === "OPEN_LONG" || o.action === "OPEN_SHORT").reduce((sum, o) =>
      sum + (o.price * o.vol * this.contract(o.symbol).contractSize) / (o.leverage ?? 1), 0);
    return Math.max(0, this.wallet - positionMargin - reserved);
  }
  private unrealized(position: MexcPosition): number {
    const size = this.contract(position.symbol).contractSize;
    return (this.ticker(position.symbol).lastPrice - position.averagePrice) * position.holdVol * size * direction(position.direction === "LONG" ? "OPEN_LONG" : "OPEN_SHORT");
  }

  async status(): Promise<MexcStatus> {
    return { configured: true, authenticated: true, unresolvedOperation: this.unresolved };
  }
  async account(): Promise<MexcAccount> {
    const positions = this.positions.map(p => ({ ...p, unrealized: this.unrealized(p) }));
    const unrealized = positions.reduce((sum, p) => sum + (p.unrealized ?? 0), 0);
    const positionMargin = positions.reduce((sum, p) => sum + (p.margin ?? 0), 0);
    const available = this.availableOpen();
    return {
      id: MEXC_ACCOUNT,
      asset: { currency: "USDT", equity: this.wallet + unrealized, availableBalance: available, availableOpen: available,
        positionMargin, frozenBalance: this.wallet - positionMargin - available, unrealized },
      positions,
    };
  }
  async contracts() { return CONTRACTS.map(c => ({ ...c })); }
  async limits() { return { ...LIMITS }; }
  async tickers(symbols: string[]) { return symbols.filter(s => CONTRACTS.some(c => c.symbol === s)).map(s => this.ticker(s)); }
  async chart(symbol: string, range: HistoryRange): Promise<History> {
    this.contract(symbol);
    const step = INTERVAL_SECONDS[range];
    if (!step) throw mexcError("invalidRange");
    const seed = seedOf(symbol), start = BASE_PRICE[symbol];
    const last = Math.floor(this.clock() / 1000 / step), count = 240;
    const level = (k: number) => start * (1 + 0.012 * Math.sin(k / 9 + seed) + 0.006 * Math.sin(k / 3.1));
    const candles: Candle[] = [];
    for (let i = 0; i < count; i++) {
      const k = last - (count - 1 - i), open = level(k), close = level(k + 1);
      const wick = start * 0.002 * (0.3 + noise(seed, k));
      candles.push({ time: k * step * 1000, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
        close, volume: Math.round(100 + 900 * noise(seed + 1, k)) });
    }
    return { symbol, candles };
  }
  async openOrders() { return this.open.map(o => ({ ...o })); }
  async closedOrders(symbol: string, from: number, to: number) {
    this.contract(symbol);
    return this.closed.filter(o => o.symbol === symbol && (o.updatedAt ?? 0) >= from && (o.updatedAt ?? 0) <= to).map(o => ({ ...o }));
  }

  private plan(draft: MexcDraft, reviewedPrice?: string): MexcOrderPlan {
    return planMexcOrder({
      draft, contract: this.contract(draft.symbol), ticker: this.ticker(draft.symbol), positions: this.positions,
      availableOpen: this.availableOpen(), positionMode: 1, limits: LIMITS, now: this.clock(), reviewedPrice,
    });
  }
  async review(draft: MexcDraft): Promise<MexcPrepared> {
    validateMexcDraft(draft);
    const frozen = freezeMexcDraft(draft), plan = this.plan(frozen), contract = this.contract(frozen.symbol);
    this.sequence++;
    const prepared: MexcPrepared = {
      id: `demo-review-${this.sequence}`, draft: frozen, accountID: MEXC_ACCOUNT, displayName: contract.displayName,
      externalOid: `demo${String(this.sequence).padStart(8, "0")}`, ...plan, takerFeeRate: contract.takerFeeRate,
      makerFeeRate: contract.makerFeeRate, fundingRate: this.ticker(frozen.symbol).fundingRate, preparedAt: this.clock(), isDemo: true,
    };
    // A newer review replaces the older one, as the server does for the same account.
    this.reviews.clear();
    this.reviews.set(prepared.id, { prepared, draft: frozen });
    return prepared;
  }
  async place(prepared: MexcPrepared): Promise<{ orderID: string }> {
    const entry = this.reviews.get(prepared.id);
    this.reviews.delete(prepared.id); // One use, whatever happens next.
    if (this.unresolved) throw mexcError("orderOutcomeUnknown");
    if (!entry || this.clock() - entry.prepared.preparedAt > MEXC_REVIEW_TTL) throw mexcError("reviewExpired");
    const { draft } = entry;
    // Re-checked against current state, keeping the price the user approved.
    const plan = this.plan(draft, entry.prepared.orderPrice);
    if (draft.vol === DEMO_UNKNOWN_VOL) {
      this.unresolved = true;
      throw new TradingError("orderOutcomeUnknown", MEXC_MESSAGES.orderOutcomeUnknown);
    }
    const contract = this.contract(draft.symbol), ticker = this.ticker(draft.symbol);
    const buying = isBuying(draft.action), vol = Number(draft.vol), now = this.clock();
    const orderID = String(8_000_000_000_000 + ++this.sequence);
    const limit = draft.kind === "LIMIT" ? Number(plan.orderPrice) : undefined;
    const crosses = limit === undefined || (buying ? limit >= (ticker.ask1 ?? Infinity) : limit <= (ticker.bid1 ?? 0));
    const order: MexcOrder = {
      id: orderID, symbol: draft.symbol, action: draft.action, orderType: limit === undefined ? 3 : 1, price: Number(plan.orderPrice),
      vol, dealVol: 0, leverage: plan.leverage, openType: plan.openType, state: 2, cancelable: true, externalOid: entry.prepared.externalOid,
      createdAt: now, updatedAt: now,
    };
    if (crosses) {
      const price = plan.referencePrice;
      this.fill(order, contract, price, plan);
      this.closed.unshift({ ...order, dealVol: vol, dealAvgPrice: price, state: 3, cancelable: false });
    } else {
      if (!isOpening(draft.action)) {
        const held = this.positions.find(p => p.id === plan.positionId);
        if (held) held.frozenVol += vol;
      }
      this.open.unshift(order);
    }
    return { orderID };
  }
  private fill(order: MexcOrder, contract: MexcContract, price: number, plan: MexcOrderPlan) {
    const sign = direction(order.action), notional = order.vol * contract.contractSize * price;
    this.wallet -= notional * contract.takerFeeRate;
    order.fee = notional * contract.takerFeeRate;
    if (isOpening(order.action)) {
      const held = this.positions.find(p => p.symbol === order.symbol && p.direction === (sign > 0 ? "LONG" : "SHORT"));
      const margin = notional / (plan.leverage ?? 1);
      if (held) {
        held.averagePrice = (held.averagePrice * held.holdVol + price * order.vol) / (held.holdVol + order.vol);
        held.holdVol += order.vol;
        held.margin = (held.margin ?? 0) + margin;
      } else {
        this.positions.push({
          id: String(9_000_000_000_000 + ++this.sequence), symbol: order.symbol, direction: sign > 0 ? "LONG" : "SHORT", openType: 1,
          holdVol: order.vol, frozenVol: 0, averagePrice: price, leverage: plan.leverage ?? 1, margin,
          liquidatePrice: price * (1 - sign / (plan.leverage ?? 1)),
        });
      }
      return;
    }
    const held = this.positions.find(p => p.id === plan.positionId);
    if (!held) return;
    const heldSign = held.direction === "LONG" ? 1 : -1;
    this.wallet += (price - held.averagePrice) * order.vol * contract.contractSize * heldSign;
    held.margin = (held.margin ?? 0) * (1 - order.vol / held.holdVol);
    held.holdVol -= order.vol;
    if (held.holdVol <= 0) this.positions = this.positions.filter(p => p !== held);
  }
  async cancelOrder(orderID: string): Promise<void> {
    if (this.unresolved) throw mexcError("orderOutcomeUnknown");
    const order = this.open.find(o => o.id === orderID);
    if (!order) throw mexcError("orderChanged");
    this.open = this.open.filter(o => o !== order);
    if (!isOpening(order.action)) {
      const held = this.positions.find(p => p.symbol === order.symbol && p.direction === (direction(order.action) > 0 ? "LONG" : "SHORT"));
      if (held) held.frozenVol = Math.max(0, held.frozenVol - order.vol);
    }
    this.closed.unshift({ ...order, state: 4, cancelable: false, updatedAt: this.clock() });
  }
  async acknowledgeReconciliation(): Promise<void> { this.unresolved = false; }
}
