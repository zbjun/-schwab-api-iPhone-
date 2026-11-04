import { MEXC_MESSAGES, MEXC_REVIEW_TTL, isBuying, isOpening, mexcClosable, plainNumber, validMexcSymbol, validateMexcDraft } from "../mexcRules.ts";
import type { ChartPriceLine } from "../chartLines.ts";
import type { Candle, History, TradeExecution } from "../types.ts";
import type { MexcAction, MexcContract, MexcDraft, MexcKind, MexcLimits, MexcOrder, MexcPosition, MexcStopDraft, MexcStopOrder, MexcTicker } from "../mexcRules.ts";

/** Pure display helpers for the MEXC screens. Nothing here decides whether an order may be sent. */

export type Venue = "schwab" | "mexc";
export const VENUE_KEY = "ths.expo.venue.v1";
/** Anything unreadable falls back to Schwab, the original app. */
export const parseVenue = (raw: string | null | undefined): Venue => (raw === "mexc" ? "mexc" : "schwab");

export const isStockContract = (contract: Pick<MexcContract, "symbol">) => contract.symbol.includes("STOCK");

export const PIP_KEY = "ths.expo.mexc.pip.v1";
/** The floating chart only shows the last stretch, and a chart with bad numbers must not reach native drawing. */
export function pipCandles(candles: readonly Candle[], limit = 120) {
  return candles
    .filter(c => [c.time, c.open, c.high, c.low, c.close].every(value => Number.isFinite(value) && value > 0))
    .slice(-limit)
    .map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
}
export const FAVORITES_KEY = "ths.expo.mexc.favorites.v1";
export const MAX_FAVORITES = 50;
/** Anything unreadable counts as no favourites; only well-formed symbols survive, once each. */
export function parseFavorites(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? [...new Set(list.filter(validMexcSymbol))].slice(0, MAX_FAVORITES) : [];
  } catch { return []; }
}
/** Newest first. Adding past the limit changes nothing, so the caller can say why. */
export function toggleFavorite(favorites: readonly string[], symbol: string): string[] {
  if (favorites.includes(symbol)) return favorites.filter(value => value !== symbol);
  return favorites.length >= MAX_FAVORITES ? [...favorites] : [symbol, ...favorites];
}
/** In saved order, leaving out anything no longer listed. */
export function favoriteContracts(favorites: readonly string[], contracts: readonly MexcContract[]): MexcContract[] {
  const bySymbol = new Map(contracts.map(contract => [contract.symbol, contract]));
  return favorites.flatMap(symbol => bySymbol.get(symbol) ?? []);
}

/** US-stock style contracts first, then a query-prefix match, then by code. */
export function sortContracts(list: readonly MexcContract[], query = ""): MexcContract[] {
  const q = query.trim().toUpperCase();
  const matches = q
    ? list.filter(c => c.symbol.includes(q) || c.displayName.toUpperCase().includes(q) || c.baseCoin.toUpperCase().includes(q))
    : [...list];
  const rank = (c: MexcContract) => (isStockContract(c) ? 0 : 2) + (q && c.symbol.startsWith(q) ? 0 : 1);
  return matches.sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
}

export const directionOf = (action: MexcAction): "LONG" | "SHORT" =>
  action === "OPEN_LONG" || action === "CLOSE_LONG" ? "LONG" : "SHORT";
export const closeActionFor = (position: Pick<MexcPosition, "direction">): MexcAction =>
  position.direction === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT";
export const findPosition = (positions: readonly MexcPosition[], symbol: string, action: MexcAction) =>
  positions.find(p => p.symbol === symbol && p.direction === directionOf(action) && p.holdVol > 0);
/** Contracts that a close order can still use: held minus what open close orders already reserve. */
export function closableOf(position: Pick<MexcPosition, "holdVol" | "frozenVol">): string {
  try { return mexcClosable(position.holdVol, position.frozenVol); } catch { return "0"; }
}
export const hasClosable = (closable: string) => Number(closable) > 0;

