import type {
  Account,
  Candle,
  Draft,
  History,
  HistoryRange,
  Order,
  OrderKind,
  OrderSession,
  Position,
  Quote,
  Side,
  StopMode,
  TradeExecution,
} from "./types.ts";
import { historyCoverage } from "./historyCoverage.ts";

/** Only controlled messages are allowed to reach the UI; provider bodies are never errors. */
export class TradingError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.name = "TradingError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const OPEN_STATUSES = new Set([
  "NEW",
  "ACCEPTED",
  "WORKING",
  "QUEUED",
  "PENDING_CANCEL",
  "PENDING_REPLACE",
  "AWAITING_REPLACEMENT",
  "PENDING_ACTIVATION",
  "AWAITING_STOP_CONDITION",
  "AWAITING_CONDITION",
  "AWAITING_MANUAL_REVIEW",
  "AWAITING_PARENT_ORDER",
  "PENDING_ACKNOWLEDGEMENT",
  "AWAITING_RELEASE_TIME",
  "AWAITING_UR_OUT",
]);
export const FINAL_STATUSES = new Set([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
  "REPLACED",
]);
const KINDS: OrderKind[] = ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"];
export const orderSessionLabels: Record<OrderSession, string> = {
  NORMAL: "常规时段",
  AM: "仅盘前",
  PM: "仅盘后",
  SEAMLESS: "盘前＋盘中＋盘后",
};
const MAX_TIME = 32_503_680_000_000;
const MAX_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export function invalidResponse(): TradingError {
  return new TradingError(
    "invalidResponse",
    "Schwab 返回的数据不完整或格式不受支持。",
  );
}

export function validSymbol(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 15 &&
    /^[A-Z][A-Z0-9]*([./-][A-Z0-9]+)?$/.test(value)
  );
}

export function validAccountHash(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    /[A-Za-z]/.test(value)
  );
}

export function validOrderID(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 32 && /^[0-9]+$/.test(value)
  );
}

function priceUnits(text: unknown): bigint | undefined {
  if (typeof text !== "string") return undefined;
  const value = text.trim();
  if (value.length > 32 || !/^[0-9]+(?:\.[0-9]{1,4})?$/.test(value))
    return undefined;
  const [integer, fraction = ""] = value.split(".");
  const units = BigInt(integer) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  return units > 0n && units <= MAX_INTEGER ? units : undefined;
}

export function parsePrice(text: string): number | undefined {
  const units = priceUnits(text);
  return units === undefined ? undefined : Number(units) / 10_000;
}

function canonicalPrice(text: string): string {
  const units = priceUnits(text);
  if (units === undefined)
    throw new TradingError("price", "价格必须大于 0，最多保留 4 位小数。");
  const fraction = (units % 10_000n)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "");
  return (units / 10_000n).toString() + (fraction ? "." + fraction : "");
}

/** Decimal arithmetic avoids losing a whole share at boundaries such as 0.3 / 0.1. */
function decimal(
  value: number | string | undefined,
): { units: bigint; scale: number } | undefined {
  if (
    value === undefined ||
    (typeof value === "number" && (!Number.isFinite(value) || value < 0))
  )
    return undefined;
  const text = String(value).trim();
  if (text.length > 80) return undefined;
  const match = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (!match) return undefined;
  const exponent = Number(match[3] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 30) return undefined;
  let units = BigInt(match[1] + (match[2] ?? ""));
  let scale = (match[2]?.length ?? 0) - exponent;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (scale > 30) return undefined;
  return { units, scale };
}

export function sharesForBudget(
  budget: number | string | undefined,
  price: number | string | undefined,
): number | undefined {
  const a = decimal(budget),
    b = decimal(price);
  if (!a || !b || b.units <= 0n) return undefined;
  const result =
    (a.units * 10n ** BigInt(b.scale)) / (b.units * 10n ** BigInt(a.scale));
  return result <= MAX_INTEGER ? Number(result) : undefined;
}

export function maximumBuy(
  account: Account | undefined,
  price: number | string | undefined,
): number | undefined {
  return sharesForBudget(account?.buyingPower, price);
}

/** Account/order responses may label exchange-traded funds separately from equities. */
export function isStockAsset(assetType: unknown): boolean {
  return assetType === "EQUITY" || assetType === "ETF";
}

export function isStockHolding(
  position: Pick<Position, "symbol" | "assetType">,
  quote?: Quote,
): boolean {
  if (isStockAsset(position.assetType)) return true;
  // COLLECTIVE_INVESTMENT also includes non-ETF products. Verify the same ticker
  // against the quote's ETF classification, without changing the raw position type.
  return (
    position.assetType === "COLLECTIVE_INVESTMENT" &&
    quote?.symbol === position.symbol &&
    (quote.assetMainType === "ETF" ||
      (quote.assetMainType === "EQUITY" && quote.assetSubType === "ETF"))
  );
}

