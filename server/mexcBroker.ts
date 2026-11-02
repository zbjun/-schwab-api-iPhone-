import { createHmac, randomBytes } from "node:crypto";
import { TradingError } from "../mobile/src/orderRules.ts";
import {
  MEXC_ACCOUNT, MEXC_REVIEW_TTL, cancelOutcome, classifyMexcResponse, createdOrderID,
  decodeMexcAsset, decodeMexcContract, decodeMexcHistory, decodeMexcOrder, decodeMexcOrderPage,
  decodeMexcPositions, decodeMexcTicker, encodeMexcCancel, encodeMexcOrder, freezeMexcDraft,
  invalidMexcResponse, isOpening, mexcError, mexcHistoryRequest, mexcKeyProblem, parseLossless, planMexcOrder,
  validMexcOrderID, validMexcSymbol, validateMexcDraft, validateMexcLimits,
} from "../mobile/src/mexcRules.ts";
import type {
  MexcAccount, MexcContract, MexcDraft, MexcLimits, MexcOrder, MexcOrderContext, MexcOrderPlan,
  MexcPrepared, MexcTicker,
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
const MAX_SYMBOLS = 100;
const HISTORY_WINDOW_DAYS = 90;

type Transport = (url: string, init: RequestInit) => Promise<Response>;
interface Marker { operation: "create" | "cancel"; symbol?: string; externalOid?: string; orderID?: string }
export interface MexcBrokerOptions {
  apiKey: string;
  apiSecret: string;
  limits: MexcLimits;
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
  private readonly reviews = new Map<string, MexcPrepared>();
  private prepareSequence = 0;
  private writeBusy = false;
  private unresolved = false;
  private keyCheck?: { at: number; problem?: string };
  private contractList?: { at: number; value: MexcContract[] };
  private tickerList?: { at: number; value: MexcTicker[] };

  constructor(vault: Vault, options: MexcBrokerOptions) {
    if (typeof options.apiKey !== "string" || !options.apiKey || typeof options.apiSecret !== "string" || !options.apiSecret ||
        options.apiKey === "REPLACE_ON_SERVER" || options.apiSecret === "REPLACE_ON_SERVER")
      throw new Error("MEXC API key is not configured");
    validateMexcLimits(options.limits);
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
  private async requireUsableKey(draft: MexcDraft, timeout?: number): Promise<void> {
    const problem = await this.keyProblem(timeout);
    if (!problem) return;
    // A failed lookup says nothing bad about the key, and closing only reduces exposure.
    if (problem === "keyCheckFailed" && !isOpening(draft.action)) return;
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
  private async write(path: string, body: string, marker: Marker, expired?: () => boolean, rejected: (code: string) => string = code => code): Promise<unknown> {
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
    const outcome = classifyMexcResponse(result.status, result.body);
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

  async prepare(accountID: unknown, draft: MexcDraft, extra?: unknown): Promise<MexcPrepared> {
    if (this.writeBusy) throw busy();
    if (extra !== undefined) throw mexcError("invalidDraft");
    this.assertAccount(accountID);
    validateMexcDraft(draft);
    const copy = freezeMexcDraft(draft);
    this.reviews.clear();
    const sequence = ++this.prepareSequence;
    if (await this.readMarker()) throw unknownOutcome();
    await this.requireUsableKey(copy);
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
  async submit(prepared: MexcPrepared): Promise<{ orderID: string }> {
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
      await this.requireUsableKey(prepared.draft, SUBMIT_READ_TIMEOUT);
      const context = await this.orderContext(prepared.draft, SUBMIT_READ_TIMEOUT);
      const plan: MexcOrderPlan = planMexcOrder({ ...context, reviewedPrice: prepared.orderPrice });
      // The approved exposure must still hold, or the user approved something else. A position
      // closed and reopened in between has a new id, and a close must not land on it unseen.
      if (plan.openType !== prepared.openType || plan.leverage !== prepared.leverage || plan.positionId !== prepared.positionId)
        throw reviewExpired();
      const data = await this.write("/api/v1/private/order/create", encodeMexcOrder(prepared.draft, plan, prepared.externalOid),
        { operation: "create", symbol: prepared.draft.symbol, externalOid: prepared.externalOid }, outOfTime);
      const orderID = createdOrderID(data);
      // A success without a usable id cannot be matched to an order, so it stays locked.
      if (orderID === undefined) throw unknownOutcome();
      await this.clearMarker();
      return { orderID };
    } finally { this.writeBusy = false; }
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
  async pendingOperation(): Promise<{ marker: Marker & { createdAt: number }; lookup: "found" | "notFound" | "failed"; order?: MexcOrder } | null> {
    const stored = await this.vault.get(OPERATION_KEY);
    if (stored === null) return null;
    const marker = JSON.parse(stored);
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
