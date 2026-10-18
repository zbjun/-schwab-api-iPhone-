import type { Account, Broker, Candle, Draft, History, HistoryRange, Order, Prepared, Quote, ScheduledOrder, SessionStatus, Vault } from "./types.ts";
import type { MarketStreamCallbacks } from "./marketStream.ts";
import type { FetchTransport } from "./broker.ts";
import { TradingError, validateDraft } from "./orderRules.ts";

const CONNECTION = "ths.server.connection.v1";
const OPERATION = "ths.server.operation.v1";
const MAX_BODY = 8 * 1024 * 1024;
interface Configuration { origin: string; deviceKey: string }
const failure = (code: string, message: string) => new TradingError(code, message);
class KnownRejection extends TradingError {}
export function serverOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw failure("serverAddress", "请输入完整的 HTTPS 服务器地址。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw failure("serverAddress", "服务器地址必须是 HTTPS 域名，可含端口，不能包含路径、账号或查询参数。");
  return url.origin;
}

/** Device credentials are independent of Schwab credentials. Never retries RPC writes. */
export class ServerBroker implements Broker {
  private readonly vault: Vault;
  private readonly transport: FetchTransport;
  private readonly timeout: number;
  private writing = false;
  private configuring = false;
  private generation = 0;
  private stopMarket?: () => void;
  private marketRelease: Promise<unknown> = Promise.resolve();
  private stopActivity?: () => void;
  private activityRelease: Promise<unknown> = Promise.resolve();
  private requestSequence = 0;
  constructor(vault: Vault, options: { fetch?: FetchTransport; timeoutMilliseconds?: number } = {}) {
    this.vault = vault;
    this.transport = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeout = options.timeoutMilliseconds ?? 30_000;
  }
  private async config(): Promise<Configuration | null> {
    const stored = await this.vault.get(CONNECTION);
    if (!stored) return null;
    try {
      const data = JSON.parse(stored);
      if (typeof data.deviceKey !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(data.deviceKey)) throw new Error();
      return { origin: serverOrigin(data.origin), deviceKey: data.deviceKey };
    } catch { throw failure("serverConfiguration", "本机服务器配置无效，请重新保存设备连接。"); }
  }
  async configuration(): Promise<{ origin: string } | null> {
    const value = await this.config();
    return value ? { origin: value.origin } : null;
  }
  async configureServer(origin: string, deviceKey: string): Promise<void> {
    if (this.writing || this.configuring) throw failure("operationBusy", "设备配置或交易请求正在处理中。");
    const normalized = serverOrigin(origin);
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(deviceKey.trim())) throw failure("serverDeviceKey", "请输入服务器生成的设备访问密钥。");
    this.configuring = true;
    try {
      this.stopMarket?.();
      this.stopActivity?.();
      await Promise.all([this.marketRelease, this.activityRelease]);
      await this.vault.set(CONNECTION, JSON.stringify({ origin: normalized, deviceKey: deviceKey.trim() }));
      ++this.generation;
    } finally { this.configuring = false; }
  }
  async configure(): Promise<void> { throw failure("serverManaged", "Schwab 应用配置由服务器管理，无需在手机填写。"); }
  private async rpc<T>(method: string, args: unknown[] = [], request?: { path: string; body?: unknown; signal?: AbortSignal; method?: "POST" | "DELETE"; timeout?: number }): Promise<T> {
    const generation = this.generation;
    const config = await this.config();
    if (!config) throw failure("serverConfiguration", "请先保存服务器地址和本机设备密钥。");
    if (generation !== this.generation) throw failure("sessionChanged", "设备连接已变化，请重新操作。");
    const controller = new AbortController();
    const abort = () => controller.abort();
    request?.signal?.addEventListener("abort", abort, { once: true });
    if (request?.signal?.aborted) controller.abort();
    const endpoint = `${config.origin}${request?.path ?? "/rpc"}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    try {
      const work = async () => {
        const response = await this.transport(endpoint, {
          method: request?.method ?? "POST", redirect: "error", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.deviceKey}` },
          body: request?.method === "DELETE" ? undefined : JSON.stringify(request?.body ?? { method, args }),
        });
        if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== endpoint)
          throw failure("serverRedirect", "服务器返回了非预期跳转，请检查连接地址。");
        if (Number(response.headers.get("content-length")) > MAX_BODY) throw new Error();
        const body = await response.text();
        if (new TextEncoder().encode(body).length > MAX_BODY) throw new Error();
        if (generation !== this.generation) throw failure("sessionChanged", "设备连接已变化，请重新操作。");
        if (response.status === 401 || response.status === 403)
          throw new KnownRejection("serverDeviceUnauthorized", "设备访问密钥已失效或无权限，请检查服务器中的设备配置；无需重新登录 Schwab。");
        const envelope = JSON.parse(body);
        if (envelope?.error) {
          // Only expose local, known messages; gateway text may contain upstream secrets.
          const messages: Record<string, string> = {
            authorizationRequired: "服务器尚未授权 Schwab，请由一台设备完成授权。",
            authorizationExpired: "本次授权链接已过期或已使用，请重新发起授权，不要重复打开旧链接。",
            authorizationDeclined: "Schwab 授权未获同意，请重新发起授权并完成账户选择。",
            invalidCallback: "授权回调与本次登录不匹配，请使用最新授权链接完成登录。",
            authorizationConfiguration: "服务器的 Schwab 应用配置无效，请检查 Client ID 和 Secret；反复登录无法解决。",
            authorizationPermission: "Schwab 未允许访问此接口，请检查应用 API 权限；无需反复登录。",
            alreadyAuthenticated: "服务器已完成 Schwab 授权，请刷新连接状态。",
            methodNotAllowed: "服务器尚不支持此操作，请先更新服务器。",
            orderOutcomeUnknown: "服务器有尚未确认的交易，请先核实订单，勿重复提交。",
            reviewExpired: "订单核对已过期，请重新核对。",
            operationBusy: "服务器正在处理另一笔交易，请等待结果。",
            insufficientShares: "可卖股数不足，请刷新账户和订单。",
            insufficientFunds: "购买力不足，请刷新账户并调整数量。",
            takeProfit: "止盈价无效，或没有高于当前价格／买入限价，请调整。",
            stopLoss: "止损无效，或止损价没有低于当前价格／买入限价（会立即触发），请调整。",
            exitQuote: "暂时缺少可用的买卖报价，无法核对止盈止损。",
            exitOrder: "止盈价必须高于止损价。",
            exitSession: "止盈止损仅支持常规时段。",
            exitEntry: "仅限价或市价买入可以附带止盈止损。",
            exitMissing: "请设置止盈价或止损。",
            scheduleTime: "定时单执行时间须在 5 秒之后、7 天之内。",
            scheduleLimit: "待执行的定时单已达上限，请先撤销部分定时单。",
            scheduleMissing: "定时单不存在，请刷新。",
            scheduleChanged: "定时单已执行或已结束，无法撤销。",
          };
          const code = typeof envelope.error.code === "string" && /^[A-Za-z]{1,64}$/.test(envelope.error.code) ? envelope.error.code : "serverRejected";
          const ErrorType = response.status === 400 && code !== "orderOutcomeUnknown" ? KnownRejection : TradingError;
          throw new ErrorType(code, messages[code] ?? "服务器未能完成请求，请检查服务器状态并刷新。");
        }
        if (!response.ok || !envelope || !("result" in envelope)) throw new Error();
        return envelope.result as T;
      };
      return await Promise.race([new Promise<T>((_, reject) => {
        rejectAbort = () => reject(failure("serverUnavailable", "服务器连接已取消。"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      }), work(), new Promise<T>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(failure("serverUnavailable", "服务器连接超时，请检查网络；无需重新授权 Schwab。")); }, request?.timeout ?? this.timeout);
      })]);
    } catch (error) {
      if (error instanceof TradingError) throw error;
      throw failure("serverUnavailable", "无法连接服务器或响应无效，请检查网络和服务器；无需重新授权 Schwab。");
    } finally {
      if (timer) clearTimeout(timer);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
      request?.signal?.removeEventListener("abort", abort);
    }
  }
  async status(): Promise<SessionStatus> {
    if (!await this.config()) return { configured: false, authenticated: false, unresolvedOperation: !!await this.vault.get(OPERATION) };
    const value = await this.rpc<SessionStatus>("status");
    if (!value || typeof value.authenticated !== "boolean" || typeof value.configured !== "boolean" || typeof value.unresolvedOperation !== "boolean")
      throw failure("serverUnavailable", "服务器状态响应无效。");
    return { ...value, unresolvedOperation: value.unresolvedOperation || !!await this.vault.get(OPERATION) };
  }
  async authorizationURL(): Promise<string> {
    const value = await this.rpc<string>("authorizationURL");
    const url = new URL(value);
    if (url.origin !== "https://api.schwabapi.com" || url.pathname !== "/v1/oauth/authorize") throw failure("serverAuthorization", "服务器返回了非官方授权地址。");
    return value;
  }
  completeAuthorization(callback: string) { return this.rpc<void>("completeAuthorization", [callback]); }
  async disconnect(): Promise<void> {
    if (this.writing || this.configuring) throw failure("operationBusy", "设备配置或交易请求正在处理中。");
    this.configuring = true;
    try {
      this.stopMarket?.();
      this.stopActivity?.();
      await Promise.all([this.marketRelease, this.activityRelease]);
      await this.vault.remove(CONNECTION);
      ++this.generation;
    } finally { this.configuring = false; }
    // Preserve unresolved marker across disconnect/reconfiguration. Never sign out other devices.
  }
  async acknowledgeReconciliation(): Promise<void> {
    if (this.writing || this.configuring) throw failure("operationBusy", "设备配置或交易请求正在处理中。");
    this.writing = true;
    try {
      const status = await this.rpc<SessionStatus>("status");
      if (status.unresolvedOperation !== false) throw failure("orderOutcomeUnknown", "服务器交易锁定尚未解除，请先在服务器核实该笔订单。");
      await this.vault.remove(OPERATION);
    } finally { this.writing = false; }
  }
  accounts() { return this.rpc<Account[]>("accounts"); }
  quotes(symbols: string[], options?: { fundamentals?: boolean }) { return this.rpc<Quote[]>("quotes", options === undefined ? [symbols] : [symbols, options]); }
  history(symbol: string, range: HistoryRange) { return this.rpc<History>("history", [symbol, range]); }
  orders(accountID: string) { return this.rpc<Order[]>("orders", [accountID]); }
  orderHistory(accountID: string, from: number, to: number) { return this.rpc<Order[]>("orderHistory", [accountID, from, to]); }
  orderDetail(accountID: string, id: string) { return this.rpc<Order>("orderDetail", [accountID, id]); }
  /**
   * A gateway without exit support would drop the take-profit/stop-loss legs and
   * place a plain order. Timed orders shipped together with exits, so a gateway
   * that answers `scheduled` understands them; ask before anything is written.
   */
  private async requireExitSupport(draft: Draft): Promise<void> {
    if (draft.exit === undefined && draft.kind !== "EXIT") return;
    try {
      await this.rpc<unknown>("scheduled");
    } catch (error) {
      if (error instanceof TradingError && error.code === "methodNotAllowed")
        throw failure("exitUnsupported", "服务器尚未更新，暂不能下止盈止损单；本次未提交订单。");
      throw error;
    }
  }
  async prepare(accountID: string, draft: Draft, replacementID?: string): Promise<Prepared> {
    validateDraft(draft); // Precise local messages before anything is sent.
    await this.requireExitSupport(draft);
    // UI expiry is measured on the device clock; the server separately enforces
    // its own one-use review deadline. Comparing the two wall clocks can reject
    // a freshly prepared quick order before submit is ever called.
    const startedAt = Date.now();
    const prepared = await this.rpc<Prepared>("prepare", replacementID === undefined ? [accountID, draft] : [accountID, draft, replacementID]);
    if (!prepared || !Number.isFinite(prepared.preparedAt) || typeof prepared.id !== "string" || !prepared.id)
      throw failure("serverUnavailable", "服务器返回的订单核对信息无效，本次未提交订单。");
    // A review that lost the exit legs must never be confirmed as a plain order.
    if (draft.exit !== undefined && !prepared.draft?.exit)
      throw failure("exitUnsupported", "服务器核对结果缺少止盈止损，本次未提交订单，请先更新服务器。");
    return { ...prepared, preparedAt: startedAt };
  }
  subscribeMarket(symbol: string, callbacks: MarketStreamCallbacks): () => void {
    if (this.configuring) { callbacks.onStatus("fallback"); return () => {}; }
    this.stopMarket?.();
    const previousRelease = this.marketRelease;
    const controller = new AbortController();
    const generation = this.generation;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: number | undefined;
    let inFlight: Promise<void> = Promise.resolve();
    let retry = 1000;
    const active = () => !stopped && generation === this.generation;
    const poll = async () => {
      if (!active()) return;
      try {
        const value = await this.rpc<{ cursor: number; status: "connecting" | "live" | "fallback"; quote?: Parameters<MarketStreamCallbacks["onQuote"]>[0]; formingCandles: Candle[]; candles: Candle[] }>("market", [], {
          path: "/market", body: { symbol, cursor, waitMs: 20_000 }, signal: controller.signal, timeout: Math.max(25_000, this.timeout),
        });
        if (!active()) return;
        if (!value || !Number.isSafeInteger(value.cursor) || !["connecting", "live", "fallback"].includes(value.status) || !Array.isArray(value.formingCandles) || !Array.isArray(value.candles)) throw new Error();
        cursor = value.cursor;
        retry = 1000;
        callbacks.onStatus(value.status);
        if (active() && value.quote?.symbol === symbol) callbacks.onQuote(value.quote);
        value.formingCandles.forEach(candle => { if (active()) callbacks.onFormingCandle?.(candle); });
        value.candles.forEach(candle => { if (active()) callbacks.onCandle(candle); });
        // Small floor prevents a faulty server from turning an empty long poll into a hot loop.
        if (active()) timer = setTimeout(startPoll, 100);
      } catch {
        if (!active()) return;
        callbacks.onStatus("fallback");
        timer = setTimeout(startPoll, retry);
        retry = Math.min(10_000, retry * 2);
      }
    };
    const startPoll = () => { inFlight = poll(); };
    callbacks.onStatus("connecting");
    inFlight = previousRelease.then(() => { if (active()) return poll(); });
    const stop = () => {
      if (stopped) return;
      stopped = true; controller.abort(); if (timer) clearTimeout(timer);
      // Release before the next symbol subscribes, so an old DELETE cannot remove its subscription.
      this.marketRelease = inFlight.catch(() => {}).then(() => this.rpc("releaseMarket", [], { path: "/market", method: "DELETE", timeout: 5000 })).catch(() => {});
      if (this.stopMarket === stop) this.stopMarket = undefined;
    };
    this.stopMarket = stop;
    return stop;
  }
  subscribeAccountActivity(onChange: () => void, onStatus?: (status: "connecting" | "live" | "fallback") => void): () => void {
    if (this.configuring) { onStatus?.("fallback"); return () => {}; }
    this.stopActivity?.();
    const previousRelease = this.activityRelease;
    const controller = new AbortController();
    const generation = this.generation;
    let stopped = false;
    let cursor: number | undefined;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> = Promise.resolve();
    const active = () => !stopped && generation === this.generation;
    const poll = async () => {
      if (!active()) return;
      try {
        const value = await this.rpc<{ cursor: number; status: "connecting" | "live" | "fallback" }>("activity", [], {
          path: "/activity", body: { cursor, waitMs: 20_000 }, signal: controller.signal, timeout: Math.max(25_000, this.timeout),
        });
        if (!active()) return;
        if (!value || !Number.isSafeInteger(value.cursor) || value.cursor < 0 || !["connecting", "live", "fallback"].includes(value.status)) throw new Error();
        // Also reconcile after a server restart resets the cursor. A first poll
        // establishes the baseline; normal UI loading already fetches account data.
        const changed = cursor !== undefined && value.cursor !== cursor;
        cursor = value.cursor;
        retry = 1000;
        onStatus?.(value.status);
        if (active() && changed) onChange();
        if (active()) timer = setTimeout(startPoll, 100);
      } catch {
        if (!active()) return;
        onStatus?.("fallback");
        if (active()) timer = setTimeout(startPoll, retry);
        retry = Math.min(10_000, retry * 2);
      }
    };
    const startPoll = () => { inFlight = poll(); };
    onStatus?.("connecting");
    inFlight = previousRelease.then(() => { if (active()) return poll(); });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      this.activityRelease = inFlight.catch(() => {}).then(() => this.rpc("releaseActivity", [], { path: "/activity", method: "DELETE", timeout: 5000 })).catch(() => {});
      if (this.stopActivity === stop) this.stopActivity = undefined;
    };
    this.stopActivity = stop;
    return stop;
  }
  private async write<T>(method: string, args: unknown[], validate?: (result: T) => T): Promise<T> {
    if (this.writing || this.configuring) throw failure("operationBusy", "设备配置或交易请求正在处理中。");
    this.writing = true;
    try {
      if (await this.vault.get(OPERATION)) throw failure("orderOutcomeUnknown", "本机上次交易结果未确认，请先核实订单，勿重复提交。");
      if (!await this.config()) throw failure("serverConfiguration", "请先连接服务器。");
      await this.vault.set(OPERATION, JSON.stringify({ method, time: Date.now() }));
      let result: T;
      try {
        result = await this.rpc<T>(method, args);
        if (validate) result = validate(result);
      }
      catch (error) { if (error instanceof KnownRejection) await this.vault.remove(OPERATION); throw error; }
      await this.vault.remove(OPERATION);
      return result;
    } finally { this.writing = false; }
  }
  submit(prepared: Prepared) { return this.write<{ orderID?: string }>("submit", [{ id: prepared.id }]); }
  async submitQuick(accountID: string, draft: Draft): Promise<{ snapshot: Prepared; result: { orderID?: string } }> {
    await this.requireExitSupport(draft);
    const startedAt = Date.now();
    // Correlation/replay identifier, not an authentication credential. Device
    // authentication remains the independent vault-backed bearer key.
    const requestID = `${startedAt.toString(36)}-${++this.requestSequence}-${Math.random().toString(36).slice(2).padEnd(12, "0")}-${Math.random().toString(36).slice(2).padEnd(12, "0")}`;
    const submittedDraft = { ...draft, session: draft.session ?? "NORMAL" };
    return this.write("submitQuick", [accountID, submittedDraft, requestID], (value: { snapshot: Prepared; result: { orderID?: string } }) => {
      const snapshot = value?.snapshot, result = value?.result;
      const draftKeys: (keyof Draft)[] = ["symbol", "side", "kind", "quantity", "limitPrice", "stopPrice", "duration", "session"];
      const exit = snapshot?.draft?.exit, sent = submittedDraft.exit;
      const exitMatches = exit === undefined ? sent === undefined
        : !!sent && exit.takeProfit === sent.takeProfit && exit.duration === sent.duration &&
          exit.stopLoss?.mode === sent.stopLoss?.mode && exit.stopLoss?.value === sent.stopLoss?.value;
      const matches = snapshot?.draft && exitMatches && draftKeys.every(key => snapshot.draft[key] === submittedDraft[key]);
      if (!snapshot || typeof snapshot.id !== "string" || !snapshot.id || snapshot.accountID !== accountID || snapshot.isDemo !== false ||
          !Number.isFinite(snapshot.preparedAt) || typeof snapshot.accountDisplay !== "string" || snapshot.quote?.symbol !== submittedDraft.symbol ||
          !Number.isFinite(snapshot.availableShares) || snapshot.availableShares < 0 || !matches ||
          !result || typeof result !== "object" || Array.isArray(result) ||
          (result.orderID !== undefined && (typeof result.orderID !== "string" || !result.orderID || result.orderID.length > 128)))
        throw failure("orderOutcomeUnknown", "服务器交易回执无效，请先核实订单，勿重复提交。");
      return { snapshot: Object.freeze({ ...snapshot, draft: Object.freeze({ ...snapshot.draft }), preparedAt: startedAt }), result };
    });
  }
  cancel(accountID: string, orderID: string) { return this.write<void>("cancel", [accountID, orderID]); }
  schedule(accountID: string, draft: Draft, runAt: number, id: string) {
    validateDraft(draft);
    // The client-chosen ID makes a retried request return the same entry, never a second order.
    return this.rpc<ScheduledOrder>("schedule", [accountID, { ...draft, session: draft.session ?? "NORMAL" }, runAt, id]);
  }
  scheduled() { return this.rpc<ScheduledOrder[]>("scheduled"); }
  cancelScheduled(id: string) { return this.rpc<ScheduledOrder>("cancelScheduled", [id]); }
}