function openOrder(order: Order): boolean {
  // An OCO wrapper is only a container: its legs decide whether shares are still committed.
  if (order.strategy === "OCO" && order.children?.length) return order.children.some(openOrder);
  return !FINAL_STATUSES.has(order.status) || (order.children ?? []).some(openOrder);
}
/**
 * Shares an open order may still sell, or undefined when that cannot be known.
 * OCO legs share the same shares, so the group reserves its largest open sell
 * leg once. A bracket's exits wait for the buy entry and reserve nothing until
 * it fills; a partially filled entry is ambiguous and blocks sell sizing.
 */
function sellReservation(order: Order, symbol: string, quote?: Quote): number | undefined {
  if (!openOrder(order)) return 0;
  if (
    order.symbol !== "" &&
    order.symbol !== "未知标的" &&
    !order.symbol.split(" / ").includes(symbol)
  )
    return 0;
  const children = order.children;
  if (!children?.length) {
    // Child strategies or different asset units cannot be converted into a stock reservation.
    if (
      !(
        order.isSingleLeg &&
        isStockHolding(
          { symbol: order.symbol, assetType: order.assetType ?? "UNKNOWN" },
          quote,
        )
      ) &&
      !order.isSimpleEquity
    )
      return undefined;
    if (order.side === "BUY") return 0;
    if (
      order.side !== "SELL" ||
      order.remainingQuantity === undefined ||
      !Number.isFinite(order.remainingQuantity) ||
      order.remainingQuantity < 0
    )
      return undefined;
    return order.remainingQuantity;
  }
  if (order.strategy === "OCO") {
    let largest = 0;
    for (const leg of children) {
      const amount = sellReservation(leg, symbol, quote);
      if (amount === undefined) return undefined;
      largest = Math.max(largest, amount);
    }
    return largest;
  }
  if (order.strategy !== "TRIGGER") return undefined;
  if (!FINAL_STATUSES.has(order.status)) {
    // Only single-stock buy-entry brackets are understood; their exits await the entry fill.
    if (order.side !== "BUY" || (order.filledQuantity ?? 0) > 0) return undefined;
    return validSymbol(order.symbol) &&
      isStockHolding({ symbol: order.symbol, assetType: order.assetType ?? "UNKNOWN" }, quote)
      ? 0
      : undefined;
  }
  if (order.status !== "FILLED")
    // A cancelled or rejected entry must not leave live exits behind.
    return children.some(openOrder) ? undefined : 0;
  let total = 0;
  for (const child of children) {
    const amount = sellReservation(child, symbol, quote);
    if (amount === undefined) return undefined;
    total += amount;
  }
  return total;
}

export function maximumSell(
  account: Account | undefined,
  symbol: string,
  orders: Order[],
  ordersLoaded = true,
  excludingOrderID?: string,
  quote?: Quote,
): number | undefined {
  if (!account || !ordersLoaded) return undefined;
  const held: number[] = [];
  for (const position of account.positions.filter((p) => p.symbol === symbol)) {
    // Never silently discard a matched holding just because its type is unsupported.
    if (!isStockHolding(position, quote)) return undefined;
    if (!Number.isFinite(position.quantity) || position.quantity < 0)
      return undefined;
    held.push(position.quantity);
  }
  const reserved: number[] = [];
  for (const order of orders) {
    if (order.id === excludingOrderID) continue;
    const amount = sellReservation(order, symbol, quote);
    if (amount === undefined) return undefined;
    reserved.push(amount);
  }
  const amounts = [...held, ...reserved].map((value) => decimal(value));
  if (amounts.some((value) => !value)) return undefined;
  const scale = amounts.reduce(
    (maximum, value) => Math.max(maximum, value!.scale),
    0,
  );
  const available = amounts.reduce((total, value, index) => {
    const units = value!.units * 10n ** BigInt(scale - value!.scale);
    return total + (index < held.length ? units : -units);
  }, 0n);
  const wholeShares = (available > 0n ? available : 0n) / 10n ** BigInt(scale);
  return wholeShares <= MAX_INTEGER ? Number(wholeShares) : undefined;
}

