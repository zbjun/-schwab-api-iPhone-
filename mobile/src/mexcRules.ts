import { TradingError } from "./orderRules.ts";
import type { Candle, History, HistoryRange } from "./types.ts";

/** One USDT-margined futures account; the id only keeps the gateway's argument shape. */
export const MEXC_ACCOUNT = "USDT";
export const MEXC_REVIEW_TTL = 60_000;
const QUOTE_MAX_AGE = 60_000;
const MARKET_QUOTE_MAX_AGE = 10_000;

export type MexcAction = "OPEN_LONG" | "CLOSE_SHORT" | "OPEN_SHORT" | "CLOSE_LONG";
/** MARKET is sent as an IOC limit at a protected price, so slippage has a hard bound. */
export type MexcKind = "LIMIT" | "MARKET";
export interface MexcDraft {
  symbol: string;
  action: MexcAction;
  kind: MexcKind;
  /** Contracts as decimal text. Value in USDT = vol x contractSize x price. */
  vol: string;
  /** Required for LIMIT, absent for MARKET. */
  price?: string;
  /** Required when opening, absent when closing. */
  leverage?: number;
  /** Opening only, as decimal text. They take effect once the order fills and trigger on the fair price. */
  takeProfitPrice?: string;
  stopLossPrice?: string;
}
/** Server-held limits. The app only displays them and cannot change them. */
export interface MexcLimits {
  maxLeverage: number;
  maxOrderNotional: number;
  /** MARKET protection: the IOC price sits this fraction away from the best quote. */
  marketProtection: number;
}
export interface MexcContract {
  symbol: string;
  displayName: string;
  baseCoin: string;
  settleCoin: string;
  futureType: number;
  state: number;
  apiAllowed: boolean;
  contractSize: number;
  priceUnit: number;
  volUnit: number;
  minVol: number;
  maxVol: number;
  minLeverage: number;
  maxLeverage: number;
  /** 1 isolated, 2 cross, 3 both. */
  positionOpenType: number;
  takerFeeRate: number;
  makerFeeRate: number;
}
export interface MexcTicker {
  symbol: string;
  lastPrice: number;
  bid1?: number;
  ask1?: number;
  fairPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  riseFallRate?: number;
  amount24?: number;
  high24Price?: number;
  lower24Price?: number;
  maxBidPrice?: number;
  minAskPrice?: number;
  timestamp: number;
}
export interface MexcPosition {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  /** 1 isolated, 2 cross. */
  openType: 1 | 2;
  holdVol: number;
  frozenVol: number;
  averagePrice: number;
  liquidatePrice?: number;
  leverage: number;
  margin?: number;
  unrealized?: number;
  realised?: number;
  holdFee?: number;
}
export interface MexcAsset {
  currency: string;
  equity: number;
  availableBalance: number;
  availableOpen: number;
  positionMargin: number;
  frozenBalance: number;
  unrealized: number;
}
export interface MexcAccount {
  id: string;
  asset: MexcAsset;
  positions: MexcPosition[];
}
export interface MexcOrder {
  id: string;
  /** What an opening order carries, shown while it is still waiting to fill. */
  takeProfitPrice?: number;
  stopLossPrice?: number;
  symbol: string;
  action: MexcAction;
  /** Exchange order type: 1 limit, 2 post only, 3 IOC, 4 FOK, 5 market. */
  orderType?: number;
  price: number;
  vol: number;
  dealVol: number;
  dealAvgPrice?: number;
  leverage?: number;
  openType?: number;
  /** 1 pending, 2 unfilled, 3 filled, 4 canceled, 5 invalid. */
  state: number;
  cancelable: boolean;
  externalOid?: string;
  profit?: number;
  fee?: number;
  createdAt?: number;
  updatedAt?: number;
}
/** What the review screen shows; every value is computed by the server. */
export interface MexcPrepared {
  id: string;
  draft: MexcDraft;
  accountID: string;
  displayName: string;
  externalOid: string;
  /** The exact price sent: the limit, or the protected IOC price for MARKET. */
  orderPrice: string;
  referencePrice: number;
  /** Largest value this order can reach, in USDT. */
  notional: number;
  openType: 1 | 2;
  /** Opening only. */
  leverage?: number;
  margin?: number;
  available?: number;
  /** Closing only. */
  closable?: number;
  positionId?: string;
  takerFeeRate: number;
  makerFeeRate: number;
  fundingRate?: number;
  preparedAt: number;
  isDemo: boolean;
}
/** The server's answer to "what would this order do", kept separate from identity and time. */
export interface MexcOrderPlan {
  orderPrice: string;
  referencePrice: number;
  notional: number;
  openType: 1 | 2;
  leverage?: number;
  margin?: number;
  available?: number;
  closable?: number;
  positionId?: string;
}
/**
 * Changing the leverage of an open position. A draft of its own that carries no side, size or price,
 * so it can never be read as an order.
 */
export interface MexcLeverageDraft {
  kind: "LEVERAGE";
  symbol: string;
  positionId: string;
  leverage: number;
}
/** The position as the server found it, so the review shows what is really being changed. */
export interface MexcLeveragePlan {
  direction: "LONG" | "SHORT";
  previousLeverage: number;
  holdVol: number;
  averagePrice: number;
  margin?: number;
  liquidatePrice?: number;
  available: number;
}
export interface MexcLeveragePrepared extends MexcLeveragePlan {
  id: string;
  draft: MexcLeverageDraft;
  accountID: string;
  displayName: string;
  preparedAt: number;
  isDemo: boolean;
}
/** A take-profit and stop-loss waiting on a position. Prices it does not set are absent. */
export interface MexcStopOrder {
  id: string;
  symbol: string;
  positionId: string;
  direction: "LONG" | "SHORT";
  takeProfitPrice?: number;
  stopLossPrice?: number;
  vol: number;
}
/**
 * Setting, changing or cancelling the take-profit and stop-loss of an open position.
 * Like a leverage change it carries no side, so it can never be read as an order.
 */
export interface MexcStopDraft {
  kind: "STOP_PLACE" | "STOP_CHANGE" | "STOP_CANCEL";
  symbol: string;
  positionId: string;
  /** Required to change or cancel, absent when placing. */
  stopOrderId?: string;
  /** As decimal text. At least one when placing or changing, none when cancelling. */
  takeProfitPrice?: string;
  stopLossPrice?: string;
}
/** The position and the prices as the server found them, so the review shows what is really changing. */
export interface MexcStopPlan {
  direction: "LONG" | "SHORT";
  holdVol: number;
  averagePrice: number;
  liquidatePrice?: number;
  leverage: number;
  /** Exact contracts covered. */
  vol: string;
  fairPrice?: number;
  existing?: { takeProfitPrice?: number; stopLossPrice?: number; vol: number };
  /** Estimated profit or loss at each price from the average entry, before fees. */
  atTakeProfit?: number;
  atStopLoss?: number;
}
export interface MexcStopPrepared extends MexcStopPlan {
  id: string;
  draft: MexcStopDraft;
  accountID: string;
  displayName: string;
  preparedAt: number;
  isDemo: boolean;
}

