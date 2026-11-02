import { MEXC_MESSAGES, MEXC_REVIEW_TTL, isOpening, mexcClosable, plainNumber } from "../mexcRules.ts";
import type { MexcAction, MexcContract, MexcKind, MexcLimits, MexcOrder, MexcPosition, MexcTicker } from "../mexcRules.ts";

/** Pure display helpers for the MEXC screens. Nothing here decides whether an order may be sent. */

export type Venue = "schwab" | "mexc";
export const VENUE_KEY = "ths.expo.venue.v1";
/** Anything unreadable falls back to Schwab, the original app. */
export const parseVenue = (raw: string | null | undefined): Venue => (raw === "mexc" ? "mexc" : "schwab");

export const isStockContract = (contract: Pick<MexcContract, "symbol">) => contract.symbol.includes("STOCK");

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
/** Price used only for the form's estimate; the review always shows the server's price. */
export function estimatePrice(kind: MexcKind, buying: boolean, limitPrice: string, ticker?: MexcTicker): string | number | undefined {
  if (kind === "LIMIT") return limitPrice;
  return (buying ? ticker?.ask1 : ticker?.bid1) ?? ticker?.lastPrice;
}

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

export const LOCK_BANNER = "有一笔委托结果未确认，交易已锁定，请先在 MEXC 核实";
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
