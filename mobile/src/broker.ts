import type {
  Account,
  Broker,
  Draft,
  History,
  HistoryRange,
  Order,
  Prepared,
  Quote,
  SessionStatus,
  Vault,
} from "./types.ts";
import { aggregateMinutes } from "./chartData.ts";
import {
  openMarketStream,
  type MarketStreamCallbacks,
  type StreamCredentials,
} from "./marketStream.ts";
import {
  TradingError,
  decodeAccountIdentifiers,
  decodeAccounts,
  decodeFundamentals,
  decodeHistory,
  decodeOrder,
  decodeOrders,
  decodeQuotes,
  encodeDraft,
  invalidResponse,
  isStockAsset,
  maximumBuy,
  maximumSell,
  referencePrice,
  validAccountHash,
  validOrderID,
  validSymbol,
  validateDraft,
  validateReplacement,
} from "./orderRules.ts";

const ORIGIN = "https://api.schwabapi.com";
export const CALLBACK_URL = "https://127.0.0.1";
const SESSION_KEY = "ths.schwab.session.v1";
const OPERATION_KEY = "ths.schwab.operation.v1";
const DAY = 86_400_000;
const MAX_TIME = 32_503_680_000_000;
const MAX_BODY_BYTES = 8 * 1_024 * 1_024;

export type FetchTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export interface BrokerTiming {
  phase: "validation" | "submit" | "refresh";
  durationMs: number;
  outcome: "ok" | "error";
}
export interface SchwabBrokerOptions {
  /** Opt-in diagnostics: never includes identifiers, credentials or payloads. */
  onTiming?: (sample: BrokerTiming) => void;
  /** Server deployment only; must exactly match the registered HTTPS callback. */
  callbackURL?: string;
  stream?: typeof openMarketStream;
  fetch?: FetchTransport;
  randomState?: () => string | Promise<string>;
  now?: () => number;
  timeoutMilliseconds?: number;
}
interface Credentials {
  clientID: string;
  clientSecret: string;
}
interface Token {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  refreshIssuedAt?: number;
  refreshExpiresAt?: number;
}
interface Pending {
  state: string;
  createdAt: number;
}
interface StoredSession {
  version: 1;
  credentials?: Credentials;
  token?: Token;
  pending?: Pending;
}
interface Review {
  snapshot: Prepared;
  generation: number;
  accountHash: string;
}
interface HTTPResult {
  status: number;
  text: string;
  location: string | null;
}

function error(code: string): TradingError {
  const messages: Record<string, string> = {
    credentialsRequired: "请先导入或保存 Schwab 连接配置。",
    invalidCredentials: "Client ID 或 Client Secret 格式无效。",
    authorizationRequired: "请先完成 Schwab 登录授权。",
    authorizationExpired: "本次授权已过期或已使用，请重新打开 Schwab 登录。",
    invalidCallback: "回调链接与本次授权不匹配，请粘贴浏览器中的完整链接。",
    authorizationDeclined: "Schwab 未完成授权，请重新登录并确认账户授权。",
    sessionChanged: "登录或账户状态已变化，请重新操作。",
    secureStorage: "无法读取或更新设备安全存储，请解锁设备后重试。",
    network: "无法完成到 Schwab 的连接，请检查网络后重试。",
    redirectRejected: "Schwab API 返回了非预期跳转。",
    invalidSymbols: "请输入 1–50 个有效股票或 ETF 代码。",
    invalidTradingAccount: "当前账户尚未取得有效交易标识，请刷新账户。",
    invalidOrderIdentifier: "订单编号无效，请刷新订单。",
    invalidDateRange: "行情或订单查询时间无效。",
    orderOutcomeUnknown:
      "无法确认本次委托操作结果。请先刷新订单并到 Schwab 核实，避免重复提交。",
    operationBusy: "当前操作尚未完成，请等待结果。",
    reviewExpired: "订单核对已过期、已使用或发生变化，请重新核对订单。",
    unsupportedAsset: "当前仅支持已确认类型的股票和 ETF。",
    insufficientShares:
      "卖出数量超过已核对的可卖整股，或存在无法确认的在途订单。",
    insufficientFunds:
      "购买力或参考价格不足以核对本次买入，请刷新账户并调整数量。",
    ordersTruncated:
      "最近 30 天的订单已达到 200 条上限，无法完整核对在途委托。请先到 Schwab 核对。",
    orderChanged: "订单状态已变化，或该复杂订单不支持在此操作，请刷新后查看。",
  };
  return new TradingError(
    code,
    messages[code] ?? "无法完成操作，请刷新后重试。",
  );
}
function httpError(status: number): TradingError {
  const specific: Record<number, string> = {
    400: "Schwab 未接受请求，请检查填写内容或应用配置。",
    401: "Schwab 未接受当前授权，请重试；持续失败请检查应用权限或重新授权。",
    403: "当前应用或账户没有此接口的访问权限。",
    429: "请求过于频繁，请稍后重试。",
  };
  return new TradingError(
    "httpStatus",
    `${specific[status] ?? "Schwab 请求未成功。"}（HTTP ${status}）`,
    status,
  );
}
function sanitized(value: unknown): TradingError {
  return value instanceof TradingError ? value : error("network");
}
function bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
function validCredential(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    bytes(value) <= 512 &&
    !/[\s\p{Cc}\p{Cf}]/u.test(value)
  );
}
function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    bytes(value) <= 32_768 &&
    !/[\s\p{Cc}\p{Cf}]/u.test(value)
  );
}
function validTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < MAX_TIME
  );
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
}
function randomState(): string {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw error("secureStorage");
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a),
    right = new TextEncoder().encode(b);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
}
function basicAuthorization(credentials: Credentials): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const input = new TextEncoder().encode(
    `${credentials.clientID}:${credentials.clientSecret}`,
  );
  let result = "";
  for (let i = 0; i < input.length; i += 3) {
    const block =
      (input[i] << 16) | ((input[i + 1] ?? 0) << 8) | (input[i + 2] ?? 0);
    result +=
      alphabet[(block >>> 18) & 63] +
      alphabet[(block >>> 12) & 63] +
      (i + 1 < input.length ? alphabet[(block >>> 6) & 63] : "=") +
      (i + 2 < input.length ? alphabet[block & 63] : "=");
  }
  return "Basic " + result;
}
function normalizedSymbols(values: string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 50)
    throw error("invalidSymbols");
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") throw error("invalidSymbols");
    const symbol = value.trim().toUpperCase();
    if (!validSymbol(symbol)) throw error("invalidSymbols");
    if (!result.includes(symbol)) result.push(symbol);
  }
  return result;
}
function pathForOrders(hash: string, id?: string): string {
  if (!validAccountHash(hash)) throw error("invalidTradingAccount");
  if (id !== undefined && !validOrderID(id))
    throw error("invalidOrderIdentifier");
  return (
    `/trader/v1/accounts/${hash}/orders` + (id === undefined ? "" : `/${id}`)
  );
}