/** The only text an exchange problem can show. Exchange messages are never forwarded. */
export const MEXC_MESSAGES: Record<string, string> = {
  invalidResponse: "MEXC 返回的数据不完整或格式不受支持。",
  invalidDecimal: "数字格式无效。",
  invalidDraft: "委托参数无效。",
  invalidSymbol: "合约代码无效。",
  invalidAccount: "账户无效。",
  invalidOrderIdentifier: "订单编号无效。",
  invalidRange: "时间或图表周期无效。",
  volumeInvalid: "张数不符合该合约的最小单位或上下限。",
  priceInvalid: "请输入有效的限价。",
  priceTick: "价格不符合该合约的最小变动单位。",
  priceLimit: "价格超出交易所当前的限价范围。",
  leverageLimit: "杠杆超出服务器设定的上限或该合约允许的范围。",
  leverageMismatch: "杠杆必须和该方向的现有持仓一致。",
  positionMode: "只支持对冲持仓模式，请先在 MEXC 切换持仓模式。",
  positionCross: "该方向已有全仓持仓，这里只支持逐仓加仓。",
  isolatedUnavailable: "该合约不支持逐仓。",
  contractUnavailable: "该合约当前不能通过 API 交易。",
  quoteStale: "行情已过期，请稍后重新核对。",
  quoteMissing: "暂时缺少买卖报价，无法下市价单。",
  quoteDeviation: "盘口偏离标记价过大，市价单已拦下，请改用限价。",
  notionalLimit: "单笔金额超出服务器设定的上限。",
  insufficientFunds: "可用保证金不足。",
  insufficientPosition: "可平张数不足，请刷新持仓和委托。",
  orderChanged: "这笔委托已结束，无法撤销，请刷新。",
  cancelRejected: "撤单被拒绝，请刷新委托状态。",
  orderOutcomeUnknown: "这笔操作的结果未确认，交易已锁定，请先在 MEXC 核实，勿重复提交。",
  reviewExpired: "核对已过期、已使用或被另一台设备更新，请重新核对。",
  operationBusy: "另一笔委托正在处理中，请稍候。",
  secureStorage: "无法写入交易标记，本次未提交。",
  exchangeUnavailable: "无法连接 MEXC，请稍后重试。",
  apiKeyRejected: "MEXC 拒绝了 API Key 或签名，请检查服务器配置。",
  ipRejected: "服务器 IP 不在 API Key 的白名单里。",
  permissionRejected: "API Key 缺少所需权限。",
  rateLimited: "请求过于频繁，请稍后再试。",
  regionRejected: "MEXC 不向服务器所在地区提供此服务。",
  exchangeRejected: "MEXC 拒绝了这笔委托，未成交。",
  marketClosed: "美股类合约休市中，现在不能交易。",
  positionChanged: "持仓已变化，请刷新后重新核对。",
  leverageUnchanged: "新杠杆和当前杠杆相同。",
  leverageCross: "全仓持仓不能在这里改杠杆。",
  leverageOrdersOpen: "该合约还有未成交的委托，MEXC 不允许改杠杆，请先撤单。杠杆没有变化。",
  leverageMargin: "可用保证金不够，MEXC 没有修改杠杆。",
  leverageSizeLimit: "当前持仓超过目标杠杆允许的上限，MEXC 没有修改杠杆。",
  leverageRejected: "MEXC 拒绝了这次杠杆修改，杠杆没有变化。",
  stopPriceMissing: "请至少填写止盈价或止损价。",
  stopPriceInvalid: "止盈价或止损价无效。",
  stopPriceSide: "价格方向不对：做多时止盈要高于、止损要低于当前价，做空相反。",
  stopExists: "这个持仓已有止盈止损，请修改现有的那一个。",
  stopChanged: "这个止盈止损已触发或已取消，请刷新后重新核对。",
  stopSideRequired: "要去掉止盈或止损，请先取消现有的，再重新设置。",
  stopRejected: "MEXC 拒绝了这次止盈止损操作，没有生效。",
  stopVolume: "止盈止损的张数超过了 MEXC 允许的可平张数，没有生效。请先撤掉占用持仓的委托，或到 MEXC 设置。",
  stopOnHeldPosition: "这个方向已有持仓，请在持仓上设置止盈止损。",
  stopsDropped: "这个方向现在有持仓了，刚填的止盈止损不能随单提交。请先清除价格，再到持仓上设置。",
  keyInvalid: "API Key 已失效，下单已关闭。",
  keyNotBound: "API Key 没有绑定具体 IP，下单已关闭。",
  keyMovesMoney: "API Key 带转账或提现权限，下单已关闭，请换一个只有合约权限的 Key。",
  keyPermissions: "API Key 权限不符，下单已关闭：只开合约账户读、合约交易读写和现货账户读（用于检查 Key），不要开其他权限。",
  keyCheckFailed: "无法确认 API Key 的权限，下单已关闭，请稍后重试。",
};
export const mexcError = (code: string) => new TradingError(code, MEXC_MESSAGES[code] ?? MEXC_MESSAGES.exchangeRejected);
export const invalidMexcResponse = () => mexcError("invalidResponse");

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidMexcResponse();
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw invalidMexcResponse();
  return value;
};
const optional = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const required = (value: unknown): number => {
  const parsed = optional(value);
  if (parsed === undefined) throw invalidMexcResponse();
  return parsed;
};
const positive = (value: unknown): number => {
  const parsed = required(value);
  if (parsed <= 0) throw invalidMexcResponse();
  return parsed;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw invalidMexcResponse();
  return value;
};
const identifier = (value: unknown): string => {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== "string" || !/^\d{1,30}$/.test(raw)) throw invalidMexcResponse();
  return raw;
};

/**
 * Order and position ids exceed 2^53 and can arrive as bare JSON numbers. Quote
 * long integers before parsing so an id can never be silently rounded to another order's.
 */
