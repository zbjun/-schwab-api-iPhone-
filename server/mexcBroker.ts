import { createHmac, randomBytes } from "node:crypto";
import { TradingError } from "../mobile/src/orderRules.ts";
import {
  DEFINITE_REJECTIONS, LEVERAGE_REJECTIONS, MEXC_ACCOUNT, MEXC_REVIEW_TTL, STOP_REJECTIONS, cancelOutcome, classifyMexcResponse, createdOrderID,
  decodeMexcAsset, decodeMexcContract, decodeMexcHistory, decodeMexcOrder, decodeMexcOrderPage,
  decodeMexcPositions, decodeMexcStopOrders, decodeMexcTicker, encodeMexcCancel, encodeMexcLeverage, encodeMexcOrder, encodeMexcStop, freezeMexcDraft, freezeMexcLeverageDraft, freezeMexcStopDraft,
  invalidMexcResponse, isLeverageDraft, isOpening, isStopDraft, mexcError, mexcHistoryRequest, mexcLiveRequest, mexcKeyProblem, mexcStopPath, parseLossless, planMexcLeverage, planMexcOrder, planMexcStop, planMexcStopCancel, stopOutcome,
  validMexcOrderID, validMexcSymbol, validateMexcDraft, validateMexcLeverageDraft, validateMexcLimits, validateMexcStopDraft,
} from "../mobile/src/mexcRules.ts";
import type {
  MexcAccount, MexcContract, MexcDraft, MexcLeverageContext, MexcLeverageDraft, MexcLeveragePrepared, MexcLimits, MexcLive, MexcOrder, MexcOrderContext, MexcOrderPlan,
  MexcPosition, MexcPrepared, MexcStopContext, MexcStopDraft, MexcStopOrder, MexcStopPlan, MexcStopPrepared, MexcTicker,
} from "../mobile/src/mexcRules.ts";
import type { HistoryRange, History, SessionStatus, Vault } from "../mobile/src/types.ts";

const ORIGIN = "https://api.mexc.com";
const OPERATION_KEY = "ths.mexc.operation.v1";
const TIMEOUT = 15_000;
// A submit must finish inside the app's 30-second wait, so its reads get less time than the send.
const SUBMIT_READ_TIMEOUT = 6_000;
const SUBMIT_BUDGET = 12_000;
const MAX_BODY = 8 * 1024 * 1024;
const KEY_CHECK_TTL = 10 * 60_000;
const CONTRACTS_TTL = 60_000;
const TICKERS_TTL = 2_000;
// Shared by devices watching the same chart, so two phones cost one pair of reads.
const LIVE_TTL = 800;
const LIVE_READ_TIMEOUT = 3_000;
const MAX_LIVE_ENTRIES = 32;
const LIVE_PAUSE_MIN = 10_000;
const LIVE_PAUSE_MAX = 120_000;
const MAX_SYMBOLS = 100;
const HISTORY_WINDOW_DAYS = 90;

type Transport = (url: string, init: RequestInit) => Promise<Response>;
interface Marker {
  operation: "create" | "cancel" | "leverage" | "stop";
  symbol?: string; externalOid?: string; orderID?: string; positionId?: string; leverage?: number; previousLeverage?: number;
  stopKind?: MexcStopDraft["kind"]; stopOrderId?: string; takeProfitPrice?: string; stopLossPrice?: string;
}
export interface MexcBrokerOptions {
  apiKey: string;
  apiSecret: string;
  limits: MexcLimits;
  /**
   * Reading the key's own settings needs spot account read access. An owner who leaves that off
   * sets this to false and takes over the check by hand: IP binding and no transfer permission.
   */
  keyCheck?: boolean;
  fetch?: Transport;
  now?: () => number;
  timeoutMilliseconds?: number;
}

const unknownOutcome = () => mexcError("orderOutcomeUnknown");
const reviewExpired = () => mexcError("reviewExpired");
const busy = () => mexcError("operationBusy");

/** Holds the MEXC key on the server. Reads may fail freely; writes follow one fixed path. */
export class MexcBroker {
  readonly limits: Readonly<MexcLimits>;
  private readonly apiKey: string;
  private readonly secret: string;
  private readonly vault: Vault;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly keyCheckEnabled: boolean;
  private readonly reviews = new Map<string, MexcPrepared | MexcLeveragePrepared | MexcStopPrepared>();
  private prepareSequence = 0;
  private writeBusy = false;
  private unresolved = false;
  private keyCheck?: { at: number; problem?: string };
  private contractList?: { at: number; value: MexcContract[] };
  private tickerList?: { at: number; value: MexcTicker[] };
  private readonly liveCache = new Map<string, { at: number; value: Promise<MexcLive> }>();
  private livePause = 0;
  private livePausedUntil = 0;

