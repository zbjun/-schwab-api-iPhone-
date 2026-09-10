import type { Candle, Quote } from "./types";

export interface StreamCredentials {
  url: string;
  accessToken: string;
  customerId: string;
  correlId: string;
  channel: string;
  functionId: string;
}

export interface MarketStreamCallbacks {
  onQuote: (
    quote: Partial<Quote> & { symbol: string; tradeTime?: number },
  ) => void;
  onFormingCandle?: (candle: Candle) => void;
  onCandle: (candle: Candle) => void;
  onStatus: (status: "connecting" | "live" | "fallback") => void;
}

export interface MarketWebSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

type Timer = ReturnType<typeof setTimeout>;
export interface MarketStreamOptions {
  createWebSocket?: (url: string) => MarketWebSocket;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
}

type Entry = Record<string, unknown>;
type StreamQuote = Parameters<MarketStreamCallbacks["onQuote"]>[0];
const object = (value: unknown): value is Entry =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Credentials must never be sent to a server outside Schwab's own domains. */
export function isSchwabStreamURL(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      !url.username &&
      !url.password &&
      !value.includes("?") &&
      !value.includes("#") &&
      (!url.port || url.port === "443") &&
      ["schwab.com", "schwabapi.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    );
  } catch {
    return false;
  }
}

function boundedText(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1_048_576) return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
    if (bytes > 1_048_576) return false;
  }
  return true;
}

// Schwab's numeric fields are documented by schwab-py's LevelOneEquityFields
// and ChartEquityFields: https://github.com/alexgolec/schwab-py/blob/main/schwab/streaming.py
const quoteFields = {
  "1": "bidPrice",
  "2": "askPrice",
  "3": "lastPrice",
  "8": "totalVolume",
  "10": "highPrice",
  "11": "lowPrice",
  "12": "closePrice",
  "17": "openPrice",
  "18": "netChange",
  "19": "high52Week",
  "20": "low52Week",
  "21": "peRatio",
  "34": "quoteTime",
  "35": "tradeTime",
  "42": "netPercentChange",
} as const;
const fields =
  "0,1,2,3,8,10,11,12,13,15,17,18,19,20,21,28,29,30,31,32,33,34,35,36,42";

/** Backwards-compatible single-symbol client. */
export function openMarketStream(
  symbol: string,
  credentials: () => Promise<StreamCredentials>,
  callbacks: MarketStreamCallbacks,
  options: MarketStreamOptions = {},
): () => void {
  return openMultiMarketStream([symbol], credentials, {
    onQuote: callbacks.onQuote,
    onFormingCandle: (_, candle) => callbacks.onFormingCandle?.(candle),
    onCandle: (_, candle) => callbacks.onCandle(candle),
    onStatus: callbacks.onStatus,
  }, options);
}

export interface MultiMarketStreamCallbacks {
  onQuote: MarketStreamCallbacks["onQuote"];
  onFormingCandle?: (symbol: string, candle: Candle) => void;
  onCandle: (symbol: string, candle: Candle) => void;
  onStatus: MarketStreamCallbacks["onStatus"];
}