export function parseLossless(body: string): unknown {
  return JSON.parse(body.replace(/([:[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}

// Exact decimal arithmetic. Tick and lot checks must not depend on binary floats.
interface Decimal { units: bigint; scale: number }
function pow10(exponent: number): bigint {
  let value = 1n;
  for (let index = 0; index < exponent; index++) value *= 10n;
  return value;
}
function parseDecimal(value: string): Decimal | undefined {
  const match = /^(\d{1,18})(?:\.(\d{1,12}))?$/.exec(value);
  if (!match) return undefined;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return { units: BigInt(match[1] + fraction), scale: fraction.length };
}
function formatDecimal({ units, scale }: Decimal): string {
  const digits = units.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return digits.slice(0, -scale) + (fraction ? "." + fraction : "");
}
/** Plain decimal text of a double, without exponent notation. */
export function plainNumber(value: number): string {
  const [mantissa, exponent] = String(value).split("e");
  if (exponent === undefined) return mantissa;
  const shift = Number(exponent), [whole, fraction = ""] = mantissa.split(".");
  if (shift < 0) return "0." + "0".repeat(-shift - 1) + whole + fraction;
  return whole + fraction.padEnd(shift, "0");
}
export function isMultipleOf(value: string, step: number): boolean {
  const amount = parseDecimal(value), unit = parseDecimal(plainNumber(step));
  if (!amount || !unit || unit.units === 0n) return false;
  const scale = Math.max(amount.scale, unit.scale);
  return (amount.units * pow10(scale - amount.scale)) % (unit.units * pow10(scale - unit.scale)) === 0n;
}
function compareDecimal(left: string, right: string): number {
  const a = parseDecimal(left), b = parseDecimal(right);
  if (!a || !b) throw invalidMexcResponse();
  const scale = Math.max(a.scale, b.scale);
  const x = a.units * pow10(scale - a.scale), y = b.units * pow10(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
/** Exact holdVol - frozenVol as decimal text. Doubles would make 0.3 - 0.1 unsendable. */
export function mexcClosable(holdVol: number, frozenVol: number): string {
  // Twelve places is the most a volume can carry; this strips noise such as 0.30000000000000004.
  const clean = (value: number) => (Number.isFinite(value) && value >= 0 ? parseDecimal(plainNumber(Number(value.toFixed(12)))) : undefined);
  const hold = clean(holdVol), frozen = clean(frozenVol);
  if (!hold || !frozen) throw invalidMexcResponse();
  const scale = Math.max(hold.scale, frozen.scale);
  const units = hold.units * pow10(scale - hold.scale) - frozen.units * pow10(scale - frozen.scale);
  return units > 0n ? formatDecimal({ units, scale }) : "0";
}
/** Canonical decimal text, so a value signs the same however it was typed. */
export function canonicalDecimal(value: string): string {
  const parsed = parseDecimal(value);
  if (!parsed) throw mexcError("invalidDecimal");
  return formatDecimal(parsed);
}
/** Snaps to the tick toward `direction`: a buy limit never rises past its protected bound. */
export function toTick(target: number, tick: number, direction: "down" | "up"): string {
  const unit = parseDecimal(plainNumber(tick));
  if (!unit || unit.units === 0n || !Number.isFinite(target) || target <= 0) throw invalidMexcResponse();
  const ratio = target / tick;
  const steps = direction === "down" ? Math.floor(ratio + 1e-9) : Math.ceil(ratio - 1e-9);
  if (!Number.isSafeInteger(steps) || steps <= 0) throw invalidMexcResponse();
  return formatDecimal({ units: BigInt(steps) * unit.units, scale: unit.scale });
}

const ACTIONS: readonly MexcAction[] = ["OPEN_LONG", "CLOSE_SHORT", "OPEN_SHORT", "CLOSE_LONG"];
export const mexcActionLabels: Record<MexcAction, string> = {
  OPEN_LONG: "开多",
  CLOSE_SHORT: "平空",
  OPEN_SHORT: "开空",
  CLOSE_LONG: "平多",
};
export const isOpening = (action: MexcAction) => action === "OPEN_LONG" || action === "OPEN_SHORT";
export const isBuying = (action: MexcAction) => action === "OPEN_LONG" || action === "CLOSE_SHORT";
const directionOf = (action: MexcAction): "LONG" | "SHORT" =>
  action === "OPEN_LONG" || action === "CLOSE_LONG" ? "LONG" : "SHORT";
export function validMexcSymbol(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{1,24}_USDT$/.test(value);
}
export function validMexcOrderID(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,30}$/.test(value);
}

export function validateMexcDraft(draft: MexcDraft): void {
  const row = draft as unknown as Record<string, unknown>;
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      Object.keys(row).some(key => !["symbol", "action", "kind", "vol", "price", "leverage", "takeProfitPrice", "stopLossPrice"].includes(key)))
    throw mexcError("invalidDraft");
  if (!validMexcSymbol(draft.symbol)) throw mexcError("invalidSymbol");
  if (!ACTIONS.includes(draft.action)) throw mexcError("invalidDraft");
  if (typeof draft.vol !== "string" || !parseDecimal(draft.vol)?.units) throw mexcError("volumeInvalid");
  if (draft.kind === "LIMIT") {
    if (typeof draft.price !== "string" || !parseDecimal(draft.price)?.units) throw mexcError("priceInvalid");
  } else if (draft.kind === "MARKET") {
    if (draft.price !== undefined) throw mexcError("invalidDraft");
  } else throw mexcError("invalidDraft");
  if (isOpening(draft.action)) {
    if (!Number.isInteger(draft.leverage) || draft.leverage! < 1) throw mexcError("leverageLimit");
  } else if (draft.leverage !== undefined || draft.takeProfitPrice !== undefined || draft.stopLossPrice !== undefined) throw mexcError("invalidDraft");
  validateStopPrices(draft);
}
/** Each price, when present, is a positive decimal. Whether it is on the right side needs a quote. */
function validateStopPrices(prices: { takeProfitPrice?: string; stopLossPrice?: string }): void {
  for (const price of [prices.takeProfitPrice, prices.stopLossPrice])
    if (price !== undefined && (typeof price !== "string" || !parseDecimal(price)?.units)) throw mexcError("stopPriceInvalid");
}
export function freezeMexcDraft(draft: MexcDraft): MexcDraft {
  return Object.freeze({
    symbol: draft.symbol,
    action: draft.action,
    kind: draft.kind,
    vol: canonicalDecimal(draft.vol),
    ...(draft.price === undefined ? {} : { price: canonicalDecimal(draft.price) }),
    ...(draft.leverage === undefined ? {} : { leverage: draft.leverage }),
    ...(draft.takeProfitPrice === undefined ? {} : { takeProfitPrice: canonicalDecimal(draft.takeProfitPrice) }),
    ...(draft.stopLossPrice === undefined ? {} : { stopLossPrice: canonicalDecimal(draft.stopLossPrice) }),
  });
}
export const isStopDraft = (draft: unknown): draft is MexcStopDraft => {
  const kind = !!draft && typeof draft === "object" ? (draft as { kind?: unknown }).kind : undefined;
  return kind === "STOP_PLACE" || kind === "STOP_CHANGE" || kind === "STOP_CANCEL";
};
export function validateMexcStopDraft(draft: MexcStopDraft): void {
  const row = draft as unknown as Record<string, unknown>;
  if (!isStopDraft(row) || Array.isArray(row) || Object.keys(row).some(key => !["kind", "symbol", "positionId", "stopOrderId", "takeProfitPrice", "stopLossPrice"].includes(key)))
    throw mexcError("invalidDraft");
  if (!validMexcSymbol(draft.symbol)) throw mexcError("invalidSymbol");
  if (!validMexcOrderID(draft.positionId)) throw mexcError("positionChanged");
  if (draft.kind === "STOP_PLACE" ? draft.stopOrderId !== undefined : !validMexcOrderID(draft.stopOrderId)) throw mexcError("invalidDraft");
  if (draft.kind === "STOP_CANCEL") {
    if (draft.takeProfitPrice !== undefined || draft.stopLossPrice !== undefined) throw mexcError("invalidDraft");
    return;
  }
  validateStopPrices(draft);
  if (draft.takeProfitPrice === undefined && draft.stopLossPrice === undefined) throw mexcError("stopPriceMissing");
}
export function freezeMexcStopDraft(draft: MexcStopDraft): MexcStopDraft {
  return Object.freeze({
    kind: draft.kind,
    symbol: draft.symbol,
    positionId: draft.positionId,
    ...(draft.stopOrderId === undefined ? {} : { stopOrderId: draft.stopOrderId }),
    ...(draft.takeProfitPrice === undefined ? {} : { takeProfitPrice: canonicalDecimal(draft.takeProfitPrice) }),
    ...(draft.stopLossPrice === undefined ? {} : { stopLossPrice: canonicalDecimal(draft.stopLossPrice) }),
  });
}

export const isLeverageDraft = (draft: unknown): draft is MexcLeverageDraft =>
  !!draft && typeof draft === "object" && (draft as { kind?: unknown }).kind === "LEVERAGE";
export function validateMexcLeverageDraft(draft: MexcLeverageDraft): void {
  const row = draft as unknown as Record<string, unknown>;
  if (!isLeverageDraft(row) || Array.isArray(row) || Object.keys(row).some(key => !["kind", "symbol", "positionId", "leverage"].includes(key)))
    throw mexcError("invalidDraft");
  if (!validMexcSymbol(draft.symbol)) throw mexcError("invalidSymbol");
  if (!validMexcOrderID(draft.positionId)) throw mexcError("positionChanged");
  if (!Number.isInteger(draft.leverage) || draft.leverage < 1) throw mexcError("leverageLimit");
}
export function freezeMexcLeverageDraft(draft: MexcLeverageDraft): MexcLeverageDraft {
  return Object.freeze({ kind: "LEVERAGE", symbol: draft.symbol, positionId: draft.positionId, leverage: draft.leverage });
}

export function validateMexcLimits(limits: MexcLimits): void {
  if (!limits || !Number.isInteger(limits.maxLeverage) || limits.maxLeverage < 1 || limits.maxLeverage > 500 ||
      !Number.isFinite(limits.maxOrderNotional) || limits.maxOrderNotional <= 0 ||
      !Number.isFinite(limits.marketProtection) || limits.marketProtection <= 0 || limits.marketProtection > 0.1)
    throw new Error("Invalid MEXC limits");
}

export interface MexcOrderContext {
  draft: MexcDraft;
  contract: MexcContract;
  ticker: MexcTicker;
  positions: MexcPosition[];
  availableOpen: number;
  /** 1 hedge, 2 one-way. */
  positionMode: number;
  limits: MexcLimits;
  now: number;
  /** Set when re-checking a reviewed order: MARKET keeps the price the user approved. */
  reviewedPrice?: string;
}
/**
 * The single place that decides whether an order may leave the server. Runs at
 * review and again immediately before the write, against freshly read state.
 */
export function planMexcOrder(context: MexcOrderContext): MexcOrderPlan {
  const { draft, contract, ticker, positions, availableOpen, positionMode, limits, now, reviewedPrice } = context;
  if (positionMode !== 1) throw mexcError("positionMode");
  if (contract.symbol !== draft.symbol || ticker.symbol !== draft.symbol) throw invalidMexcResponse();
  if (contract.state !== 0 || contract.apiAllowed !== true || contract.futureType !== 1 || contract.settleCoin !== "USDT")
    throw mexcError("contractUnavailable");
  if (!Number.isFinite(ticker.timestamp) || Math.abs(now - ticker.timestamp) > QUOTE_MAX_AGE)
    throw mexcError("quoteStale");
  if (draft.kind === "MARKET" && Math.abs(now - ticker.timestamp) > MARKET_QUOTE_MAX_AGE) throw mexcError("quoteStale");

  const vol = Number(draft.vol);
  if (!isMultipleOf(draft.vol, contract.volUnit) || vol < contract.minVol || vol > contract.maxVol)
    throw mexcError("volumeInvalid");

  const buying = isBuying(draft.action);
  const best = buying ? ticker.ask1 : ticker.bid1;
  if (draft.kind === "MARKET") {
    if (best === undefined || best <= 0) throw mexcError("quoteMissing");
    // A thin book can sit far from the mark; protection measured from it alone would not help.
    const fair = ticker.fairPrice;
    if (fair === undefined || fair <= 0 || Math.abs(best - fair) / fair > limits.marketProtection) throw mexcError("quoteDeviation");
  }
  let orderPrice: string;
  if (draft.kind === "LIMIT") {
    orderPrice = draft.price!;
    if (!isMultipleOf(orderPrice, contract.priceUnit)) throw mexcError("priceTick");
  } else if (reviewedPrice !== undefined) {
    orderPrice = reviewedPrice;
  } else {
    orderPrice = buying
      ? toTick(best! * (1 + limits.marketProtection), contract.priceUnit, "down")
      : toTick(best! * (1 - limits.marketProtection), contract.priceUnit, "up");
  }
  const price = Number(orderPrice);
  if ((buying && ticker.maxBidPrice !== undefined && price > ticker.maxBidPrice) ||
      (!buying && ticker.minAskPrice !== undefined && price < ticker.minAskPrice))
    throw mexcError("priceLimit");

  const referencePrice = best !== undefined && best > 0 ? best : ticker.lastPrice;
  // A limit sell below the market fills near the market, so the larger price bounds the value.
  const notional = vol * contract.contractSize * Math.max(price, referencePrice);
  const direction = directionOf(draft.action);
  const matching = positions.filter(position => position.symbol === draft.symbol && position.direction === direction && position.holdVol > 0);
  if (draft.takeProfitPrice !== undefined || draft.stopLossPrice !== undefined) {
    // MEXC refuses these on top of a position's own with codes that prove nothing about the order, which would lock everything.
    if (matching.length) throw mexcError("stopOnHeldPosition");
    checkStopPrices(direction, draft, orderStopReferences(draft.kind, direction, price, referencePrice, ticker.fairPrice), contract.priceUnit);
  }

  if (isOpening(draft.action)) {
    const leverage = draft.leverage!;
    if (leverage < contract.minLeverage || leverage > contract.maxLeverage || leverage > limits.maxLeverage)
      throw mexcError("leverageLimit");
    if (contract.positionOpenType !== 1 && contract.positionOpenType !== 3)
      throw mexcError("isolatedUnavailable");
    if (matching.some(position => position.openType !== 1))
      throw mexcError("positionCross");
    if (matching.some(position => position.leverage !== leverage))
      throw mexcError("leverageMismatch");
    if (notional > limits.maxOrderNotional)
      throw mexcError("notionalLimit");
    const margin = notional / leverage;
    if (margin > availableOpen) throw mexcError("insufficientFunds");
    return { orderPrice, referencePrice, notional, openType: 1, leverage, margin, available: availableOpen };
  }
  // Closing only ever reduces risk, so the leverage and value limits do not apply.
  if (matching.length !== 1) throw mexcError("insufficientPosition");
  const position = matching[0];
  const closable = mexcClosable(position.holdVol, position.frozenVol);
  if (compareDecimal(draft.vol, closable) > 0) throw mexcError("insufficientPosition");
  return { orderPrice, referencePrice, notional, openType: position.openType, closable: Number(closable), positionId: position.id };
}

export interface MexcLeverageContext {
  draft: MexcLeverageDraft;
  contract: MexcContract;
  positions: MexcPosition[];
  availableOpen: number;
  /** 1 hedge, 2 one-way. */
  positionMode: number;
  limits: MexcLimits;
}
/**
 * The single place that decides whether a leverage change may leave the server, at review and again
 * immediately before the write. Going down is also held to the limits: a position opened elsewhere
 * above them can come down to them, not stop halfway. MEXC decides whether the margin is enough.
 */
export function planMexcLeverage(context: MexcLeverageContext): MexcLeveragePlan {
  const { draft, contract, positions, availableOpen, positionMode, limits } = context;
  if (positionMode !== 1) throw mexcError("positionMode");
  if (contract.symbol !== draft.symbol) throw invalidMexcResponse();
  if (contract.state !== 0 || contract.apiAllowed !== true || contract.futureType !== 1 || contract.settleCoin !== "USDT")
    throw mexcError("contractUnavailable");
  const position = positions.find(row => row.id === draft.positionId && row.symbol === draft.symbol && row.holdVol > 0);
  if (!position) throw mexcError("positionChanged");
  if (position.openType !== 1) throw mexcError("leverageCross");
  if (draft.leverage < contract.minLeverage || draft.leverage > contract.maxLeverage || draft.leverage > limits.maxLeverage)
    throw mexcError("leverageLimit");
  if (draft.leverage === position.leverage) throw mexcError("leverageUnchanged");
  return {
    direction: position.direction, previousLeverage: position.leverage, holdVol: position.holdVol, averagePrice: position.averagePrice,
    margin: position.margin, liquidatePrice: position.liquidatePrice, available: availableOpen,
  };
}

/**
 * What each price of an opening order is measured from. A limit order can fill better than its price, so a stop-loss
 * must clear both its price and the quote: a limit buy at 110 with the ask at 100 fills near 100, and a stop at 105 would
 * fire at once. A market order fills near the quote and its stops watch the fair price, so it must clear both of those.
 */
export function orderStopReferences(kind: MexcKind, direction: "LONG" | "SHORT", limitPrice: number | undefined, quote: number | undefined, fair: number | undefined): { takeProfit?: number; stopLoss?: number } {
  const usable = (values: (number | undefined)[]) => values.filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
  const long = direction === "LONG";
  // A limit that crosses the book fills at once, so its stop watches the fair price straight away. One still
  // waiting is not judged by where the fair price is today: waiting for a dip is the point of it.
  const crossing = limitPrice !== undefined && quote !== undefined && (long ? limitPrice >= quote : limitPrice <= quote);
  const takeProfit = usable(kind === "LIMIT" ? [limitPrice] : [quote, fair]);
  const stopLoss = usable(kind === "LIMIT" ? [limitPrice, quote, ...(crossing ? [fair] : [])] : [quote, fair]);
  return {
    takeProfit: takeProfit.length ? (long ? Math.max : Math.min)(...takeProfit) : undefined,
    stopLoss: stopLoss.length ? (long ? Math.min : Math.max)(...stopLoss) : undefined,
  };
}
/** A price on the wrong side would trigger as soon as it was placed. */
function checkStopPrices(direction: "LONG" | "SHORT", prices: { takeProfitPrice?: string; stopLossPrice?: string }, references: { takeProfit?: number; stopLoss?: number }, tick: number): void {
  const { takeProfitPrice, stopLossPrice } = prices;
  for (const price of [takeProfitPrice, stopLossPrice])
    if (price !== undefined && !isMultipleOf(price, tick)) throw mexcError("priceTick");
  const sign = direction === "LONG" ? 1 : -1;
  if ((takeProfitPrice !== undefined && references.takeProfit !== undefined && (Number(takeProfitPrice) - references.takeProfit) * sign <= 0) ||
      (stopLossPrice !== undefined && references.stopLoss !== undefined && (references.stopLoss - Number(stopLossPrice)) * sign <= 0))
    throw mexcError("stopPriceSide");
}
function stopTarget(draft: MexcStopDraft, positions: MexcPosition[], stopOrders: MexcStopOrder[]) {
  const position = positions.find(row => row.id === draft.positionId && row.symbol === draft.symbol && row.holdVol > 0);
  if (!position) throw mexcError("positionChanged");
  const held = stopOrders.filter(row => row.positionId === draft.positionId);
  const found = draft.stopOrderId === undefined ? undefined : held.find(row => row.id === draft.stopOrderId);
  if (draft.kind !== "STOP_PLACE" && !found) throw mexcError("stopChanged");
  const existing = found && { takeProfitPrice: found.takeProfitPrice, stopLossPrice: found.stopLossPrice, vol: found.vol };
  const base = {
    direction: position.direction, holdVol: position.holdVol, averagePrice: position.averagePrice, liquidatePrice: position.liquidatePrice,
    leverage: position.leverage, existing,
  };
  return { position, held, found, base };
}
/** Needs no quote or contract state, and the reads behind it none either: taking a stop off must work whatever the market is doing. */
export function planMexcStopCancel(draft: MexcStopDraft, positions: MexcPosition[], stopOrders: MexcStopOrder[]): MexcStopPlan {
  if (draft.kind !== "STOP_CANCEL") throw mexcError("invalidDraft");
  const { found, base } = stopTarget(draft, positions, stopOrders);
  return { ...base, vol: plainNumber(found!.vol) };
}
export interface MexcStopContext {
  draft: MexcStopDraft;
  contract: MexcContract;
  ticker: MexcTicker;
  positions: MexcPosition[];
  stopOrders: MexcStopOrder[];
  /** 1 hedge, 2 one-way. */
  positionMode: number;
  now: number;
}
/** The single place that decides whether setting or changing one may leave the server, at review and again immediately before the write. */
export function planMexcStop(context: MexcStopContext): MexcStopPlan {
  const { draft, contract, ticker, positions, stopOrders, positionMode, now } = context;
  if (draft.kind === "STOP_CANCEL") throw mexcError("invalidDraft");
  if (contract.symbol !== draft.symbol || ticker.symbol !== draft.symbol) throw invalidMexcResponse();
  const { position, held, found, base } = stopTarget(draft, positions, stopOrders);
  if (positionMode !== 1) throw mexcError("positionMode");
  if (contract.state !== 0 || contract.apiAllowed !== true || contract.futureType !== 1 || contract.settleCoin !== "USDT")
    throw mexcError("contractUnavailable");
  if (!Number.isFinite(ticker.timestamp) || Math.abs(now - ticker.timestamp) > QUOTE_MAX_AGE) throw mexcError("quoteStale");
  const fair = ticker.fairPrice;
  if (fair === undefined || fair <= 0) throw mexcError("quoteMissing");
  // Both trigger on the fair price, so that is what each is measured from.
  checkStopPrices(position.direction, draft, { takeProfit: fair, stopLoss: fair }, contract.priceUnit);
  let vol: string;
  if (draft.kind === "STOP_PLACE") {
    if (held.length) throw mexcError("stopExists");
    vol = mexcClosable(position.holdVol, position.frozenVol);
    if (Number(vol) < contract.minVol || !isMultipleOf(vol, contract.volUnit)) throw mexcError("insufficientPosition");
  } else {
    // Leaving a price out of a change would not clearly remove it, so that takes a cancel and a new one.
    if ((found!.takeProfitPrice !== undefined && draft.takeProfitPrice === undefined) || (found!.stopLossPrice !== undefined && draft.stopLossPrice === undefined))
      throw mexcError("stopSideRequired");
    vol = plainNumber(found!.vol);
  }
  const sign = position.direction === "LONG" ? 1 : -1;
  const atPrice = (price?: string) => (price === undefined ? undefined : (Number(price) - position.averagePrice) * Number(vol) * contract.contractSize * sign);
  return { ...base, fairPrice: fair, vol, atTakeProfit: atPrice(draft.takeProfitPrice), atStopLoss: atPrice(draft.stopLossPrice) };
}

/**
 * Built by hand so the signed text carries exact decimals and full-length ids.
 * Every interpolated value has already passed a strict format check.
 */
// 2 is the fair price, which one stray trade on a thin book cannot move the way it can the latest price.
const STOP_TRIGGER_FAIR = 2;
export function encodeMexcOrder(draft: MexcDraft, plan: MexcOrderPlan, externalOid: string): string {
  if (!validMexcSymbol(draft.symbol) || !/^[A-Za-z0-9]{8,32}$/.test(externalOid) ||
      (plan.positionId !== undefined && !validMexcOrderID(plan.positionId)))
    throw invalidMexcResponse();
  const side = { OPEN_LONG: 1, CLOSE_SHORT: 2, OPEN_SHORT: 3, CLOSE_LONG: 4 }[draft.action];
  const fields = [
    `"symbol":"${draft.symbol}"`,
    `"price":${canonicalDecimal(plan.orderPrice)}`,
    `"vol":${canonicalDecimal(draft.vol)}`,
    `"side":${side}`,
    `"sideType":"${isBuying(draft.action) ? "buy" : "sell"}"`,
    // 1 limit rests on the book; 3 IOC cancels whatever cannot fill inside the protected price.
    `"type":${draft.kind === "LIMIT" ? 1 : 3}`,
    `"openType":${plan.openType}`,
    `"positionType":"${directionOf(draft.action) === "LONG" ? "long" : "short"}"`,
    `"positionMode":1`,
    `"externalOid":"${externalOid}"`,
  ];
  if (plan.leverage !== undefined) {
    if (!Number.isInteger(plan.leverage)) throw invalidMexcResponse();
    fields.push(`"leverage":${plan.leverage}`);
  }
  if (plan.positionId !== undefined) fields.push(`"positionId":${plan.positionId}`);
  if (draft.takeProfitPrice !== undefined) fields.push(`"takeProfitPrice":${canonicalDecimal(draft.takeProfitPrice)}`, `"profitTrend":${STOP_TRIGGER_FAIR}`);
  if (draft.stopLossPrice !== undefined) fields.push(`"stopLossPrice":${canonicalDecimal(draft.stopLossPrice)}`, `"lossTrend":${STOP_TRIGGER_FAIR}`);
  return `{${fields.join(",")}}`;
}
/** Bare digits, never Number: order ids do not fit in a double. */
export function encodeMexcCancel(orderID: string): string {
  if (!validMexcOrderID(orderID)) throw mexcError("invalidOrderIdentifier");
  return `[${orderID}]`;
}

/** Bare digits, never Number: a position id may not fit in a double. */
export function encodeMexcLeverage(draft: MexcLeverageDraft): string {
  if (!validMexcOrderID(draft.positionId) || !Number.isInteger(draft.leverage)) throw invalidMexcResponse();
  return `{"positionId":${draft.positionId},"leverage":${draft.leverage}}`;
}

/**
 * An accepted answer only counts when it says what the request should. Setting one must name an id, in any of the shapes
 * MEXC's documentation and its other endpoints show, though not necessarily a new one: at the same price it returns the old id.
 * A row reporting its own error, or naming a different one, is a partial failure inside a successful answer.
 * Anything else cannot be matched to this request.
 */
export function stopOutcome(draft: Pick<MexcStopDraft, "kind" | "stopOrderId">, data: unknown): "done" | "unknown" {
  if (data === false) return "unknown";
  const rows: unknown[] = Array.isArray(data) ? data : data === null || data === undefined || data === true ? [] : [data];
  const field = (row: unknown, name: string) => (row && typeof row === "object" ? (row as Record<string, unknown>)[name] : undefined);
  if (rows.some(row => { const code = field(row, "errorCode"); return code !== undefined && code !== null && code !== 0; })) return "unknown";
  const idText = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value);
  if (draft.kind !== "STOP_PLACE") {
    // A row that names which one it answered must name this one.
    return rows.every(row => { const named = field(row, "stopPlanOrderId"); return named === undefined || idText(named) === draft.stopOrderId; }) ? "done" : "unknown";
  }
  const usableID = (value: unknown) => { const text = idText(value); return validMexcOrderID(text) && !/^0+$/.test(text); };
  return rows.length > 0 && rows.every(row => usableID(row) || usableID(field(row, "id")) || usableID(field(row, "orderId")) || usableID(field(row, "stopPlanOrderId"))) ? "done" : "unknown";
}
export const mexcStopPath = (kind: MexcStopDraft["kind"]) =>
  ({ STOP_PLACE: "/api/v1/private/stoporder/place", STOP_CHANGE: "/api/v1/private/stoporder/change_plan_price", STOP_CANCEL: "/api/v1/private/stoporder/cancel" })[kind];
/**
 * Bare digits, never Number. Reversing is turned off by name, because a reverse would open a
 * position in the other direction; a market exit is named too, as MEXC's documentation marks both required.
 */
export function encodeMexcStop(draft: MexcStopDraft, plan: MexcStopPlan): string {
  const ids = [draft.positionId, ...(draft.stopOrderId === undefined ? [] : [draft.stopOrderId])];
  if (!ids.every(validMexcOrderID)) throw invalidMexcResponse();
  if (draft.kind === "STOP_CANCEL") return `[{"stopPlanOrderId":${draft.stopOrderId}}]`;
  const prices = [
    ...(draft.takeProfitPrice === undefined ? [] : [`"takeProfitPrice":${canonicalDecimal(draft.takeProfitPrice)}`]),
    ...(draft.stopLossPrice === undefined ? [] : [`"stopLossPrice":${canonicalDecimal(draft.stopLossPrice)}`]),
  ];
  const trigger = [`"lossTrend":${STOP_TRIGGER_FAIR}`, `"profitTrend":${STOP_TRIGGER_FAIR}`, `"takeProfitReverse":2`, `"stopLossReverse":2`];
  if (draft.kind === "STOP_CHANGE") return `{${[`"stopPlanOrderId":${draft.stopOrderId}`, ...trigger, ...prices].join(",")}}`;
  return `{${[`"positionId":${draft.positionId}`, `"vol":${canonicalDecimal(plan.vol)}`, `"volType":2`, `"profitLossVolType":"SAME"`, `"takeProfitType":0`, `"stopLossType":0`, ...trigger, ...prices].join(",")}}`;
}

/**
 * Only codes that say the request was refused may unlock trading. Anything else
 * (500, 501, 603 repeated request, 604, 801, 6008 "placed successfully", or a code
 * added later) could mean the order exists, so it stays unknown.
 */
export const DEFINITE_REJECTIONS: Record<number, string> = {
  401: "apiKeyRejected", 402: "apiKeyRejected", 602: "apiKeyRejected", 406: "ipRejected",
  506: "exchangeRejected", 511: "permissionRejected", 701: "permissionRejected", 702: "permissionRejected",
  703: "permissionRejected", 704: "permissionRejected", 510: "rateLimited", 2036: "rateLimited", 2037: "rateLimited",
  513: "exchangeRejected", 600: "exchangeRejected", 601: "exchangeRejected", 1000: "exchangeRejected",
  1001: "contractUnavailable", 1002: "contractUnavailable", 6001: "contractUnavailable", 6005: "contractUnavailable", 8930: "contractUnavailable",
  1003: "exchangeRejected", 1004: "volumeInvalid", 2011: "volumeInvalid", 2028: "volumeInvalid", 2051: "volumeInvalid", 2057: "volumeInvalid", 7008: "volumeInvalid",
  2001: "exchangeRejected", 2002: "exchangeRejected", 2022: "exchangeRejected", 2029: "exchangeRejected", 2035: "exchangeRejected", 2043: "exchangeRejected",
  2003: "priceLimit", 2004: "priceLimit", 2007: "priceLimit", 2015: "priceTick", 2032: "priceLimit", 2033: "priceLimit",
  2005: "insufficientFunds", 2008: "insufficientPosition", 2009: "insufficientPosition",
  2040: "orderChanged", 2041: "orderChanged",
  2006: "leverageLimit", 2021: "leverageMismatch", 2027: "positionCross", 7002: "positionMode",
  9070: "isolatedUnavailable", 9071: "isolatedUnavailable", 9073: "marketClosed", 300002: "regionRejected",
};
/**
 * The same rule for a leverage change, plus refusals only that request can get. Kept apart
 * so that none of them could ever unlock an order.
 */
export const LEVERAGE_REJECTIONS: Record<number, string> = {
  ...DEFINITE_REJECTIONS,
  2005: "leverageMargin", 2044: "leverageMargin", 2009: "positionChanged", 2019: "leverageOrdersOpen", 2021: "leverageRejected", 2026: "leverageCross",
  2038: "leverageSizeLimit", 8815: "leverageSizeLimit", 8816: "leverageSizeLimit", 8818: "leverageSizeLimit", 8819: "leverageSizeLimit", 8821: "leverageSizeLimit",
  8931: "leverageLimit",
};
/** The same again for take-profit and stop-loss requests. */
export const STOP_REJECTIONS: Record<number, string> = {
  ...DEFINITE_REJECTIONS,
  2008: "insufficientPosition", 2009: "positionChanged",
  5001: "stopPriceMissing", 5002: "stopChanged", 5003: "stopPriceInvalid", 5004: "stopVolume", 5005: "stopExists", 5006: "stopRejected",
};
export type MexcOutcome =
  | { kind: "accepted"; data: unknown }
  | { kind: "rejected"; code: string; exchangeCode?: number }
  | { kind: "unknown" };
export function classifyMexcResponse(status: number, body: string, rejections: Record<number, string> = DEFINITE_REJECTIONS): MexcOutcome {
  let envelope: Record<string, unknown> | undefined;
  try {
    const parsed = parseLossless(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) envelope = parsed as Record<string, unknown>;
  } catch { /* A body that cannot be read says nothing about the order. */ }
  if (status >= 500 || status === 408) return { kind: "unknown" };
  // A named code decides whatever the status: a listed refusal, or unknown for anything else.
  const code = envelope?.code;
  if (envelope?.success === false || (status >= 400 && code !== undefined)) {
    if (typeof code === "number" && Object.hasOwn(rejections, code))
      return { kind: "rejected", code: rejections[code], exchangeCode: code };
    return { kind: "unknown" };
  }
  // Only these say the request never reached matching: signature, firewall, rate limit.
  // A body claiming success, or any other 4xx such as a proxy's 499, proves nothing.
  if ((status === 401 || status === 403 || status === 429) && envelope?.success !== true)
    return { kind: "rejected", code: status === 429 ? "rateLimited" : status === 401 ? "apiKeyRejected" : "exchangeRejected" };
  if (status >= 200 && status < 300 && envelope?.success === true && envelope.code === 0)
    return { kind: "accepted", data: envelope.data };
  return { kind: "unknown" };
}
export function createdOrderID(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>).orderId;
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return validMexcOrderID(raw) ? raw : undefined;
}
/** Cancels answer per order inside a successful envelope. */
export function cancelOutcome(data: unknown, orderID: string): "cancelled" | "changed" | "unknown" {
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== "object") return "unknown";
  const row = data[0] as Record<string, unknown>;
  if (row.orderId !== undefined && String(row.orderId) !== orderID) return "unknown";
  if (row.errorCode === 0) return "cancelled";
  if (row.errorCode === 2040 || row.errorCode === 2041) return "changed";
  return "unknown";
}

export function decodeMexcContract(value: unknown): MexcContract {
  const row = object(value);
  if (typeof row.apiAllowed !== "boolean") throw invalidMexcResponse();
  return {
    symbol: text(row.symbol),
    displayName: typeof row.displayNameEn === "string" && row.displayNameEn ? row.displayNameEn : text(row.symbol),
    baseCoin: text(row.baseCoin),
    settleCoin: text(row.settleCoin),
    futureType: required(row.futureType),
    state: required(row.state),
    apiAllowed: row.apiAllowed,
    contractSize: positive(row.contractSize),
    priceUnit: positive(row.priceUnit),
    volUnit: positive(row.volUnit),
    minVol: positive(row.minVol),
    maxVol: positive(row.maxVol),
    minLeverage: positive(row.minLeverage),
    maxLeverage: positive(row.maxLeverage),
    positionOpenType: required(row.positionOpenType),
    takerFeeRate: required(row.takerFeeRate),
    makerFeeRate: required(row.makerFeeRate),
  };
}
export function decodeMexcTicker(value: unknown): MexcTicker {
  const row = object(value);
  return {
    symbol: text(row.symbol),
    lastPrice: positive(row.lastPrice),
    bid1: optional(row.bid1),
    ask1: optional(row.ask1),
    fairPrice: optional(row.fairPrice),
    indexPrice: optional(row.indexPrice),
    fundingRate: optional(row.fundingRate),
    riseFallRate: optional(row.riseFallRate),
    amount24: optional(row.amount24),
    high24Price: optional(row.high24Price),
    lower24Price: optional(row.lower24Price),
    maxBidPrice: optional(row.maxBidPrice),
    minAskPrice: optional(row.minAskPrice),
    timestamp: positive(row.timestamp),
  };
}
export function decodeMexcPositions(value: unknown): MexcPosition[] {
  return array(value).map(item => {
    const row = object(item);
    if ((row.positionType !== 1 && row.positionType !== 2) || (row.openType !== 1 && row.openType !== 2))
      throw invalidMexcResponse();
    return {
      id: identifier(row.positionId),
      symbol: text(row.symbol),
      direction: row.positionType === 1 ? "LONG" as const : "SHORT" as const,
      openType: row.openType,
      holdVol: required(row.holdVol),
      frozenVol: required(row.frozenVol),
      averagePrice: required(row.holdAvgPrice),
      liquidatePrice: optional(row.liquidatePrice),
      leverage: required(row.leverage),
      margin: optional(row.im) ?? optional(row.oim),
      unrealized: optional(row.unRealizedPnl),
      realised: optional(row.realised),
      holdFee: optional(row.holdFee),
    };
  });
}
/** Only what is still waiting to trigger. A price of zero means that side is not set. */
export function decodeMexcStopOrders(value: unknown): MexcStopOrder[] {
  if (value === null || value === undefined) return [];
  const rows = Array.isArray(value) ? value : array(object(value).resultList);
  return rows.flatMap(item => {
    const row = object(item);
    if (required(row.state) !== 1 || row.isFinished === 1) return [];
    if (row.positionType !== 1 && row.positionType !== 2) throw invalidMexcResponse();
    const price = (raw: unknown) => { const number = optional(raw); return number !== undefined && number > 0 ? number : undefined; };
    return [{
      id: identifier(row.id),
      symbol: text(row.symbol),
      positionId: identifier(row.positionId),
      direction: row.positionType === 1 ? "LONG" as const : "SHORT" as const,
      takeProfitPrice: price(row.takeProfitPrice),
      stopLossPrice: price(row.stopLossPrice),
      vol: required(row.vol),
    }];
  });
}
export function decodeMexcAsset(value: unknown): MexcAsset {
  const row = object(value);
  return {
    currency: text(row.currency),
    equity: required(row.equity),
    availableBalance: required(row.availableBalance),
    // Older responses lack availableOpen; available balance is the stricter reading.
    availableOpen: optional(row.availableOpen) ?? required(row.availableBalance),
    positionMargin: required(row.positionMargin),
    frozenBalance: required(row.frozenBalance),
    unrealized: required(row.unrealized),
  };
}
export function decodeMexcOrder(value: unknown): MexcOrder {
  const row = object(value);
  const takeProfitPrice = optional(row.takeProfitPrice), stopLossPrice = optional(row.stopLossPrice);
  const action = ({ 1: "OPEN_LONG", 2: "CLOSE_SHORT", 3: "OPEN_SHORT", 4: "CLOSE_LONG" } as const)[required(row.side) as 1 | 2 | 3 | 4];
  if (!action) throw invalidMexcResponse();
  const state = required(row.state);
  return {
    id: identifier(row.orderId),
    symbol: text(row.symbol),
    action,
    orderType: optional(row.orderType),
    price: required(row.price),
    vol: required(row.vol),
    dealVol: optional(row.dealVol) ?? 0,
    dealAvgPrice: optional(row.dealAvgPrice),
    leverage: optional(row.leverage),
    openType: optional(row.openType),
    state,
    cancelable: state === 1 || state === 2,
    externalOid: typeof row.externalOid === "string" && row.externalOid ? row.externalOid : undefined,
    profit: optional(row.profit),
    fee: (optional(row.takerFee) ?? 0) + (optional(row.makerFee) ?? 0),
    createdAt: optional(row.createTime),
    updatedAt: optional(row.updateTime),
    ...(takeProfitPrice !== undefined && takeProfitPrice > 0 ? { takeProfitPrice } : {}),
    ...(stopLossPrice !== undefined && stopLossPrice > 0 ? { stopLossPrice } : {}),
  };
}
export function decodeMexcOrderPage(value: unknown): MexcOrder[] {
  const rows = Array.isArray(value) ? value : array(object(value).resultList);
  return rows.map(decodeMexcOrder);
}

const HISTORY: Partial<Record<HistoryRange, { interval: string; span: number }>> = {
  // 1-minute bars are only kept for about 30 days, so nothing asks further back.
  intraday: { interval: "Min1", span: 86_400 },
  fiveDay: { interval: "Min5", span: 5 * 86_400 },
  minute1: { interval: "Min1", span: 86_400 },
  minute5: { interval: "Min5", span: 5 * 86_400 },
  minute15: { interval: "Min15", span: 15 * 86_400 },
  minute30: { interval: "Min30", span: 30 * 86_400 },
  minute60: { interval: "Min60", span: 60 * 86_400 },
  daily: { interval: "Day1", span: 1500 * 86_400 },
  weekly: { interval: "Week1", span: 1500 * 7 * 86_400 },
  monthly: { interval: "Month1", span: 200 * 30 * 86_400 },
};
export function mexcHistoryRequest(range: HistoryRange, nowMilliseconds: number) {
  const entry = Object.hasOwn(HISTORY, range) ? HISTORY[range] : undefined;
  if (!entry) throw mexcError("invalidRange");
  const end = Math.floor(nowMilliseconds / 1000);
  return { interval: entry.interval, start: end - entry.span, end };
}
/** The latest candles and quote, for refreshing an open chart once a second. */
export interface MexcLive {
  symbol: string;
  /** The last two candles, so a candle that just closed still gets its final values. */
  candles: Candle[];
  ticker: MexcTicker;
}
const BAR_SECONDS: Record<string, number> = {
  Min1: 60, Min5: 300, Min15: 900, Min30: 1800, Min60: 3600, Day1: 86_400, Week1: 604_800, Month1: 2_678_400,
};
export function mexcLiveRequest(range: HistoryRange, nowMilliseconds: number) {
  const { interval, end } = mexcHistoryRequest(range, nowMilliseconds);
  return { interval, start: end - Math.ceil(BAR_SECONDS[interval] * 2.5), end };
}
export function decodeMexcHistory(value: unknown, symbol: string): History {
  const row = object(value), time = array(row.time), open = array(row.open), high = array(row.high),
    low = array(row.low), close = array(row.close), volume = array(row.vol);
  if ([open, high, low, close, volume].some(column => column.length !== time.length)) throw invalidMexcResponse();
  const candles: Candle[] = time.map((seconds, index) => ({
    time: positive(seconds) * 1000,
    open: required(open[index]),
    high: required(high[index]),
    low: required(low[index]),
    close: required(close[index]),
    volume: optional(volume[index]),
  }));
  return { symbol, candles: candles.sort((a, b) => a.time - b.time) };
}

const KEY_PERMISSIONS = new Set(["SPOT_ACCOUNT_READ", "CONTRACT_ACCOUNT_READ", "CONTRACT_DEAL_READ", "CONTRACT_DEAL_WRITE"]);
/** What a key may do. An unbound key, or one with anything beyond these, never reaches the order path. */
export function mexcKeyProblem(value: unknown): string | undefined {
  const row = object(value);
  // A body without a status is an error reply, which says nothing about the key.
  if (typeof row.status !== "string") return "keyCheckFailed";
  if (row.status !== "VALID") return "keyInvalid";
  if (typeof row.remainingValidity === "number" && row.remainingValidity === 0) return "keyInvalid";
  if (typeof row.ipWhiteList !== "string") return "keyNotBound";
  const addresses = row.ipWhiteList.split(",").map(item => item.trim()).filter(Boolean);
  if (!addresses.length || addresses.some(item => item === "*" || item === "0.0.0.0" || item === "::" || item.endsWith("/0")))
    return "keyNotBound";
  if (typeof row.permissions !== "string") return "keyPermissions";
  const permissions = row.permissions.split(",").map(item => item.trim().toUpperCase()).filter(Boolean);
  if (permissions.some(item => item.includes("TRANSFER") || item.includes("WITHDRAW"))) return "keyMovesMoney";
  for (const needed of ["CONTRACT_ACCOUNT_READ", "CONTRACT_DEAL_READ", "CONTRACT_DEAL_WRITE"])
    if (!permissions.includes(needed)) return "keyPermissions";
  if (permissions.some(item => !KEY_PERMISSIONS.has(item))) return "keyPermissions";
  return undefined;
}