const PERCENT = /^(?:[0-9]{1,2})(?:\.[0-9]{1,2})?$/;
/** Validates the broker-held exit legs; prices are compared in exact 1/10000 units. */
function validateExit(draft: Draft): void {
  const exit = draft.exit;
  if (exit === undefined) {
    if (draft.kind === "EXIT")
      throw new TradingError("exitMissing", "请设置止盈价或止损。");
    return;
  }
  if (!exit || typeof exit !== "object" || Array.isArray(exit))
    throw new TradingError("exit", "止盈止损参数无效。");
  if ((draft.session ?? "NORMAL") !== "NORMAL")
    throw new TradingError("exitSession", "止盈止损仅支持常规时段。");
  if (!["DAY", "GOOD_TILL_CANCEL"].includes(exit.duration))
    throw new TradingError("exitDuration", "止盈止损有效期暂不支持。");
  const take = exit.takeProfit;
  const stop = exit.stopLoss;
  if (take === undefined && stop === undefined)
    throw new TradingError("exitMissing", "请设置止盈价或止损。");
  const takeUnits = take === undefined ? undefined : priceUnits(take);
  if (take !== undefined && takeUnits === undefined)
    throw new TradingError("takeProfit", "止盈价必须大于 0，最多保留 4 位小数。");
  let stopUnits: bigint | undefined;
  if (stop !== undefined) {
    if (!stop || typeof stop !== "object" || typeof stop.value !== "string")
      throw new TradingError("stopLoss", "止损参数无效。");
    if (stop.mode === "PRICE" || stop.mode === "TRAIL_VALUE") {
      const units = priceUnits(stop.value);
      if (units === undefined)
        throw new TradingError("stopLoss", stop.mode === "PRICE"
          ? "止损价必须大于 0，最多保留 4 位小数。"
          : "移动止损价差必须大于 0，最多保留 4 位小数。");
      if (stop.mode === "PRICE") stopUnits = units;
    } else if (stop.mode === "TRAIL_PERCENT") {
      const percent = Number(stop.value);
      if (!PERCENT.test(stop.value.trim()) || !(percent > 0) || percent > 50)
        throw new TradingError("stopLoss", "移动止损比例须大于 0% 且不超过 50%，最多 2 位小数。");
    } else throw new TradingError("stopLoss", "止损方式暂不支持。");
  }
  if (takeUnits !== undefined && stopUnits !== undefined && takeUnits <= stopUnits)
    throw new TradingError("exitOrder", "止盈价必须高于止损价。");
  if (draft.kind === "EXIT") {
    if (draft.side !== "SELL")
      throw new TradingError("exitSide", "止盈止损单只能卖出已有持仓。");
    if (draft.duration !== exit.duration)
      throw new TradingError("exitDuration", "止盈止损有效期不一致，请重新设置。");
    return;
  }
  if (draft.side !== "BUY" || (draft.kind !== "LIMIT" && draft.kind !== "MARKET"))
    throw new TradingError("exitEntry", "仅限价或市价买入可以附带止盈止损。");
  const entry = draft.kind === "LIMIT" ? priceUnits(draft.limitPrice) : undefined;
  if (entry !== undefined && takeUnits !== undefined && takeUnits <= entry)
    throw new TradingError("takeProfit", "止盈价必须高于买入限价。");
  if (entry !== undefined && stopUnits !== undefined && stopUnits >= entry)
    throw new TradingError("stopLoss", "止损价必须低于买入限价。");
}

/** Rejects exits the current market would trigger immediately. */
export function validateExitAgainstQuote(draft: Draft, quote: Quote): void {
  const exit = draft.exit;
  if (exit === undefined || (draft.kind !== "EXIT" && draft.kind !== "MARKET")) return;
  const reference = draft.kind === "EXIT" ? quote.bidPrice : quote.askPrice;
  if (reference === undefined || !Number.isFinite(reference) || reference <= 0)
    throw new TradingError("exitQuote", "缺少可用的买卖报价，无法核对止盈止损价格。");
  const label = draft.kind === "EXIT" ? "当前买一价" : "当前卖一价";
  const take = exit.takeProfit === undefined ? undefined : parsePrice(exit.takeProfit);
  if (take !== undefined && take <= reference)
    throw new TradingError("takeProfit", `止盈价必须高于${label} ${reference}。`);
  const stop = exit.stopLoss?.mode === "PRICE" ? parsePrice(exit.stopLoss.value) : undefined;
  if (stop !== undefined && stop >= reference)
    throw new TradingError("stopLoss", `止损价必须低于${label} ${reference}，否则会立即触发。`);
}

export const stopModeLabels: Record<StopMode, string> = {
  PRICE: "止损价",
  TRAIL_VALUE: "移动止损 $",
  TRAIL_PERCENT: "移动止损 %",
};
export function describeStop(stop: { mode: StopMode; value: string }): string {
  return stop.mode === "PRICE"
    ? `$${stop.value}`
    : stop.mode === "TRAIL_VALUE"
      ? `回撤 $${stop.value} 触发`
      : `回撤 ${stop.value}% 触发`;
}

