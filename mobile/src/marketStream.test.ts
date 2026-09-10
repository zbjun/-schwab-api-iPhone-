import assert from "node:assert/strict";
import test from "node:test";
import { isSchwabStreamURL, openMarketStream, openMultiMarketStream } from "./marketStream.ts";
import type {
  MarketWebSocket,
  MarketStreamCallbacks,
  StreamCredentials,
} from "./marketStream.ts";
import type { Candle } from "./types.ts";

type Timer = ReturnType<typeof setTimeout>;
const start = 1_800_000_000_000;
function clock() {
  let time = start;
  let serial = 0;
  const tasks = new Map<Timer, { at: number; callback: () => void }>();
  return {
    now: () => time,
    setTimeout(callback: () => void, delay: number) {
      const id = ++serial as unknown as Timer;
      tasks.set(id, { at: time + delay, callback });
      return id;
    },
    clearTimeout(id: Timer) {
      tasks.delete(id);
    },
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const task = [...tasks.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!task) break;
        time = task[1].at;
        tasks.delete(task[0]);
        task[1].callback();
      }
      time = end;
    },
    pending: () => tasks.size,
    nextDelay: () =>
      Math.min(...[...tasks.values()].map((task) => task.at - time)),
  };
}
class Socket implements MarketWebSocket {
  onopen: MarketWebSocket["onopen"] = null;
  onmessage: MarketWebSocket["onmessage"] = null;
  onerror: MarketWebSocket["onerror"] = null;
  onclose: MarketWebSocket["onclose"] = null;
  sent: Array<{ requests: Array<Record<string, any>> }> = [];
  closed = false;
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.closed = true;
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  ack(id: string | number, service: string, command: string, code = 0) {
    this.message({
      response: [{ requestid: id, service, command, content: { code } }],
    });
  }
  live() {
    this.onopen?.();
    this.ack("0", "ADMIN", "LOGIN");
    this.ack("1", "LEVELONE_EQUITIES", "SUBS");
    this.ack("2", "CHART_EQUITY", "SUBS");
  }
  quote(entry: Record<string, unknown>, timestamp = start + 40_000) {
    this.message({
      data: [{ service: "LEVELONE_EQUITIES", timestamp, content: [entry] }],
    });
  }
  candle(entry: Record<string, unknown>) {
    this.message({ data: [{ service: "CHART_EQUITY", content: [entry] }] });
  }
}
const auth: StreamCredentials = {
  url: "wss://streamer-api.schwab.com/ws",
  accessToken: "raw-token",
  customerId: "customer",
  correlId: "correl",
  channel: "channel",
  functionId: "function",
};
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}
async function setup(
  getCredentials: () => Promise<StreamCredentials> = async () => auth,
) {
  const time = clock();
  const sockets: Socket[] = [];
  const quotes: Parameters<MarketStreamCallbacks["onQuote"]>[0][] = [];
  const candles: Candle[] = [];
  const formingCandles: Candle[] = [];
  const events: string[] = [];
  const statuses: string[] = [];
  const stop = openMarketStream(
    "AAPL",
    getCredentials,
    {
      onQuote: (quote) => { quotes.push(quote); events.push("quote"); },
      onFormingCandle: (candle) => { formingCandles.push(candle); events.push("forming"); },
      onCandle: (candle) => { candles.push(candle); events.push("authoritative"); },
      onStatus: (status) => statuses.push(status),
    },
    {
      ...time,
      createWebSocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    },
  );
  await settle();
  return { time, sockets, quotes, candles, formingCandles, events, statuses, stop, socket: sockets[0] };
}
const bar = (time = start, sequence = 1) => ({
  key: "AAPL",
  "1": sequence,
  "2": 100,
  "3": 110,
  "4": 90,
  "5": 105,
  "6": 23,
  "7": time,
  "8": 1,
});

test("only allows exact Schwab domains over credential-free secure URLs", () => {
  for (const url of [
    auth.url,
    "wss://schwab.com",
    "wss://a.schwabapi.com:443/ws",
  ])
    assert.equal(isSchwabStreamURL(url), true, url);
  for (const url of [
    "ws://streamer.schwab.com",
    "wss://schwab.com.evil.test",
    "wss://evil-schwab.com",
    "wss://schwabapi.com.evil.test",
    "wss://user@schwab.com",
    "wss://schwab.com:8443",
    "wss://schwab.com/?token=x",
    "wss://schwab.com/#token",
    "wss://schwab.com/?",
    "wss://schwab.com/#",
    "https://schwab.com",
    "bad",
    "wss://127.0.0.1",
  ])
    assert.equal(isSchwabStreamURL(url), false, url);
});

