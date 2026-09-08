import type {
  Account,
  Candle,
  Draft,
  History,
  Order,
  OrderKind,
  OrderSession,
  Position,
  Quote,
  Side,
  TradeExecution,
} from "./types.ts";

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
    if (order.id === excludingOrderID || FINAL_STATUSES.has(order.status))
      continue;
    if (
      order.symbol !== "" &&
      order.symbol !== "未知标的" &&
      !order.symbol.split(" / ").includes(symbol)
    )
      continue;
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
    if (order.side === "BUY") continue;
    if (
      order.side !== "SELL" ||
      order.remainingQuantity === undefined ||
      !Number.isFinite(order.remainingQuantity) ||
      order.remainingQuantity < 0
    )
      return undefined;
    reserved.push(order.remainingQuantity);
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
    !KINDS.includes(draft.kind) ||
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
}

export function encodeDraft(draft: Draft): string {
  validateDraft(draft);
  return JSON.stringify({
    orderType: draft.kind,
    session: draft.session ?? "NORMAL",
    duration: draft.duration,
    orderStrategyType: "SINGLE",
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
  });
}

export function validateReplacement(order: Order, draft: Draft): void {
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

export function decodeOrder(payload: unknown): Order {
  const o = object(payload),
    id = orderID(o.orderId);
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
  const symbol = symbols.join(" / ") || "未知标的";
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
  // Cancellation uses a fresh broker flag and order ID, not a reconstructed draft.
  const cancelUnavailableReason = !singleLeg
    ? "组合或联动委托暂需到 Schwab 撤销。"
    : !(isStockAsset(assetType) || assetType === "COLLECTIVE_INVESTMENT")
      ? "此类委托暂不支持在此撤销。"
      : !actionable
        ? "订单已结束或正在处理撤销／修改，请刷新查看状态。"
        : o.cancelable !== true
          ? "Schwab 当前未将此订单标记为可撤，请刷新或到券商查看。"
          : undefined;
  return {
    id,
    status,
    symbol,
    side,
    kind,
    quantity,
    filledQuantity,
    remainingQuantity,
    limitPrice,
    stopPrice,
    duration,
    enteredAt: optionalDate(o.enteredTime),
    executions: decodeExecutions(o, id, legs),
    cancelable: cancelUnavailableReason === undefined,
    cancelUnavailableReason,
    isSingleLeg: singleLeg,
    assetType,
    session,
    editable,
    isSimpleEquity: simple,
  };
}

export function decodeOrders(payload: unknown): Order[] {
  const orders = array(payload).map(decodeOrder);
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

export function decodeHistory(payload: unknown, symbol: string): History {
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
  return {
    symbol,
    previousClose,
    candles: [...byTime.values()].sort((a, b) => a.time - b.time),
  };
}