export function validateDraft(draft: Draft): void {
  const session = draft?.session === undefined ? "NORMAL" : draft.session;
  if (!Object.hasOwn(orderSessionLabels, session))
    throw new TradingError("orderSession", "此交易时段暂不支持。");
  if (session !== "NORMAL" && draft.kind !== "LIMIT")
    throw new TradingError("extendedOrderKind", "盘前盘后仅支持限价单。");
  if ((session === "AM" || session === "PM") && draft.duration !== "DAY")
    throw new TradingError("extendedDuration", "仅盘前或仅盘后订单须选择当日有效。");
  if (!validSymbol(draft?.symbol))
    throw new TradingError("symbol", "请输入有效的股票或 ETF 代码。");
  if (draft.side !== "BUY" && draft.side !== "SELL")
    throw new TradingError("side", "仅支持买入和卖出现有持仓。");
  if (!Number.isSafeInteger(draft.quantity) || draft.quantity <= 0)
    throw new TradingError("quantity", "股数必须是大于 0 的安全整数。");
  if (
    !(KINDS.includes(draft.kind as OrderKind) || draft.kind === "EXIT") ||
    !["DAY", "GOOD_TILL_CANCEL"].includes(draft.duration)
  ) {
    throw new TradingError("orderKind", "此订单类型或有效期暂不支持。");
  }
  const needsLimit = draft.kind === "LIMIT" || draft.kind === "STOP_LIMIT";
  const needsStop = draft.kind === "STOP" || draft.kind === "STOP_LIMIT";
  if (needsLimit && priceUnits(draft.limitPrice) === undefined)
    throw new TradingError("limitPrice", "限价必须大于 0，最多保留 4 位小数。");
  if (needsStop && priceUnits(draft.stopPrice) === undefined)
    throw new TradingError(
      "stopPrice",
      "触发价必须大于 0，最多保留 4 位小数。",
    );
  if (
    (!needsLimit && draft.limitPrice !== undefined) ||
    (!needsStop && draft.stopPrice !== undefined)
  ) {
    throw new TradingError("unexpectedPrice", "当前订单类型不需要这些价格。");
  }
  if (draft.kind === "MARKET" && draft.duration !== "DAY")
    throw new TradingError("marketDuration", "市价单仅支持当日有效。");
  validateExit(draft);
}

function exitLegs(draft: Draft): Record<string, unknown> {
  const exit = draft.exit!;
  const base = (orderType: string) => ({
    orderType,
    session: "NORMAL",
    duration: exit.duration,
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "SELL",
        quantity: draft.quantity,
        instrument: { symbol: draft.symbol, assetType: "EQUITY" },
      },
    ],
  });
  const legs: Record<string, unknown>[] = [];
  if (exit.takeProfit !== undefined)
    legs.push({ ...base("LIMIT"), price: canonicalPrice(exit.takeProfit) });
  const stop = exit.stopLoss;
  if (stop?.mode === "PRICE")
    legs.push({ ...base("STOP"), stopPrice: canonicalPrice(stop.value) });
  else if (stop)
    legs.push({
      ...base("TRAILING_STOP"),
      stopPriceLinkBasis: "BID",
      stopPriceLinkType: stop.mode === "TRAIL_VALUE" ? "VALUE" : "PERCENT",
      stopPriceOffset: Number(stop.mode === "TRAIL_VALUE" ? canonicalPrice(stop.value) : stop.value.trim()),
    });
  // Two legs share the same shares: Schwab cancels the other leg once one fills.
  return legs.length === 1 ? legs[0] : { orderStrategyType: "OCO", childOrderStrategies: legs };
}

/** Deep-frozen copy so a review cannot change after validation. */
export function freezeDraft(draft: Draft): Draft {
  const exit = draft.exit;
  return Object.freeze({
    symbol: draft.symbol,
    side: draft.side,
    kind: draft.kind,
    quantity: draft.quantity,
    limitPrice: draft.limitPrice,
    stopPrice: draft.stopPrice,
    duration: draft.duration,
    session: draft.session ?? "NORMAL",
    ...(exit
      ? {
          exit: Object.freeze({
            ...(exit.takeProfit !== undefined ? { takeProfit: exit.takeProfit } : {}),
            ...(exit.stopLoss
              ? { stopLoss: Object.freeze({ mode: exit.stopLoss.mode, value: exit.stopLoss.value }) }
              : {}),
            duration: exit.duration,
          }),
        }
      : {}),
  });
}

export function encodeDraft(draft: Draft): string {
  validateDraft(draft);
  if (draft.kind === "EXIT") return JSON.stringify(exitLegs(draft));
  return JSON.stringify({
    orderType: draft.kind,
    session: draft.session ?? "NORMAL",
    duration: draft.duration,
    orderStrategyType: draft.exit ? "TRIGGER" : "SINGLE",
    orderLegCollection: [
      {
        instruction: draft.side,
        quantity: draft.quantity,
        instrument: { symbol: draft.symbol, assetType: "EQUITY" },
      },
    ],
    ...(draft.limitPrice !== undefined
      ? { price: canonicalPrice(draft.limitPrice) }
      : {}),
    ...(draft.stopPrice !== undefined
      ? { stopPrice: canonicalPrice(draft.stopPrice) }
      : {}),
    // Schwab submits the exits only after this entry order fills.
    ...(draft.exit ? { childOrderStrategies: [exitLegs(draft)] } : {}),
  });
}