test("sends LOGIN first, subscribes only to L1 and chart, and waits for both acknowledgments", async () => {
  const h = await setup();
  assert.deepEqual(h.statuses, ["connecting"]);
  h.socket.onopen?.();
  assert.deepEqual(h.socket.sent[0].requests[0], {
    requestid: "0",
    service: "ADMIN",
    command: "LOGIN",
    SchwabClientCustomerId: "customer",
    SchwabClientCorrelId: "correl",
    parameters: {
      Authorization: "raw-token",
      SchwabClientChannel: "channel",
      SchwabClientFunctionId: "function",
    },
  });
  h.socket.ack("1", "ADMIN", "LOGIN");
  assert.equal(h.socket.sent.length, 1);
  h.socket.ack("0", "ADMIN", "LOGIN");
  assert.equal(h.socket.sent.length, 2);
  const requests = h.socket.sent[1].requests;
  assert.deepEqual(
    requests.map((r) => [r.requestid, r.service, r.command]),
    [
      ["1", "LEVELONE_EQUITIES", "SUBS"],
      ["2", "CHART_EQUITY", "SUBS"],
    ],
  );
  for (const r of requests) {
    assert.equal(r.SchwabClientCustomerId, "customer");
    assert.equal(r.SchwabClientCorrelId, "correl");
    assert.equal(r.parameters.keys, "AAPL");
  }
  h.socket.ack("2", "CHART_EQUITY", "SUBS");
  h.socket.ack("2", "CHART_EQUITY", "SUBS");
  assert.deepEqual(h.statuses, ["connecting"]);
  h.socket.ack("1", "LEVELONE_EQUITIES", "SUBS");
  assert.deepEqual(h.statuses, ["connecting", "live"]);
  h.stop();
});

test("merges partial deltas, preserves delayed metadata, and coalesces each minute and latest quote", async () => {
  const h = await setup();
  h.socket.live();
  h.socket.quote({
    key: "AAPL",
    "3": 100,
    "1": 99,
    "34": start,
    "35": start - 10,
    delayed: true,
    assetMainType: "EQUITY",
  });
  h.socket.quote({ key: "AAPL", "2": 101, "3": 100.5, "34": start + 1 });
  h.socket.candle(bar(start - 60_000));
  h.socket.candle(bar(start, 2));
  h.socket.candle({ ...bar(start, 3), "5": 106 });
  assert.equal(h.quotes.length, 0);
  h.time.advance(249);
  assert.equal(h.quotes.length, 0);
  h.time.advance(1);
  assert.equal(h.quotes.length, 1);
  assert.deepEqual(h.quotes[0], {
    symbol: "AAPL",
    lastPrice: 100.5,
    bidPrice: 99,
    askPrice: 101,
    quoteTime: start + 1,
    tradeTime: start - 10,
    isRealtime: false,
    assetMainType: "EQUITY",
  });
  assert.equal(h.candles.length, 2);
  assert.equal(h.candles[1].close, 106);
  h.socket.quote({ key: "AAPL", "1": 100 });
  h.time.advance(250);
  assert.equal(h.quotes[1].tradeTime, start - 10);
  h.stop();
});

test("malformed, foreign, future, and out-of-order entries cannot poison later deltas", async () => {
  const h = await setup();
  h.socket.live();
  h.socket.quote({ key: "AAPL", seq: 5, "3": 100, "34": start, "35": start });
  h.socket.onmessage?.({ data: "{" });
  h.socket.quote({ key: "MSFT", seq: 999, "3": 900, "34": start + 1 });
  h.socket.quote({ key: "AAPL", "0": "MSFT", "3": 900 });
  h.socket.quote({ key: "AAPL", seq: 999, "3": "900", "34": start + 1 });
  h.socket.quote({ key: "AAPL", seq: 999, "3": 900, "34": start - 1 });
  h.socket.quote({ key: "AAPL", seq: 999, "3": 900, "35": start - 1 });
  h.socket.quote({ key: "AAPL", seq: 999, "3": 900, "34": start + 100_000 });
  h.socket.quote({ key: "AAPL", seq: 4, "3": 900 });
  h.socket.quote({ key: "AAPL", seq: 6, "2": 101 });
  h.socket.candle(bar());
  h.socket.candle({ ...bar(start + 60_000, 999), "3": 1 });
  h.socket.candle(bar(start - 60_000, 999));
  h.socket.candle({ ...bar(start, 0), "5": 90 });
  h.socket.candle({ ...bar(start, 2), "5": 106 });
  h.time.advance(250);
  assert.equal(h.quotes[0].lastPrice, 100);
  assert.equal(h.quotes[0].askPrice, 101);
  assert.equal(h.candles.length, 1);
  assert.equal(h.candles[0].close, 106);
  h.stop();
});

