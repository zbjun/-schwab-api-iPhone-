import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ServerBroker, serverOrigin } from "./ServerBroker.ts";
import type { FetchTransport } from "./broker.ts";
import type { Prepared, Vault } from "./types.ts";

const KEY = "a".repeat(64), ORIGIN = "https://fixture.example.test";
const prepared = { id: "opaque-review" } as Prepared;
function vault() {
  const data = new Map<string, string>();
  const store: Vault = {
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async remove(key) { data.delete(key); },
  };
  return { store, data };
}
function response(result: unknown, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { result } : result), { status });
}
async function fixture(fetch: FetchTransport, timeoutMilliseconds = 1000) {
  const v = vault();
  const broker = new ServerBroker(v.store, { fetch, timeoutMilliseconds });
  await broker.configureServer(ORIGIN, KEY);
  return { broker, ...v };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100 && !check(); n++) await delay(5);
  assert.ok(check(), "condition reached");
}

test("device connection persists through vault; public configuration never returns its key", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return response({}); });
  assert.deepEqual(await f.broker.configuration(), { origin: ORIGIN });
  const restored = new ServerBroker(f.store);
  assert.deepEqual(await restored.configuration(), { origin: ORIGIN });
  assert.equal(calls, 0);
  assert.equal(f.data.size, 1);
  assert.equal([...f.data.values()][0].includes("clientSecret"), false);
  await f.broker.disconnect();
  assert.equal(await f.broker.configuration(), null);
  assert.equal(calls, 0, "forgetting connection never logs out server");
});

test("HTTPS origins only; reject credential URLs, paths, query and hash", async () => {
  for (const value of ["http://fixture.test", "https://user:pass@fixture.test", "https://fixture.test/api", "https://fixture.test?a=b", "https://fixture.test/#x"])
    assert.throws(() => serverOrigin(value));
  assert.equal(serverOrigin(" https://fixture.test:8443/ "), "https://fixture.test:8443");
  const f = await fixture(async () => response({}));
  await assert.rejects(f.broker.configureServer(ORIGIN, "short"));
  assert.deepEqual(await f.broker.configuration(), { origin: ORIGIN });
});

test("reads use only device bearer; redirects and broker-token endpoints are not accepted", async () => {
  const f = await fixture(async (url, init) => {
    assert.equal(url, `${ORIGIN}/rpc`);
    assert.equal((init?.headers as Record<string,string>).Authorization, `Bearer ${KEY}`);
    assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(init?.body)), { method: "accounts", args: [] });
    return response([]);
  });
  assert.deepEqual(await f.broker.accounts(), []);
  const redirected = await fixture(async () => new Response("", { status: 302 }));
  await assert.rejects(redirected.broker.accounts(), { code: "serverRedirect" });
  const wrongAuth = await fixture(async () => response("https://not-schwab.test/login"));
  await assert.rejects(wrongAuth.broker.authorizationURL(), { code: "serverAuthorization" });
});

test("an uncertain write is never retried and blocks later writes across restart and disconnect", async () => {
  let attempts = 0;
  const f = await fixture(async () => { attempts++; throw new Error("network lost"); });
  await assert.rejects(f.broker.submit(prepared), { code: "serverUnavailable" });
  await assert.rejects(f.broker.submit(prepared), { code: "orderOutcomeUnknown" });
  await f.broker.disconnect();
  const restored = new ServerBroker(f.store, { fetch: async () => { attempts++; return response(null); } });
  await restored.configureServer(ORIGIN, KEY);
  await assert.rejects(restored.cancel("account", "order"), { code: "orderOutcomeUnknown" });
  assert.equal(attempts, 1);
});

test("known pre-write rejection clears local marker; server unknown result does not", async () => {
  let unknown = false, submissions = 0;
  const f = await fixture(async (_url, init) => {
    const { method, args } = JSON.parse(String(init?.body));
    assert.equal(method, "submit");
    assert.deepEqual(args, [{ id: prepared.id }]);
    submissions++;
    return response({ error: { code: unknown ? "orderOutcomeUnknown" : "reviewExpired", message: "untrusted secret" } }, 400);
  });
  await assert.rejects(f.broker.submit(prepared), { code: "reviewExpired" });
  unknown = true;
  await assert.rejects(f.broker.submit(prepared), { code: "orderOutcomeUnknown" });
  await assert.rejects(f.broker.submit(prepared), { code: "orderOutcomeUnknown" });
  assert.equal(submissions, 2);
});