export function validateReplacement(order: Order, draft: Draft): void {
  if (draft.exit !== undefined || draft.kind === "EXIT")
    throw new TradingError("replacementExit", "改单不支持止盈止损，请撤单后重新下单。");
  if ((draft.session ?? "NORMAL") !== (order.session ?? "NORMAL"))
    throw new TradingError("replacementSession", "改单不能改变原订单的交易时段。");
  if (
    !order.editable ||
    !order.isSimpleEquity ||
    !OPEN_STATUSES.has(order.status) ||
    order.filledQuantity !== 0 ||
    order.symbol !== draft.symbol ||
    order.side !== draft.side
  ) {
    throw new TradingError(
      "replacementChanged",
      "订单已成交、状态已变化，或证券及方向不一致，请重新核对。",
    );
  }
}

export function referencePrice(draft: Draft, quote: Quote): number | undefined {
  if (draft.limitPrice !== undefined) return parsePrice(draft.limitPrice);
  if (draft.kind === "STOP" && draft.stopPrice !== undefined)
    return parsePrice(draft.stopPrice);
  const value =
    draft.side === "BUY"
      ? (quote.askPrice ?? quote.lastPrice)
      : (quote.bidPrice ?? quote.lastPrice);
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidResponse();
  return value as Json;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value;
}
function optionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw invalidResponse();
  return value;
}
function number(value: unknown, nonnegative = false): number | undefined {
  if (value == null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (nonnegative && value < 0)
  )
    throw invalidResponse();
  return value;
}
function requiredNumber(value: unknown, nonnegative = false): number {
  const result = number(value, nonnegative);
  if (result === undefined) throw invalidResponse();
  return result;
}
function accountID(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 64 ||
    /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw invalidResponse();
  return value;
}
function orderID(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    value = String(value);
  if (!validOrderID(value)) throw invalidResponse();
  return value;
}
function optionalDate(value: unknown): number | undefined {
  const raw = optionalString(value);
  if (raw === undefined) return undefined;
  // Broker order timestamps can use +0000; normalize before Date.parse for Hermes.
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      normalized,
    )
  )
    throw invalidResponse();
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp >= MAX_TIME)
    throw invalidResponse();
  return timestamp;
}

export function decodeAccounts(payload: unknown): Account[] {
  const seen = new Set<string>();
  return array(payload).map((entry) => {
    const a = object(object(entry).securitiesAccount),
      id = accountID(a.accountNumber);
    if (seen.has(id)) throw invalidResponse();
    seen.add(id);
    const balances = a.currentBalances == null ? {} : object(a.currentBalances);
    const positions = array(a.positions ?? []).map((value) => {
      const p = object(value),
        instrument = object(p.instrument);
      const symbol =
        optionalString(instrument.symbol) ?? optionalString(instrument.cusip);
      if (!symbol || (p.longQuantity == null && p.shortQuantity == null))
        throw invalidResponse();
      const quantity =
        (number(p.longQuantity, true) ?? 0) -
        (number(p.shortQuantity, true) ?? 0);
      return {
        symbol,
        description: optionalString(instrument.description),
        assetType: optionalString(instrument.assetType) ?? "UNKNOWN",
        quantity,
        averagePrice: number(p.averagePrice, true),
        marketValue: number(p.marketValue),
        dayProfitLoss: number(p.currentDayProfitLoss),
      };
    });
    return {
      id,
      displayNumber:
        id.length > 4 ? "•••• " + id.slice(-4) : "•".repeat(id.length),
      accountType: optionalString(a.type) ?? "UNKNOWN",
      liquidationValue: number(balances.liquidationValue),
      cashBalance: number(balances.cashBalance),
      buyingPower: number(balances.buyingPower),
      positions,
    };
  });
}

export function decodeAccountIdentifiers(
  payload: unknown,
): Map<string, string> {
  const result = new Map<string, string>(),
    hashes = new Set<string>();
  for (const raw of array(payload)) {
    const value = object(raw),
      id = accountID(value.accountNumber),
      hash = value.hashValue;
    if (!validAccountHash(hash) || result.has(id) || hashes.has(hash))
      throw invalidResponse();
    result.set(id, hash);
    hashes.add(hash);
  }
  return result;
}