export function historyQuery(
  symbol: string,
  range: HistoryRange,
  end: number,
): URLSearchParams {
  if (!validSymbol(symbol)) throw error("invalidSymbols");
  if (!validTime(end)) throw error("invalidDateRange");
  const options: Record<
    HistoryRange,
    [string, string | undefined, string, string]
  > = {
    intraday: ["day", "1", "minute", "1"],
    fiveDay: ["day", "5", "minute", "5"],
    daily: ["year", "1", "daily", "1"],
    weekly: ["year", "2", "weekly", "1"],
    monthly: ["year", "5", "monthly", "1"],
    minute1: ["day", "10", "minute", "1"],
    minute5: ["day", "10", "minute", "5"],
    minute15: ["day", "10", "minute", "15"],
    minute30: ["day", "10", "minute", "30"],
    minute60: ["day", undefined, "minute", "1"],
    minute120: ["day", undefined, "minute", "1"],
  };
  if (!Object.prototype.hasOwnProperty.call(options, range))
    throw error("invalidDateRange");
  const [periodType, period, frequencyType, frequency] = options[range];
  const endDate = Math.floor(end);
  const query = new URLSearchParams({
    symbol,
    periodType,
    frequencyType,
    frequency,
    endDate: String(endDate),
    needExtendedHoursData: frequencyType === "minute" ? "true" : "false",
    needPreviousClose: "true",
  });
  if (period !== undefined) query.set("period", period);
  else {
    if (endDate < 30 * DAY) throw error("invalidDateRange");
    query.set("startDate", String(endDate - 30 * DAY));
  }
  return query;
}

function validHistoryQuery(query: URLSearchParams): boolean {
  const bounded = query.has("startDate");
  const names = [
    "symbol",
    "periodType",
    bounded ? "startDate" : "period",
    "frequencyType",
    "frequency",
    "endDate",
    "needExtendedHoursData",
    "needPreviousClose",
  ];
  if (
    [...query.keys()].length !== names.length ||
    names.some((name) => !query.has(name))
  )
    return false;
  const q = Object.fromEntries(query);
  if (
    !validSymbol(q.symbol) ||
    q.needPreviousClose !== "true" ||
    q.needExtendedHoursData !==
      (q.frequencyType === "minute" ? "true" : "false") ||
    !/^[0-9]+$/.test(q.endDate) ||
    !validTime(Number(q.endDate)) ||
    !Number.isSafeInteger(Number(q.endDate))
  )
    return false;
  if (bounded)
    return (
      q.periodType === "day" &&
      q.frequencyType === "minute" &&
      q.frequency === "1" &&
      /^[0-9]+$/.test(q.startDate) &&
      validTime(Number(q.startDate)) &&
      Number.isSafeInteger(Number(q.startDate)) &&
      Number(q.endDate) - Number(q.startDate) === 30 * DAY
    );
  return [
    "day/1/minute/1",
    "day/5/minute/5",
    "day/10/minute/1",
    "day/10/minute/5",
    "day/10/minute/15",
    "day/10/minute/30",
    "year/1/daily/1",
    "year/2/weekly/1",
    "year/5/monthly/1",
  ].includes([q.periodType, q.period, q.frequencyType, q.frequency].join("/"));
}
function validOrderQuery(query: URLSearchParams): boolean {
  if ([...query.keys()].length !== 3 || query.get("maxResults") !== "200")
    return false;
  const from = query.get("fromEnteredTime"),
    to = query.get("toEnteredTime");
  const utc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
  if (!from || !to || !utc.test(from) || !utc.test(to)) return false;
  const start = Date.parse(from),
    end = Date.parse(to);
  return (
    validTime(start) &&
    validTime(end) &&
    end >= start &&
    end - start <= 60 * DAY
  );
}