test("login/subscription rejection falls back and reconnects with fresh credentials", async () => {
  for (const rejecting of ["login", "subscription"]) {
    let calls = 0;
    const h = await setup(async () => ({
      ...auth,
      accessToken: `token-${++calls}`,
    }));
    h.socket.onopen?.();
    if (rejecting === "subscription") {
      h.socket.ack("0", "ADMIN", "LOGIN");
      h.socket.ack("2", "CHART_EQUITY", "SUBS", 3);
    } else h.socket.ack("0", "ADMIN", "LOGIN", 3);
    assert.equal(h.statuses.at(-1), "fallback");
    assert.equal(h.socket.closed, true);
    assert.equal(h.time.nextDelay(), 5000);
    h.time.advance(5000);
    await settle();
    assert.equal(calls, 2);
    h.sockets[1].onopen?.();
    assert.equal(
      h.sockets[1].sent[0].requests[0].parameters.Authorization,
      "token-2",
    );
    h.stop();
    assert.equal(h.time.pending(), 0);
  }
});

test("timeouts, heartbeat, and reconnect backoff are bounded and stop ignores late events", async () => {
  const h = await setup();
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    h.time.advance(10000);
    assert.equal(h.statuses.at(-1), "fallback");
    assert.equal(h.time.nextDelay(), delay);
    h.time.advance(delay);
    await settle();
  }
  const socket = h.sockets.at(-1)!;
  socket.live();
  h.time.advance(44000);
  socket.message({ notify: [{ heartbeat: String(h.time.now()) }] });
  h.time.advance(44000);
  assert.equal(h.statuses.at(-1), "live");
  h.time.advance(1000);
  assert.equal(h.statuses.at(-1), "fallback");
  assert.equal(h.time.nextDelay(), 5000);
  h.time.advance(5000);
  await settle();
  const last = h.sockets.at(-1)!;
  last.live();
  const lateMessage = last.onmessage;
  const lateError = last.onerror;
  last.quote({ key: "AAPL", "3": 100 });
  h.stop();
  h.stop();
  lateMessage?.({
    data: JSON.stringify({
      data: [
        { service: "LEVELONE_EQUITIES", content: [{ key: "AAPL", "3": 999 }] },
      ],
    }),
  });
  lateError?.();
  h.time.advance(120000);
  await settle();
  assert.equal(h.time.pending(), 0);
  assert.equal(h.quotes.length, 0);
  assert.equal(last.closed, true);
});

