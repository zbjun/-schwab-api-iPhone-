import { FINAL_STATUSES, OPEN_STATUSES, TradingError, parsePrice, validSymbol } from "./orderRules.ts";
import type { Broker, Draft, Order, OrderSession, Quote, Side } from "./types.ts";

export interface LocalMarketSettings {
  /** Maximum adverse movement from the initial bid/ask midpoint, including slippage. */
  boundaryPercent: number;
  /** Buy above / sell below each current midpoint by this percentage. */
  slippagePercent: number;
  /** Foreground execution is capped at one hour; cancellation confirmation may take longer. */
  durationSeconds: number;
}

export function validateLocalMarketSettings(settings: LocalMarketSettings): void {
  if (!Number.isFinite(settings.boundaryPercent) || settings.boundaryPercent < 0 || settings.boundaryPercent >= 100)
    throw new TradingError("localMarketBoundary", "价格偏离范围须大于或等于 0%，且小于 100%。");
  if (!Number.isFinite(settings.slippagePercent) || settings.slippagePercent < 0 || settings.slippagePercent > settings.boundaryPercent)
    throw new TradingError("localMarketSlippage", "滑点须大于或等于 0%，且不能超过价格边界。");
  if (!Number.isInteger(settings.durationSeconds) || settings.durationSeconds < 1 || settings.durationSeconds > 3600)
    throw new TradingError("localMarketDuration", "追价时长须为 1 至 3600 秒的整数。");
}

/** Require both sides of the same quote; never substitute last trade or one side. */
export function quoteMidpoint(quote?: Quote): number | undefined {
  const bid = quote?.bidPrice, ask = quote?.askPrice;
  if (bid === undefined || ask === undefined || !Number.isFinite(bid) || !Number.isFinite(ask) ||
    bid <= 0 || ask <= 0 || bid > ask) return undefined;
  return bid + (ask - bid) / 2;
}