export interface LeverageChoice { min: number; max: number; fixed?: number }
/** Cap is the smaller of the server limit and the contract's own; an existing same-side position pins it. */
export function leverageChoice(
  contract: Pick<MexcContract, "minLeverage" | "maxLeverage" | "symbol">,
  limits: Pick<MexcLimits, "maxLeverage">,
  positions: readonly MexcPosition[],
  action: MexcAction,
): LeverageChoice {
  const max = Math.max(1, Math.floor(Math.min(limits.maxLeverage, contract.maxLeverage)));
  const min = Math.min(max, Math.max(1, Math.ceil(contract.minLeverage)));
  const held = findPosition(positions, contract.symbol, action);
  return { min, max, fixed: held ? held.leverage : undefined };
}
export const clampLeverage = (value: number, choice: LeverageChoice) =>
  choice.fixed ?? Math.min(choice.max, Math.max(choice.min, Math.round(Number.isFinite(value) ? value : choice.min)));

/** Value in USDT = contracts x contractSize x price. Undefined while an input is not a number. */
export function notionalOf(vol: string, contractSize: number, price: string | number | undefined): number | undefined {
  if (price === undefined || vol.trim() === "" || String(price).trim() === "") return undefined;
  const value = Number(vol) * contractSize * Number(price);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
export const marginOf = (notional: number | undefined, leverage: number) =>
  notional === undefined || leverage < 1 ? undefined : notional / leverage;
/** What is wrong with the form as filled in. Empty when it can go to review. */
export function draftIssueOf(draft: MexcDraft, closable: string): string {
  try { validateMexcDraft(draft); } catch (error) { return error instanceof Error ? error.message : "委托参数无效。"; }
  return !isOpening(draft.action) && !hasClosable(closable) ? "该方向没有可平的持仓。" : "";
}
export interface TicketGates {
  locked: boolean; entryBlocked: boolean; draftIssue: string; reviewing: boolean; hasContract: boolean;
  limitsMissing: boolean; leverageEmpty: boolean; sending: boolean;
}
/** Whether the form's review button is off. Any one of these is enough, and the server still decides afterwards. */
export const ticketBlocked = (gates: TicketGates) =>
  gates.locked || gates.entryBlocked || !!gates.draftIssue || gates.reviewing || !gates.hasContract ||
  gates.limitsMissing || gates.leverageEmpty || gates.sending;

const bestQuote = (buying: boolean, ticker: MexcTicker | undefined): number | undefined => {
  const best = buying ? ticker?.ask1 : ticker?.bid1;
  const reference = best !== undefined && best > 0 ? best : ticker?.lastPrice;
  return reference !== undefined && Number.isFinite(reference) && reference > 0 ? reference : undefined;
};
/**
 * The price the server values this order at (planMexcOrder): a limit order at the larger of its price and
 * the best quote, a market buy at its protection price, a market sell at the best quote.
 */
export function valuationPrice(kind: MexcKind, buying: boolean, limitPrice: string, ticker: MexcTicker | undefined, marketProtection: number): number | undefined {
  const quoted = bestQuote(buying, ticker);
  if (kind === "LIMIT") {
    const price = limitPrice.trim() === "" ? NaN : Number(limitPrice);
    if (!Number.isFinite(price) || price <= 0) return undefined;
    return quoted === undefined ? price : Math.max(price, quoted);
  }
  if (quoted === undefined || !Number.isFinite(marketProtection)) return undefined;
  return buying ? quoted * (1 + marketProtection) : quoted;
}
/** Estimated profit or loss of the whole position at a price, from the average entry and before fees. */
export function stopEstimate(position: Pick<MexcPosition, "direction" | "averagePrice" | "holdVol">, contractSize: number, price: string): number | undefined {
  const value = price.trim() === "" ? NaN : Number(price);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return (value - position.averagePrice) * position.holdVol * contractSize * (position.direction === "LONG" ? 1 : -1);
}
/**
 * How far a candle under the crosshair moved: on K-lines from the bar before it, or its own open for the first;
 * on a line chart from where the line starts, which is how a line reads.
 */
export function candleMove(candles: readonly Candle[], selected: Candle, line: boolean): { reference?: number; rate?: number } {
  const earlier = candles.filter(candle => candle.time < selected.time);
  const reference = line ? (earlier[0] ?? selected).open : earlier.reduce<Candle | undefined>((best, candle) => (!best || candle.time > best.time ? candle : best), undefined)?.close ?? selected.open;
  if (!Number.isFinite(reference) || reference <= 0 || !Number.isFinite(selected.close)) return {};
  return { reference, rate: selected.close / reference - 1 };
}
/** The same estimate for any size: part of a position, or an order that has not opened one yet. */
export function closeEstimate(position: Pick<MexcPosition, "direction" | "averagePrice">, contractSize: number, vol: string, price: string | number | undefined): number | undefined {
  const size = vol.trim() === "" ? NaN : Number(vol);
  if (price === undefined || !Number.isFinite(size) || size <= 0) return undefined;
  return stopEstimate({ ...position, holdVol: size }, contractSize, String(price));
}
/**
 * Where an order should fill, for estimating what it makes: the limit, or for a market order the best quote on its side.
 * The protection price is only the worst it may reach, and would understate every market close.
 */
export function expectedFill(kind: MexcKind, buying: boolean, limitPrice: string, ticker: MexcTicker | undefined): number | undefined {
  if (kind !== "LIMIT") return bestQuote(buying, ticker);
  const price = limitPrice.trim() === "" ? NaN : Number(limitPrice);
  return Number.isFinite(price) && price > 0 ? price : undefined;
}
/** The margin behind part of a position, so what it makes can be shown as a return. */
export function marginFor(position: Pick<MexcPosition, "margin" | "holdVol">, vol: number): number | undefined {
  if (position.margin === undefined || !(position.margin > 0) || !(position.holdVol > 0) || !Number.isFinite(vol) || vol <= 0) return undefined;
  return (position.margin * Math.min(vol, position.holdVol)) / position.holdVol;
}
/** The side check the server makes, so a price on the wrong side shows before a review is asked for. */
export function stopSideIssue(direction: "LONG" | "SHORT", takeProfit: string, stopLoss: string, references: { takeProfit?: number; stopLoss?: number }): boolean {
  const sign = direction === "LONG" ? 1 : -1;
  const wrong = (price: string, reference: number | undefined, side: 1 | -1) =>
    reference !== undefined && Number.isFinite(reference) && price.trim() !== "" && Number.isFinite(Number(price)) && (Number(price) - reference) * sign * side <= 0;
  return wrong(takeProfit, references.takeProfit, 1) || wrong(stopLoss, references.stopLoss, -1);
}
/**
 * Prices were typed for an order that can no longer carry them, because a position in that direction has
 * appeared since. They cannot simply be dropped: the person would believe the order was protected.
 */
export const stopsDropped = (opening: boolean, stopsOn: boolean, held: boolean, takeProfit: string, stopLoss: string) =>
  opening && stopsOn && held && (takeProfit.trim() !== "" || stopLoss.trim() !== "");
/** Same text whichever way a price is written or its fields are ordered, so a review can be matched to the form. */
export function stopDraftKey(draft: MexcStopDraft): string {
  const price = (value: string | undefined) => (value === undefined || !Number.isFinite(Number(value)) ? value ?? "" : String(Number(value)));
  return [draft.kind, draft.symbol, draft.positionId, draft.stopOrderId ?? "", price(draft.takeProfitPrice), price(draft.stopLossPrice)].join("|");
}
/** Slightly under the real limits, so the quote can move a little before the review at full size. */
const CAPACITY_ROOM = 0.995;
/**
 * The most contracts the position slider offers when opening, on the contract's step. Holds back the
 * taker fee both ways, and stays within the server's value cap and the contract's maximum. The server still decides.
 */
export function openCapacity(
  available: number | undefined,
  leverage: number,
  unitPrice: number | undefined,
  contract: Pick<MexcContract, "contractSize" | "volUnit" | "maxVol" | "takerFeeRate">,
  limits: Pick<MexcLimits, "maxOrderNotional">,
): number | undefined {
  if (available === undefined || unitPrice === undefined || ![available, leverage, unitPrice, limits.maxOrderNotional].every(Number.isFinite)) return undefined;
  const value = contract.contractSize * unitPrice;
  if (available < 0 || leverage < 1 || !(value > 0) || limits.maxOrderNotional <= 0) return undefined;
  const byMargin = available / (value * (1 / leverage + 2 * Math.max(0, contract.takerFeeRate)));
  const room = CAPACITY_ROOM * Math.min(byMargin, limits.maxOrderNotional / value);
  const steps = Math.floor(Math.min(room, contract.maxVol) / contract.volUnit);
  return Number((steps * contract.volUnit).toFixed(decimalPlaces(contract.volUnit)));
}
/**
 * Contracts for a slider position: rounded down to the step, never below the minimum, and empty at zero or when
 * not even the minimum fits. `exactFull` is the closable amount, which a full close must send to the last digit.
 */
export function volForFraction(
  fraction: number,
  capacity: number | undefined,
  contract: Pick<MexcContract, "volUnit" | "minVol">,
  exactFull?: string,
): string {
  if (!(fraction > 0) || capacity === undefined || !(capacity >= contract.minVol)) return "";
  if (fraction >= 1 && exactFull !== undefined) return exactFull;
  // Capacity is already on the step, so the small nudge only undoes binary rounding such as 0.3 / 0.1.
  const steps = Math.floor((Math.min(fraction, 1) * capacity) / contract.volUnit + 1e-9);
  return Math.max(contract.minVol, steps * contract.volUnit).toFixed(decimalPlaces(contract.volUnit));
}
/** Where the slider sits for a chosen or typed size, from 0 to 1 whatever was typed. */
export function fractionOfCapacity(vol: string, capacity: number | undefined): number {
  const value = vol.trim() === "" ? NaN : Number(vol);
  if (capacity === undefined || !(capacity > 0) || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value / capacity);
}

export const priceDecimals = (unit: number) => decimalPlaces(unit);
const decimalPlaces = (unit: number) => (plainNumber(unit).split(".")[1] ?? "").length;
/** Moves a typed number one tick up or down, snapping to the grid first. */
export function stepDecimal(value: string, unit: number, direction: 1 | -1, min = unit): string {
  const base = Number(value);
  const ratio = (Number.isFinite(base) ? base : 0) / unit;
  const steps = direction > 0 ? Math.floor(ratio + 1e-9) + 1 : Math.ceil(ratio - 1e-9) - 1;
  return Math.max(min, steps * unit).toFixed(decimalPlaces(unit));
}
/** Nearest tick, for prefilling a limit price from a quote. */
export function snapToTick(value: number, unit: number): string {
  return (Math.max(1, Math.round(value / unit)) * unit).toFixed(decimalPlaces(unit));
}

/** Whole seconds left on a review, never above the full window even if the clock moves back. */
export const reviewRemainingSeconds = (preparedAt: number, now: number) =>
  Math.min(MEXC_REVIEW_TTL / 1000, Math.max(0, Math.ceil((preparedAt + MEXC_REVIEW_TTL - now) / 1000)));
export const reviewExpired = (preparedAt: number, now: number) => reviewRemainingSeconds(preparedAt, now) === 0;
export const CONFIRM_ARM_DELAY = 800;
/**
 * The review appears exactly where the form's button was, so a second press meant for that button must not
 * land on "confirm". If the clock moved back it stays off, and going back and reviewing again starts over.
 */
export const confirmArmed = (shownAt: number, now: number) => now >= shownAt + CONFIRM_ARM_DELAY;

/** Trading is locked by an unconfirmed order the server knows about, or one this session just saw. */
export const tradingLocked = (status: { unresolvedOperation?: boolean; writeInProgress?: boolean } | undefined, sawUnknown: boolean) =>
  sawUnknown || status?.unresolvedOperation === true || status?.writeInProgress === true;
/** The server is handling a write right now: unresolvedOperation is also true, but nothing has gone wrong yet. */
export const writeInProgress = (status: { writeInProgress?: boolean } | undefined) => status?.writeInProgress === true;
/** Show the "unconfirmed" banner: a lock exists and it is not just a write in flight on this or the server side. */
export const lockUnconfirmed = (status: { unresolvedOperation?: boolean; writeInProgress?: boolean } | undefined, sawUnknown: boolean, sending: boolean) =>
  tradingLocked(status, sawUnknown) && !writeInProgress(status) && !sending;
/** Only a failed key check lets a closing order through; any other closure stops every new order. */
export const orderEntryBlocked = (code: string | undefined, action: MexcAction): boolean =>
  !code ? false : !(code === "keyCheckFailed" && !isOpening(action));
export function blockMessage(blocked: string | undefined): string | undefined {
  if (!blocked) return undefined;
  return MEXC_MESSAGES[blocked] ?? "交易已被服务器关闭。";
}

export const LOCK_BANNER = "有一笔操作结果未确认，交易已锁定，请先在 MEXC 核实";
export const STOCK_NOTE = "美股类合约为永续合约，不是股票本身。";

export function percent(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}
export function signedPercent(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}
/** Prices keep the contract's own precision, so a 0.0001 tick is not rounded to cents. */
export function priceText(value: number | undefined, unit?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const places = unit ? decimalPlaces(unit) : 2;
  return value.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
}

export const ORDER_STATE_LABELS: Record<number, string> = { 1: "待处理", 2: "未成交", 3: "已成交", 4: "已撤销", 5: "无效" };
export const orderStateLabel = (order: Pick<MexcOrder, "state"> & { dealVol?: number }) =>
  order.state === 2 && (order.dealVol ?? 0) > 0 ? "部分成交" : ORDER_STATE_LABELS[order.state] ?? "未知";

/**
 * What orders have filled, as the chart's markers expect. MEXC reports these per order, so the time is when the order
 * last changed: a fill's own moment only for an order that filled all at once, and one marker for a partly filled order.
 */
export function mexcExecutions(orders: readonly MexcOrder[]): TradeExecution[] {
  return orders.flatMap(order => {
    const time = order.updatedAt ?? order.createdAt;
    return order.dealVol > 0 && time !== undefined
      ? [{ id: order.id, symbol: order.symbol, side: isBuying(order.action) ? "BUY" as const : "SELL" as const, time, price: order.dealAvgPrice ?? order.price, quantity: order.dealVol }]
      : [];
  });
}
/** Each position's cost and whatever is waiting on it. Hedge mode can hold both directions, and then each line says whose it is. */
export function positionPriceLines(
  positions: readonly MexcPosition[],
  stops: readonly MexcStopOrder[],
  colors: { cost: string; takeProfit: string; stopLoss: string },
  contractSize?: number,
): ChartPriceLine[] {
  return positions.flatMap(position => {
    const side = positions.length > 1 ? (position.direction === "LONG" ? "多" : "空") : "";
    const lines: ChartPriceLine[] = [{ id: `${position.id}:cost`, price: position.averagePrice, label: `${side}成本`, color: colors.cost }];
    for (const stop of stops.filter(row => row.positionId === position.id)) {
      const profit = (price: number) => (contractSize === undefined ? {} : { profit: stopEstimate({ ...position, holdVol: stop.vol }, contractSize, String(price)) });
      if (stop.takeProfitPrice !== undefined) lines.push({ id: `${stop.id}:tp`, price: stop.takeProfitPrice, label: `${side}止盈`, color: colors.takeProfit, ...profit(stop.takeProfitPrice) });
      if (stop.stopLossPrice !== undefined) lines.push({ id: `${stop.id}:sl`, price: stop.stopLossPrice, label: `${side}止损`, color: colors.stopLoss, ...profit(stop.stopLossPrice) });
    }
    return lines;
  });
}
/** MEXC allows 90 days in one query, and bars older than that are too long for a marker to say much anyway. */
export const chartFillWindow = (now: number) => ({ from: now - 90 * 86_400_000, to: now });
export const CLOSED_ORDER_DAYS = 7;
export const closedOrderWindow = (now: number) => ({ from: now - CLOSED_ORDER_DAYS * 86_400_000, to: now });
/** The tickers endpoint takes at most 100 symbols per call. */
export const TICKER_BATCH = 100;
export function batches<T>(list: readonly T[], size = TICKER_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
export const openTypeLabel = (openType: number | undefined) => (openType === 2 ? "全仓" : openType === 1 ? "逐仓" : "—");

/**
 * Lays the latest candles over a loaded chart: same time replaces, newer appends, older is ignored.
 * Only the very last candle is marked as still forming, which is what the chart animates.
 */
export function mergeLiveCandles(history: History, live: readonly Candle[]): History {
  // Nothing new keeps the same object, so the chart does not redraw and a closed bar is not marked as forming.
  if (!live.length) return history;
  const unchanged = history.candles.at(-1)?.provisional === true && live.every(candle => {
    let shown: Candle | undefined;
    for (let index = history.candles.length - 1; index >= 0 && !shown && history.candles[index].time >= candle.time; index--)
      if (history.candles[index].time === candle.time) shown = history.candles[index];
    return shown !== undefined && shown.open === candle.open && shown.high === candle.high && shown.low === candle.low &&
      shown.close === candle.close && shown.volume === candle.volume;
  });
  if (unchanged) return history;
  const candles = history.candles.map(candle => (candle.provisional ? { ...candle, provisional: false } : candle));
  for (const candle of [...live].sort((a, b) => a.time - b.time)) {
    if (![candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    const last = candles.at(-1);
    if (!last || candle.time > last.time) candles.push({ ...candle });
    else {
      for (let index = candles.length - 1; index >= 0 && candles[index].time >= candle.time; index--)
        if (candles[index].time === candle.time) candles[index] = { ...candle };
    }
  }
  if (candles.length) candles[candles.length - 1] = { ...candles[candles.length - 1], provisional: true };
  return { ...history, candles };
}