/** Optional chart annotations must never make a valid order unreadable or uncancelable. */
function decodeExecutions(
  order: Json,
  id: string,
  legs: Json[],
): TradeExecution[] {
  if (!Array.isArray(order.orderActivityCollection)) return [];
  const identifier = (value: unknown): string | undefined => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      return String(value);
    if (typeof value === "string" && /^[0-9]{1,32}$/.test(value))
      return value.replace(/^0+(?=\d)/, "");
    return undefined;
  };
  const byLeg = new Map<string, Json | undefined>();
  for (const leg of legs) {
    const legID = identifier(leg.legId);
    if (legID !== undefined)
      byLeg.set(legID, byLeg.has(legID) ? undefined : leg);
  }
  const activities = new Map<string, TradeExecution[]>();
  const conflicts = new Set<string>();
  for (const raw of order.orderActivityCollection) {
    try {
      const activity = object(raw);
      if (
        activity.activityType !== "EXECUTION" ||
        activity.executionType !== "FILL"
      )
        continue;
      if (!Array.isArray(activity.executionLegs)) continue;
      const activityID = identifier(activity.activityId);
      const fills = new Map<string, TradeExecution>();
      for (const rawFill of activity.executionLegs) {
        try {
          const fill = object(rawFill),
            legID = identifier(fill.legId);
          const leg = legID === undefined ? undefined : byLeg.get(legID);
          if (!leg || (leg.instruction !== "BUY" && leg.instruction !== "SELL"))
            continue;
          const instrument = object(leg.instrument);
          if (
            !validSymbol(instrument.symbol) ||
            !(
              isStockAsset(instrument.assetType) ||
              instrument.assetType === "COLLECTIVE_INVESTMENT"
            )
          )
            continue;
          const time = optionalDate(fill.time);
          const price = requiredNumber(fill.price, true);
          const quantity = requiredNumber(fill.quantity, true);
          if (time === undefined || price <= 0 || quantity <= 0) continue;
          const key = `${legID}:${time}:${price}:${quantity}`;
          fills.set(key, {
            id: `${id}:${activityID ?? "fill"}:${key}`,
            symbol: instrument.symbol,
            side: leg.instruction,
            time,
            price,
            quantity,
          });
        } catch {
          /* Incomplete execution metadata does not invalidate other fills. */
        }
      }
      const values = [...fills.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      // Without a broker activity ID, repeated identical fill records are ambiguous;
      // keep one rather than presenting duplicate executions as extra trades.
      const key = activityID ?? JSON.stringify(values);
      if (conflicts.has(key)) continue;
      const previous = activities.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(values)) {
        activities.delete(key);
        conflicts.add(key);
      } else activities.set(key, values);
    } catch {
      /* Malformed optional activity. */
    }
  }
  const unique = new Map<string, TradeExecution>();
  for (const fill of [...activities.values()].flat()) unique.set(fill.id, fill);
  return [...unique.values()].sort(
    (a, b) => a.time - b.time || a.id.localeCompare(b.id),
  );
}