test("configuration changes cannot race writes or reconciliation", async () => {
  let finish!: (r: Response) => void;
  const f = await fixture(async () => new Promise<Response>(r => { finish = r; }));
  const write = f.broker.submit(prepared);
  await until(() => !!finish);
  await assert.rejects(f.broker.configureServer("https://other.test", KEY), { code: "operationBusy" });
  await assert.rejects(f.broker.disconnect(), { code: "operationBusy" });
  await assert.rejects(f.broker.acknowledgeReconciliation(), { code: "operationBusy" });
  finish(response({ orderID: "fixture" }));
  await write;
});

test("market polls forward incremental data, abort on stop, release once and suppress late results", async () => {
  const statuses: string[] = [], quotes: unknown[] = [], candles: unknown[] = [];
  let posts = 0, deletes = 0, lastSignal: AbortSignal | null | undefined;
  let late!: (r: Response) => void;
  const candle = { time: 1, open: 2, high: 3, low: 1, close: 2 };
  const f = await fixture(async (url, init) => {
    assert.equal(url, `${ORIGIN}/market`);
    if (init?.method === "DELETE") { deletes++; return response(null); }
    const body = JSON.parse(String(init?.body));
    assert.equal(body.waitMs, 20000);
    assert.equal(body.symbol, "SNDU");
    lastSignal = init?.signal;
    posts++;
    if (posts === 1) return response({ cursor: 10, status: "live", quote: { symbol: "SNDU", lastPrice: 2 }, formingCandles: [candle], candles: [candle] });
    assert.equal(body.cursor, 10);
    return new Promise<Response>(r => { late = r; });
  }, 5); // RPC timeout must not accidentally shorten the 20-second market wait.
  const stop = f.broker.subscribeMarket("SNDU", { onStatus: x => statuses.push(x), onQuote: q => quotes.push(q), onCandle: c => candles.push(c), onFormingCandle: c => candles.push(c) });
  await until(() => posts === 2);
  await delay(25);
  assert.equal(statuses.at(-1), "live");
  stop(); stop();
  await until(() => deletes === 1);
  assert.equal(lastSignal?.aborted, true);
  late(response({ cursor: 11, status: "live", quote: { symbol: "SNDU", lastPrice: 999 }, formingCandles: [], candles: [] }));
  await delay(120);
  assert.equal(quotes.length, 1);
  assert.equal(candles.length, 2);
  assert.equal(posts, 2);
  assert.equal(deletes, 1);
});

