import test from "node:test";
import assert from "node:assert/strict";
import { MarketHub } from "./market.ts";
import type { MultiMarketStreamCallbacks } from "../mobile/src/marketStream.ts";

function fixture() {
  const streams: Array<{ symbols: string[]; callbacks: MultiMarketStreamCallbacks; closed: boolean }> = [];
  const hub = new MarketHub(async () => { throw new Error("Never connect real broker in tests"); }, {
    openStream: (symbols, _credentials, callbacks) => {
      const stream = { symbols, callbacks, closed: false };
      streams.push(stream);
      callbacks.onStatus("connecting");
      return () => { stream.closed = true; };
    },
  });
  return { hub, streams };
}

test("two devices receive independent symbols through one union subscription and repeat polls reuse it", async () => {
  const { hub, streams } = fixture();
  try {
    await hub.poll("phone", "AAPL");
    await hub.poll("tablet", "QQQ");
    assert.equal(streams.length, 2);
    assert.equal(streams[0].closed, true);
    assert.deepEqual(streams[1].symbols, ["AAPL", "QQQ"]);
    assert.equal(streams.filter((stream) => !stream.closed).length, 1);
    const stream = streams[1];
    stream.callbacks.onStatus("live");
    stream.callbacks.onQuote({ symbol: "AAPL", lastPrice: 200 });
    stream.callbacks.onQuote({ symbol: "QQQ", lastPrice: 500 });
    assert.equal((await hub.poll("phone", "AAPL")).quote?.lastPrice, 200);
    assert.equal((await hub.poll("tablet", "QQQ")).quote?.lastPrice, 500);
    assert.equal(streams.length, 2);
    hub.release("tablet");
    assert.equal(stream.closed, true);
    assert.deepEqual(streams[2].symbols, ["AAPL"]);
    stream.callbacks.onQuote({ symbol: "AAPL", lastPrice: 1 });
    assert.equal((await hub.poll("phone", "AAPL")).quote?.lastPrice, 200);
    hub.release("phone");
    assert.equal(streams.every((entry) => entry.closed), true);
  } finally { hub.close(); }
});

test("same symbol devices reuse upstream and long poll wakes only on their symbol; abort removes pending request", async () => {
  const { hub, streams } = fixture();
  try {
    const first = await hub.poll("phone", "AAPL");
    await hub.poll("tablet", "AAPL");
    assert.equal(streams.length, 1);
    const abort = new AbortController();
    const pending = hub.poll("phone", "AAPL", first.cursor, 20_000, abort.signal);
    await assert.rejects(hub.poll("phone", "AAPL", first.cursor), /pending/);
    abort.abort();
    const noChange = await pending;
    assert.equal(noChange.cursor, first.cursor);
    const changed = hub.poll("phone", "AAPL", noChange.cursor);
    streams[0].callbacks.onQuote({ symbol: "AAPL", lastPrice: 201 });
    assert.equal((await changed).quote?.lastPrice, 201);
    hub.release("phone");
    assert.equal(streams.length, 1);
    assert.equal(streams[0].closed, false);
  } finally { hub.close(); }
});

test("minute extrema survive multiple relay batches and snapshots are bounded and cursor-filtered", async () => {
  const { hub, streams } = fixture();
  try {
    const first = await hub.poll("phone", "AAPL");
    const callbacks = streams[0].callbacks;
    callbacks.onFormingCandle?.("AAPL", { time: 60_000, open: 10, high: 12, low: 9, close: 11, provisional: true });
    callbacks.onFormingCandle?.("AAPL", { time: 60_000, open: 11, high: 11, low: 10, close: 10, provisional: true });
    const batch = await hub.poll("phone", "AAPL", first.cursor, 0);
    assert.deepEqual(batch.formingCandles, [{ time: 60_000, open: 10, high: 12, low: 9, close: 10, provisional: true }]);
    assert.deepEqual((await hub.poll("phone", "AAPL", batch.cursor, 0)).formingCandles, []);
    for (let index = 0; index < 1000; index++) callbacks.onCandle("AAPL", {
      time: index * 60_000, open: 10, high: 12, low: 9, close: 11, volume: index,
    });
    const latest = await hub.poll("phone", "AAPL");
    assert.equal(latest.candles.length, 128);
    assert.equal(latest.candles.at(-1)?.volume, 999);
    assert.equal(JSON.stringify(latest).includes("accessToken"), false);
  } finally { hub.close(); }
});

test("invalid symbols, unbounded waits and cursors never create an upstream", async () => {
  const { hub, streams } = fixture();
  try {
    await assert.rejects(hub.poll("phone", "AAPL,QQQ"), /Invalid/);
    await assert.rejects(hub.poll("phone", "AAPL", -1), /Invalid/);
    await assert.rejects(hub.poll("phone", "AAPL", 0, 20_001), /Invalid/);
    assert.equal(streams.length, 0);
    for (let index = 0; index < 16; index++) await hub.poll(String(index), "AAPL");
    await assert.rejects(hub.poll("extra", "AAPL"), /limit/);
    assert.equal(streams.length, 1);
  } finally { hub.close(); }
});