/** Linked OCO/TRIGGER legs may omit an ID; synthetic IDs are never valid for writes. */
export function decodeOrder(payload: unknown, fallbackID?: string): Order {
  const o = object(payload),
    id = o.orderId == null && fallbackID !== undefined ? fallbackID : orderID(o.orderId);
  const strategy =
    o.orderStrategyType === "SINGLE" || o.orderStrategyType === "OCO" || o.orderStrategyType === "TRIGGER"
      ? o.orderStrategyType
      : undefined;
  const rawChildren = array(o.childOrderStrategies ?? []);
  let children: Order[] | undefined;
  try {
    children = rawChildren.length
      ? rawChildren.map((child, index) => decodeOrder(child, id + "-" + (index + 1)))
      : undefined;
  } catch {
    // Unreadable legs keep the group visible but make its share reservation unknown.
    children = undefined;
  }
  const quantity = number(o.quantity, true),
    filledQuantity = number(o.filledQuantity, true);
  const remainingQuantity = number(o.remainingQuantity, true),
    limitPrice = number(o.price, true),
    stopPrice = number(o.stopPrice, true);
  if (
    quantity !== undefined &&
    ((filledQuantity ?? 0) > quantity || (remainingQuantity ?? 0) > quantity)
  )
    throw invalidResponse();
  const legs = array(o.orderLegCollection ?? []).map(object);
  const leg = legs.length === 1 ? legs[0] : undefined;
  const instrument =
    leg?.instrument == null ? undefined : object(leg.instrument);
  const side: Side | undefined =
    leg?.instruction === "BUY" || leg?.instruction === "SELL"
      ? leg.instruction
      : undefined;
  const kind = KINDS.includes(o.orderType as OrderKind)
    ? (o.orderType as OrderKind)
    : undefined;
  const duration =
    o.duration === "DAY" || o.duration === "GOOD_TILL_CANCEL"
      ? o.duration
      : undefined;
  const symbols = [
    ...new Set(
      legs.flatMap((l) => {
        const i = l.instrument == null ? undefined : object(l.instrument);
        return typeof i?.symbol === "string" && i.symbol ? [i.symbol] : [];
      }),
    ),
  ];
  // An OCO wrapper has no legs of its own; it acts on its children's instrument.
  const childSymbols = legs.length || !children ? [] : [
    ...new Set(children.flatMap((c) => c.symbol.split(" / ")).filter(validSymbol)),
  ];
  const symbol = symbols.join(" / ") || childSymbols.join(" / ") || "未知标的";
  const groupSide = !legs.length && children?.length && children.every((c) => c.side === children![0].side)
    ? children[0].side
    : undefined;
  const singleLeg =
    !!leg &&
    !!side &&
    validSymbol(symbol) &&
    o.orderStrategyType === "SINGLE" &&
    (o.complexOrderStrategyType == null ||
      o.complexOrderStrategyType === "NONE") &&
    array(o.childOrderStrategies ?? []).length === 0;
  const assetType = optionalString(instrument?.assetType);
  const session = optionalString(o.session);
  const simple =
    singleLeg &&
    isStockAsset(assetType) &&
    !!kind &&
    !!duration &&
    session === "NORMAL";
  const status = optionalString(o.status) ?? "UNKNOWN";
  const actionable =
    OPEN_STATUSES.has(status) &&
    !["PENDING_CANCEL", "PENDING_REPLACE", "AWAITING_REPLACEMENT"].includes(
      status,
    );
  const preservesInstructions =
    o.specialInstruction == null &&
    o.taxLotMethod == null &&
    o.cancelTime == null &&
    (o.requestedDestination == null || o.requestedDestination === "AUTO");
  const pricesFit = [limitPrice, stopPrice].every(
    (p) => p === undefined || priceUnits(String(p)) !== undefined,
  );
  let completeDraft = false;
  if (simple && side && kind && duration && quantity !== undefined) {
    try {
      validateDraft({
        symbol,
        side,
        kind,
        quantity,
        duration,
        limitPrice: limitPrice === undefined ? undefined : String(limitPrice),
        stopPrice: stopPrice === undefined ? undefined : String(stopPrice),
      });
      completeDraft =
        leg?.quantity == null ||
        (typeof leg.quantity === "number" && leg.quantity === quantity);
    } catch {
      /* The incomplete original cannot safely be replaced. */
    }
  }
  const editable =
    simple &&
    actionable &&
    o.editable === true &&
    filledQuantity === 0 &&
    quantity !== undefined &&
    Number.isSafeInteger(quantity) &&
    quantity > 0 &&
    preservesInstructions &&
    pricesFit &&
    completeDraft;
  const group = (strategy === "OCO" || strategy === "TRIGGER") && !!children?.length;
  // Cancellation uses a fresh broker flag and order ID, not a reconstructed draft.
  const cancelUnavailableReason = !validOrderID(id)
    ? "此联动子委托没有独立订单号，请撤销整组委托。"
    : group
    ? !children!.every(stockOnly)
      ? "组合中含非股票委托，请到 Schwab 撤销。"
      : !actionable
        ? "联动委托已结束或正在处理，请刷新查看状态。"
        : o.cancelable !== true
          ? "Schwab 当前未将这组联动委托标记为可撤，请撤销其中的单笔委托或到券商查看。"
          : undefined
    : !singleLeg
    ? "组合或联动委托暂需到 Schwab 撤销。"
    : !(isStockAsset(assetType) || assetType === "COLLECTIVE_INVESTMENT")
      ? "此类委托暂不支持在此撤销。"
      : !actionable
        ? "订单已结束或正在处理撤销／修改，请刷新查看状态。"
        : o.cancelable !== true
          ? "Schwab 当前未将此订单标记为可撤，请刷新或到券商查看。"
          : undefined;
  const trailing =
    o.orderType === "TRAILING_STOP" &&
    (o.stopPriceLinkType === "VALUE" || o.stopPriceLinkType === "PERCENT") &&
    typeof o.stopPriceOffset === "number" && Number.isFinite(o.stopPriceOffset) && o.stopPriceOffset > 0
      ? { type: o.stopPriceLinkType as "VALUE" | "PERCENT", offset: o.stopPriceOffset }
      : undefined;
  const ownExecutions = decodeExecutions(o, id, legs);
  const executions = children
    ? [...new Map([...ownExecutions, ...children.flatMap((c) => c.executions ?? [])].map((e) => [e.id, e])).values()]
        .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    : ownExecutions;
  return {
    id,
    status,
    symbol,
    side: side ?? groupSide,
    kind,
    quantity,
    filledQuantity,
    remainingQuantity,
    limitPrice,
    stopPrice,
    duration,
    enteredAt: optionalDate(o.enteredTime),
    executions,
    cancelable: cancelUnavailableReason === undefined,
    cancelUnavailableReason,
    isSingleLeg: singleLeg,
    assetType,
    session,
    editable,
    isSimpleEquity: simple,
    strategy,
    ...(children ? { children } : {}),
    ...(trailing ? { trailing } : {}),
  };
}