test("switching chart symbol releases the previous subscription before starting next", async () => {
  const calls: string[] = [];
  const f = await fixture(async (_url, init) => {
    if (init?.method === "DELETE") { calls.push("DELETE"); return response(null); }
    const { symbol } = JSON.parse(String(init?.body));
    calls.push(symbol);
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const cb = { onStatus() {}, onQuote() {}, onCandle() {} };
  f.broker.subscribeMarket("SNDU", cb);
  await until(() => calls.includes("SNDU"));
  const stop = f.broker.subscribeMarket("QQQ", cb);
  await until(() => calls.includes("QQQ"));
  assert.deepEqual(calls, ["SNDU", "DELETE", "QQQ"]);
  stop();
  await until(() => calls.length === 4);
});

test("reconciliation cannot clear a server-wide unresolved write; it clears only local marker after server is clear", async () => {
  let unresolved = true;
  const f = await fixture(async (_url, init) => {
    const { method } = JSON.parse(String(init?.body));
    if (method === "submit") throw new Error("lost response");
    assert.equal(method, "status");
    return response({ configured: true, authenticated: true, unresolvedOperation: unresolved });
  });
  await assert.rejects(f.broker.submit(prepared));
  await assert.rejects(f.broker.acknowledgeReconciliation(), { code: "orderOutcomeUnknown" });
  assert.equal((await f.broker.status()).unresolvedOperation, true);
  unresolved = false;
  assert.equal((await f.broker.status()).unresolvedOperation, true, "local uncertainty remains until deliberate reconciliation");
  await f.broker.acknowledgeReconciliation();
  assert.equal((await f.broker.status()).unresolvedOperation, false);
});

test("device configuration mutation locks writes before asynchronous vault persistence", async () => {
  const v = vault();
  const originalSet = v.store.set;
  let finish!: () => void;
  v.store.set = async (key, value) => { await new Promise<void>(r => { finish = r; }); await originalSet(key, value); };
  let calls = 0;
  const broker = new ServerBroker(v.store, { fetch: async () => { calls++; return response(null); } });
  const save = broker.configureServer(ORIGIN, KEY);
  await until(() => !!finish);
  await assert.rejects(broker.submit(prepared), { code: "operationBusy" });
  await assert.rejects(broker.disconnect(), { code: "operationBusy" });
  await assert.rejects(broker.configureServer("https://other.test", KEY), { code: "operationBusy" });
  finish(); await save;
  assert.equal(calls, 0);
});

test("optional RPC arguments are omitted instead of JSON null for new orders and default quotes", async () => {
  const requests: { method: string; args: unknown[] }[] = [];
  const f = await fixture(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return response({ id: "fixture-review", preparedAt: Date.now() });
  });
  const draft = { symbol: "SNDU", side: "BUY", kind: "LIMIT", quantity: 1, limitPrice: "27", duration: "DAY" } as const;
  await f.broker.prepare("account", draft);
  await f.broker.prepare("account", draft, "replacement");
  await f.broker.quotes(["SNDU"]);
  await f.broker.quotes(["SNDU"], { fundamentals: true });
  assert.deepEqual(requests, [
    { method: "prepare", args: ["account", draft] },
    { method: "prepare", args: ["account", draft, "replacement"] },
    { method: "quotes", args: [["SNDU"]] },
    { method: "quotes", args: [["SNDU"], { fundamentals: true }] },
  ]);
});

test("remote review timestamps use the local request start and malformed reviews fail before submission", async () => {
  const draft = { symbol: "SNDQ", side: "BUY", kind: "LIMIT", quantity: 1, limitPrice: "27", duration: "DAY" } as const;
  for (const offset of [-120_000, 120_000]) {
    const f = await fixture(async () => response({ id: "remote-review", preparedAt: Date.now() + offset }));
    const before = Date.now();
    const value = await f.broker.prepare("account", draft);
    assert.ok(value.preparedAt >= before && value.preparedAt <= Date.now());
    assert.equal(value.id, "remote-review");
  }
  for (const malformed of [null, {}, { id: "", preparedAt: 1 }, { id: "x", preparedAt: "1" }]) {
    let calls = 0;
    const f = await fixture(async () => { calls++; return response(malformed); });
    await assert.rejects(f.broker.prepare("account", draft), {code: "serverUnavailable"});
    assert.equal(calls, 1);
    assert.equal(f.data.has("ths.server.operation.v1"), false);
  }
});

test("stopping from status callback suppresses remaining quote and candle callbacks", async () => {
  let deletes = 0, emitted = 0;
  const f = await fixture(async (_url, init) => {
    if (init?.method === "DELETE") { deletes++; return response(null); }
    const candle = { time: 1, open: 2, high: 3, low: 1, close: 2 };
    return response({ cursor: 1, status: "live", quote: { symbol: "SNDU", lastPrice: 2 }, formingCandles: [candle], candles: [candle] });
  });
  const stop = f.broker.subscribeMarket("SNDU", {
    onStatus(status) { if (status === "live") stop(); },
    onQuote() { emitted++; }, onCandle() { emitted++; }, onFormingCandle() { emitted++; },
  });
  await until(() => deletes === 1);
  assert.equal(emitted, 0);
});

test("atomic quick submit sends one RPC and validates receipt before clearing pending marker", async () => {
  const draft = { symbol: "SNDU", side: "BUY", kind: "LIMIT", quantity: 1, limitPrice: "27", duration: "DAY" } as const;
  const snapshot = { id: "quick-review", draft: { ...draft, session: "NORMAL" }, accountID: "account", accountDisplay: "fixture", isDemo: false, preparedAt: 1, availableShares: 25, quote: { symbol: "SNDU" } };
  let calls = 0;
  const f = await fixture(async (_url, init) => {
    calls++;
    const { method, args } = JSON.parse(String(init?.body));
    assert.equal(method, "submitQuick");
    assert.deepEqual(args.slice(0, 2), ["account", { ...draft, session: "NORMAL" }]);
    assert.match(args[2], /^[A-Za-z0-9_-]{16,128}$/);
    return response({ snapshot, result: { orderID: "quick-order" } });
  });
  const startedAt = Date.now();
  const value = await f.broker.submitQuick("account", draft);
  assert.equal(value.result.orderID, "quick-order");
  assert.ok(value.snapshot.preparedAt >= startedAt);
  assert.equal(f.data.has("ths.server.operation.v1"), false);
  assert.equal(calls, 1);
  for (const malformed of [null, { snapshot, result: null }, { snapshot: { ...snapshot, accountID: "wrong" }, result: {} }, { snapshot: { ...snapshot, draft: { ...snapshot.draft, quantity: 100 } }, result: {} }]) {
    let attempts = 0;
    const invalid = await fixture(async () => { attempts++; return response(malformed); });
    await assert.rejects(invalid.broker.submitQuick("account", draft), { code: "orderOutcomeUnknown" });
    assert.equal(invalid.data.has("ths.server.operation.v1"), true);
    await assert.rejects(invalid.broker.submitQuick("account", draft), { code: "orderOutcomeUnknown" });
    assert.equal(attempts, 1);
  }
});

test("account activity long poll forwards changes and reset, then aborts and releases on disconnect", async () => {
  let posts = 0, deletes = 0, changes = 0;
  let lastSignal: AbortSignal | null | undefined;
  const statuses: string[] = [];
  const f = await fixture(async (url, init) => {
    assert.equal(url, `${ORIGIN}/activity`);
    if (init?.method === "DELETE") { deletes++; return response(null); }
    const body = JSON.parse(String(init?.body));
    assert.equal(body.waitMs, 20_000);
    lastSignal = init?.signal;
    posts++;
    if (posts === 1) return response({ cursor: 5, status: "live" });
    if (posts === 2) { assert.equal(body.cursor, 5); return response({ cursor: 6, status: "live" }); }
    if (posts === 3) return response({ cursor: 0, status: "connecting" });
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("stopped"))));
  }, 5);
  f.broker.subscribeAccountActivity(() => { changes++; }, status => statuses.push(status));
  await until(() => posts === 4);
  assert.equal(changes, 2);
  assert.deepEqual(statuses, ["connecting", "live", "live", "connecting"]);
  await f.broker.disconnect();
  assert.equal(lastSignal?.aborted, true);
  assert.equal(deletes, 1);
  assert.equal(await f.broker.configuration(), null);
});