test("invalid host, oversize data, and credentials resolving after stop never leak credentials", async () => {
  const invalid = await setup(async () => ({
    ...auth,
    url: "wss://schwab.com.evil.test",
  }));
  assert.equal(invalid.sockets.length, 0);
  assert.equal(invalid.statuses.at(-1), "fallback");
  invalid.stop();
  const h = await setup();
  h.socket.live();
  h.socket.onmessage?.({ data: " ".repeat(1_048_577) });
  assert.equal(h.socket.closed, true);
  h.stop();
  let resolve!: (value: StreamCredentials) => void;
  const waiting = await setup(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  waiting.stop();
  resolve(auth);
  await settle();
  assert.equal(waiting.sockets.length, 0);
  assert.equal(waiting.time.pending(), 0);
});

test("subscription timeout, socket errors, and multibyte payload limits fall back", async () => {
  const subscribing = await setup();
  subscribing.socket.onopen?.();
  subscribing.socket.ack("0", "ADMIN", "LOGIN");
  subscribing.socket.ack("1", "LEVELONE_EQUITIES", "SUBS");
  subscribing.time.advance(10000);
  assert.equal(subscribing.statuses.at(-1), "fallback");
  subscribing.stop();
  for (const event of ["onerror", "onclose"] as const) {
    const h = await setup();
    h.socket.live();
    h.socket[event]?.();
    assert.equal(h.statuses.at(-1), "fallback");
    assert.equal(h.socket.closed, true);
    h.stop();
  }
  const oversized = await setup();
  oversized.socket.live();
  oversized.socket.onmessage?.({
    data: JSON.stringify({ text: "中".repeat(350000) }),
  });
  assert.equal(oversized.statuses.at(-1), "fallback");
  oversized.stop();
});

test("pending minute storage is bounded and ignores incomplete candles", async () => {
  const h = await setup();
  h.socket.live();
  for (let index = 0; index < 300; index++)
    h.socket.candle(bar(start - (299 - index) * 60_000, index));
  h.socket.candle({ key: "AAPL", "1": 999, "5": 100, "7": start });
  h.time.advance(250);
  assert.equal(h.candles.length, 256);
  assert.equal(h.candles[0].time, start - 255 * 60_000);
  assert.equal(h.candles.at(-1)?.close, 105);
  h.stop();
});

test("acknowledgments accept exact numeric IDs but reject coerced or malformed IDs", async () => {
  const h = await setup();
  h.socket.onopen?.();
  for (const requestid of [null, false, "00", "0.0", " 0", [], {}, 0.5]) {
    h.socket.message({
      response: [
        { requestid, service: "ADMIN", command: "LOGIN", content: { code: 0 } },
      ],
    });
  }
  assert.equal(h.socket.sent.length, 1);
  h.socket.ack(0, "ADMIN", "LOGIN");
  assert.equal(h.socket.sent.length, 2);
  h.socket.ack(1, "LEVELONE_EQUITIES", "SUBS");
  h.socket.ack(2, "CHART_EQUITY", "SUBS");
  assert.equal(h.statuses.at(-1), "live");
  h.stop();
});

test("initial data during subscription is retained and delivered only after both acknowledgments", async () => {
  const h = await setup();
  h.socket.onopen?.();
  h.socket.ack("0", "ADMIN", "LOGIN");
  h.socket.quote({
    key: "AAPL",
    "3": 100,
    "35": start,
    delayed: true,
    assetMainType: "EQUITY",
  });
  h.socket.candle(bar());
  h.time.advance(500);
  assert.equal(h.quotes.length, 0);
  assert.equal(h.candles.length, 0);
  h.socket.ack("1", "LEVELONE_EQUITIES", "SUBS");
  h.socket.quote({ key: "AAPL", "1": 99 });
  h.time.advance(500);
  assert.equal(h.quotes.length, 0);
  h.socket.ack("2", "CHART_EQUITY", "SUBS");
  h.time.advance(250);
  assert.deepEqual(h.quotes[0], {
    symbol: "AAPL",
    lastPrice: 100,
    tradeTime: start,
    bidPrice: 99,
    isRealtime: false,
    assetMainType: "EQUITY",
  });
  assert.equal(h.candles.length, 1);
  h.stop();
});

test("reconnection resets quote data and chart ordering before new partial updates", async () => {
  const h = await setup();
  h.socket.live();
  h.socket.quote({
    key: "AAPL",
    "3": 100,
    "35": start,
    "34": start,
    delayed: false,
  });
  h.socket.candle(bar());
  h.time.advance(250);
  h.socket.onclose?.();
  h.time.advance(5000);
  await settle();
  const next = h.sockets[1];
  next.live();
  next.quote({ key: "AAPL", "1": 98 });
  next.candle(bar(start - 60_000, 0));
  h.time.advance(250);
  assert.deepEqual(h.quotes[1], { symbol: "AAPL", bidPrice: 98 });
  assert.equal(h.candles[1].time, start - 60_000);
  h.stop();
});

test("same-sequence candle corrections are emitted while identical duplicates and older updates are ignored", async () => {
  const h = await setup();
  h.socket.live();
  h.socket.candle(bar());
  h.time.advance(250);
  h.socket.candle(bar());
  h.time.advance(250);
  assert.equal(h.candles.length, 1);
  h.socket.candle({ ...bar(), "5": 106, "6": 30 });
  h.time.advance(250);
  assert.equal(h.candles.length, 2);
  assert.equal(h.candles[1].close, 106);
  assert.equal(h.candles[1].volume, 30);
  h.socket.candle({ ...bar(start - 60_000, 99), "5": 99 });
  h.socket.candle({ ...bar(start, 0), "5": 99 });
  h.time.advance(250);
  assert.equal(h.candles.length, 2);
  h.stop();
});

test("forming candles preserve first open and every intrabatch trade extreme before quote coalescing", async () => {
  const h = await setup(); h.socket.live();
  h.socket.quote({ key: "AAPL", "3": 100, "35": start, delayed: false });
  h.socket.quote({ key: "AAPL", "3": 110, "35": start + 1 });
  h.socket.quote({ key: "AAPL", "3": 90, "35": start + 2 });
  h.socket.quote({ key: "AAPL", "3": 105, "35": start + 3 });
  assert.equal(h.formingCandles.length, 0);
  h.time.advance(250);
  assert.deepEqual(h.formingCandles, [{ time: start, open: 100, high: 110, low: 90,
    close: 105, provisional: true }]);
  assert.equal(h.quotes.length, 1); assert.equal(h.quotes[0].lastPrice, 105);
  assert.deepEqual(h.events, ["forming", "quote"]); h.stop();
});

test("a coalesced batch spanning a minute boundary retains both forming candles", async () => {
  const h = await setup(); h.socket.live();
  h.socket.quote({ key: "AAPL", "3": 100, "35": start - 10, delayed: false });
  h.socket.quote({ key: "AAPL", "3": 101, "35": start - 1 });
  h.socket.quote({ key: "AAPL", "3": 102, "35": start });
  h.socket.quote({ key: "AAPL", "3": 99, "35": start + 1 });
  h.time.advance(250);
  assert.deepEqual(h.formingCandles, [
    { time: start - 60_000, open: 100, high: 101, low: 100, close: 101, provisional: true },
    { time: start, open: 102, high: 102, low: 99, close: 99, provisional: true },
  ]);
  assert.deepEqual(h.events, ["forming", "forming", "quote"]); h.stop();
});

test("bid/ask-only deltas do not synthesize trades, while timestamp-only trades retain the last price", async () => {
  const h = await setup(); h.socket.live();
  h.socket.quote({ key: "AAPL", "3": 100, "35": start, delayed: false });
  h.time.advance(250);
  h.socket.quote({ key: "AAPL", "1": 99, "2": 101, "34": start + 1 });
  h.time.advance(250); assert.equal(h.formingCandles.length, 1);
  h.socket.quote({ key: "AAPL", "35": start + 2 });
  h.time.advance(250); assert.equal(h.formingCandles.length, 2);
  assert.equal(h.formingCandles[1].close, 100);
  h.socket.quote({ key: "AAPL", "3": 200, "35": start + 1 });
  h.time.advance(250); assert.equal(h.formingCandles.length, 2);
  h.stop();
});

test("forming candles require explicit realtime permission, a recent trade time, and positive price", async () => {
  for (const entry of [
    { "3": 100, "35": start },
    { "3": 100, "35": start, delayed: true },
    { "3": 100, "35": start - 60_001, delayed: false },
    { "3": 100, "35": start + 5_001, delayed: false },
    { "3": 100, delayed: false },
    { "35": start, delayed: false },
    { "3": 0, "35": start, delayed: false },
  ]) {
    const h = await setup(); h.socket.live();
    h.socket.quote({ key: "AAPL", ...entry }); h.time.advance(250);
    assert.equal(h.formingCandles.length, 0, JSON.stringify(entry)); h.stop();
  }
});

test("forming bars flush before authoritative bars, and pending provisional buffers clear on failure and stop", async () => {
  const h = await setup(); h.socket.live();
  h.socket.quote({ key: "AAPL", "3": 100, "35": start, delayed: false });
  h.socket.candle(bar()); h.time.advance(250);
  assert.deepEqual(h.events, ["forming", "quote", "authoritative"]);
  assert.equal(h.formingCandles[0].provisional, true);
  assert.equal(h.candles[0].provisional, undefined); assert.equal(h.candles[0].volume, 23);
  h.socket.candle({ ...bar(start, 2), "3": 112, "5": 108, "6": 50 });
  h.time.advance(250);
  assert.equal(h.candles[1].close, 108); assert.equal(h.candles[1].volume, 50);
  h.socket.quote({ key: "AAPL", "3": 110, "35": start + 1 });
  h.socket.onclose?.(); h.time.advance(5000); await settle();
  h.sockets[1].live(); h.sockets[1].quote({ key: "AAPL", "1": 99 });
  h.time.advance(250); assert.equal(h.formingCandles.length, 1);
  h.sockets[1].quote({ key: "AAPL", "3": 111, "35": h.time.now(), delayed: false });
  h.stop(); h.time.advance(250); assert.equal(h.formingCandles.length, 1);
});

test("multi-symbol stream shares one login, routes independent sequences, and reconnects as one", async () => {
  const time = clock();
  const sockets: Socket[] = [];
  const quotes: Array<{ symbol: string; lastPrice?: number }> = [];
  const candles: string[] = [];
  let credentialReads = 0;
  const stop = openMultiMarketStream(["AAPL", "QQQ"], async () => { credentialReads++; return auth; }, {
    onQuote: (quote) => quotes.push(quote),
    onCandle: (symbol) => candles.push(symbol),
    onStatus: () => {},
  }, { ...time, createWebSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  await settle();
  assert.equal(sockets.length, 1);
  sockets[0].live();
  assert.equal(sockets[0].sent[1].requests[0].parameters.keys, "AAPL,QQQ");
  sockets[0].quote({ key: "AAPL", seq: 999, "3": 200 });
  sockets[0].quote({ key: "QQQ", seq: 1, "3": 500 });
  sockets[0].quote({ key: "AAPL", seq: 998, "3": 100 });
  sockets[0].quote({ key: "QQQ", "0": "AAPL", seq: 2, "3": 1 });
  sockets[0].candle({ key: "QQQ", "1": 1, "2": 500, "3": 501, "4": 499, "5": 500, "6": 10, "7": start });
  time.advance(250);
  assert.deepEqual(quotes.map(({ symbol, lastPrice }) => ({ symbol, lastPrice })), [{ symbol: "AAPL", lastPrice: 200 }, { symbol: "QQQ", lastPrice: 500 }]);
  assert.deepEqual(candles, ["QQQ"]);
  sockets[0].onclose?.();
  time.advance(5000);
  await settle();
  assert.equal(credentialReads, 2);
  assert.equal(sockets.length, 2);
  sockets[1].live();
  assert.equal(sockets[1].sent[1].requests[0].parameters.keys, "AAPL,QQQ");
  sockets[1].quote({ key: "AAPL", seq: 1, "3": 201 });
  time.advance(250);
  assert.equal(quotes.at(-1)?.lastPrice, 201);
  stop();
  assert.equal(time.pending(), 0);
});

test("multi-symbol forming extrema and chart sequences stay independent within a shared batch", async () => {
  const time = clock();
  const socket = new Socket();
  const forming: Array<{ symbol: string; candle: Candle }> = [];
  const candles: Array<{ symbol: string; candle: Candle }> = [];
  const stop = openMultiMarketStream(["AAPL", "QQQ"], async () => auth, {
    onQuote: () => {},
    onStatus: () => {},
    onFormingCandle: (symbol, candle) => forming.push({ symbol, candle }),
    onCandle: (symbol, candle) => candles.push({ symbol, candle }),
  }, { ...time, createWebSocket: () => socket });
  await settle(); socket.live();
  socket.quote({ key: "AAPL", seq: 99, "3": 100, "35": start, delayed: false });
  socket.quote({ key: "QQQ", seq: 1, "3": 500, "35": start, delayed: false });
  socket.quote({ key: "AAPL", seq: 100, "3": 102, "35": start + 1 });
  socket.quote({ key: "QQQ", seq: 2, "3": 499, "35": start + 1 });
  socket.candle(bar(start, 99));
  socket.candle({ ...bar(start, 1), key: "QQQ", "5": 106 });
  time.advance(250);
  assert.deepEqual(forming.map(({ symbol, candle }) => [symbol, candle.open, candle.high, candle.low, candle.close]),
    [["AAPL", 100, 102, 100, 102], ["QQQ", 500, 500, 499, 499]]);
  assert.deepEqual(candles.map(({ symbol, candle }) => [symbol, candle.close]), [["AAPL", 105], ["QQQ", 106]]);
  stop(); assert.equal(time.pending(), 0);
});