function stockOnly(order: Order): boolean {
  return order.children?.length
    ? order.children.every(stockOnly)
    : order.isSingleLeg === true &&
        (isStockAsset(order.assetType) || order.assetType === "COLLECTIVE_INVESTMENT");
}
function descendantIDs(order: Order): string[] {
  return (order.children ?? []).flatMap((child) => [child.id, ...descendantIDs(child)]);
}

export function decodeOrders(payload: unknown): Order[] {
  const decoded = array(payload).map((entry) => decodeOrder(entry));
  // A linked leg listed again at top level is already represented inside its group.
  const nested = new Set(decoded.flatMap(descendantIDs));
  const orders = decoded.filter((o) => !nested.has(o.id));
  if (new Set(orders.map((o) => o.id)).size !== orders.length)
    throw invalidResponse();
  return orders.sort((a, b) => (b.enteredAt ?? 0) - (a.enteredAt ?? 0));
}

export function decodeQuotes(payload: unknown, symbols: string[]): Quote[] {
  const rows = object(payload);
  const result: Quote[] = [];
  for (const symbol of symbols) {
    try {
      const row = object(rows[symbol]);
      if (row.symbol != null && row.symbol !== symbol) continue;
      const q = object(row.quote),
        ref = row.reference == null ? {} : object(row.reference);
      const quote: Quote = {
        symbol,
        description: optionalString(ref.description),
        assetMainType: optionalString(row.assetMainType),
        assetSubType:
          typeof row.assetSubType === "string" ? row.assetSubType : undefined,
        isRealtime:
          typeof row.realtime === "boolean" ? row.realtime : undefined,
        lastPrice: number(q.lastPrice, true),
        bidPrice: number(q.bidPrice, true),
        askPrice: number(q.askPrice, true),
        netChange: number(q.netChange),
        netPercentChange: number(q.netPercentChange),
        quoteTime: number(q.quoteTime, true),
        openPrice: number(q.openPrice, true),
        highPrice: number(q.highPrice, true),
        lowPrice: number(q.lowPrice, true),
        closePrice: number(q.closePrice, true),
        totalVolume: number(q.totalVolume, true),
        high52Week: number(q["52WeekHigh"], true),
        low52Week: number(q["52WeekLow"], true),
      };
      if (
        quote.quoteTime !== undefined &&
        (quote.quoteTime <= 0 || quote.quoteTime >= MAX_TIME)
      )
        quote.quoteTime = undefined;
      // Fundamental metadata is optional; its absence must not erase an executable quote.
      try {
        quote.peRatio = number(object(row.fundamental).peRatio);
      } catch {
        /* absent or malformed metadata */
      }
      result.push(quote);
    } catch {
      /* A bad symbol must not erase other requested quotes. */
    }
  }
  if (!result.length) throw invalidResponse();
  return result;
}

export function decodeFundamentals(
  payload: unknown,
  symbol: string,
): Pick<Quote, "marketCap" | "sharesOutstanding"> {
  const rows = array(object(payload).instruments);
  if (rows.length !== 1) throw invalidResponse();
  const row = object(rows[0]);
  if (row.symbol !== symbol || row.assetType !== "EQUITY")
    throw invalidResponse();
  if (row.fundamental == null) return {};
  const f = object(row.fundamental);
  if (f.symbol != null && f.symbol !== symbol) throw invalidResponse();
  const result: Pick<Quote, "marketCap" | "sharesOutstanding"> = {};
  try {
    result.marketCap = number(f.marketCap, true);
  } catch {
    /* optional */
  }
  try {
    const shares = number(f.sharesOutstanding, true);
    if (shares && shares > 0) result.sharesOutstanding = shares;
  } catch {
    /* optional */
  }
  return result;
}

export function decodeHistory(payload: unknown, symbol: string, capture?: { receivedAt: number; range: HistoryRange }): History {
  const row = object(payload),
    source = array(row.candles);
  if (row.symbol !== symbol || (row.empty === true && source.length !== 0))
    throw invalidResponse();
  const previousClose = number(row.previousClose, true),
    byTime = new Map<number, Candle>();
  for (const item of source) {
    const c = object(item),
      time = requiredNumber(c.datetime, true);
    const open = requiredNumber(c.open, true),
      high = requiredNumber(c.high, true);
    const low = requiredNumber(c.low, true),
      close = requiredNumber(c.close, true);
    if (
      time >= MAX_TIME ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      low > high
    )
      throw invalidResponse();
    byTime.set(time, {
      time,
      open,
      high,
      low,
      close,
      volume: number(c.volume, true),
    });
  }
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return {
    symbol,
    previousClose,
    candles,
    ...(capture ? { sourceCoverage: { ...capture, rawBars: source.length,
      decoded: historyCoverage(candles, !["daily", "weekly", "monthly"].includes(capture.range)) } } : {}),
  };
}