interface Request {
  broker: Pick<Broker, "quotes" | "prepare" | "submit" | "orderDetail" | "cancel">;
  accountID: string;
  symbol: string;
  side: Side;
  quantity: number;
  session: OrderSession;
  settings: LocalMarketSettings;
  isDemo: boolean;
  isCurrent: () => boolean;
  shouldStop: () => boolean;
  onProgress: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface OwnedOrder {
  id: string;
  quantity: number;
  price: number;
  filled: number;
  placedAt: number;
  cancelAttempted: boolean;
  identityInvalid: boolean;
  latest?: Order;
}

class Stop extends Error {}

/**
 * Caller holds the shared trade lock, keeps the app foreground, and supplies a sticky
 * stop flag. Only a confirmed CANCELED order can be followed by another submission.
 * Acknowledgements, missing IDs, ambiguous writes and external replacements stop the
 * strategy. The broker retains responsibility for durable ambiguous-write markers.
 */
export async function executeLocalMarket(request: Request): Promise<{
  filledQuantity: number;
  orderIDs: string[];
  message: string;
}> {
  const { broker, accountID, symbol, side, quantity, session, isDemo, isCurrent, shouldStop, onProgress } = request;
  const settings = Object.freeze({ ...request.settings });
  validateLocalMarketSettings(settings);
  if (!validSymbol(symbol) || !["BUY", "SELL"].includes(side) || !Number.isSafeInteger(quantity) || quantity <= 0)
    throw new TradingError("localMarketQuantity", "本地市价单需要有效股票代码和正整数股数。");
  if (!["NORMAL", "AM", "PM", "SEAMLESS"].includes(session))
    throw new TradingError("localMarketSession", "交易时段无效。");
  const clock = request.now ?? Date.now;
  let lastTime = clock();
  let clockRegressed = !Number.isFinite(lastTime);
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value) || value < lastTime) clockRegressed = true;
    else lastTime = value;
    return lastTime;
  };
  const sleep = request.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + settings.durationSeconds * 1000;
  const ids: string[] = [];
  let completed = 0;
  let active: OwnedOrder | undefined;
  let submitting = false;
  let boundary: number | undefined;

  function permitted(): void {
    now();
    if (clockRegressed) throw new Stop("设备时间发生变化，已停止追价。");
    if (!isCurrent()) throw new Stop("账户或订单内容已变化，已停止追价。");
    if (shouldStop()) throw new Stop("已停止追价。");
    if (now() >= deadline) throw new Stop("已达到追价时长，已停止追价。");
  }

  function executable(quote: Quote | undefined): number {
    if (!quote || quote.symbol !== symbol) throw new Stop("未取得该股票的买卖报价，已停止追价。");
    const age = now() - (quote.quoteTime ?? Number.NaN);
    if (!isDemo && (quote.isRealtime !== true || !Number.isFinite(age) || age < -2000 || age > 10000))
      throw new Stop("买卖报价超过 10 秒或并非实时，已停止追价。");
    const raw = quoteMidpoint(quote);
    if (raw === undefined)
      throw new Stop("买卖双边报价缺失或异常，无法计算中间价，已停止追价。");
    return raw;
  }

  function priceFor(raw: number): number {
    const target = raw * (1 + (side === "BUY" ? 1 : -1) * settings.slippagePercent / 100);
    // Stock prices >= $1 use cents; sub-dollar prices use four decimal places.
    const scale = target >= 1 ? 100 : 10000;
    const units = side === "BUY" ? Math.ceil(target * scale - 1e-8) : Math.floor(target * scale + 1e-8);
    const price = units / scale;
    if (!parsePrice(price.toFixed(4)) || boundary === undefined ||
      (side === "BUY" ? price > boundary + 1e-10 : price < boundary - 1e-10))
      throw new Stop("报价已超出设定价格边界，已停止追价。");
    return price;
  }

  async function nextPrice(): Promise<number> {
    permitted();
    const quotes = await broker.quotes([symbol], { fundamentals: false });
    permitted();
    const raw = executable(quotes.find((quote) => quote.symbol === symbol));
    if (boundary === undefined) {
      boundary = raw * (1 + (side === "BUY" ? 1 : -1) * settings.boundaryPercent / 100);
      onProgress(`本地市价执行中 · ${side === "BUY" ? "最高买价" : "最低卖价"} ${boundary.toFixed(4)} · 最多 ${settings.durationSeconds} 秒`);
    }
    return priceFor(raw);
  }

  async function readOwned(order: OwnedOrder): Promise<Order> {
    const detail = await broker.orderDetail(accountID, order.id);
    if (detail.id !== order.id || detail.symbol !== symbol || detail.side !== side || detail.quantity !== order.quantity || detail.kind !== "LIMIT") {
      order.identityInvalid = true;
      throw new Stop("委托身份无法核对，已停止追价；请在订单页核对。");
    }
    const filled = detail.filledQuantity;
    const remaining = detail.remainingQuantity;
    const terminal = FINAL_STATUSES.has(detail.status);
    if (filled === undefined || !Number.isFinite(filled) || filled < order.filled || filled > order.quantity ||
      remaining === undefined || !Number.isFinite(remaining) || remaining < 0 || remaining > order.quantity - filled ||
      (!terminal && filled + remaining !== order.quantity) ||
      (detail.status === "FILLED" && filled !== order.quantity))
      throw new Stop("委托成交数量无法核对，已停止追价；请在订单页核对。");
    order.filled = filled;
    order.latest = detail;
    return detail;
  }

  function finishOwned(order: OwnedOrder): void {
    completed += order.filled;
    active = undefined;
  }

  /** Returns true only for confirmed FILLED/CANCELED, never just a DELETE response. */
  async function cancelAndConfirm(order: OwnedOrder): Promise<boolean> {
    if (order.identityInvalid) return false;
    if (order.latest?.status === "FILLED" || order.latest?.status === "CANCELED") return true;
    if (order.latest && FINAL_STATUSES.has(order.latest.status)) return false;
    let ambiguousCancel = false;
    if (!order.cancelAttempted) {
      order.cancelAttempted = true;
      onProgress(`正在撤销剩余委托 #${order.id}，等待确认；勿重复提交。`);
      try {
        await broker.cancel(accountID, order.id);
      } catch (error) {
        // A definite rejection may be a FILLED/cancel race; read to establish it.
        // Unknown outcomes must never permit another child order, even after reads.
        ambiguousCancel = !(error instanceof TradingError && error.httpStatus !== undefined &&
          error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408);
      }
    }
    const confirmUntil = now() + 15000;
    let attempts = 0;
    do {
      attempts++;
      try {
        const detail = await readOwned(order);
        if (detail.status === "FILLED" || detail.status === "CANCELED") return !ambiguousCancel;
        if (FINAL_STATUSES.has(detail.status) || order.identityInvalid) return false;
      } catch {
        if (order.identityInvalid) return false;
      }
      await sleep(1000);
    } while (now() < confirmUntil && attempts < 15);
    return false;
  }

  function result(message: string) {
    const filled = completed + (active?.filled ?? 0);
    const receipt = ids.length ? ` 委托：${ids.map((id) => `#${id}`).join("、")}。` : "";
    const output = { filledQuantity: filled, orderIDs: [...ids], message: `${message} 已核对成交 ${filled}/${quantity} 股。${receipt}` };
    onProgress(output.message);
    return output;
  }

  try {
    let price = await nextPrice();
    while (completed < quantity) {
      permitted();
      const remaining = quantity - completed;
      if (!Number.isSafeInteger(remaining)) throw new Stop("剩余数量不是整股，已停止追价，请手动核对。");
      const draft: Draft = Object.freeze({ symbol, side, quantity: remaining, kind: "LIMIT", limitPrice: price.toFixed(price >= 1 ? 2 : 4), duration: "DAY", session });
      const prepared = await broker.prepare(accountID, draft);
      permitted();
      if (prepared.accountID !== accountID || prepared.isDemo !== isDemo ||
        prepared.draft.symbol !== symbol || prepared.draft.side !== side || prepared.draft.quantity !== remaining ||
        prepared.draft.kind !== "LIMIT" || prepared.draft.limitPrice !== draft.limitPrice ||
        prepared.draft.duration !== "DAY" || prepared.draft.session !== session)
        throw new Stop("订单核对内容已变化，已停止追价。");
      const age = now() - prepared.preparedAt;
      if (!Number.isFinite(age) || age < 0 || age > 60000) throw new Stop("订单核对已失效，已停止追价。");
      priceFor(executable(prepared.quote));
      permitted();
      submitting = true;
      const submission = await broker.submit(prepared);
      if (!submission.orderID || !/^[A-Za-z0-9_-]{1,64}$/.test(submission.orderID))
        throw new Stop("提交结果缺少委托编号，结果待核对；已停止，不会重复提交。");
      submitting = false;
      if (ids.includes(submission.orderID)) throw new Stop("委托编号重复，结果待核对；已停止，不会重复提交。");
      ids.push(submission.orderID);
      active = { id: submission.orderID, quantity: remaining, price, filled: 0, placedAt: now(), cancelAttempted: false, identityInvalid: false };
      onProgress(`本地市价执行中 · 委托 #${active.id} · 限价 ${draft.limitPrice} · 剩余 ${remaining} 股`);

      while (active) {
        const detail = await readOwned(active);
        if (detail.status === "FILLED") {
          finishOwned(active);
          return result("本地市价单已全部成交。");
        }
        if (FINAL_STATUSES.has(detail.status)) {
          finishOwned(active);
          return result(`委托已结束（${detail.status}），已停止追价。`);
        }
        if (!OPEN_STATUSES.has(detail.status) || ["PENDING_REPLACE", "AWAITING_REPLACEMENT"].includes(detail.status))
          throw new Stop("委托状态发生变化，已停止追价。");
        permitted();
        await sleep(Math.min(1000, Math.max(1, deadline - now())));
        price = await nextPrice();
        // A resting buy above / sell below the new target is already more aggressive.
        if (side === "BUY" ? price <= active.price : price >= active.price) continue;
        // Each chase needs two writes; cap replacement cycles at one per two seconds.
        if (now() - active.placedAt < 2000) continue;
        if (!detail.cancelable) throw new Stop("当前委托暂不可撤，已停止追价。");
        const owned = active;
        if (!(await cancelAndConfirm(owned))) return result("撤单结果仍待核对，已停止追价；剩余委托可能仍有效，请在订单页核对，勿重复提交。");
        const terminal = owned.latest?.status;
        finishOwned(owned);
        if (terminal === "FILLED" || completed === quantity) return result("本地市价单已全部成交。");
        permitted();
        price = await nextPrice();
      }
    }
    return result("本地市价单已全部成交。");
  } catch (error) {
    const reason = error instanceof Stop || error instanceof TradingError ? error.message : "执行请求失败，已停止追价。";
    if (submitting) return result(`${reason} 提交结果待核对；请在订单页核对，勿重复提交。`);
    if (active) {
      const owned = active;
      if (owned.latest && FINAL_STATUSES.has(owned.latest.status)) {
        finishOwned(owned);
        return result(`${reason} 委托已结束（${owned.latest.status}）。`);
      }
      if (await cancelAndConfirm(owned)) {
        const status = owned.latest?.status;
        finishOwned(owned);
        return result(`${reason} ${status === "FILLED" ? "原委托已成交。" : "剩余委托已确认撤销。"}`);
      }
      return result(`${reason} 撤单结果仍待核对；委托 #${owned.id} 可能仍有效，请在订单页核对，勿重复提交。`);
    }
    return result(reason);
  }
}