/** Applied even to injected transports. No arbitrary URL, encoded path, or duplicate key is accepted. */
export function validateRequest(
  raw: string,
  method = "GET",
  body?: string,
  contentType?: string,
): void {
  if (
    /[\s\\\u0000-\u001f\u007f]/u.test(raw) ||
    !raw.startsWith(ORIGIN + "/") ||
    raw.includes("#")
  )
    throw invalidResponse();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidResponse();
  }
  if (
    url.origin !== ORIGIN ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname.includes("%") ||
    raw.split("?")[0] !== ORIGIN + url.pathname
  )
    throw invalidResponse();
  const q = url.searchParams,
    keys = [...q.keys()];
  if (new Set(keys).size !== keys.length) throw invalidResponse();
  let allowed = false;
  if (method === "POST" && url.pathname === "/v1/oauth/token")
    allowed =
      keys.length === 0 &&
      contentType === "application/x-www-form-urlencoded" &&
      !!body;
  if (method === "GET" && !body) {
    switch (url.pathname) {
      case "/trader/v1/accounts":
        allowed = keys.length === 1 && q.get("fields") === "positions";
        break;
      case "/trader/v1/accounts/accountNumbers":
      case "/trader/v1/userPreference":
        allowed = keys.length === 0;
        break;
      case "/marketdata/v1/quotes": {
        const symbols = q.get("symbols")?.split(",") ?? [];
        allowed =
          keys.length === 1 &&
          symbols.length > 0 &&
          symbols.length <= 50 &&
          symbols.every(validSymbol);
        break;
      }
      case "/marketdata/v1/instruments":
        allowed =
          keys.length === 2 &&
          q.get("projection") === "fundamental" &&
          validSymbol(q.get("symbol"));
        break;
      case "/marketdata/v1/pricehistory":
        allowed = validHistoryQuery(q);
        break;
    }
  }
  const match =
    /^\/trader\/v1\/accounts\/([A-Za-z0-9_-]+)\/orders(?:\/([0-9]+))?$/.exec(
      url.pathname,
    );
  if (
    match &&
    validAccountHash(match[1]) &&
    (match[2] === undefined || validOrderID(match[2]))
  ) {
    if (method === "GET" && !body)
      allowed = match[2] === undefined ? validOrderQuery(q) : keys.length === 0;
    if (method === "DELETE")
      allowed = match[2] !== undefined && keys.length === 0 && !body;
    if (method === "POST" || method === "PUT")
      allowed =
        keys.length === 0 &&
        !!body &&
        contentType === "application/json" &&
        (method === "POST" ? match[2] === undefined : match[2] !== undefined);
  }
  if (!allowed) throw invalidResponse();
}

