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
  orderOutcomeUnknown: "这笔委托的结果未确认，交易已锁定，请先在 MEXC 核实，勿重复提交。",
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
      Object.keys(row).some(key => !["symbol", "action", "kind", "vol", "price", "leverage"].includes(key)))
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
  } else if (draft.leverage !== undefined) throw mexcError("invalidDraft");
}
export function freezeMexcDraft(draft: MexcDraft): MexcDraft {
  return Object.freeze({
    symbol: draft.symbol,
    action: draft.action,
    kind: draft.kind,
    vol: canonicalDecimal(draft.vol),
    ...(draft.price === undefined ? {} : { price: canonicalDecimal(draft.price) }),
    ...(draft.leverage === undefined ? {} : { leverage: draft.leverage }),
  });
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

/**
 * Built by hand so the signed text carries exact decimals and full-length ids.
 * Every interpolated value has already passed a strict format check.
 */
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
  return `{${fields.join(",")}}`;
}
/** Bare digits, never Number: order ids do not fit in a double. */
export function encodeMexcCancel(orderID: string): string {
  if (!validMexcOrderID(orderID)) throw mexcError("invalidOrderIdentifier");
  return `[${orderID}]`;
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
  9070: "isolatedUnavailable", 9071: "isolatedUnavailable", 300002: "regionRejected",
};
export type MexcOutcome =
  | { kind: "accepted"; data: unknown }
  | { kind: "rejected"; code: string; exchangeCode?: number }
  | { kind: "unknown" };
export function classifyMexcResponse(status: number, body: string): MexcOutcome {
  let envelope: Record<string, unknown> | undefined;
  try {
    const parsed = parseLossless(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) envelope = parsed as Record<string, unknown>;
  } catch { /* A body that cannot be read says nothing about the order. */ }
  if (status >= 500 || status === 408) return { kind: "unknown" };
  // A named code decides whatever the status: a listed refusal, or unknown for anything else.
  const code = envelope?.code;
  if (envelope?.success === false || (status >= 400 && code !== undefined)) {
    if (typeof code === "number" && Object.hasOwn(DEFINITE_REJECTIONS, code))
      return { kind: "rejected", code: DEFINITE_REJECTIONS[code], exchangeCode: code };
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