test("atomic receipt is checked against the dispatched copy when caller mutates its draft", async () => {
  const draft = { symbol: "SNDU", side: "BUY", kind: "LIMIT", quantity: 1, limitPrice: "27", duration: "DAY" } as const;
  let finish!: (r: Response) => void;
  const f = await fixture(async (_url, init) => {
    const { args } = JSON.parse(String(init?.body));
    const snapshot = { id: "quick-review", draft: args[1], accountID: args[0], accountDisplay: "fixture", isDemo: false, preparedAt: 1, availableShares: 25, quote: { symbol: args[1].symbol } };
    return new Promise<Response>(resolve => { finish = () => resolve(response({ snapshot, result: { orderID: "accepted" } })); });
  });
  const pending = f.broker.submitQuick("account", draft);
  await until(() => !!finish);
  Object.assign(draft, { symbol: "QQQ", quantity: 100 });
  finish(response(null));
  assert.equal((await pending).result.orderID, "accepted");
  assert.equal(f.data.has("ths.server.operation.v1"), false);
});

test("auth failure messages are local and explain callback expiration without leaking provider content", async () => {
  const f = await fixture(async () => response({ error: { code: "authorizationExpired", message: "PRIVATE_PROVIDER_BODY" } }, 400));
  await assert.rejects(f.broker.completeAuthorization("https://fixture/callback"), error => {
    assert.match((error as Error).message, /旧链接/);
    assert.equal((error as Error).message.includes("PRIVATE_PROVIDER_BODY"), false);
    return true;
  });
});

test("exit orders are refused before any write when the gateway predates them", async () => {
  const methods: string[] = [];
  const f = await fixture(async (_url, init) => {
    const { method } = JSON.parse(String(init?.body));
    methods.push(method);
    if (method === "scheduled") return response({ error: { code: "methodNotAllowed", message: "x" } }, 400);
    // An old gateway prepares a copy without the exit legs.
    return response({ id: "review", preparedAt: Date.now(), draft: { symbol: "AAPL" } });
  });
  const draft = {
    symbol: "AAPL", side: "BUY" as const, kind: "LIMIT" as const, quantity: 1, limitPrice: "100", duration: "DAY" as const,
    exit: { takeProfit: "110", duration: "DAY" as const },
  };
  const unsupported = (error: { code?: string }) => error.code === "exitUnsupported";
  await assert.rejects(f.broker.submitQuick("acct", draft), unsupported);
  await assert.rejects(f.broker.prepare("acct", draft), unsupported);
  assert.deepEqual(methods, ["scheduled", "scheduled"]);
  assert.equal(f.data.size, 1, "no pending-write marker was ever stored");
  // A gateway that answers but still drops the legs is caught at review, before submit.
  methods.length = 0;
  const g = await fixture(async (_url, init) => {
    const { method } = JSON.parse(String(init?.body));
    methods.push(method);
    if (method === "scheduled") return response([]);
    return response({ id: "review", preparedAt: Date.now(), draft: { symbol: "AAPL" } });
  });
  await assert.rejects(g.broker.prepare("acct", draft), unsupported);
  assert.deepEqual(methods, ["scheduled", "prepare"]);
});