test("idle device expiry removes the union and closes the last upstream", async () => {
  const timers = new Map<object, { callback: () => void; delay: number }>();
  let closed = 0;
  const hub = new MarketHub(async () => { throw new Error("No credentials"); }, {
    openStream: () => () => { closed++; },
    setTimeout: ((callback: () => void, delay: number) => {
      const id = {}; timers.set(id, { callback, delay }); return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: object) => timers.delete(id)) as unknown as typeof clearTimeout,
  });
  await hub.poll("phone", "AAPL");
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  assert.equal(timer.delay, 45_000);
  timer.callback();
  assert.equal(closed, 1);
  assert.equal(timers.size, 0);
  hub.close();
});

test("a newly registered device ignores an earlier server cursor and receives a complete snapshot", async () => {
  const { hub, streams } = fixture();
  try {
    await hub.poll("phone", "AAPL");
    streams[0].callbacks.onQuote({ symbol: "AAPL", lastPrice: 201 });
    const current = await hub.poll("phone", "AAPL");
    // A device reconnecting after a server restart can carry any old cursor,
    // including a number that happens to equal this process's current revision.
    const restored = await hub.poll("tablet", "AAPL", current.cursor, 0);
    assert.equal(restored.quote?.lastPrice, 201);
    hub.release("phone");
    assert.equal((await hub.poll("phone", "AAPL", current.cursor, 0)).quote?.lastPrice, 201);
  } finally { hub.close(); }
});

test("frequent forming updates cannot evict completed candles from initial or lagging snapshots", async () => {
  const { hub, streams } = fixture();
  try {
    const initial = await hub.poll("phone", "AAPL");
    const callbacks = streams[0].callbacks;
    callbacks.onCandle("AAPL", { time: 60_000, open: 10, high: 12, low: 9, close: 11, volume: 25 });
    for (let index = 0; index < 600; index++) callbacks.onFormingCandle?.("AAPL", {
      time: 120_000, open: 11, high: 12, low: 10, close: 11, provisional: true,
    });
    const lagging = await hub.poll("phone", "AAPL", initial.cursor, 0);
    assert.equal(lagging.candles.length, 1);
    assert.equal(lagging.candles[0].volume, 25);
    const fresh = await hub.poll("tablet", "AAPL");
    assert.equal(fresh.candles.length, 1);
    assert.equal(fresh.formingCandles.length, 1);
    assert.deepEqual((await hub.poll("phone", "AAPL", lagging.cursor, 0)).candles, []);
  } finally { hub.close(); }
});

test("release and shutdown settle waiting polls and ignore late upstream data", async () => {
  const { hub, streams } = fixture();
  const initial = await hub.poll("phone", "AAPL");
  const pending = hub.poll("phone", "AAPL", initial.cursor);
  hub.release("phone");
  assert.equal((await pending).status, "fallback");
  const next = await hub.poll("tablet", "QQQ");
  const closing = hub.poll("tablet", "QQQ", next.cursor);
  hub.close();
  streams.at(-1)!.callbacks.onQuote({ symbol: "QQQ", lastPrice: 500 });
  assert.equal((await closing).quote, undefined);
  assert.equal(streams.every(stream => stream.closed), true);
});

test("other symbols do not wake a pending device and switching symbols replays its quote", async () => {
  const { hub, streams } = fixture();
  try {
    await hub.poll("phone", "AAPL");
    await hub.poll("tablet", "QQQ");
    const current = await hub.poll("phone", "AAPL");
    let settled = false;
    const pending = hub.poll("phone", "AAPL", current.cursor).then(value => { settled = true; return value; });
    streams.at(-1)!.callbacks.onQuote({ symbol: "QQQ", lastPrice: 500 });
    await Promise.resolve();
    assert.equal(settled, false);
    streams.at(-1)!.callbacks.onQuote({ symbol: "AAPL", lastPrice: 200 });
    assert.equal((await pending).quote?.lastPrice, 200);
    const next = await hub.poll("phone", "QQQ", current.cursor, 0);
    assert.equal(next.quote?.lastPrice, 500);
  } finally { hub.close(); }
});

test("replayed older upstream history cannot evict the most recent retained minutes", async () => {
  const { hub, streams } = fixture();
  try {
    await hub.poll("phone", "AAPL");
    const callbacks = streams[0].callbacks;
    for (let index = 100; index < 228; index++) callbacks.onCandle("AAPL", {
      time: index * 60_000, open: 10, high: 12, low: 9, close: 11, volume: index,
    });
    callbacks.onCandle("AAPL", { time: 60_000, open: 10, high: 12, low: 9, close: 11, volume: 1 });
    const snapshot = await hub.poll("phone", "AAPL");
    assert.equal(snapshot.candles.length, 128);
    assert.equal(snapshot.candles[0].time, 100 * 60_000);
    assert.equal(snapshot.candles.at(-1)?.time, 227 * 60_000);
  } finally { hub.close(); }
});