export function orderIDFromLocation(
  raw: string | null,
  accountHash: string,
): string | undefined {
  if (
    !raw ||
    raw.length > 2048 ||
    !validAccountHash(accountHash) ||
    /[\s\\\u0000-\u001f\u007f]/u.test(raw) ||
    /[?#%]/.test(raw)
  )
    return undefined;
  const prefix = `/trader/v1/accounts/${accountHash}/orders/`;
  const path = raw.startsWith(ORIGIN + "/") ? raw.slice(ORIGIN.length) : raw;
  if (!path.startsWith(prefix)) return undefined;
  const id = path.slice(prefix.length);
  return validOrderID(id) ? id : undefined;
}

/** The application must keep one broker instance per Vault. Credentials never leave this origin. */
export class SchwabBroker implements Broker {
  private readonly vault: Vault;
  private readonly fetcher: FetchTransport;
  private readonly makeState: () => string | Promise<string>;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly onTiming?: (sample: BrokerTiming) => void;
  private readonly callbackURL: string;
  private state: StoredSession = { version: 1 };
  private loaded = false;
  private loading?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private refresh?: Promise<Token>;
  private readonly controllers = new Set<AbortController>();
  private readonly streams = new Set<() => void>();
  private readonly openStream: typeof openMarketStream;
  private readonly reviews = new Map<string, Review>();
  private hashes = new Map<string, string>();
  private writeBusy = false;
  private prepareSequence = 0;
  private nonce = 0;
  private unresolved = false;

  constructor(vault: Vault, options: SchwabBrokerOptions = {}) {
    this.callbackURL = options.callbackURL ?? CALLBACK_URL;
    const callback = new URL(this.callbackURL);
    if (callback.protocol !== "https:" || callback.username || callback.password ||
        callback.search || callback.hash || /[\\\s]/u.test(this.callbackURL))
      throw invalidResponse();
    this.openStream = options.stream ?? openMarketStream;
    this.vault = vault;
    this.fetcher =
      options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.makeState = options.randomState ?? randomState;
    this.now = options.now ?? Date.now;
    this.onTiming = options.onTiming;
    this.timeout = options.timeoutMilliseconds ?? 20_000;
    if (
      !Number.isFinite(this.timeout) ||
      this.timeout <= 0 ||
      this.timeout > 60_000
    )
      throw invalidResponse();
  }

  private async measured<T>(
    phase: BrokerTiming["phase"],
    action: () => Promise<T>,
    succeeded: (value: T) => boolean = () => true,
  ): Promise<T> {
    const started = this.now();
    let outcome: BrokerTiming["outcome"] = "error";
    try {
      const result = await action();
      outcome = succeeded(result) ? "ok" : "error";
      return result;
    } finally {
      // Diagnostic observers cannot change a trading result, even after an ACK.
      try {
        const elapsed = this.now() - started;
        this.onTiming?.({ phase, outcome, durationMs: Number.isFinite(elapsed) ? Math.min(300_000, Math.max(0, elapsed)) : 0 });
      } catch { /* diagnostics are best effort and carry no private data */ }
    }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    const task = this.serial(async () => {
      if (this.loaded) return;
      try {
        const raw = await this.vault.get(SESSION_KEY);
        const restored = raw === null ? { version: 1 } : JSON.parse(raw);
        if (!isObject(restored) || restored.version !== 1)
          throw error("secureStorage");
        const c = restored.credentials,
          t = restored.token,
          p = restored.pending;
        if (
          c !== undefined &&
          (!isObject(c) ||
            !validCredential(c.clientID) ||
            c.clientID.includes(":") ||
            !validCredential(c.clientSecret))
        )
          throw error("secureStorage");
        if (
          t !== undefined &&
          (!c ||
            !isObject(t) ||
            !validToken(t.accessToken) ||
            !validTime(t.expiresAt) ||
            (t.refreshToken !== undefined && !validToken(t.refreshToken)) ||
            (t.refreshIssuedAt !== undefined && !validTime(t.refreshIssuedAt)) ||
            (t.refreshExpiresAt !== undefined && !validTime(t.refreshExpiresAt)))
        )
          throw error("secureStorage");
        if (
          p !== undefined &&
          (!c ||
            !isObject(p) ||
            typeof p.state !== "string" ||
            !/^[a-f0-9]{64}$/.test(p.state) ||
            !validTime(p.createdAt))
        )
          throw error("secureStorage");
        this.unresolved = (await this.vault.get(OPERATION_KEY)) !== null;
        this.state = restored as unknown as StoredSession;
        this.loaded = true;
      } catch {
        throw error("secureStorage");
      }
    });
    this.loading = task;
    try {
      await task;
    } finally {
      if (this.loading === task) this.loading = undefined;
    }
  }
  private async persist(next: StoredSession): Promise<void> {
    try {
      await this.vault.set(SESSION_KEY, JSON.stringify(next));
    } catch {
      throw error("secureStorage");
    }
    this.state = next;
    this.loaded = true;
  }
  private invalidate(): void {
    this.generation++;
    this.prepareSequence++;
    this.reviews.clear();
    this.hashes.clear();
    this.refresh = undefined;
    for (const controller of this.controllers) controller.abort();
    for (const stop of this.streams) stop();
  }
  private assertGeneration(expected: number): void {
    if (expected !== this.generation) throw error("sessionChanged");
  }
  private async readMarker(): Promise<boolean> {
    return this.serial(async () => {
      try {
        this.unresolved = (await this.vault.get(OPERATION_KEY)) !== null;
      } catch {
        this.unresolved = true;
        throw error("secureStorage");
      }
      return this.unresolved;
    });
  }

  async status(): Promise<SessionStatus> {
    await this.load();
    const unresolvedOperation = await this.readMarker();
    const token = this.state.token;
    const refreshUsable = !!token?.refreshToken &&
      (token.refreshExpiresAt === undefined || token.refreshExpiresAt > this.now());
    return {
      configured: !!this.state.credentials,
      authenticated:
        !!this.state.credentials &&
        !!token &&
        (token.expiresAt > this.now() || refreshUsable),
      expiresAt: token?.expiresAt,
      refreshExpiresAt: token?.refreshExpiresAt,
      reauthorizationRequired: !!this.state.credentials && !refreshUsable &&
        (!token || token.expiresAt <= this.now()),
      unresolvedOperation,
    };
  }
  async configure(clientID: string, clientSecret: string): Promise<void> {
    if (typeof clientID !== "string" || typeof clientSecret !== "string")
      throw error("invalidCredentials");
    const c = { clientID: clientID.trim(), clientSecret: clientSecret.trim() };
    if (
      !validCredential(c.clientID) ||
      c.clientID.includes(":") ||
      !validCredential(c.clientSecret)
    )
      throw error("invalidCredentials");
    await this.load();
    await this.serial(async () => {
      if (
        this.state.credentials?.clientID === c.clientID &&
        this.state.credentials?.clientSecret === c.clientSecret
      )
        return;
      this.invalidate();
      await this.persist({ version: 1, credentials: c });
    });
  }
  async authorizationURL(): Promise<string> {
    await this.load();
    const expected = this.generation;
    let state: string;
    try {
      state = await this.makeState();
    } catch {
      throw error("secureStorage");
    }
    if (typeof state !== "string" || !/^[a-f0-9]{64}$/.test(state))
      throw error("secureStorage");
    return this.serial(async () => {
      this.assertGeneration(expected);
      const credentials = this.state.credentials;
      if (!credentials) throw error("credentialsRequired");
      const createdAt = this.now();
      if (!validTime(createdAt)) throw error("invalidDateRange");
      this.invalidate();
      await this.persist({ ...this.state, pending: { state, createdAt } });
      return (
        ORIGIN +
        "/v1/oauth/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: credentials.clientID,
          redirect_uri: this.callbackURL,
          state,
        }).toString()
      );
    });
  }
  async completeAuthorization(callback: string): Promise<void> {
    await this.load();
    const exchange = await this.serial(async () => {
      const credentials = this.state.credentials,
        pending = this.state.pending;
      if (!credentials) throw error("credentialsRequired");
      const age = pending ? this.now() - pending.createdAt : -1;
      if (!pending || !Number.isFinite(age) || age < 0 || age > 600_000) {
        await this.persist({ ...this.state, pending: undefined });
        throw error("authorizationExpired");
      }
      if (typeof callback !== "string") throw error("invalidCallback");
      const raw = callback.trim();
      const expectedCallback = new URL(this.callbackURL);
      const base = raw.split("?")[0];
      if (
        bytes(raw) > 16_384 ||
        /[\p{Cc}\p{Cf}\\]/u.test(raw) ||
        (base !== this.callbackURL &&
          !(expectedCallback.pathname === "/" && base === this.callbackURL + "/")) ||
        raw.includes("#")
      )
        throw error("invalidCallback");
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw error("invalidCallback");
      }
      if (
        url.origin !== expectedCallback.origin ||
        url.username ||
        url.password ||
        url.pathname !== expectedCallback.pathname
      )
        throw error("invalidCallback");
      const q = url.searchParams;
      if (
        new Set(q.keys()).size !== [...q.keys()].length ||
        q.getAll("state").length !== 1 ||
        !constantTimeEqual(q.get("state") ?? "", pending.state)
      )
        throw error("invalidCallback");
      if (q.has("error")) {
        await this.persist({ ...this.state, pending: undefined });
        throw error("authorizationDeclined");
      }
      const code = q.get("code");
      if (
        q.getAll("code").length !== 1 ||
        !code ||
        bytes(code) > 8192 ||
        /[\p{Cc}\p{Cf}]/u.test(code)
      )
        throw error("invalidCallback");
      // Consume before sending, so process restart cannot replay the authorization code.
      this.invalidate();
      await this.persist({
        ...this.state,
        pending: undefined,
        token: undefined,
      });
      return { credentials, code, generation: this.generation };
    });
    const response = await this.exchange(
      exchange.credentials,
      {
        grant_type: "authorization_code",
        code: exchange.code,
        redirect_uri: this.callbackURL,
      },
      exchange.generation,
    );
    const token = this.decodeToken(response.text);
    await this.serial(async () => {
      this.assertGeneration(exchange.generation);
      await this.persist({ ...this.state, token });
    });
  }
  async disconnect(clearCredentials = false): Promise<void> {
    if (!clearCredentials) await this.load();
    await this.serial(async () => {
      this.invalidate();
      await this.persist({
        version: 1,
        credentials: clearCredentials ? undefined : this.state.credentials,
      });
      // Intentionally never delete the reconciliation marker when logging out or changing keys.
    });
  }
  async acknowledgeReconciliation(): Promise<void> {
    if (this.writeBusy) throw error("operationBusy");
    this.writeBusy = true;
    try {
      await this.load();
      await this.serial(async () => {
        try {
          await this.vault.remove(OPERATION_KEY);
        } catch {
          this.unresolved = true;
          throw error("secureStorage");
        }
        this.unresolved = false;
        this.reviews.clear();
        this.prepareSequence++;
      });
    } finally {
      this.writeBusy = false;
    }
  }

  /** Server maintenance is non-interactive and shares the request refresh flight. */
  async maintainAuthorization(): Promise<void> {
    await this.load();
    if (!this.state.token || !this.state.credentials) return;
    await this.ensureToken(this.generation);
  }

  private async ensureToken(expected: number, rejectedToken?: Token): Promise<Token> {
    await this.load();
    this.assertGeneration(expected);
    const token = this.state.token,
      credentials = this.state.credentials;
    if (!token || !credentials) throw error("authorizationRequired");
    // A delayed 401 must reuse the token already refreshed by another read.
    if (rejectedToken && token !== rejectedToken && token.expiresAt - this.now() > 60_000) return token;
    if (this.refresh) return this.refresh;
    if (!rejectedToken && token.expiresAt - this.now() > 60_000) return token;
    if (!token.refreshToken ||
        (token.refreshExpiresAt !== undefined && token.refreshExpiresAt <= this.now()))
      throw error("authorizationRequired");
    const task = this.measured("refresh", async () => {
      try {
        const response = await this.exchange(
          credentials,
          { grant_type: "refresh_token", refresh_token: token.refreshToken! },
          expected,
        );
        const next = this.decodeToken(response.text, token);
        await this.serial(async () => {
          this.assertGeneration(expected);
          await this.persist({ ...this.state, token: next });
        });
        return next;
      } catch (e) {
        this.assertGeneration(expected);
        if (
          e instanceof TradingError &&
          e.code === "authorizationRequired"
        ) {
          await this.serial(async () => {
            this.assertGeneration(expected);
            this.invalidate();
            await this.persist({ ...this.state, token: undefined });
          });
        }
        throw sanitized(e);
      }
    });
    this.refresh = task;
    try {
      return await task;
    } finally {
      if (this.refresh === task) this.refresh = undefined;
    }
  }
  private decodeToken(text: string, previous?: Token): Token {
    const value = json(text);
    if (
      !isObject(value) ||
      !validToken(value.access_token) ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      value.expires_in > 86_400 ||
      (value.token_type != null &&
        (typeof value.token_type !== "string" ||
          value.token_type.toLowerCase() !== "bearer")) ||
      (value.refresh_token != null && !validToken(value.refresh_token))
    )
      throw invalidResponse();
    const expiresAt = this.now() + value.expires_in * 1000;
    if (!validTime(expiresAt)) throw invalidResponse();
    return {
      accessToken: value.access_token,
      refreshToken:
        (value.refresh_token as string | undefined) ?? previous?.refreshToken,
      expiresAt,
      // Rotating the refresh token does not extend the original authorization.
      // Older sessions have unknown age; never invent a fresh seven-day window.
      refreshIssuedAt: previous ? previous.refreshIssuedAt : this.now(),
      refreshExpiresAt: previous ? previous.refreshExpiresAt : this.now() + 7 * DAY,
    };
  }
  private async exchange(
    credentials: Credentials,
    form: Record<string, string>,
    expected: number,
  ): Promise<HTTPResult> {
    this.assertGeneration(expected);
    const response = await this.send(
      "/v1/oauth/token",
      undefined,
      "POST",
      new URLSearchParams(form).toString(),
      basicAuthorization(credentials),
      "application/x-www-form-urlencoded",
    );
    this.assertGeneration(expected);
    if (response.status !== 200) {
      // Only a definitive OAuth invalid_grant means the refresh credential died.
      // Never expose provider descriptions or erase tokens on network/config errors.
      if (form.grant_type === "refresh_token" &&
          (response.status === 400 || response.status === 401)) {
        let problem: unknown;
        try { problem = JSON.parse(response.text); } catch { /* sanitized below */ }
        if (isObject(problem) && problem.error === "invalid_grant")
          throw error("authorizationRequired");
      }
      throw httpError(response.status);
    }
    return response;
  }
  private async send(
    path: string,
    query: URLSearchParams | undefined,
    method: string,
    body: string | undefined,
    authorization: string,
    contentType?: string,
  ): Promise<HTTPResult> {
    const url =
      ORIGIN +
      path +
      (query && [...query.keys()].length ? "?" + query.toString() : "");
    validateRequest(url, method, body, contentType);
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(error("network"));
      }, this.timeout);
    });
    try {
      const operation = (async () => {
        const response = await this.fetcher(url, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: authorization,
            ...(contentType ? { "Content-Type": contentType } : {}),
          },
          body,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        });
        if (
          response.redirected ||
          response.url !== url ||
          (response.status >= 300 && response.status < 400)
        )
          throw error("redirectRejected");
        if (
          !Number.isInteger(response.status) ||
          response.status < 100 ||
          response.status > 599
        )
          throw invalidResponse();
        const length = response.headers.get("content-length");
        if (
          length !== null &&
          (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY_BYTES)
        )
          throw invalidResponse();
        const text = await response.text();
        if (bytes(text) > MAX_BODY_BYTES) throw invalidResponse();
        return {
          status: response.status,
          text,
          location: response.headers.get("location"),
        };
      })();
      return await Promise.race([operation, timeout]);
    } catch (e) {
      throw sanitized(e);
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  private async read(
    path: string,
    query?: URLSearchParams,
    expected = this.generation,
  ): Promise<unknown> {
    let token = await this.ensureToken(expected);
    for (let attempt = 0; attempt < 2; attempt++) {
      this.assertGeneration(expected);
      const result = await this.send(path, query, "GET", undefined, "Bearer " + token.accessToken);
      this.assertGeneration(expected);
      if (result.status === 401 && attempt === 0) {
        token = await this.ensureToken(expected, token);
        continue;
      }
      if (result.status !== 200) throw httpError(result.status);
      return json(result.text);
    }
    throw httpError(401);
  }

  private async hash(
    accountID: string,
    fresh = false,
    expected = this.generation,
  ): Promise<string> {
    if (
      typeof accountID !== "string" ||
      !accountID ||
      accountID.length > 64 ||
      /[\s\p{Cc}\p{Cf}]/u.test(accountID)
    )
      throw error("invalidTradingAccount");
    if (!fresh && this.hashes.has(accountID)) {
      this.assertGeneration(expected);
      return this.hashes.get(accountID)!;
    }
    const values = decodeAccountIdentifiers(
      await this.read(
        "/trader/v1/accounts/accountNumbers",
        undefined,
        expected,
      ),
    );
    this.assertGeneration(expected);
    this.hashes = values;
    const hash = values.get(accountID);
    if (!hash) throw error("invalidTradingAccount");
    return hash;
  }
  async accounts(): Promise<Account[]> {
    await this.load();
    return decodeAccounts(
      await this.read(
        "/trader/v1/accounts",
        new URLSearchParams({ fields: "positions" }),
      ),
    );
  }
  private async executableQuotes(
    symbols: string[],
    expected = this.generation,
  ): Promise<Quote[]> {
    return decodeQuotes(
      await this.read(
        "/marketdata/v1/quotes",
        new URLSearchParams({ symbols: symbols.join(",") }),
        expected,
      ),
      symbols,
    );
  }
  async quotes(
    symbols: string[],
    options?: { fundamentals?: boolean },
  ): Promise<Quote[]> {
    const normalized = normalizedSymbols(symbols);
    await this.load();
    const expected = this.generation;
    const result = await this.executableQuotes(normalized, expected);
    if (
      options?.fundamentals !== false &&
      normalized.length === 1 &&
      isStockAsset(result[0]?.assetMainType)
    ) {
      try {
        const metadata = await this.read(
          "/marketdata/v1/instruments",
          new URLSearchParams({
            symbol: normalized[0],
            projection: "fundamental",
          }),
          expected,
        );
        Object.assign(result[0], decodeFundamentals(metadata, normalized[0]));
      } catch (e) {
        this.assertGeneration(expected);
        if (
          e instanceof TradingError &&
          ["authorizationRequired", "secureStorage"].includes(e.code)
        )
          throw e;
        // This optional endpoint can be unavailable without removing the valid quote.
      }
    }
    this.assertGeneration(expected);
    return result;
  }
  /** Server-local credential provider; never expose through a remote API. */
  async marketCredentials(): Promise<StreamCredentials> {
    await this.load();
    return this.streamCredentials(this.generation);
  }
  private async streamCredentials(expected: number): Promise<StreamCredentials> {
    const prefs = await this.read(
      "/trader/v1/userPreference",
      undefined,
      expected,
    );
    const token = await this.ensureToken(expected);
    this.assertGeneration(expected);
    const info = (
      prefs as { streamerInfo?: Record<string, unknown>[] } | null
    )?.streamerInfo?.[0];
    const field = (key: string): string => {
      const value = info?.[key];
      if (
        typeof value !== "string" ||
        !value ||
        value.length > 2048 ||
        /[\s\u0000-\u001f\u007f]/u.test(value)
      )
        throw invalidResponse();
      return value;
    };
    return {
      url: field("streamerSocketUrl"),
      accessToken: token.accessToken,
      customerId: field("schwabClientCustomerId"),
      correlId: field("schwabClientCorrelId"),
      channel: field("schwabClientChannel"),
      functionId: field("schwabClientFunctionId"),
    };
  }
  subscribeMarket(
    symbol: string,
    callbacks: MarketStreamCallbacks,
  ): () => void {
    const normalized = normalizedSymbols([symbol])[0];
    const expected = this.generation;
    let stopped = false;
    const stopTransport = this.openStream(
      normalized,
      async (): Promise<StreamCredentials> => {
        if (stopped) throw error("sessionChanged");
        const credentials = await this.streamCredentials(expected);
        if (stopped) throw error("sessionChanged");
        return credentials;
      },
      callbacks,
    );
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stopTransport();
      this.streams.delete(stop);
    };
    this.streams.add(stop);
    return stop;
  }
  async history(symbol: string, range: HistoryRange): Promise<History> {
    const normalized = normalizedSymbols([symbol])[0];
    await this.load();
    const end = this.now(),
      expected = this.generation;
    const history = decodeHistory(
      await this.read(
        "/marketdata/v1/pricehistory",
        historyQuery(normalized, range, end),
        expected,
      ),
      normalized,
      { receivedAt: this.now(), range },
    );
    if (range === "minute60" || range === "minute120")
      history.candles = aggregateMinutes(
        history.candles,
        range === "minute60" ? 60 : 120,
        end,
        true,
      );
    return history;
  }
  private async ordersWithHash(
    hash: string,
    expected: number,
  ): Promise<Order[]> {
    const to = this.now();
    return this.ordersBetween(hash, Math.max(0, to - 30 * DAY), to, expected);
  }
  private async ordersBetween(
    hash: string,
    from: number,
    to: number,
    expected: number,
  ): Promise<Order[]> {
    if (!validTime(from) || !validTime(to) || from > to || to - from > 60 * DAY)
      throw error("invalidDateRange");
    return decodeOrders(
      await this.read(
        pathForOrders(hash),
        new URLSearchParams({
          maxResults: "200",
          fromEnteredTime: new Date(from).toISOString(),
          toEnteredTime: new Date(to).toISOString(),
        }),
        expected,
      ),
    );
  }
  async orders(accountID: string): Promise<Order[]> {
    await this.load();
    const expected = this.generation;
    return this.ordersWithHash(
      await this.hash(accountID, false, expected),
      expected,
    );
  }
  /** Read-only history for fill export; one window of at most 60 days per call. */
  async orderHistory(accountID: string, from: number, to: number): Promise<Order[]> {
    await this.load();
    const expected = this.generation;
    if (!validTime(from) || !validTime(to) || from > to || to - from > 60 * DAY)
      throw error("invalidDateRange");
    return this.ordersBetween(
      await this.hash(accountID, false, expected),
      from,
      to,
      expected,
    );
  }
  private async detailWithHash(
    hash: string,
    id: string,
    expected: number,
  ): Promise<Order> {
    const order = decodeOrder(
      await this.read(pathForOrders(hash, id), undefined, expected),
    );
    if (order.id !== id) throw invalidResponse();
    return order;
  }
  async orderDetail(accountID: string, id: string): Promise<Order> {
    await this.load();
    const expected = this.generation;
    return this.detailWithHash(
      await this.hash(accountID, false, expected),
      id,
      expected,
    );
  }
  private async freshContext(
    accountID: string,
    draft: Draft,
    expected: number,
    replacementID?: string,
  ): Promise<{
    account: Account;
    quote: Quote;
    hash: string;
    availableShares: number;
    price?: number;
  }> {
    return this.measured("validation", async () => {
      const [accounts, quotes, { hash, orders, replacement }] = await Promise.all([
        this.read(
          "/trader/v1/accounts",
          new URLSearchParams({ fields: "positions" }),
          expected,
        ).then(decodeAccounts),
        this.executableQuotes([draft.symbol], expected),
        // Orders depend on the fresh account hash, not on accounts or quotes.
        // Start both order reads immediately while the independent checks finish.
        this.hash(accountID, true, expected).then(async (hash) => {
          const [orders, replacement] = await Promise.all([
            this.ordersWithHash(hash, expected),
            replacementID === undefined
              ? Promise.resolve(undefined)
              : this.detailWithHash(hash, replacementID, expected),
          ]);
          return { hash, orders, replacement };
        }),
      ]);
      this.assertGeneration(expected);
      const account = accounts.find((a) => a.id === accountID),
        quote = quotes.find((q) => q.symbol === draft.symbol);
      if (!account) throw error("invalidTradingAccount");
      if (!quote || !isStockAsset(quote.assetMainType))
        throw error("unsupportedAsset");
      if (orders.length >= 200) throw error("ordersTruncated");
      if (replacement !== undefined) validateReplacement(replacement, draft);
      this.assertGeneration(expected);
      const availableShares = maximumSell(
        account,
        draft.symbol,
        orders,
        true,
        replacementID,
        quote,
      );
      if (
        draft.side === "SELL" &&
        (availableShares === undefined || draft.quantity > availableShares)
      )
        throw error("insufficientShares");
      const price = referencePrice(draft, quote),
        maxBuy = maximumBuy(account, price);
      if (
        draft.side === "BUY" &&
        (maxBuy === undefined || draft.quantity > maxBuy)
      )
        throw error("insufficientFunds");
      return {
        account,
        quote,
        hash,
        availableShares: availableShares ?? 0,
        price,
      };
    });
  }
  async prepare(
    accountID: string,
    draft: Draft,
    replacementID?: string,
  ): Promise<Prepared> {
    if (this.writeBusy) throw error("operationBusy");
    validateDraft(draft);
    if (replacementID !== undefined && !validOrderID(replacementID))
      throw error("invalidOrderIdentifier");
    const copy: Draft = Object.freeze({
      symbol: draft.symbol,
      side: draft.side,
      kind: draft.kind,
      quantity: draft.quantity,
      limitPrice: draft.limitPrice,
      stopPrice: draft.stopPrice,
      duration: draft.duration,
      session: draft.session ?? "NORMAL",
    });
    this.reviews.clear();
    const sequence = ++this.prepareSequence;
    await this.load();
    const expected = this.generation;
    if (await this.readMarker()) throw error("orderOutcomeUnknown");
    const context = await this.freshContext(
      accountID,
      copy,
      expected,
      replacementID,
    );
    this.assertGeneration(expected);
    if (sequence !== this.prepareSequence || this.writeBusy)
      throw error("reviewExpired");
    const snapshot = await this.snapshot(accountID, copy, context, expected, replacementID);
    if (sequence !== this.prepareSequence || this.writeBusy)
      throw error("reviewExpired");
    this.reviews.set(snapshot.id, {
      snapshot,
      generation: expected,
      accountHash: context.hash,
    });
    return snapshot;
  }
  private async snapshot(
    accountID: string,
    copy: Draft,
    context: Awaited<ReturnType<SchwabBroker["freshContext"]>>,
    expected: number,
    replacementID?: string,
  ): Promise<Prepared> {
    let random: string;
    try {
      random = await this.makeState();
    } catch {
      throw error("secureStorage");
    }
    if (typeof random !== "string" || !/^[a-f0-9]{64}$/.test(random))
      throw error("secureStorage");
    this.assertGeneration(expected);
    const estimatedValue =
      context.price === undefined ? undefined : context.price * copy.quantity;
    return Object.freeze({
      id: random + "-" + ++this.nonce,
      draft: copy,
      accountID,
      accountDisplay: context.account.displayNumber,
      quote: Object.freeze({ ...context.quote }),
      estimatedValue:
        estimatedValue !== undefined && Number.isFinite(estimatedValue)
          ? estimatedValue
          : undefined,
      availableShares: context.availableShares,
      buyingPower: context.account.buyingPower,
      preparedAt: this.now(),
      replacementOrderID: replacementID,
      isDemo: false,
    });
  }
  /** One locked validation/write boundary for explicit quick-mode submissions. */
  async submitQuick(accountID: string, draft: Draft): Promise<{
    snapshot: Prepared;
    result: { orderID?: string };
  }> {
    if (this.writeBusy) throw error("operationBusy");
    validateDraft(draft);
    const copy: Draft = Object.freeze({
      symbol: draft.symbol, side: draft.side, kind: draft.kind,
      quantity: draft.quantity, limitPrice: draft.limitPrice,
      stopPrice: draft.stopPrice, duration: draft.duration,
      session: draft.session ?? "NORMAL",
    });
    this.writeBusy = true;
    this.reviews.clear();
    this.prepareSequence++;
    try {
      await this.load();
      const expected = this.generation;
      if (await this.readMarker()) throw error("orderOutcomeUnknown");
      const validationStarted = this.now();
      const context = await this.freshContext(accountID, copy, expected);
      const snapshot = await this.snapshot(accountID, copy, context, expected);
      const validationAge = this.now() - validationStarted;
      if (!Number.isFinite(validationAge) || validationAge < 0 || validationAge > 60_000)
        throw error("reviewExpired");
      const result = await this.writeRequest(context.hash, "POST", expected, undefined, encodeDraft(copy), validationStarted);
      return { snapshot, result };
    } finally {
      this.writeBusy = false;
    }
  }
  async submit(prepared: Prepared): Promise<{ orderID?: string }> {
    if (this.writeBusy) throw error("operationBusy");
    const review = this.reviews.get(prepared?.id);
    // Identity plus a private frozen copy rejects constructed, altered, replayed, and cross-session reviews.
    this.reviews.clear();
    this.prepareSequence++;
    if (
      !review ||
      review.snapshot !== prepared ||
      review.generation !== this.generation ||
      prepared.isDemo ||
      this.now() < prepared.preparedAt ||
      this.now() - prepared.preparedAt > 120_000
    )
      throw error("reviewExpired");
    this.writeBusy = true;
    try {
      if (await this.readMarker()) throw error("orderOutcomeUnknown");
      const context = await this.freshContext(
        prepared.accountID,
        prepared.draft,
        review.generation,
        prepared.replacementOrderID,
      );
      if (context.hash !== review.accountHash) throw error("sessionChanged");
      return await this.writeRequest(
        context.hash,
        prepared.replacementOrderID === undefined ? "POST" : "PUT",
        review.generation,
        prepared.replacementOrderID,
        encodeDraft(prepared.draft),
      );
    } finally {
      this.writeBusy = false;
    }
  }
  async cancel(accountID: string, orderID: string): Promise<void> {
    if (this.writeBusy) throw error("operationBusy");
    if (!validOrderID(orderID)) throw error("invalidOrderIdentifier");
    this.writeBusy = true;
    this.reviews.clear();
    this.prepareSequence++;
    try {
      await this.load();
      const expected = this.generation;
      if (await this.readMarker()) throw error("orderOutcomeUnknown");
      const hash = await this.hash(accountID, true, expected);
      const order = await this.detailWithHash(hash, orderID, expected);
      if (!order.cancelable) throw error("orderChanged");
      await this.writeRequest(hash, "DELETE", expected, orderID);
    } finally {
      this.writeBusy = false;
    }
  }
  private async writeRequest(
    hash: string,
    method: "POST" | "PUT" | "DELETE",
    expected: number,
    orderID?: string,
    body?: string,
    validationStarted?: number,
  ): Promise<{ orderID?: string }> {
    const validationExpired = () => {
      if (validationStarted === undefined) return false;
      const age = this.now() - validationStarted;
      return !Number.isFinite(age) || age < 0 || age > 60_000;
    };
    const token = await this.ensureToken(expected),
      path = pathForOrders(hash, orderID);
    const contentType = body ? "application/json" : undefined;
    validateRequest(ORIGIN + path, method, body, contentType);
    if (validationExpired()) throw error("reviewExpired");
    await this.serial(async () => {
      this.assertGeneration(expected);
      try {
        if ((await this.vault.get(OPERATION_KEY)) !== null) {
          this.unresolved = true;
          throw error("orderOutcomeUnknown");
        }
        // The marker contains no account, symbol, credentials, or order body.
        await this.vault.set(
          OPERATION_KEY,
          JSON.stringify({ version: 1, pending: true, createdAt: this.now() }),
        );
        this.unresolved = true;
      } catch (e) {
        this.unresolved = true;
        throw e instanceof TradingError ? e : error("secureStorage");
      }
    });
    // Token renewal and durable storage can be slow. Recheck immediately before
    // dispatch, after all awaits; this branch definitively has not sent a write.
    if (validationExpired()) {
      try {
        await this.serial(async () => {
          this.assertGeneration(expected);
          await this.vault.remove(OPERATION_KEY);
          this.unresolved = false;
        });
      } catch {
        throw error("orderOutcomeUnknown");
      }
      throw error("reviewExpired");
    }
    let response: HTTPResult;
    try {
      this.assertGeneration(expected);
      // Never retry a POST, PUT, or DELETE, including token expiry or a lost response.
      response = await this.measured("submit", () => this.send(
        path,
        undefined,
        method,
        body,
        "Bearer " + token.accessToken,
        contentType,
      ), result => result.status === (method === "DELETE" ? 200 : 201));
      this.assertGeneration(expected);
    } catch {
      throw error("orderOutcomeUnknown");
    }
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408
    ) {
      try {
        await this.serial(async () => {
          this.assertGeneration(expected);
          if (
            response.status === 401 &&
            this.state.token?.accessToken === token.accessToken
          ) {
            // Rejected writes are never replayed. Preserve refresh credentials
            // so the next independent request can recover authorization.
            await this.persist({ ...this.state, token: { ...token, expiresAt: this.now() } });
          }
          await this.vault.remove(OPERATION_KEY);
          this.unresolved = false;
        });
      } catch {
        throw error("orderOutcomeUnknown");
      }
      throw httpError(response.status);
    }
    if (response.status !== (method === "DELETE" ? 200 : 201))
      throw error("orderOutcomeUnknown");
    const receivedID =
      method === "DELETE"
        ? orderID
        : orderIDFromLocation(response.location, hash);
    if (receivedID !== undefined) {
      try {
        await this.serial(async () => {
          this.assertGeneration(expected);
          await this.vault.remove(OPERATION_KEY);
          this.unresolved = false;
        });
      } catch {
        throw error("orderOutcomeUnknown");
      }
    }
    return { orderID: receivedID };
  }
}