/** One authenticated socket for a bounded symbol set; sequences stay per symbol. */
export function openMultiMarketStream(
  symbols: string[],
  credentials: () => Promise<StreamCredentials>,
  callbacks: MultiMarketStreamCallbacks,
  options: MarketStreamOptions = {},
): () => void {
  symbols = [...new Set(symbols)];
  if (!symbols.length || symbols.length > 32 || symbols.some((symbol) => !/^[A-Z0-9][A-Z0-9.\/-]{0,19}$/.test(symbol)))
    throw new Error("Invalid market symbol set");
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  // Resolve the native API only when connecting; importing this file is safe in Node.
  const createSocket =
    options.createWebSocket ??
    ((url: string) => new WebSocket(url) as unknown as MarketWebSocket);
  let stopped = false;
  let generation = 0;
  let socket: MarketWebSocket | undefined;
  let phase: "connecting" | "login" | "subscribing" | "live" = "connecting";
  let retry = 0;
  let deadline: Timer | undefined;
  let heartbeat: Timer | undefined;
  let reconnect: Timer | undefined;
  let flushTimer: Timer | undefined;
  function freshState(symbol: string) {
    return {
      quote: { symbol } as StreamQuote,
      pendingQuote: undefined as StreamQuote | undefined,
      pendingCandles: new Map<number, Candle>(),
      pendingFormingCandles: new Map<number, Candle>(),
      quoteSequence: -1, chartSequence: -1, chartTime: -1,
      lastCandle: undefined as Candle | undefined,
    };
  }
  const states = new Map(symbols.map((symbol) => [symbol, freshState(symbol)]));
  function clearPending() {
    for (const state of states.values()) {
      state.pendingQuote = undefined;
      state.pendingCandles.clear();
      state.pendingFormingCandles.clear();
    }
  }

  function report(status: Parameters<MarketStreamCallbacks["onStatus"]>[0]) {
    if (!stopped) callbacks.onStatus(status);
  }
  function clearTimers() {
    for (const timer of [deadline, heartbeat, reconnect, flushTimer]) {
      if (timer !== undefined) cancel(timer);
    }
    deadline = heartbeat = reconnect = flushTimer = undefined;
  }
  function closeSocket() {
    const previous = socket;
    socket = undefined;
    if (!previous) return;
    previous.onopen =
      previous.onmessage =
      previous.onerror =
      previous.onclose =
        null;
    try {
      previous.close();
    } catch {
      /* Already closed. */
    }
  }
  function fail() {
    if (stopped) return;
    generation++;
    clearTimers();
    closeSocket();
    clearPending();
    report("fallback");
    if (stopped) return;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(retry++, 4));
    reconnect = schedule(() => {
      reconnect = undefined;
      void connect();
    }, delay);
  }
  function armDeadline() {
    if (deadline !== undefined) cancel(deadline);
    deadline = schedule(fail, 10_000);
  }
  function armHeartbeat() {
    if (heartbeat !== undefined) cancel(heartbeat);
    heartbeat = schedule(fail, 45_000);
  }
  function queueFlush() {
    if (phase !== "live" || flushTimer !== undefined) return;
    flushTimer = schedule(() => {
      flushTimer = undefined;
      for (const [symbol, state] of states) {
        const nextQuote = state.pendingQuote;
        const formingCandles = [...state.pendingFormingCandles.values()].sort(
          (a, b) => a.time - b.time,
        );
        const candles = [...state.pendingCandles.values()].sort(
          (a, b) => a.time - b.time,
        );
        state.pendingQuote = undefined;
        state.pendingCandles.clear();
        state.pendingFormingCandles.clear();
        if (stopped) return;
        for (const candle of formingCandles) {
          if (stopped) return;
          callbacks.onFormingCandle?.(symbol, candle);
        }
        if (stopped) return;
        if (nextQuote) callbacks.onQuote(nextQuote);
        for (const candle of candles) {
          if (stopped) break;
          callbacks.onCandle(symbol, candle);
        }
      }
    }, 250);
  }
  const timestamp = (value: unknown): value is number =>
    finite(value) &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= now() + 60_000;
  function matches(entry: Entry, symbol: string) {
    return (
      (entry.key === symbol || entry["0"] === symbol) &&
      (entry.key === undefined || entry.key === symbol) &&
      (entry["0"] === undefined || entry["0"] === symbol)
    );
  }
  function readQuote(entry: Entry, symbol: string, state: ReturnType<typeof freshState>) {
    if (!matches(entry, symbol)) return;
    const delta: StreamQuote = { symbol };
    for (const [field, name] of Object.entries(quoteFields)) {
      if (entry[field] === undefined) continue;
      const value = entry[field];
      if (!finite(value)) return;
      if ((name === "quoteTime" || name === "tradeTime") && !timestamp(value))
        return;
      if (
        name !== "netChange" &&
        name !== "netPercentChange" &&
        name !== "peRatio" &&
        value < 0
      )
        return;
      delta[name] = value;
    }
    if (
      entry.seq !== undefined &&
      (!finite(entry.seq) ||
        !Number.isSafeInteger(entry.seq) ||
        entry.seq <= state.quoteSequence)
    )
      return;
    if (
      delta.quoteTime !== undefined &&
      delta.quoteTime < (state.quote.quoteTime ?? 0)
    )
      return;
    if (
      delta.tradeTime !== undefined &&
      delta.tradeTime < (state.quote.tradeTime ?? 0)
    )
      return;
    if (entry.delayed !== undefined) {
      if (typeof entry.delayed !== "boolean") return;
      delta.isRealtime = !entry.delayed;
    }
    if (entry.assetMainType !== undefined) {
      if (
        typeof entry.assetMainType !== "string" ||
        entry.assetMainType.length > 64
      )
        return;
      delta.assetMainType = entry.assetMainType;
    }
    if (entry.assetSubType !== undefined) {
      if (
        typeof entry.assetSubType !== "string" ||
        entry.assetSubType.length > 64
      )
        return;
      delta.assetSubType = entry.assetSubType;
    }
    if (entry["15"] !== undefined) {
      if (typeof entry["15"] !== "string" || entry["15"].length > 512) return;
      delta.description = entry["15"];
    }
    if (Object.keys(delta).length === 1) return;
    if (finite(entry.seq)) state.quoteSequence = entry.seq;
    state.quote = { ...state.quote, ...delta };
    // Collect trades before the UI throttle so first open and transient extrema
    // survive even when the displayed quote only retains the latest price.
    const { lastPrice, tradeTime } = state.quote;
    if (
      (delta.lastPrice !== undefined || delta.tradeTime !== undefined) &&
      state.quote.isRealtime === true &&
      finite(lastPrice) && lastPrice > 0 &&
      finite(tradeTime) &&
      tradeTime >= now() - 60_000 && tradeTime <= now() + 5_000
    ) {
      const time = Math.floor(tradeTime / 60_000) * 60_000;
      const previous = state.pendingFormingCandles.get(time);
      state.pendingFormingCandles.set(time, {
        time,
        open: previous?.open ?? lastPrice,
        high: Math.max(previous?.high ?? lastPrice, lastPrice),
        low: Math.min(previous?.low ?? lastPrice, lastPrice),
        close: lastPrice,
        provisional: true,
      });
      if (state.pendingFormingCandles.size > 256)
        state.pendingFormingCandles.delete(state.pendingFormingCandles.keys().next().value!);
    }
    state.pendingQuote = { ...state.quote };
    queueFlush();
  }
  function readCandle(entry: Entry, symbol: string, state: ReturnType<typeof freshState>) {
    if (!matches(entry, symbol) || !timestamp(entry["7"])) return;
    const [sequence, open, high, low, close, volume] = [
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ].map((key) => entry[key]);
    if (![sequence, open, high, low, close, volume].every(finite)) return;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) return;
    const candle: Candle = {
      time: Math.floor(entry["7"] / 60_000) * 60_000,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: volume as number,
    };
    if (
      candle.low < 0 ||
      candle.volume! < 0 ||
      candle.high < candle.low ||
      candle.open < candle.low ||
      candle.open > candle.high ||
      candle.close < candle.low ||
      candle.close > candle.high
    )
      return;
    if (
      candle.time < state.chartTime ||
      (candle.time === state.chartTime && (sequence as number) < state.chartSequence)
    )
      return;
    const identical =
      state.lastCandle &&
      candle.time === state.lastCandle.time &&
      candle.open === state.lastCandle.open &&
      candle.high === state.lastCandle.high &&
      candle.low === state.lastCandle.low &&
      candle.close === state.lastCandle.close &&
      candle.volume === state.lastCandle.volume;
    state.chartTime = candle.time;
    state.chartSequence = sequence as number;
    state.lastCandle = candle;
    if (identical) return;
    state.pendingCandles.set(candle.time, candle);
    if (state.pendingCandles.size > 256)
      state.pendingCandles.delete(state.pendingCandles.keys().next().value!);
    queueFlush();
  }
  async function connect() {
    if (stopped) return;
    const current = ++generation;
    const active = () => !stopped && current === generation;
    phase = "connecting";
    for (const symbol of symbols) states.set(symbol, freshState(symbol));
    report("connecting");
    if (!active()) return;
    armDeadline();
    try {
      const auth = await credentials();
      if (!active()) return;
      if (
        !isSchwabStreamURL(auth.url) ||
        [
          auth.accessToken,
          auth.customerId,
          auth.correlId,
          auth.channel,
          auth.functionId,
        ].some((value) => typeof value !== "string" || !value.trim())
      )
        throw new Error("Invalid stream credentials");
      const ws = createSocket(auth.url);
      socket = ws;
      const acknowledged = new Set<string>();
      const request = (
        id: string,
        service: string,
        command: string,
        parameters: Entry,
      ) => ({
        requestid: id,
        service,
        command,
        SchwabClientCustomerId: auth.customerId,
        SchwabClientCorrelId: auth.correlId,
        parameters,
      });
      ws.onopen = () => {
        if (!active() || phase !== "connecting") return;
        phase = "login";
        armDeadline();
        try {
          ws.send(
            JSON.stringify({
              requests: [
                request("0", "ADMIN", "LOGIN", {
                  Authorization: auth.accessToken,
                  SchwabClientChannel: auth.channel,
                  SchwabClientFunctionId: auth.functionId,
                }),
              ],
            }),
          );
        } catch {
          fail();
        }
      };
      ws.onmessage = (event) => {
        if (!active()) return;
        if (!boundedText(event.data)) {
          fail();
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (
          !object(message) ||
          ![message.response, message.data, message.notify].some(Array.isArray)
        )
          return;
        armHeartbeat();
        if (Array.isArray(message.response))
          for (const response of message.response) {
            if (!active()) return;
            if (!object(response) || !object(response.content)) continue;
            const id =
              typeof response.requestid === "number" &&
              Number.isInteger(response.requestid) &&
              response.requestid >= 0 &&
              response.requestid <= 2
                ? String(response.requestid)
                : response.requestid;
            const login =
              phase === "login" &&
              id === "0" &&
              response.service === "ADMIN" &&
              response.command === "LOGIN";
            const subscription =
              phase === "subscribing" &&
              response.command === "SUBS" &&
              ((id === "1" && response.service === "LEVELONE_EQUITIES") ||
                (id === "2" && response.service === "CHART_EQUITY"));
            if (!login && !subscription) continue;
            if (response.content.code !== 0) {
              fail();
              return;
            }
            if (login) {
              phase = "subscribing";
              armDeadline();
              try {
                ws.send(
                  JSON.stringify({
                    requests: [
                      request("1", "LEVELONE_EQUITIES", "SUBS", {
                        keys: symbols.join(","),
                        fields,
                      }),
                      request("2", "CHART_EQUITY", "SUBS", {
                        keys: symbols.join(","),
                        fields: "0,1,2,3,4,5,6,7,8",
                      }),
                    ],
                  }),
                );
              } catch {
                fail();
                return;
              }
            } else {
              acknowledged.add(id as string);
              if (acknowledged.size === 2) {
                phase = "live";
                retry = 0;
                if (deadline !== undefined) cancel(deadline);
                deadline = undefined;
                report("live");
                if (active() && [...states.values()].some((state) => state.pendingQuote || state.pendingCandles.size))
                  queueFlush();
              }
            }
          }
        if (
          !active() ||
          (phase !== "live" && phase !== "subscribing") ||
          !Array.isArray(message.data)
        )
          return;
        for (const update of message.data) {
          if (!object(update) || !Array.isArray(update.content)) continue;
          for (const entry of update.content) {
            if (!object(entry)) continue;
            const symbol = typeof entry.key === "string" ? entry.key : entry["0"];
            if (typeof symbol !== "string") continue;
            const state = states.get(symbol);
            if (!state) continue;
            if (update.service === "LEVELONE_EQUITIES") readQuote(entry, symbol, state);
            if (update.service === "CHART_EQUITY") readCandle(entry, symbol, state);
          }
        }
      };
      ws.onerror = ws.onclose = () => {
        if (active()) fail();
      };
    } catch {
      if (active()) fail();
    }
  }
  void connect();
  return () => {
    if (stopped) return;
    stopped = true;
    generation++;
    clearTimers();
    closeSocket();
    clearPending();
  };
}