  constructor(vault: Vault, options: MexcBrokerOptions) {
    if (typeof options.apiKey !== "string" || !options.apiKey || typeof options.apiSecret !== "string" || !options.apiSecret ||
        options.apiKey === "REPLACE_ON_SERVER" || options.apiSecret === "REPLACE_ON_SERVER")
      throw new Error("MEXC API key is not configured");
    validateMexcLimits(options.limits);
    // Only a real false turns it off, so a typo such as "false" in the config cannot.
    if (options.keyCheck !== undefined && typeof options.keyCheck !== "boolean") throw new Error("Invalid MEXC key check setting");
    this.keyCheckEnabled = options.keyCheck !== false;
    this.vault = vault;
    this.apiKey = options.apiKey;
    this.secret = options.apiSecret;
    this.limits = Object.freeze({ ...options.limits });
    this.transport = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.timeout = options.timeoutMilliseconds ?? TIMEOUT;
  }

  private sign(text: string): string {
    return createHmac("sha256", this.secret).update(text, "utf8").digest("hex");
  }
  private async send(method: "GET" | "POST", path: string, options: { query?: Record<string, string | number>; body?: string; signed?: boolean; timeout?: number } = {}) {
    const entries = Object.entries(options.query ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // Values are symbols, digits and timestamps, so no percent-encoding can change the signed text.
    const query = entries.map(([key, value]) => `${key}=${value}`).join("&");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.signed) {
      const time = String(this.now());
      headers.ApiKey = this.apiKey;
      headers["Request-Time"] = time;
      headers.Signature = this.sign(this.apiKey + time + (method === "POST" ? options.body ?? "" : query));
    }
    return this.fetchText(ORIGIN + path + (query ? "?" + query : ""), { method, headers, body: options.body }, options.timeout);
  }
  private async fetchText(url: string, init: RequestInit, timeout = this.timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeout, this.timeout));
    try {
      const response = await this.transport(url, { ...init, redirect: "error", signal: controller.signal });
      const body = await response.text();
      if (new TextEncoder().encode(body).length > MAX_BODY) throw new Error("Response too large");
      return { status: response.status, body };
    } finally { clearTimeout(timer); }
  }
  /** Reads are never retried here either; a failed read surfaces and the user refreshes. */
  private async read(path: string, query?: Record<string, string | number>, signed = false, timeout?: number): Promise<unknown> {
    let result: { status: number; body: string };
    try { result = await this.send("GET", path, { query, signed, timeout }); }
    catch { throw mexcError("exchangeUnavailable"); }
    const outcome = classifyMexcResponse(result.status, result.body);
    if (outcome.kind === "accepted") return outcome.data;
    // "Rejected, not filled" describes a new order; a refused read says nothing about one.
    if (outcome.kind === "rejected" && outcome.code !== "exchangeRejected") throw mexcError(outcome.code);
    throw mexcError("exchangeUnavailable");
  }

  /** Spot-style signing: this is the only endpoint that reports the key's own settings. */
  private async fetchKeyProblem(timeout?: number): Promise<string | undefined> {
    const query = `accessKey=${this.apiKey}&timestamp=${this.now()}`;
    const { status, body } = await this.fetchText(`${ORIGIN}/api/v3/apiKeyInfo?${query}&signature=${this.sign(query)}`, {
      method: "GET", headers: { "Content-Type": "application/json", "X-MEXC-APIKEY": this.apiKey },
    }, timeout);
    if (status !== 200) return "keyCheckFailed";
    return mexcKeyProblem(parseLossless(body));
  }
  /** Fails closed: without a passing check the order path stays shut, reads keep working. */
  private async keyProblem(timeout?: number): Promise<string | undefined> {
    if (!this.keyCheckEnabled) return undefined;
    const now = this.now();
    if (this.keyCheck && now >= this.keyCheck.at && now - this.keyCheck.at < KEY_CHECK_TTL) return this.keyCheck.problem;
    let problem: string | undefined;
    try { problem = await this.fetchKeyProblem(timeout); }
    catch { problem = "keyCheckFailed"; }
    if (problem === "keyCheckFailed") {
      // A failed lookup proves nothing: a key already known to be bad stays bad until a lookup says otherwise.
      if (this.keyCheck?.problem) return this.keyCheck.problem;
      // Not remembered otherwise, so the next attempt asks again.
      this.keyCheck = undefined;
      return problem;
    }
    this.keyCheck = { at: now, problem };
    return problem;
  }
  private async requireUsableKey(allowFailedLookup: boolean, timeout?: number): Promise<void> {
    const problem = await this.keyProblem(timeout);
    if (!problem) return;
    // A failed lookup says nothing bad about the key, so what manages an existing position stays possible.
    if (problem === "keyCheckFailed" && allowFailedLookup) return;
    throw mexcError(problem);
  }

  private async readMarker(): Promise<boolean> {
    if (this.unresolved) return true;
    try { this.unresolved = (await this.vault.get(OPERATION_KEY)) !== null; }
    catch { this.unresolved = true; }
    return this.unresolved;
  }
  private async clearMarker(): Promise<void> {
    try {
      await this.vault.remove(OPERATION_KEY);
      this.unresolved = false;
    } catch { throw unknownOutcome(); }
  }
  /**
   * The marker is durable before the request leaves. It is removed only when the
   * answer proves what happened, and the request is never sent a second time.
   */
  private async write(path: string, body: string, marker: Marker, expired?: () => boolean, rejected: (code: string) => string = code => code,
    rejections: Record<number, string> = DEFINITE_REJECTIONS): Promise<unknown> {
    try {
      if ((await this.vault.get(OPERATION_KEY)) !== null) {
        this.unresolved = true;
        throw unknownOutcome();
      }
      await this.vault.set(OPERATION_KEY, JSON.stringify({ version: 1, pending: true, createdAt: this.now(), ...marker }));
      this.unresolved = true;
    } catch (error) {
      this.unresolved = true;
      throw error instanceof TradingError ? error : mexcError("secureStorage");
    }
    // Durable storage can be slow. This branch definitively has not sent anything.
    if (expired?.()) {
      await this.clearMarker();
      throw reviewExpired();
    }
    let result: { status: number; body: string };
    try { result = await this.send("POST", path, { body, signed: true }); }
    catch { throw unknownOutcome(); }
    const outcome = classifyMexcResponse(result.status, result.body, rejections);
    if (outcome.kind === "unknown") throw unknownOutcome();
    if (outcome.kind === "rejected") {
      await this.clearMarker();
      throw mexcError(rejected(outcome.code));
    }
    return outcome.data;
  }

  private assertAccount(accountID: unknown): void {
    if (accountID !== MEXC_ACCOUNT) throw mexcError("invalidAccount");
  }
  private async orderContext(draft: MexcDraft, timeout?: number): Promise<Omit<MexcOrderContext, "reviewedPrice">> {
    const [contract, ticker, positionMode, positions, asset] = await Promise.all([
      this.read("/api/v1/contract/detail", { symbol: draft.symbol }, false, timeout).then(decodeMexcContract),
      this.read("/api/v1/contract/ticker", { symbol: draft.symbol }, false, timeout).then(decodeMexcTicker),
      this.read("/api/v1/private/position/position_mode", undefined, true, timeout),
      this.read("/api/v1/private/position/open_positions", { symbol: draft.symbol }, true, timeout).then(decodeMexcPositions),
      this.read("/api/v1/private/account/asset/USDT", undefined, true, timeout).then(decodeMexcAsset),
    ]);
    if (typeof positionMode !== "number") throw invalidMexcResponse();
    return { draft, contract, ticker, positions, availableOpen: asset.availableOpen, positionMode, limits: this.limits, now: this.now() };
  }

  private async leverageContext(draft: MexcLeverageDraft, timeout?: number): Promise<MexcLeverageContext> {
    const [contract, positionMode, positions, asset] = await Promise.all([
      this.read("/api/v1/contract/detail", { symbol: draft.symbol }, false, timeout).then(decodeMexcContract),
      this.read("/api/v1/private/position/position_mode", undefined, true, timeout),
      this.read("/api/v1/private/position/open_positions", { symbol: draft.symbol }, true, timeout).then(decodeMexcPositions),
      this.read("/api/v1/private/account/asset/USDT", undefined, true, timeout).then(decodeMexcAsset),
    ]);
    if (typeof positionMode !== "number") throw invalidMexcResponse();
    return { draft, contract, positions, availableOpen: asset.availableOpen, positionMode, limits: this.limits };
  }
  private async readStopOrders(symbol?: string, timeout?: number): Promise<MexcStopOrder[]> {
    return decodeMexcStopOrders(await this.read("/api/v1/private/stoporder/open_orders", symbol === undefined ? undefined : { symbol }, true, timeout));
  }
  private async stopContext(draft: MexcStopDraft, timeout?: number): Promise<MexcStopContext> {
    const [contract, ticker, positionMode, positions, stopOrders] = await Promise.all([
      this.read("/api/v1/contract/detail", { symbol: draft.symbol }, false, timeout).then(decodeMexcContract),
      this.read("/api/v1/contract/ticker", { symbol: draft.symbol }, false, timeout).then(decodeMexcTicker),
      this.read("/api/v1/private/position/position_mode", undefined, true, timeout),
      this.read("/api/v1/private/position/open_positions", { symbol: draft.symbol }, true, timeout).then(decodeMexcPositions),
      this.readStopOrders(draft.symbol, timeout),
    ]);
    if (typeof positionMode !== "number") throw invalidMexcResponse();
    return { draft, contract, ticker, positions, stopOrders, positionMode, now: this.now() };
  }
  /** Taking one off reads only what it needs, so a market data outage cannot hold it up. */
  private async stopPlan(draft: MexcStopDraft, timeout?: number): Promise<{ plan: MexcStopPlan; displayName?: string }> {
    if (draft.kind === "STOP_CANCEL") {
      const [positions, stopOrders] = await Promise.all([
        this.read("/api/v1/private/position/open_positions", { symbol: draft.symbol }, true, timeout).then(decodeMexcPositions),
        this.readStopOrders(draft.symbol, timeout),
      ]);
      return { plan: planMexcStopCancel(draft, positions, stopOrders) };
    }
    const context = await this.stopContext(draft, timeout);
    return { plan: planMexcStop(context), displayName: context.contract.displayName };
  }

  async status(): Promise<SessionStatus & { tradingBlocked?: string; writeInProgress?: boolean }> {
    // Slowest read first: the lock has to describe the moment of the answer, not the moment of the question.
    const problem = await this.keyProblem();
    const marker = await this.readMarker();
    // A write still being checked has no marker yet, but it may send, so nothing may unlock meanwhile.
    const writeInProgress = this.writeBusy;
    const unresolvedOperation = marker || writeInProgress;
    return { configured: true, authenticated: problem === undefined, unresolvedOperation, ...(writeInProgress ? { writeInProgress } : {}), ...(problem ? { tradingBlocked: problem } : {}) };
  }
  // The key lives in the server config, so there is no sign-in to perform.
  async authorizationURL(): Promise<string> { throw new TradingError("methodNotAllowed", "MEXC 不需要授权登录。"); }
  async completeAuthorization(): Promise<void> { throw new TradingError("methodNotAllowed", "MEXC 不需要授权登录。"); }

  async accounts(): Promise<MexcAccount[]> {
    const [asset, positions] = await Promise.all([
      this.read("/api/v1/private/account/asset/USDT", undefined, true).then(decodeMexcAsset),
      this.read("/api/v1/private/position/open_positions", undefined, true).then(decodeMexcPositions),
    ]);
    return [{ id: MEXC_ACCOUNT, asset, positions }];
  }
  async quotes(symbols: unknown): Promise<MexcTicker[]> {
    if (!Array.isArray(symbols) || symbols.length > MAX_SYMBOLS || !symbols.every(validMexcSymbol))
      throw mexcError("invalidSymbol");
    const now = this.now();
    if (!this.tickerList || now < this.tickerList.at || now - this.tickerList.at >= TICKERS_TTL) {
      const rows = await this.read("/api/v1/contract/ticker");
      if (!Array.isArray(rows)) throw invalidMexcResponse();
      const value: MexcTicker[] = [];
      for (const row of rows) {
        // An unlisted contract with no price must not hide every other quote.
        try { value.push(decodeMexcTicker(row)); } catch { /* Skipped. */ }
      }
      this.tickerList = { at: now, value };
    }
    const wanted = new Set<string>(symbols);
    return this.tickerList.value.filter(ticker => wanted.has(ticker.symbol));
  }
  /** Listed USDT perpetuals that accept API orders; everything else cannot be traded here. */
  async contracts(): Promise<MexcContract[]> {
    const now = this.now();
    if (!this.contractList || now < this.contractList.at || now - this.contractList.at >= CONTRACTS_TTL) {
      const rows = await this.read("/api/v1/contract/detail");
      if (!Array.isArray(rows)) throw invalidMexcResponse();
      const value: MexcContract[] = [];
      for (const row of rows) {
        // One malformed listing must not hide every other contract.
        try {
          const contract = decodeMexcContract(row);
          if (contract.apiAllowed && contract.state === 0 && contract.futureType === 1 && contract.settleCoin === "USDT" && validMexcSymbol(contract.symbol))
            value.push(contract);
        } catch { /* Skipped. */ }
      }
      this.contractList = { at: now, value };
    }
    return this.contractList.value;
  }
  async history(symbol: unknown, range: HistoryRange): Promise<History> {
    if (!validMexcSymbol(symbol)) throw mexcError("invalidSymbol");
    const request = mexcHistoryRequest(range, this.now());
    return decodeMexcHistory(await this.read(`/api/v1/contract/kline/${symbol}`, request), symbol);
  }
  private async liveRead(path: string, query: Record<string, string | number>): Promise<unknown> {
    let result: { status: number; body: string };
    try { result = await this.send("GET", path, { query, timeout: LIVE_READ_TIMEOUT }); }
    catch { throw mexcError("exchangeUnavailable"); }
    // A firewall refusal counts as a rate limit here: this optional path should be the first to step back.
    if (result.status === 403) throw mexcError("rateLimited");
    const outcome = classifyMexcResponse(result.status, result.body);
    if (outcome.kind === "accepted") return outcome.data;
    throw mexcError(outcome.kind === "rejected" && outcome.code === "rateLimited" ? "rateLimited" : "exchangeUnavailable");
  }
  /**
   * Public market data only: this never uses the key and never touches the write path. Orders and
   * cancels share this IP, so when MEXC pushes back this stops first. Only this path pauses, never them.
   */
  async live(symbol: unknown, range: HistoryRange): Promise<MexcLive> {
    if (!validMexcSymbol(symbol)) throw mexcError("invalidSymbol");
    const request = mexcLiveRequest(range, this.now());
    const key = `${symbol}:${request.interval}`, now = this.now();
    // The bound keeps a clock that jumped backwards from pausing this for longer than intended.
    if (now < this.livePausedUntil && this.livePausedUntil - now <= LIVE_PAUSE_MAX) throw mexcError("rateLimited");
    const cached = this.liveCache.get(key);
    if (cached && now >= cached.at && now - cached.at < LIVE_TTL) return cached.value;
    if (this.liveCache.size >= MAX_LIVE_ENTRIES) this.liveCache.clear();
    const value = Promise.all([
      this.liveRead(`/api/v1/contract/kline/${symbol}`, request),
      this.liveRead("/api/v1/contract/ticker", { symbol }),
    ]).then(([candles, ticker]): MexcLive => ({
      symbol, candles: decodeMexcHistory(candles, symbol).candles.slice(-2), ticker: decodeMexcTicker(ticker),
    }));
    this.liveCache.set(key, { at: now, value });
    value.then(() => { this.livePause = 0; }, error => {
      // Any other failure is not worth remembering: the next second simply asks again.
      if (this.liveCache.get(key)?.value === value) this.liveCache.delete(key);
      if (error instanceof TradingError && error.code === "rateLimited") {
        this.livePause = Math.min(LIVE_PAUSE_MAX, Math.max(LIVE_PAUSE_MIN, this.livePause * 2));
        this.livePausedUntil = this.now() + this.livePause;
      }
    });
    return value;
  }
  /** What is still waiting to trigger, for one contract or for the whole account. */
  async stopOrders(symbol?: unknown): Promise<MexcStopOrder[]> {
    if (symbol !== undefined && !validMexcSymbol(symbol)) throw mexcError("invalidSymbol");
    return this.readStopOrders(symbol as string | undefined);
  }
  async orders(accountID: unknown): Promise<MexcOrder[]> {
    this.assertAccount(accountID);
    return decodeMexcOrderPage(await this.read("/api/v1/private/order/list/open_orders", { page_num: 1, page_size: 100 }, true));
  }
  async closedOrders(symbol: unknown, from: unknown, to: unknown): Promise<MexcOrder[]> {
    if (!validMexcSymbol(symbol)) throw mexcError("invalidSymbol");
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || (from as number) < 0 || (from as number) > (to as number) ||
        (to as number) - (from as number) > HISTORY_WINDOW_DAYS * 86_400_000)
      throw mexcError("invalidRange");
    return decodeMexcOrderPage(await this.read("/api/v1/private/order/list/close_orders",
      { symbol, start_time: from as number, end_time: to as number, page_num: 1, page_size: 100 }, true));
  }
  async orderDetail(accountID: unknown, id: unknown): Promise<MexcOrder> {
    this.assertAccount(accountID);
    if (!validMexcOrderID(id)) throw mexcError("invalidOrderIdentifier");
    return decodeMexcOrder(await this.read(`/api/v1/private/order/get/${id}`, undefined, true));
  }
  private async cancelTarget(id: string): Promise<MexcOrder> {
    // Bounded like a submit's reads, so a cancel also finishes inside the app's wait.
    return decodeMexcOrder(await this.read(`/api/v1/private/order/get/${id}`, undefined, true, SUBMIT_READ_TIMEOUT));
  }

  async prepare(accountID: unknown, draft: MexcDraft | MexcLeverageDraft | MexcStopDraft, extra?: unknown): Promise<MexcPrepared | MexcLeveragePrepared | MexcStopPrepared> {
    if (this.writeBusy) throw busy();
    if (extra !== undefined) throw mexcError("invalidDraft");
    this.assertAccount(accountID);
    if (isLeverageDraft(draft)) return this.prepareLeverage(draft);
    if (isStopDraft(draft)) return this.prepareStop(draft);
    validateMexcDraft(draft);
    const copy = freezeMexcDraft(draft);
    this.reviews.clear();
    const sequence = ++this.prepareSequence;
    if (await this.readMarker()) throw unknownOutcome();
    await this.requireUsableKey(!isOpening(copy.action));
    const context = await this.orderContext(copy);
    if (sequence !== this.prepareSequence || this.writeBusy) throw reviewExpired();
    const plan = planMexcOrder(context);
    const snapshot: MexcPrepared = Object.freeze({
      id: randomBytes(32).toString("base64url"),
      draft: copy,
      accountID: MEXC_ACCOUNT,
      displayName: context.contract.displayName,
      // Fixed at review so the marker and any later lookup name this exact order.
      externalOid: "ths" + randomBytes(12).toString("hex"),
      orderPrice: plan.orderPrice,
      referencePrice: plan.referencePrice,
      notional: plan.notional,
      openType: plan.openType,
      leverage: plan.leverage,
      margin: plan.margin,
      available: plan.available,
      closable: plan.closable,
      positionId: plan.positionId,
      takerFeeRate: context.contract.takerFeeRate,
      makerFeeRate: context.contract.makerFeeRate,
      fundingRate: context.ticker.fundingRate,
      preparedAt: this.now(),
      isDemo: false,
    });
    this.reviews.set(snapshot.id, snapshot);
    return snapshot;
  }
  /** A higher leverage is more exposure, so a failed key lookup stops this as it stops an opening order. */
  private async prepareLeverage(draft: MexcLeverageDraft): Promise<MexcLeveragePrepared> {
    validateMexcLeverageDraft(draft);
    const copy = freezeMexcLeverageDraft(draft);
    this.reviews.clear();
    const sequence = ++this.prepareSequence;
    if (await this.readMarker()) throw unknownOutcome();
    await this.requireUsableKey(false);
    const context = await this.leverageContext(copy);
    if (sequence !== this.prepareSequence || this.writeBusy) throw reviewExpired();
    const plan = planMexcLeverage(context);
    const snapshot: MexcLeveragePrepared = Object.freeze({
      ...plan,
      id: randomBytes(32).toString("base64url"),
      draft: copy,
      accountID: MEXC_ACCOUNT,
      displayName: context.contract.displayName,
      preparedAt: this.now(),
      isDemo: false,
    });
    this.reviews.set(snapshot.id, snapshot);
    return snapshot;
  }
  /** Cancelling is not held back by the key check, as with any cancel. A failed lookup lets the others through, since a stop may be needed most just then. */
  private async prepareStop(draft: MexcStopDraft): Promise<MexcStopPrepared> {
    validateMexcStopDraft(draft);
    const copy = freezeMexcStopDraft(draft);
    this.reviews.clear();
    const sequence = ++this.prepareSequence;
    if (await this.readMarker()) throw unknownOutcome();
    if (copy.kind !== "STOP_CANCEL") await this.requireUsableKey(true);
    const { plan, displayName } = await this.stopPlan(copy);
    if (sequence !== this.prepareSequence || this.writeBusy) throw reviewExpired();
    const snapshot: MexcStopPrepared = Object.freeze({
      ...plan,
      id: randomBytes(32).toString("base64url"),
      draft: copy,
      accountID: MEXC_ACCOUNT,
      displayName: displayName ?? copy.symbol,
      preparedAt: this.now(),
      isDemo: false,
    });
    this.reviews.set(snapshot.id, snapshot);
    return snapshot;
  }
  async submit(prepared: MexcPrepared | MexcLeveragePrepared | MexcStopPrepared): Promise<{ orderID: string } | { leverage: number } | { stopKind: MexcStopDraft["kind"] }> {
    if (this.writeBusy) throw busy();
    const review = this.reviews.get(prepared?.id);
    // Identity rejects constructed, altered and replayed reviews, and each review is used once.
    this.reviews.clear();
    this.prepareSequence++;
    const expired = () => {
      const age = this.now() - prepared.preparedAt;
      return !Number.isFinite(age) || age < 0 || age > MEXC_REVIEW_TTL;
    };
    if (!review || review !== prepared || prepared.isDemo || expired()) throw reviewExpired();
    const started = this.now();
    // Past the budget the order has definitively not been sent, so it can stop cleanly.
    const outOfTime = () => expired() || this.now() - started > SUBMIT_BUDGET;
    this.writeBusy = true;
    try {
      if (await this.readMarker()) throw unknownOutcome();
      if (isLeverageDraft(prepared.draft)) return await this.sendLeverage(prepared as MexcLeveragePrepared, outOfTime);
      if (isStopDraft(prepared.draft)) return await this.sendStop(prepared as MexcStopPrepared, outOfTime);
      const order = prepared as MexcPrepared;
      await this.requireUsableKey(!isOpening(order.draft.action), SUBMIT_READ_TIMEOUT);
      const context = await this.orderContext(order.draft, SUBMIT_READ_TIMEOUT);
      const plan: MexcOrderPlan = planMexcOrder({ ...context, reviewedPrice: order.orderPrice });
      // The approved exposure must still hold, or the user approved something else. A position
      // closed and reopened in between has a new id, and a close must not land on it unseen.
      if (plan.openType !== order.openType || plan.leverage !== order.leverage || plan.positionId !== order.positionId)
        throw reviewExpired();
      const data = await this.write("/api/v1/private/order/create", encodeMexcOrder(order.draft, plan, order.externalOid),
        { operation: "create", symbol: order.draft.symbol, externalOid: order.externalOid }, outOfTime);
      const orderID = createdOrderID(data);
      // A success without a usable id cannot be matched to an order, so it stays locked.
      if (orderID === undefined) throw unknownOutcome();
      await this.clearMarker();
      return { orderID };
    } finally { this.writeBusy = false; }
  }
  /** Runs inside submit, so the write lock, the marker check and the time budget all apply. */
  private async sendLeverage(prepared: MexcLeveragePrepared, outOfTime: () => boolean): Promise<{ leverage: number }> {
    const { draft } = prepared;
    await this.requireUsableKey(false, SUBMIT_READ_TIMEOUT);
    const plan = planMexcLeverage(await this.leverageContext(draft, SUBMIT_READ_TIMEOUT));
    // The reviewed position must still be what it was, or the user approved something else.
    if (plan.previousLeverage !== prepared.previousLeverage || plan.direction !== prepared.direction || plan.holdVol !== prepared.holdVol)
      throw reviewExpired();
    await this.write("/api/v1/private/position/change_leverage", encodeMexcLeverage(draft),
      { operation: "leverage", symbol: draft.symbol, positionId: draft.positionId, leverage: draft.leverage, previousLeverage: prepared.previousLeverage }, outOfTime,
      // A refusal of this request must not read like a refused order.
      code => (["apiKeyRejected", "ipRejected", "permissionRejected", "rateLimited", "regionRejected", "contractUnavailable", "positionMode", "marketClosed", "leverageLimit",
        "leverageCross", "leverageMargin", "leverageOrdersOpen", "leverageSizeLimit", "positionChanged"].includes(code) ? code : "leverageRejected"),
      LEVERAGE_REJECTIONS);
    await this.clearMarker();
    return { leverage: draft.leverage };
  }
  /** Runs inside submit, so the write lock, the marker check and the time budget all apply. */
  private async sendStop(prepared: MexcStopPrepared, outOfTime: () => boolean): Promise<{ stopKind: MexcStopDraft["kind"] }> {
    const { draft } = prepared;
    if (draft.kind !== "STOP_CANCEL") await this.requireUsableKey(true, SUBMIT_READ_TIMEOUT);
    const { plan } = await this.stopPlan(draft, SUBMIT_READ_TIMEOUT);
    // The reviewed position and prices must still be what they were, or the user approved something else.
    if (plan.direction !== prepared.direction || plan.holdVol !== prepared.holdVol || plan.vol !== prepared.vol ||
        plan.existing?.takeProfitPrice !== prepared.existing?.takeProfitPrice || plan.existing?.stopLossPrice !== prepared.existing?.stopLossPrice)
      throw reviewExpired();
    const data = await this.write(mexcStopPath(draft.kind), encodeMexcStop(draft, plan),
      { operation: "stop", symbol: draft.symbol, positionId: draft.positionId, stopKind: draft.kind, stopOrderId: draft.stopOrderId, takeProfitPrice: draft.takeProfitPrice, stopLossPrice: draft.stopLossPrice }, outOfTime,
      // A refusal of this request must not read like a refused order.
      code => (["apiKeyRejected", "ipRejected", "permissionRejected", "rateLimited", "regionRejected", "contractUnavailable", "positionMode", "marketClosed", "priceLimit", "priceTick", "quoteMissing",
        "positionChanged", "insufficientPosition", "stopPriceMissing", "stopPriceInvalid", "stopChanged", "stopExists", "stopVolume"].includes(code) ? code : "stopRejected"),
      STOP_REJECTIONS);
    // An answer that cannot be matched to this request stays locked, as an order without an id does.
    if (stopOutcome(draft, data) === "unknown") throw unknownOutcome();
    await this.clearMarker();
    return { stopKind: draft.kind };
  }
  async cancel(accountID: unknown, orderID: unknown): Promise<void> {
    if (this.writeBusy) throw busy();
    this.assertAccount(accountID);
    if (!validMexcOrderID(orderID)) throw mexcError("invalidOrderIdentifier");
    this.writeBusy = true;
    this.reviews.clear();
    this.prepareSequence++;
    try {
      if (await this.readMarker()) throw unknownOutcome();
      const order = await this.cancelTarget(orderID);
      if (!order.cancelable) throw mexcError("orderChanged");
      // Cancelling only reduces exposure, so the key check does not block it.
      const data = await this.write("/api/v1/private/order/cancel", encodeMexcCancel(orderID), { operation: "cancel", symbol: order.symbol, orderID }, undefined,
        // The order is still live or partly filled, so the new-order wording would mislead.
        code => (["apiKeyRejected", "ipRejected", "permissionRejected", "rateLimited", "orderChanged"].includes(code) ? code : "cancelRejected"));
      const outcome = cancelOutcome(data, orderID);
      if (outcome === "unknown") throw unknownOutcome();
      await this.clearMarker();
      if (outcome === "changed") throw mexcError("orderChanged");
    } finally { this.writeBusy = false; }
  }

  /** For the offline recovery script: what is locked, and what MEXC says about it, if it answered. */
  async pendingOperation(): Promise<{ marker: Marker & { createdAt: number }; lookup: "found" | "notFound" | "failed"; order?: MexcOrder; position?: MexcPosition; stopOrders?: MexcStopOrder[] } | null> {
    const stored = await this.vault.get(OPERATION_KEY);
    if (stored === null) return null;
    const marker = JSON.parse(stored);
    if (marker.operation === "leverage") {
      if (!validMexcSymbol(marker.symbol) || !validMexcOrderID(marker.positionId)) return { marker, lookup: "failed" };
      try {
        const positions = decodeMexcPositions(await this.read("/api/v1/private/position/open_positions", { symbol: marker.symbol }, true));
        const position = positions.find(row => row.id === marker.positionId);
        return position ? { marker, lookup: "found", position } : { marker, lookup: "notFound" };
      } catch { return { marker, lookup: "failed" }; }
    }
    if (marker.operation === "stop") {
      if (!validMexcSymbol(marker.symbol)) return { marker, lookup: "failed" };
      try {
        const stopOrders = (await this.readStopOrders(marker.symbol)).filter(row => row.positionId === marker.positionId);
        return { marker, lookup: stopOrders.length ? "found" : "notFound", stopOrders };
      } catch { return { marker, lookup: "failed" }; }
    }
    let path: string | undefined;
    if (marker.operation === "create" && validMexcSymbol(marker.symbol) && /^[A-Za-z0-9]{8,32}$/.test(marker.externalOid))
      path = `/api/v1/private/order/external/${marker.symbol}/${marker.externalOid}`;
    else if (marker.operation === "cancel" && validMexcOrderID(marker.orderID))
      path = `/api/v1/private/order/get/${marker.orderID}`;
    if (!path) return { marker, lookup: "failed" };
    try {
      const raw = await this.read(path, undefined, true);
      return raw === null || raw === undefined ? { marker, lookup: "notFound" } : { marker, lookup: "found", order: decodeMexcOrder(raw) };
    } catch (error) {
      // Only MEXC's own "order does not exist" counts. A failed lookup is no evidence either way.
      return { marker, lookup: error instanceof TradingError && error.code === "orderChanged" ? "notFound" : "failed" };
    }
  }
  /** Offline-only, after a person verified the order at MEXC. Never exposed over RPC. */
  async acknowledgeReconciliation(): Promise<void> {
    await this.vault.remove(OPERATION_KEY);
    this.unresolved = false;
  }
}
