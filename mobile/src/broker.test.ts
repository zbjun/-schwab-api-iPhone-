import test from "node:test";
import assert from "node:assert/strict";
import {
  SchwabBroker,
  CALLBACK_URL,
  historyQuery,
  orderIDFromLocation,
  validateRequest,
} from "./broker.ts";
import type { FetchTransport } from "./broker.ts";
import type { Draft, HistoryRange, Vault } from "./types.ts";
import {
  TradingError,
  decodeAccountIdentifiers,
  decodeAccounts,
  decodeHistory,
  decodeOrder,
  decodeOrders,
  decodeQuotes,
  encodeDraft,
  maximumBuy,
  maximumSell,
  parsePrice,
  sharesForBudget,
  validateDraft,
} from "./orderRules.ts";

// Every value in this file is invented. No fixture ever falls through to global fetch.
const ORIGIN = "https://api.schwabapi.com";
const ACCOUNT = "12345678";
const HASH = "FixtureAccountHash_A";
const CLIENT = "fictional_client_id";
const SECRET = "fictional_client_secret";
const SESSION = "ths.schwab.session.v1";
const MARKER = "ths.schwab.operation.v1";
const initialTime = Date.parse("2026-09-08T14:00:00Z");
const draft: Draft = {
  symbol: "AAPL",
  side: "BUY",
  kind: "LIMIT",
  quantity: 5,
  limitPrice: "100",
  duration: "DAY",
};
const orderDTO = (overrides: Record<string, unknown> = {}) => ({
  orderId: "123",
  status: "WORKING",
  orderType: "LIMIT",
  session: "NORMAL",
  duration: "DAY",
  orderStrategyType: "SINGLE",
  quantity: 5,
  filledQuantity: 0,
  remainingQuantity: 5,
  price: 100,
  cancelable: true,
  editable: true,
  enteredTime: "2026-09-08T13:45:00Z",
  orderLegCollection: [
    {
      instruction: "SELL",
      quantity: 5,
      instrument: { symbol: "AAPL", assetType: "EQUITY" },
    },
  ],
  ...overrides,
});

test("order timestamps accept compact broker offsets and preserve instants", () => {
  for (const enteredTime of [
    "2026-09-08T13:45:00+0000",
    "2026-09-08T09:45:00-0400",
    "2026-09-08T19:15:00+0530",
    "2026-09-08T13:45:00+00:00",
    "2026-09-08T13:45:00Z",
  ]) {
    assert.equal(
      decodeOrder(orderDTO({ enteredTime })).enteredAt,
      Date.parse("2026-09-08T13:45:00Z"),
    );
  }
  assert.equal(
    decodeOrder(orderDTO({ enteredTime: "2026-09-08T09:45:00.123-0400" }))
      .enteredAt,
    Date.parse("2026-09-08T13:45:00.123Z"),
  );
  for (const enteredTime of [
    "private-provider-detail",
    "2026-09-08T13:45:00",
    "2026-09-08T13:45:00+2500",
    "2026-09-08T13:45:00+0060",
  ]) {
    assert.throws(() => decodeOrder(orderDTO({ enteredTime })), {
      code: "invalidResponse",
    });
  }
});

test("25 shares remain sellable after decoding filled order with broker timestamp", async () => {
  const f = fixture();
  await f.authorize();
  f.state.accounts = accountDTO(3.56, 25);
  f.state.orders = [
    orderDTO({
      status: "FILLED",
      quantity: 25,
      filledQuantity: 25,
      remainingQuantity: 0,
      enteredTime: "2026-09-08T13:45:00+0000",
    }),
  ];
  const [account] = await f.broker.accounts();
  const orders = await f.broker.orders(ACCOUNT);
  assert.equal(maximumSell(account, "AAPL", orders, true), 25);
  assert.equal(maximumSell(account, "AAPL", orders, false), undefined);
  f.state.orders.push(
    orderDTO({
      orderId: "124",
      quantity: 5,
      remainingQuantity: 5,
      enteredTime: "2026-09-08T13:46:00+0000",
    }),
  );
  assert.equal(
    maximumSell(account, "AAPL", await f.broker.orders(ACCOUNT), true),
    20,
  );
  assert.equal(f.writes().length, 0);
});
const accountDTO = (buyingPower = 10_000, longQuantity = 20.5) => [
  {
    securitiesAccount: {
      accountNumber: ACCOUNT,
      type: "MARGIN",
      currentBalances: {
        liquidationValue: 12_000,
        cashBalance: 8_000,
        buyingPower,
      },
      positions: [
        {
          longQuantity,
          shortQuantity: 0,
          averagePrice: 90,
          marketValue: 2_050,
          instrument: {
            symbol: "AAPL",
            description: "Fixture Stock",
            assetType: "EQUITY",
          },
        },
      ],
    },
  },
];
function response(
  url: string,
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const result = new Response(
    value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value),
    { status, headers },
  );
  Object.defineProperty(result, "url", { value: url });
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class MemoryVault implements Vault {
  values = new Map<string, string>();
  failGet = false;
  failSetKey?: string;
  failRemove = false;
  async get(key: string) {
    if (this.failGet) throw new Error(SECRET);
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    if (key === this.failSetKey) throw new Error(SECRET);
    this.values.set(key, value);
  }
  async remove(key: string) {
    if (this.failRemove) throw new Error(SECRET);
    this.values.delete(key);
  }
}
interface RequestRecord {
  url: string;
  init: RequestInit;
}
function fixture(vault = new MemoryVault()) {
  const clock = { value: initialTime };
  const requests: RequestRecord[] = [];
  let random = 0;
  const state = {
    accounts: accountDTO(),
    orders: [] as Record<string, unknown>[],
    detail: orderDTO(),
    quoteAsset: "EQUITY",
    quoteSubType: undefined as string | undefined,
    tokenSeconds: 1800,
    onRequest: undefined as
      | ((url: string, init: RequestInit) => Promise<Response | undefined>)
      | undefined,
  };
  const fetcher: FetchTransport = async (raw, init) => {
    requests.push({ url: raw, init });
    if (state.onRequest) {
      const overridden = await state.onRequest(raw, init);
      if (overridden) return overridden;
    }
    const url = new URL(raw),
      method = init.method ?? "GET";
    assert.equal(url.origin, ORIGIN);
    if (url.pathname === "/v1/oauth/token")
      return response(raw, {
        access_token: "fixture_access_token",
        refresh_token: "fixture_refresh_token",
        expires_in: state.tokenSeconds,
        token_type: "Bearer",
      });
    if (url.pathname === "/trader/v1/accounts")
      return response(raw, state.accounts);
    if (url.pathname === "/trader/v1/accounts/accountNumbers")
      return response(raw, [{ accountNumber: ACCOUNT, hashValue: HASH }]);
    if (url.pathname === "/marketdata/v1/quotes")
      return response(
        raw,
        Object.fromEntries(
          (url.searchParams.get("symbols") ?? "").split(",").map((symbol) => [
            symbol,
            {
              symbol,
              realtime: true,
              assetMainType: state.quoteAsset,
              assetSubType: state.quoteSubType,
              reference: { description: "Fixture Stock" },
              quote: {
                lastPrice: 100,
                askPrice: 100.02,
                bidPrice: 99.98,
                quoteTime: clock.value,
                totalVolume: 12345,
              },
              fundamental: { peRatio: 25.5 },
            },
          ]),
        ),
      );
    if (url.pathname === "/marketdata/v1/instruments")
      return response(raw, {
        instruments: [
          {
            symbol: url.searchParams.get("symbol"),
            assetType: "EQUITY",
            fundamental: { marketCap: 50_000_000, sharesOutstanding: 500_000 },
          },
        ],
      });
    if (url.pathname === "/trader/v1/userPreference")
      return response(raw, {
        streamerInfo: [
          {
            streamerSocketUrl: "wss://streamer-api.schwab.com/ws",
            schwabClientCustomerId: "fixture-customer",
            schwabClientCorrelId: "fixture-correl",
            schwabClientChannel: "N9",
            schwabClientFunctionId: "APIAPP",
          },
        ],
      });
    if (url.pathname === "/marketdata/v1/pricehistory")
      return response(raw, {
        symbol: url.searchParams.get("symbol"),
        previousClose: 99,
        candles: [
          Date.parse("2026-09-04T08:05:00Z"),
          Date.parse("2026-09-04T20:01:00Z"),
        ].map((datetime) => ({
          datetime,
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 10,
        })),
      });
    if (
      url.pathname === `/trader/v1/accounts/${HASH}/orders` &&
      method === "GET"
    )
      return response(raw, state.orders);
    if (
      url.pathname === `/trader/v1/accounts/${HASH}/orders/123` &&
      method === "GET"
    )
      return response(raw, state.detail);
    if (method === "POST" || method === "PUT")
      return response(raw, undefined, 201, {
        location: `/trader/v1/accounts/${HASH}/orders/456`,
      });
    if (method === "DELETE") return response(raw, undefined, 200);
    throw new Error("Unexpected fixture path");
  };
  const create = () =>
    new SchwabBroker(vault, {
      fetch: fetcher,
      now: () => clock.value,
      randomState: () => (++random).toString(16).padStart(64, "0"),
    });
  const broker = create();
  const authorize = async (target = broker) => {
    await target.configure(CLIENT, SECRET);
    const url = new URL(await target.authorizationURL());
    await target.completeAuthorization(
      CALLBACK_URL +
        "?" +
        new URLSearchParams({
          state: url.searchParams.get("state")!,
          code: "fictional_code+with_special=/characters",
        }),
    );
  };
  const writes = () =>
    requests.filter(
      (r) => r.init.method !== "GET" && !r.url.includes("/oauth/token"),
    );
  return {
    broker,
    create,
    vault,
    clock,
    state,
    requests,
    authorize,
    fetcher,
    writes,
  };
}
async function rejectsCode(operation: Promise<unknown>, code: string) {
  await assert.rejects(
    operation,
    (e: unknown) =>
      e instanceof TradingError &&
      e.code === code &&
      !e.message.includes(SECRET),
  );
}

test("whole-share long-only draft validation and four-decimal encoding", () => {
  for (const price of ["1", "0.0001", "00100.2300"])
    assert.notEqual(parsePrice(price), undefined);
  for (const price of [
    "",
    "0",
    "-1",
    "1.00001",
    "1e2",
    "NaN",
    "Infinity",
    ".1",
  ])
    assert.equal(parsePrice(price), undefined);
  for (const change of [
    { quantity: 0 },
    { quantity: 1.2 },
    { quantity: Number.MAX_SAFE_INTEGER + 1 },
    { side: "SELL_SHORT" },
    { side: "BUY_TO_COVER" },
    { symbol: "AAPL,MSFT" },
    { symbol: "AAPL../../" },
    { duration: "UNTIL_DATE" },
    { stopPrice: "99" },
    { kind: "MARKET" },
    { limitPrice: "1.00001" },
  ])
    assert.throws(() => validateDraft({ ...draft, ...change } as Draft));
  assert.throws(() =>
    validateDraft({
      ...draft,
      kind: "MARKET",
      limitPrice: undefined,
      duration: "GOOD_TILL_CANCEL",
    }),
  );
  const body = JSON.parse(
    encodeDraft({
      ...draft,
      kind: "STOP_LIMIT",
      limitPrice: "00100.2300",
      stopPrice: "99.0001",
    }),
  );
  assert.equal(body.price, "100.23");
  assert.equal(body.stopPrice, "99.0001");
  assert.equal(body.session, "NORMAL");
  assert.equal(body.orderStrategyType, "SINGLE");
  assert.deepEqual(body.orderLegCollection, [
    {
      instruction: "BUY",
      quantity: 5,
      instrument: { symbol: "AAPL", assetType: "EQUITY" },
    },
  ]);
});

test("extended sessions encode limits, reject unsupported night and incompatible orders", () => {
  for (const session of ["NORMAL", "AM", "PM", "SEAMLESS"] as const) {
    for (const side of ["BUY", "SELL"] as const) {
      assert.equal(JSON.parse(encodeDraft({ ...draft, session, side })).session, session);
    }
    if (session !== "NORMAL") {
      for (const kind of ["MARKET", "STOP", "STOP_LIMIT"] as const)
        assert.throws(() => validateDraft({ ...draft, session, kind }), { code: "extendedOrderKind" });
    }
  }
  for (const session of ["AM", "PM"] as const)
    assert.throws(() => validateDraft({ ...draft, session, duration: "GOOD_TILL_CANCEL" }), { code: "extendedDuration" });
  assert.doesNotThrow(() => validateDraft({ ...draft, session: "SEAMLESS", duration: "GOOD_TILL_CANCEL" }));
  for (const session of ["EXTO", "OVERNIGHT", "", null, "toString"])
    assert.throws(() => validateDraft({ ...draft, session } as Draft), { code: "orderSession" });
});

test("extended session survives frozen review and exact broker write for both sides", async () => {
  for (const session of ["AM", "PM", "SEAMLESS"] as const) {
    for (const side of ["BUY", "SELL"] as const) {
      const f = fixture();
      await f.authorize();
      const input: Draft = { ...draft, session, side };
      const review = await f.broker.prepare(ACCOUNT, input);
      input.session = "NORMAL";
      assert.equal(review.draft.session, session);
      await f.broker.submit(review);
      assert.equal(f.writes().length, 1);
      const body = JSON.parse(String(f.writes()[0].init.body));
      assert.equal(body.session, session);
      assert.equal(body.orderType, "LIMIT");
      assert.equal(body.orderLegCollection[0].instruction, side);
    }
  }
});

test("amount sizing uses decimal division and refuses unsafe or unknown inputs", () => {
  assert.equal(sharesForBudget("0.3", "0.1"), 3);
  assert.equal(sharesForBudget(0.3, 0.1), 3);
  assert.equal(sharesForBudget("100", "33.3334"), 2);
  assert.equal(sharesForBudget(0, 1), 0);
  for (const amount of [-1, NaN, Infinity, undefined, "nonsense"])
    assert.equal(sharesForBudget(amount, 1), undefined);
  for (const price of [-1, 0, NaN, Infinity, undefined])
    assert.equal(sharesForBudget(100, price), undefined);
  assert.equal(sharesForBudget("9007199254740992", 1), undefined);
  const account = decodeAccounts(accountDTO(100))[0];
  assert.equal(maximumBuy(account, "33.3334"), 2);
  assert.equal(
    maximumBuy({ ...account, buyingPower: undefined }, 1),
    undefined,
  );
});

test("ETF holdings and order legs participate in sell sizing and fresh preparation", async () => {
  for (const assetType of ["EQUITY", "ETF"]) {
    const f = fixture();
    await f.authorize();
    f.state.accounts = accountDTO(3.56, 25);
    f.state.accounts[0].securitiesAccount.positions[0].instrument.assetType =
      assetType;
    f.state.quoteAsset = assetType;
    f.state.orders = [
      orderDTO({
        orderLegCollection: [
          {
            instruction: "SELL",
            quantity: 5,
            instrument: { symbol: "AAPL", assetType },
          },
        ],
      }),
    ];
    const [account] = await f.broker.accounts();
    const orders = await f.broker.orders(ACCOUNT);
    assert.equal(maximumSell(account, "AAPL", orders), 20);
    assert.equal(orders[0].cancelable, true);
    assert.equal(maximumBuy(account, "26.67"), 0);
    await f.broker.prepare(ACCOUNT, { ...draft, side: "SELL", quantity: 20 });
    await assert.rejects(
      f.broker.prepare(ACCOUNT, { ...draft, side: "SELL", quantity: 21 }),
      { code: "insufficientShares" },
    );
    assert.equal(f.writes().length, 0);
  }
});

test("unrecognized same-symbol holdings cannot silently become zero sellable shares", () => {
  const [account] = decodeAccounts(accountDTO(3.56, 25));
  for (const assetType of [
    "UNKNOWN",
    "OPTION",
    "MUTUAL_FUND",
    "COLLECTIVE_INVESTMENT",
  ]) {
    account.positions[0].assetType = assetType;
    assert.equal(maximumSell(account, "AAPL", []), undefined);
  }
});

test("collective ETF holdings require matching ETF quote evidence through preparation and submit", async () => {
  const f = fixture();
  await f.authorize();
  f.state.accounts = accountDTO(3.56, 25);
  Object.assign(f.state.accounts[0].securitiesAccount.positions[0].instrument, {
    symbol: "SNDU",
    assetType: "COLLECTIVE_INVESTMENT",
  });
  f.state.quoteSubType = "ETF";
  const [account] = await f.broker.accounts();
  const [quote] = await f.broker.quotes(["SNDU"]);
  assert.equal(quote.assetSubType, "ETF");
  assert.equal(maximumSell(account, "SNDU", [], true, undefined, quote), 25);
  for (const evidence of [
    undefined,
    { ...quote, symbol: "SPY" },
    { ...quote, assetSubType: undefined },
    { ...quote, assetSubType: "COE" },
    { ...quote, assetMainType: "MUTUAL_FUND" },
  ]) {
    assert.equal(
      maximumSell(account, "SNDU", [], true, undefined, evidence),
      undefined,
    );
  }
  assert.equal(
    maximumSell(account, "SNDU", [], false, undefined, quote),
    undefined,
  );
  const sell = {
    ...draft,
    symbol: "SNDU",
    side: "SELL" as const,
    quantity: 25,
  };
  await assert.rejects(f.broker.prepare(ACCOUNT, { ...sell, quantity: 26 }), {
    code: "insufficientShares",
  });
  const prepared = await f.broker.prepare(ACCOUNT, sell);
  f.state.orders = [
    orderDTO({
      orderLegCollection: [
        {
          instruction: "SELL",
          quantity: 5,
          instrument: { symbol: "SNDU", assetType: "EQUITY" },
        },
      ],
    }),
  ];
  assert.equal(
    maximumSell(
      account,
      "SNDU",
      await f.broker.orders(ACCOUNT),
      true,
      undefined,
      quote,
    ),
    20,
  );
  await assert.rejects(f.broker.submit(prepared), {
    code: "insufficientShares",
  });
  const next = await f.broker.prepare(ACCOUNT, { ...sell, quantity: 20 });
  f.state.quoteSubType = "COE";
  await assert.rejects(f.broker.submit(next), { code: "insufficientShares" });
  assert.equal(f.writes().length, 0);
});

test("sell sizing reserves remaining orders and blocks ambiguous or short positions", () => {
  const account = decodeAccounts(accountDTO())[0];
  const order = decodeOrder(orderDTO());
  assert.equal(maximumSell(account, "AAPL", [order]), 15);
  assert.equal(maximumSell(account, "AAPL", [order], true, order.id), 20);
  assert.equal(
    maximumSell(account, "AAPL", [{ ...order, status: "FILLED" }]),
    20,
  );
  assert.equal(
    maximumSell(account, "AAPL", [{ ...order, remainingQuantity: undefined }]),
    undefined,
  );
  assert.equal(
    maximumSell(account, "AAPL", [
      { ...order, side: undefined, symbol: "未知标的" },
    ]),
    undefined,
  );
  assert.equal(
    maximumSell(account, "AAPL", [
      { ...order, side: "BUY", isSimpleEquity: false, isSingleLeg: false },
    ]),
    undefined,
  );
  assert.equal(maximumSell(account, "AAPL", [order], false), undefined);
  assert.equal(
    maximumSell(
      { ...account, positions: [{ ...account.positions[0], quantity: -2 }] },
      "AAPL",
      [],
    ),
    undefined,
  );
  assert.equal(
    maximumSell(
      {
        ...account,
        positions: [0.3, 0.6, 0.1].map((quantity) => ({
          ...account.positions[0],
          quantity,
        })),
      },
      "AAPL",
      [],
    ),
    1,
  );
});

test("complex, partial, routed, special-instruction and unsupported precision orders are not editable", () => {
  assert.equal(decodeOrder(orderDTO()).editable, true);
  for (const changes of [
    { filledQuantity: 1 },
    { taxLotMethod: "FIFO" },
    { specialInstruction: "ALL_OR_NONE" },
    { requestedDestination: "NYSE" },
    { cancelTime: "2026-09-09T00:00:00Z" },
    { price: 0.12345 },
    { complexOrderStrategyType: "COVERED" },
    { childOrderStrategies: [{}] },
    { session: "SEAMLESS" },
    { orderStrategyType: "TRIGGER" },
    { status: "PENDING_REPLACE" },
    { quantity: 5.5 },
    { price: undefined },
    { orderType: "STOP_LIMIT" },
    {
      orderLegCollection: [
        {
          instruction: "SELL_SHORT",
          instrument: { symbol: "AAPL", assetType: "EQUITY" },
        },
      ],
    },
  ]) {
    assert.equal(decodeOrder(orderDTO(changes)).editable, false);
  }
  assert.equal(decodeOrder(orderDTO({ filledQuantity: 1 })).cancelable, true);
  assert.equal(
    decodeOrder(orderDTO({ complexOrderStrategyType: "COVERED" })).cancelable,
    false,
  );
  assert.throws(() =>
    decodeOrder(orderDTO({ orderId: 9_007_199_254_740_992 })),
  );
  assert.throws(() => decodeOrder(orderDTO({ remainingQuantity: -1 })));
  assert.throws(() => decodeOrders([orderDTO(), orderDTO()]));
});

test("account identities and duplicate or invalid broker records fail closed", () => {
  assert.equal(decodeAccounts(accountDTO())[0].displayNumber, "•••• 5678");
  assert.equal(decodeAccounts(accountDTO())[0].positions[0].quantity, 20.5);
  assert.deepEqual(
    [
      ...decodeAccountIdentifiers([
        { accountNumber: ACCOUNT, hashValue: HASH },
      ]),
    ],
    [[ACCOUNT, HASH]],
  );
  for (const hash of ["123456", "../abc", "abc/def", "", "abc?x=1"])
    assert.throws(() =>
      decodeAccountIdentifiers([{ accountNumber: ACCOUNT, hashValue: hash }]),
    );
  assert.throws(() => decodeAccounts([...accountDTO(), ...accountDTO()]));
  assert.throws(() =>
    decodeAccountIdentifiers([
      { accountNumber: "1", hashValue: HASH },
      { accountNumber: "2", hashValue: HASH },
    ]),
  );
  assert.throws(() =>
    decodeAccounts([
      {
        securitiesAccount: {
          accountNumber: ACCOUNT,
          positions: [{ instrument: { symbol: "AAPL" } }],
        },
      },
    ]),
  );
});

test("optional bad metadata cannot erase quotes, malformed OHLC cannot become history", () => {
  const quotes = decodeQuotes(
    {
      AAPL: { quote: { lastPrice: 100 }, fundamental: { peRatio: "bad" } },
      MSFT: { quote: "bad" },
    },
    ["AAPL", "MSFT"],
  );
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].lastPrice, 100);
  assert.equal(quotes[0].peRatio, undefined);
  assert.throws(() =>
    decodeQuotes({ AAPL: { symbol: "MSFT", quote: {} } }, ["AAPL"]),
  );
  const bar = {
    datetime: initialTime,
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 20,
  };
  const decoded = decodeHistory(
    {
      symbol: "AAPL",
      candles: [bar, { ...bar, close: 102, volume: undefined }],
    },
    "AAPL",
  );
  assert.equal(decoded.candles.length, 1);
  assert.equal(decoded.candles[0].close, 102);
  assert.equal(decoded.candles[0].volume, undefined);
  for (const changes of [
    { high: 90 },
    { low: 110 },
    { open: NaN },
    { volume: -1 },
    { datetime: Infinity },
  ]) {
    assert.throws(() =>
      decodeHistory(
        { symbol: "AAPL", candles: [{ ...bar, ...changes }] },
        "AAPL",
      ),
    );
  }
  assert.throws(() => decodeHistory({ symbol: "MSFT", candles: [] }, "AAPL"));
});

test("all history ranges allow exactly their intended extended-hours requests", () => {
  const ranges: HistoryRange[] = [
    "intraday",
    "fiveDay",
    "daily",
    "weekly",
    "monthly",
    "minute1",
    "minute5",
    "minute15",
    "minute30",
    "minute60",
    "minute120",
  ];
  for (const range of ranges) {
    const q = historyQuery("AAPL", range, initialTime),
      minute = !["daily", "weekly", "monthly"].includes(range);
    assert.equal(q.get("needExtendedHoursData"), String(minute));
    validateRequest(ORIGIN + "/marketdata/v1/pricehistory?" + q);
    const wrong = new URLSearchParams(q);
    wrong.set("needExtendedHoursData", String(!minute));
    assert.throws(() =>
      validateRequest(ORIGIN + "/marketdata/v1/pricehistory?" + wrong),
    );
    wrong.set("needExtendedHoursData", "TRUE");
    assert.throws(() =>
      validateRequest(ORIGIN + "/marketdata/v1/pricehistory?" + wrong),
    );
    q.append("frequency", "1");
    assert.throws(() =>
      validateRequest(ORIGIN + "/marketdata/v1/pricehistory?" + q),
    );
  }
  const bounded = historyQuery("AAPL", "minute120", initialTime);
  assert.equal(
    Number(bounded.get("endDate")) - Number(bounded.get("startDate")),
    30 * 86_400_000,
  );
  bounded.set("startDate", "0");
  assert.throws(() =>
    validateRequest(ORIGIN + "/marketdata/v1/pricehistory?" + bounded),
  );
});

test("transport policy refuses foreign origins, normalized paths, duplicate queries and unsupported writes", () => {
  for (const raw of [
    ORIGIN.replace("https", "http") + "/trader/v1/accounts?fields=positions",
    "https://api.schwabapi.com.evil.test/trader/v1/accounts?fields=positions",
    "https://api.schwabapi.com:443/trader/v1/accounts?fields=positions",
    "https://user@api.schwabapi.com/trader/v1/accounts?fields=positions",
    ORIGIN + "/trader/v1/x/../accounts?fields=positions",
    ORIGIN + "/trader/v1/%61ccounts?fields=positions",
    ORIGIN + "/trader/v1/accounts?fields=positions&fields=positions",
    ORIGIN + "/trader/v1/accounts?fields=positions#",
    ORIGIN + "/trader/v1/accounts?fields=positions&extra=1",
  ])
    assert.throws(() => validateRequest(raw));
  assert.throws(() =>
    validateRequest(
      ORIGIN + "/trader/v1/accounts?fields=positions",
      "POST",
      "{}",
      "application/json",
    ),
  );
  assert.throws(() =>
    validateRequest(ORIGIN + `/trader/v1/accounts/${HASH}/orders`, "DELETE"),
  );
  assert.throws(() =>
    validateRequest(
      ORIGIN + `/trader/v1/accounts/${HASH}/orders`,
      "POST",
      "{}",
      "text/plain",
    ),
  );
});

test("receipt location is accepted only for the exact account and digit-only order", () => {
  const path = `/trader/v1/accounts/${HASH}/orders/123`;
  assert.equal(orderIDFromLocation(path, HASH), "123");
  assert.equal(orderIDFromLocation(ORIGIN + path, HASH), "123");
  for (const raw of [
    "https://evil.test" + path,
    "//api.schwabapi.com" + path,
    path + "?x=1",
    path + "#",
    path + "/extra",
    path.replace(HASH, "OtherHash"),
    path.replace("123", "%31%32%33"),
    " " + path,
  ])
    assert.equal(orderIDFromLocation(raw, HASH), undefined);
});

test("credentials and usable authorization survive reload; saving the same keys keeps tokens", async () => {
  const f = fixture();
  assert.equal((await f.broker.status()).configured, false);
  await f.authorize();
  await f.broker.configure(" " + CLIENT + " ", SECRET);
  assert.equal((await f.create().status()).authenticated, true);
  await f.broker.disconnect();
  assert.deepEqual(await f.create().status(), {
    configured: true,
    authenticated: false,
    expiresAt: undefined,
    refreshExpiresAt: undefined,
    reauthorizationRequired: true,
    unresolvedOperation: false,
  });
  await f.broker.disconnect(true);
  assert.equal((await f.create().status()).configured, false);
});

test("invalid credentials and storage failures never echo sensitive values", async () => {
  const f = fixture();
  for (const [id, secret] of [
    ["bad:id", SECRET],
    [CLIENT, "with space"],
    ["", SECRET],
    [CLIENT, "x".repeat(513)],
    [CLIENT, "bad\nsecret"],
  ]) {
    await rejectsCode(f.broker.configure(id, secret), "invalidCredentials");
  }
  f.vault.failGet = true;
  await rejectsCode(f.broker.status(), "secureStorage");
  f.vault.failGet = false;
  await f.broker.configure(CLIENT, SECRET);
  f.vault.failSetKey = SESSION;
  await rejectsCode(f.broker.configure("changed_id", SECRET), "secureStorage");
  f.vault.failSetKey = undefined;
  assert.equal((await f.broker.status()).configured, true);
});

test("callback validation rejects host, path, state and duplicate ambiguity before any token request", async () => {
  const f = fixture();
  await f.broker.configure(CLIENT, SECRET);
  const state = new URL(await f.broker.authorizationURL()).searchParams.get(
    "state",
  )!;
  const good = `https://127.0.0.1/?state=${state}&code=fake`;
  for (const value of [
    good.replace("https:", "http:"),
    good.replace("127.0.0.1", "127.0.0.1.evil.test"),
    good.replace("127.0.0.1", "127.0.0.1:443"),
    good.replace("/?", "/evil?"),
    good + "#fragment",
    good + "&code=second",
    good + "&state=" + state,
    good.replace(state, "0".repeat(64)),
    good.replace("fake", "fake%0Asecret"),
  ])
    await rejectsCode(f.broker.completeAuthorization(value), "invalidCallback");
  assert.equal(f.requests.length, 0);
  await f.broker.completeAuthorization(good);
  assert.equal(f.requests.length, 1);
  const form = new URLSearchParams(String(f.requests[0].init.body));
  assert.equal(form.get("redirect_uri"), CALLBACK_URL);
  await rejectsCode(
    f.broker.completeAuthorization(good),
    "authorizationExpired",
  );
});

test("pending authorization persists across restart and expires after ten minutes or clock reversal", async () => {
  for (const elapsed of [600_001, -1]) {
    const f = fixture();
    await f.broker.configure(CLIENT, SECRET);
    const state = new URL(await f.broker.authorizationURL()).searchParams.get(
      "state",
    )!;
    f.clock.value += elapsed;
    await rejectsCode(
      f
        .create()
        .completeAuthorization(`${CALLBACK_URL}?state=${state}&code=fake`),
      "authorizationExpired",
    );
    assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  await f.broker.configure(CLIENT, SECRET);
  const state = new URL(await f.broker.authorizationURL()).searchParams.get(
    "state",
  )!;
  await f
    .create()
    .completeAuthorization(`${CALLBACK_URL}?state=${state}&code=fake`);
  assert.equal((await f.create().status()).authenticated, true);
});

test("denied and unsuccessfully exchanged authorization codes cannot be replayed after restart", async () => {
  for (const declined of [false, true]) {
    const f = fixture();
    await f.broker.configure(CLIENT, SECRET);
    const state = new URL(await f.broker.authorizationURL()).searchParams.get(
      "state",
    )!;
    f.state.onRequest = async (raw) =>
      response(raw, { error_description: SECRET }, 400);
    const callback = `${CALLBACK_URL}?state=${state}&${declined ? "error=access_denied" : "code=fake"}`;
    await rejectsCode(
      f.broker.completeAuthorization(callback),
      declined ? "authorizationDeclined" : "httpStatus",
    );
    await rejectsCode(
      f.create().completeAuthorization(callback),
      "authorizationExpired",
    );
    assert.equal(f.requests.length, declined ? 0 : 1);
  }
});

test("in-flight old authorization cannot restore a session after disconnect", async () => {
  const f = fixture();
  await f.broker.configure(CLIENT, SECRET);
  const state = new URL(await f.broker.authorizationURL()).searchParams.get(
    "state",
  )!;
  const entered = deferred<void>(),
    gate = deferred<void>();
  f.state.onRequest = async () => {
    entered.resolve();
    await gate.promise;
    return undefined;
  };
  const pending = f.broker.completeAuthorization(
    `${CALLBACK_URL}?state=${state}&code=fake`,
  );
  await entered.promise;
  await f.broker.disconnect();
  gate.resolve();
  await rejectsCode(pending, "sessionChanged");
  assert.equal((await f.create().status()).authenticated, false);
});

test("concurrent expired-token reads share exactly one refresh request", async () => {
  const f = fixture();
  f.state.tokenSeconds = 61;
  await f.authorize();
  f.clock.value += 2_000;
  await Promise.all([
    f.broker.accounts(),
    f.broker.accounts(),
    f.broker.quotes(["AAPL", "MSFT"]),
  ]);
  const refreshes = f.requests.filter(
    (r) =>
      new URLSearchParams(String(r.init.body)).get("grant_type") ===
      "refresh_token",
  );
  assert.equal(refreshes.length, 1);
  assert.equal((await f.create().status()).authenticated, true);
});

test("refresh rejection invalidates persisted authentication without leaking provider error descriptions", async () => {
  const f = fixture();
  f.state.tokenSeconds = 61;
  await f.authorize();
  f.clock.value += 2_000;
  f.state.onRequest = async (url, init) =>
    new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token"
      ? response(url, { error: "invalid_grant", error_description: SECRET }, 400)
      : undefined;
  await rejectsCode(f.broker.accounts(), "authorizationRequired");
  assert.equal((await f.create().status()).authenticated, false);
});

test("failed secure-store reads can retry, malformed stored sessions fail closed", async () => {
  const f = fixture();
  f.vault.failGet = true;
  await rejectsCode(f.broker.status(), "secureStorage");
  f.vault.failGet = false;
  await f.authorize();
  assert.equal((await f.broker.status()).authenticated, true);
  f.vault.values.set(SESSION, "{" + SECRET);
  await rejectsCode(f.create().status(), "secureStorage");
  await f.create().disconnect(true);
  assert.equal((await f.create().status()).configured, false);
});

test("API errors retain refresh credentials and never expose response payload", async () => {
  for (const status of [401, 403]) {
    const f = fixture();
    await f.authorize();
    f.state.onRequest = async (raw) => response(raw, SECRET, status);
    await rejectsCode(f.broker.accounts(), "httpStatus");
    assert.equal((await f.create().status()).authenticated, true);
  }
  const f = fixture();
  await f.authorize();
  f.state.onRequest = async (raw) =>
    response(raw.replace("api.schwabapi.com", "untrusted.test"), SECRET);
  await rejectsCode(f.broker.accounts(), "redirectRejected");
  assert.equal(f.requests.at(-1)?.init.redirect, "error");
  assert.equal(f.requests.at(-1)?.init.credentials, "omit");
});

test("stream credentials are fetched through broker auth and disconnect closes the stream", async () => {
  const f = fixture();
  let readCredentials:
    | (() => Promise<import("./marketStream.ts").StreamCredentials>)
    | undefined;
  let closes = 0;
  const broker = new SchwabBroker(f.vault, {
    fetch: f.fetcher,
    now: () => f.clock.value,
    randomState: () => "a".repeat(64),
    stream: (symbol, getCredentials) => {
      assert.equal(symbol, "AAPL");
      readCredentials = getCredentials;
      return () => {
        closes++;
      };
    },
  });
  await f.authorize(broker);
  const stop = broker.subscribeMarket("aapl", {
    onQuote: () => {},
    onCandle: () => {},
    onStatus: () => {},
  });
  const credentials = await readCredentials!();
  assert.equal(credentials.customerId, "fixture-customer");
  assert.ok(credentials.accessToken);
  assert.equal(
    f.requests.at(-1) && new URL(f.requests.at(-1)!.url).pathname,
    "/trader/v1/userPreference",
  );
  await broker.disconnect();
  assert.equal(closes, 1);
  await rejectsCode(readCredentials!(), "sessionChanged");
  stop();
  assert.equal(closes, 1);
  assert.equal(f.writes().length, 0);
});

test("fast quote reads skip optional fundamental requests without changing default reads", async () => {
  const f = fixture();
  await f.authorize();
  const start = f.requests.length;
  const [quote] = await f.broker.quotes(["AAPL"], { fundamentals: false });
  assert.equal(quote.symbol, "AAPL");
  assert.deepEqual(
    f.requests.slice(start).map((r) => new URL(r.url).pathname),
    ["/marketdata/v1/quotes"],
  );
  assert.equal(f.writes().length, 0);
});

test("real data methods decode account, fundamentals, minute history and detail fixtures", async () => {
  const f = fixture();
  await f.authorize();
  assert.equal((await f.broker.accounts())[0].positions[0].quantity, 20.5);
  const quote = (await f.broker.quotes(["aapl"]))[0];
  assert.equal(quote.marketCap, 50_000_000);
  assert.equal(quote.sharesOutstanding, 500_000);
  assert.equal(quote.peRatio, 25.5);
  for (const range of [
    "intraday",
    "fiveDay",
    "minute1",
    "minute5",
    "minute15",
    "minute30",
    "minute60",
    "minute120",
  ] as HistoryRange[]) {
    const history = await f.broker.history("AAPL", range);
    assert.equal(history.candles.length, 2, range);
    assert.equal(history.previousClose, 99);
    assert.equal(history.candles[0].volume, 10);
    assert.equal(
      new URL(f.requests.at(-1)!.url).searchParams.get("needExtendedHoursData"),
      "true",
    );
  }
  assert.equal((await f.broker.orderDetail(ACCOUNT, "123")).id, "123");
  await rejectsCode(
    f.broker.orderDetail(ACCOUNT, "../123"),
    "invalidOrderIdentifier",
  );
  await rejectsCode(
    f.broker.orders("missing-account"),
    "invalidTradingAccount",
  );
});

test("preparation uses fresh accounts, quotes and orders and returns a deeply frozen single-use review", async () => {
  const f = fixture();
  await f.authorize();
  f.state.orders = [orderDTO()];
  const mutable = { ...draft, side: "SELL" as const };
  const review = await f.broker.prepare(ACCOUNT, mutable);
  mutable.quantity = 99;
  assert.equal(review.draft.quantity, 5);
  assert.equal(review.availableShares, 15);
  assert.equal(review.estimatedValue, 500);
  assert.equal(Object.isFrozen(review), true);
  assert.equal(Object.isFrozen(review.draft), true);
  assert.equal(Object.isFrozen(review.quote), true);
  assert.equal(JSON.stringify(review).includes(SECRET), false);
  assert.equal(JSON.stringify(review).includes(HASH), false);
  assert.throws(() => {
    review.draft.quantity = 6;
  });
  assert.equal(f.writes().length, 0);
  await rejectsCode(
    f.broker.prepare(ACCOUNT, { ...draft, side: "SELL", quantity: 16 }),
    "insufficientShares",
  );
  await rejectsCode(
    f.broker.prepare(ACCOUNT, { ...draft, quantity: 101 }),
    "insufficientFunds",
  );
});

test("fresh validation starts orders and replacement detail after hash without waiting for accounts or quotes", async () => {
  for (const stage of ["prepare", "submit"] as const) {
    for (const replacementID of [undefined, "123"]) {
      const f = fixture();
      await f.authorize();
      const ticket = { ...draft, side: "SELL" as const };
      const review = stage === "submit"
        ? await f.broker.prepare(ACCOUNT, ticket, replacementID) : undefined;
      const hashGate = deferred<void>(), accountGate = deferred<void>(), quoteGate = deferred<void>(),
        ordersGate = deferred<void>(), detailGate = deferred<void>();
      const started = new Set<string>();
      f.state.onRequest = async (url, init) => {
        if (init.method !== "GET") return undefined;
        const path = new URL(url).pathname;
        started.add(path);
        if (path.endsWith("/accountNumbers")) await hashGate.promise;
        else if (path === "/trader/v1/accounts") await accountGate.promise;
        else if (path === "/marketdata/v1/quotes") await quoteGate.promise;
        else if (path.endsWith("/orders")) await ordersGate.promise;
        else if (path.endsWith("/orders/123")) await detailGate.promise;
        return undefined;
      };
      let completed = false;
      const operation = (review ? f.broker.submit(review) : f.broker.prepare(ACCOUNT, ticket, replacementID))
        .then(value => { completed = true; return value; });
      const ordersPath = `/trader/v1/accounts/${HASH}/orders`;
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(started.has("/trader/v1/accounts"), true);
        assert.equal(started.has("/marketdata/v1/quotes"), true);
        assert.equal(started.has(ordersPath), false, "orders must depend on the fresh account hash");
        hashGate.resolve();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(started.has(ordersPath), true, `${stage}: slow accounts/quotes must not delay orders`);
        assert.equal(started.has(`${ordersPath}/123`), replacementID !== undefined,
          "replacement detail starts alongside orders, only for replacements");
        ordersGate.resolve();
        detailGate.resolve();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(completed, false);
        assert.equal(f.writes().length, 0, "pending account/quote checks must still block writes");
        accountGate.resolve();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(completed, false, "the final quote check must also finish");
        assert.equal(f.writes().length, 0);
      } finally {
        hashGate.resolve(); accountGate.resolve(); quoteGate.resolve();
        ordersGate.resolve(); detailGate.resolve();
        await operation;
      }
      assert.equal(f.writes().length, stage === "submit" ? 1 : 0);
    }
  }
});

test("a failed parallel validation read cannot enter the order write boundary", async () => {
  for (const failurePath of ["/trader/v1/accounts", "/marketdata/v1/quotes",
    "/trader/v1/accounts/accountNumbers", `/trader/v1/accounts/${HASH}/orders`,
    `/trader/v1/accounts/${HASH}/orders/123`]) {
    const f = fixture();
    await f.authorize();
    const review = await f.broker.prepare(ACCOUNT, { ...draft, side: "SELL" }, "123");
    const gate = deferred<void>();
    f.state.onRequest = async (url, init) => {
      if (init.method === "GET" && new URL(url).pathname === failurePath) {
        await gate.promise;
        return response(url, {}, 503);
      }
      return undefined;
    };
    const operation = rejectsCode(f.broker.submit(review), "httpStatus");
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(f.writes().length, 0);
    } finally {
      gate.resolve();
      await operation;
    }
    assert.equal(f.writes().length, 0, failurePath);
    assert.equal(f.vault.values.has(MARKER), false);
  }
});

test("double tapping a reviewed order sends one write, with marker persisted before fetch", async () => {
  const f = fixture();
  await f.authorize();
  const review = await f.broker.prepare(ACCOUNT, draft);
  const entered = deferred<void>(),
    gate = deferred<void>();
  f.state.onRequest = async (_url, init) => {
    if (init.method === "POST") {
      assert.notEqual(f.vault.values.get(MARKER), undefined);
      entered.resolve();
      await gate.promise;
    }
    return undefined;
  };
  const submission = f.broker.submit(review);
  await entered.promise;
  await rejectsCode(f.broker.submit(review), "operationBusy");
  await rejectsCode(f.broker.acknowledgeReconciliation(), "operationBusy");
  gate.resolve();
  assert.deepEqual(await submission, { orderID: "456" });
  await rejectsCode(f.broker.submit(review), "reviewExpired");
  assert.equal(f.writes().length, 1);
  assert.equal(f.vault.values.has(MARKER), false);
});

test("constructed, expired, replaced, and cross-session reviews cannot write", async () => {
  for (const scenario of ["constructed", "expired", "changed", "newer"]) {
    const f = fixture();
    await f.authorize();
    const review = await f.broker.prepare(ACCOUNT, draft);
    let submitted = review;
    if (scenario === "constructed") submitted = { ...review };
    if (scenario === "expired") f.clock.value += 120_001;
    if (scenario === "changed")
      await f.broker.configure("new_fixture_id", "new_fixture_secret");
    if (scenario === "newer")
      await f.broker.prepare(ACCOUNT, { ...draft, quantity: 1 });
    await rejectsCode(f.broker.submit(submitted), "reviewExpired");
    assert.equal(f.writes().length, 0);
  }
});

test("submit refreshes changed buying power and reserved sells before entering write boundary", async () => {
  const f = fixture();
  await f.authorize();
  const buy = await f.broker.prepare(ACCOUNT, draft);
  f.state.accounts = accountDTO(100);
  await rejectsCode(f.broker.submit(buy), "insufficientFunds");
  f.state.accounts = accountDTO();
  const sell = await f.broker.prepare(ACCOUNT, {
    ...draft,
    side: "SELL",
    quantity: 20,
  });
  f.state.orders = [orderDTO()];
  await rejectsCode(f.broker.submit(sell), "insufficientShares");
  assert.equal(f.writes().length, 0);
  assert.equal(f.vault.values.has(MARKER), false);
});

test("unsupported asset or a truncated order window cannot enter preparation", async () => {
  const f = fixture();
  await f.authorize();
  f.state.quoteAsset = "OPTION";
  await rejectsCode(f.broker.prepare(ACCOUNT, draft), "unsupportedAsset");
  f.state.quoteAsset = "EQUITY";
  f.state.orders = Array.from({ length: 200 }, (_, index) =>
    orderDTO({ orderId: String(index + 1), status: "FILLED" }),
  );
  await rejectsCode(f.broker.prepare(ACCOUNT, draft), "ordersTruncated");
  const orderQuery = new URL(f.requests.at(-1)!.url).searchParams;
  assert.equal(
    Date.parse(orderQuery.get("toEnteredTime")!) -
      Date.parse(orderQuery.get("fromEnteredTime")!),
    30 * 86_400_000,
  );
  assert.equal(f.writes().length, 0);
});

test("order history reads one bounded window and rejects ranges over 60 days", async () => {
  const f = fixture();
  await f.authorize();
  f.state.orders = [orderDTO({ orderId: "7", status: "FILLED" })];
  const to = Date.parse("2026-10-18T12:00:00.000Z"),
    from = to - 45 * 86_400_000;
  const orders = await f.broker.orderHistory(ACCOUNT, from, to);
  assert.deepEqual(orders.map((o) => o.id), ["7"]);
  const query = new URL(f.requests.at(-1)!.url).searchParams;
  assert.equal(query.get("fromEnteredTime"), new Date(from).toISOString());
  assert.equal(query.get("toEnteredTime"), new Date(to).toISOString());
  assert.equal(query.get("maxResults"), "200");
  const count = f.requests.length;
  for (const [a, b] of [[to - 61 * 86_400_000, to], [to, from], [Number.NaN, to]])
    await rejectsCode(f.broker.orderHistory(ACCOUNT, a, b), "invalidDateRange");
  assert.equal(f.requests.length, count);
  assert.equal(f.writes().length, 0);
});

test("operation marker write failure prevents sending and does not echo secure-store errors", async () => {
  const f = fixture();
  await f.authorize();
  const review = await f.broker.prepare(ACCOUNT, draft);
  f.vault.failSetKey = MARKER;
  await rejectsCode(f.broker.submit(review), "secureStorage");
  assert.equal(f.writes().length, 0);
});

test("network errors and server ambiguity persist reconciliation and never retry writes", async () => {
  for (const status of [0, 408, 500, 202, 302]) {
    const f = fixture();
    await f.authorize();
    const review = await f.broker.prepare(ACCOUNT, draft);
    f.state.onRequest = async (url, init) => {
      if (init.method !== "POST") return undefined;
      if (status === 0) throw new Error(SECRET);
      return response(url, SECRET, status);
    };
    await rejectsCode(f.broker.submit(review), "orderOutcomeUnknown");
    assert.equal(f.writes().length, 1);
    assert.equal((await f.create().status()).unresolvedOperation, true);
    await rejectsCode(
      f.create().prepare(ACCOUNT, draft),
      "orderOutcomeUnknown",
    );
  }
});

test("definitive order rejections clear reconciliation without write or authentication retries", async () => {
  for (const status of [400, 401, 403, 429]) {
    const f = fixture();
    await f.authorize();
    const review = await f.broker.prepare(ACCOUNT, draft);
    f.state.onRequest = async (url, init) =>
      init.method === "POST"
        ? response(url, { error: SECRET }, status)
        : undefined;
    await rejectsCode(f.broker.submit(review), "httpStatus");
    assert.equal(f.writes().length, 1);
    assert.equal((await f.create().status()).unresolvedOperation, false);
    assert.equal((await f.create().status()).authenticated, true);
  }
});

test("accepted write without a verifiable receipt stays unresolved across disconnect and key changes", async () => {
  const f = fixture();
  await f.authorize();
  const review = await f.broker.prepare(ACCOUNT, draft);
  f.state.onRequest = async (url, init) =>
    init.method === "POST"
      ? response(url, undefined, 201, {
          location: "https://untrusted.test/orders/123",
        })
      : undefined;
  assert.deepEqual(await f.broker.submit(review), { orderID: undefined });
  await f.broker.disconnect(true);
  await f.broker.configure("another_fixture_id", SECRET);
  assert.equal((await f.create().status()).unresolvedOperation, true);
  await f.broker.acknowledgeReconciliation();
  assert.equal((await f.create().status()).unresolvedOperation, false);
});

test("failure to clear a successful write marker remains conservatively unresolved", async () => {
  const f = fixture();
  await f.authorize();
  const review = await f.broker.prepare(ACCOUNT, draft);
  f.vault.failRemove = true;
  await rejectsCode(f.broker.submit(review), "orderOutcomeUnknown");
  assert.equal((await f.create().status()).unresolvedOperation, true);
  assert.equal(f.writes().length, 1);
});

test("replacement verifies the original again and uses PUT with the immutable draft", async () => {
  const f = fixture();
  await f.authorize();
  const replacement = { ...draft, side: "SELL" as const, quantity: 20 };
  f.state.orders = [orderDTO()];
  const review = await f.broker.prepare(ACCOUNT, replacement, "123");
  assert.equal(review.availableShares, 20);
  const receipt = await f.broker.submit(review);
  assert.equal(receipt.orderID, "456");
  assert.equal(f.writes()[0].init.method, "PUT");
  assert.equal(
    new URL(f.writes()[0].url).pathname.endsWith("/orders/123"),
    true,
  );
  const second = await f.broker.prepare(ACCOUNT, replacement, "123");
  f.state.detail = orderDTO({ filledQuantity: 1 });
  await rejectsCode(f.broker.submit(second), "replacementChanged");
  assert.equal(f.writes().length, 1);
});

test("cancel checks fresh detail, refuses complex or changed orders, and sends DELETE once", async () => {
  const f = fixture();
  await f.authorize();
  for (const patch of [
    { cancelable: false },
    { status: "FILLED" },
    { status: "PENDING_CANCEL" },
    { childOrderStrategies: [{}] },
  ]) {
    f.state.detail = orderDTO(patch);
    await rejectsCode(f.broker.cancel(ACCOUNT, "123"), "orderChanged");
  }
  assert.equal(f.writes().length, 0);
  f.state.detail = orderDTO();
  await f.broker.cancel(ACCOUNT, "123");
  assert.equal(f.writes().length, 1);
  assert.equal(f.writes()[0].init.method, "DELETE");
  assert.equal((await f.create().status()).unresolvedOperation, false);
});

test("extended-session and collective ETF orders reserve shares and cancel without being replaceable", async () => {
  for (const assetType of ["EQUITY", "COLLECTIVE_INVESTMENT"]) {
    for (const session of ["NORMAL", "AM", "PM", "SEAMLESS"]) {
      const f = fixture();
      await f.authorize();
      const [account] = decodeAccounts(accountDTO(3.56, 25));
      const quote = {
        symbol: "AAPL",
        assetMainType: "EQUITY",
        assetSubType: "ETF",
      };
      f.state.detail = orderDTO({
        session,
        orderLegCollection: [
          {
            instruction: "SELL",
            quantity: 5,
            instrument: { symbol: "AAPL", assetType },
          },
        ],
      });
      f.state.orders = [f.state.detail];
      const [order] = await f.broker.orders(ACCOUNT);
      assert.equal(
        maximumSell(account, "AAPL", [order], true, undefined, quote),
        20,
      );
      assert.equal(order.cancelable, true);
      if (session !== "NORMAL" || assetType === "COLLECTIVE_INVESTMENT")
        assert.equal(order.editable, false);
      await f.broker.cancel(ACCOUNT, "123");
      assert.equal(f.writes().length, 1);
      assert.equal(f.writes()[0].init.method, "DELETE");
      assert.equal(
        new URL(f.writes()[0].url).pathname,
        `/trader/v1/accounts/${HASH}/orders/123`,
      );
      assert.equal(f.writes()[0].init.body, undefined);
    }
  }
});

test("pending, noncancelable and complex orders stay unavailable and explain why", async () => {
  for (const patch of [
    { status: "PENDING_CANCEL" },
    { status: "PENDING_REPLACE" },
    { status: "FILLED" },
    { cancelable: false },
    { orderStrategyType: "TRIGGER" },
    { childOrderStrategies: [{}] },
  ]) {
    const f = fixture();
    await f.authorize();
    f.state.detail = orderDTO({ session: "SEAMLESS", ...patch });
    const order = await f.broker.orderDetail(ACCOUNT, "123");
    assert.equal(order.cancelable, false);
    assert.ok(order.cancelUnavailableReason);
    await assert.rejects(f.broker.cancel(ACCOUNT, "123"), {
      code: "orderChanged",
    });
    assert.equal(f.writes().length, 0);
  }
  const [account] = decodeAccounts(accountDTO(3.56, 25));
  const buy = decodeOrder(
    orderDTO({
      session: "SEAMLESS",
      orderLegCollection: [
        {
          instruction: "BUY",
          quantity: 5,
          instrument: { symbol: "AAPL", assetType: "EQUITY" },
        },
      ],
    }),
  );
  assert.equal(maximumSell(account, "AAPL", [buy]), 25);
  const sell = decodeOrder(
    orderDTO({ session: "PM", remainingQuantity: undefined }),
  );
  assert.equal(maximumSell(account, "AAPL", [sell]), undefined);
});

test("uncertain cancel persists the same duplicate-write block across restart", async () => {
  const f = fixture();
  await f.authorize();
  f.state.onRequest = async (_url, init) => {
    if (init.method === "DELETE") throw new Error(SECRET);
    return undefined;
  };
  await rejectsCode(f.broker.cancel(ACCOUNT, "123"), "orderOutcomeUnknown");
  await rejectsCode(f.create().cancel(ACCOUNT, "123"), "orderOutcomeUnknown");
  assert.equal(f.writes().length, 1);
});

test("an actual fetch timeout aborts and keeps the persisted uncertain write marker", async () => {
  const f = fixture();
  await f.authorize();
  let writeCount = 0,
    aborted = false;
  const broker = new SchwabBroker(f.vault, {
    now: () => f.clock.value,
    randomState: () => "a".repeat(64),
    timeoutMilliseconds: 10,
    fetch: async (url, init) => {
      if (init.method !== "POST") return f.fetcher(url, init);
      writeCount++;
      assert.equal(f.vault.values.has(MARKER), true);
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error(SECRET));
        }),
      );
    },
  });
  const review = await broker.prepare(ACCOUNT, draft);
  await rejectsCode(broker.submit(review), "orderOutcomeUnknown");
  assert.equal(writeCount, 1);
  assert.equal(aborted, true);
  assert.equal((await f.create().status()).unresolvedOperation, true);
});

test("changing credentials during refresh prevents the old refresh from repopulating storage", async () => {
  const f = fixture();
  f.state.tokenSeconds = 61;
  await f.authorize();
  f.clock.value += 2_000;
  const entered = deferred<void>(),
    gate = deferred<void>();
  f.state.onRequest = async (_url, init) => {
    if (
      new URLSearchParams(String(init.body)).get("grant_type") ===
      "refresh_token"
    ) {
      entered.resolve();
      await gate.promise;
    }
    return undefined;
  };
  const reading = f.broker.accounts();
  await entered.promise;
  await f.broker.configure("new_fixture_client", "new_fixture_secret");
  gate.resolve();
  await rejectsCode(reading, "sessionChanged");
  assert.equal((await f.create().status()).authenticated, false);
  assert.equal(
    JSON.parse(f.vault.values.get(SESSION)!).credentials.clientID,
    "new_fixture_client",
  );
});

test("disconnect during an in-flight write cannot clear the reconciliation requirement", async () => {
  const f = fixture();
  await f.authorize();
  const review = await f.broker.prepare(ACCOUNT, draft);
  const entered = deferred<void>(),
    gate = deferred<void>();
  f.state.onRequest = async (_url, init) => {
    if (init.method === "POST") {
      entered.resolve();
      await gate.promise;
    }
    return undefined;
  };
  const writing = f.broker.submit(review);
  await entered.promise;
  await f.broker.disconnect();
  gate.resolve();
  await rejectsCode(writing, "orderOutcomeUnknown");
  const status = await f.create().status();
  assert.equal(status.authenticated, false);
  assert.equal(status.unresolvedOperation, true);
  assert.equal(f.writes().length, 1);
});

test("a failed token persistence still leaves authorization codes consumed", async () => {
  const f = fixture();
  await f.broker.configure(CLIENT, SECRET);
  const state = new URL(await f.broker.authorizationURL()).searchParams.get(
    "state",
  )!;
  f.state.onRequest = async () => {
    f.vault.failSetKey = SESSION;
    return undefined;
  };
  const callback = `${CALLBACK_URL}?state=${state}&code=fake`;
  await rejectsCode(f.broker.completeAuthorization(callback), "secureStorage");
  f.vault.failSetKey = undefined;
  await rejectsCode(
    f.create().completeAuthorization(callback),
    "authorizationExpired",
  );
  assert.equal((await f.create().status()).authenticated, false);
  assert.equal(f.requests.length, 1);
});

test("malformed tokens and duplicate account mappings never establish usable access", async () => {
  for (const token of [
    { access_token: "bad token", expires_in: 1800 },
    { access_token: "fixture", expires_in: 0 },
    { access_token: "fixture", expires_in: 100_000 },
    { access_token: "fixture", expires_in: 1800, token_type: "Basic" },
  ]) {
    const f = fixture();
    f.state.onRequest = async (url) => response(url, token);
    await rejectsCode(f.authorize(), "invalidResponse");
    assert.equal((await f.create().status()).authenticated, false);
  }
  const f = fixture();
  await f.authorize();
  f.state.onRequest = async (url) =>
    url.includes("accountNumbers")
      ? response(url, [
          { accountNumber: ACCOUNT, hashValue: HASH },
          { accountNumber: ACCOUNT, hashValue: "OtherHash" },
        ])
      : undefined;
  await rejectsCode(f.broker.prepare(ACCOUNT, draft), "invalidResponse");
  assert.equal(f.writes().length, 0);
});


test("GET 401 recovery refreshes once across concurrent rejected reads and bounds retries", async () => {
  const f = fixture();
  await f.authorize();
  let refreshes = 0;
  f.state.onRequest = async (url, init) => {
    if (url.includes("/oauth/token")) {
      refreshes++;
      return response(url, { access_token: "new_access", expires_in: 1800 });
    }
    if (init.headers && (init.headers as Record<string, string>).Authorization === "Bearer fixture_access_token")
      return response(url, {}, 401);
    return undefined;
  };
  await Promise.all([f.broker.accounts(), f.broker.accounts(), f.broker.quotes(["AAPL"])]);
  assert.equal(refreshes, 1);
  f.state.onRequest = async (url) => url.includes("/oauth/token")
    ? response(url, { access_token: "another_access", expires_in: 1800 })
    : response(url, {}, 401);
  const start = f.requests.length;
  await rejectsCode(f.broker.accounts(), "httpStatus");
  assert.equal(f.requests.length - start, 3);
  assert.equal((await f.create().status()).authenticated, true);
});

test("transient and configuration refresh errors preserve credentials and original refresh expiry", async () => {
  for (const providerError of ["invalid_client", "temporarily_unavailable", undefined]) {
    const f = fixture();
    await f.authorize();
    const before = JSON.parse(f.vault.values.get(SESSION)!).token;
    assert.equal(before.refreshIssuedAt, initialTime);
    assert.equal(before.refreshExpiresAt, initialTime + 7 * 86_400_000);
    f.clock.value += 1_800_000;
    f.state.onRequest = async (url) => response(url, { error: providerError, error_description: SECRET }, 400);
    await rejectsCode(f.broker.maintainAuthorization(), "httpStatus");
    assert.deepEqual(JSON.parse(f.vault.values.get(SESSION)!).token, before);
    f.state.onRequest = undefined;
    await f.broker.maintainAuthorization();
    const after = JSON.parse(f.vault.values.get(SESSION)!).token;
    assert.equal(after.refreshIssuedAt, before.refreshIssuedAt);
    assert.equal(after.refreshExpiresAt, before.refreshExpiresAt);
  }
});

test("legacy refresh metadata remains unknown and known expiry requests reauthorization", async () => {
  const f = fixture();
  await f.authorize();
  const session = JSON.parse(f.vault.values.get(SESSION)!);
  delete session.token.refreshIssuedAt;
  delete session.token.refreshExpiresAt;
  f.vault.values.set(SESSION, JSON.stringify(session));
  f.clock.value += 1_800_000;
  const legacy = f.create();
  await legacy.maintainAuthorization();
  assert.equal((await legacy.status()).refreshExpiresAt, undefined);
  session.token.refreshExpiresAt = initialTime + 1000;
  f.vault.values.set(SESSION, JSON.stringify(session));
  const expired = f.create();
  assert.equal((await expired.status()).reauthorizationRequired, true);
  await rejectsCode(expired.maintainAuthorization(), "authorizationRequired");
});

test("atomic quick submit uses one fresh validation and returns immutable non-replayable receipt snapshot", async () => {
  const f = fixture();
  await f.authorize();
  const start = f.requests.length;
  const { snapshot, result } = await f.broker.submitQuick(ACCOUNT, draft);
  assert.deepEqual(result, { orderID: "456" });
  assert.equal(f.requests.slice(start).filter(r => r.init.method === "GET").length, 4);
  assert.equal(f.writes().length, 1);
  assert.equal(Object.isFrozen(snapshot.draft), true);
  await rejectsCode(f.broker.submit(snapshot), "reviewExpired");
});

test("atomic quick submit rejects insufficient funds and preserves unknown-outcome blockade", async () => {
  const f = fixture();
  await f.authorize();
  f.state.accounts = accountDTO(0);
  await rejectsCode(f.broker.submitQuick(ACCOUNT, draft), "insufficientFunds");
  assert.equal(f.writes().length, 0);
  f.state.accounts = accountDTO();
  f.state.onRequest = async (url, init) => init.method === "POST" ? response(url, {}, 500) : undefined;
  await rejectsCode(f.broker.submitQuick(ACCOUNT, draft), "orderOutcomeUnknown");
  await rejectsCode(f.broker.submitQuick(ACCOUNT, draft), "orderOutcomeUnknown");
  assert.equal(f.writes().length, 1);
});


test("quick submission freezes input, serializes competing writes and invalidates older reviews", async () => {
  const f = fixture();
  await f.authorize();
  const review = await f.broker.prepare(ACCOUNT, draft);
  const gate = deferred<void>(), entered = deferred<void>();
  f.state.onRequest = async (url, init) => {
    if (init.method === "GET" && url.endsWith("/accountNumbers")) {
      entered.resolve();
      await gate.promise;
    }
    return undefined;
  };
  const mutable = { ...draft };
  const pending = f.broker.submitQuick(ACCOUNT, mutable);
  await entered.promise;
  mutable.quantity = 5000;
  await rejectsCode(f.broker.submitQuick(ACCOUNT, draft), "operationBusy");
  await rejectsCode(f.broker.cancel(ACCOUNT, "123"), "operationBusy");
  gate.resolve();
  const receipt = await pending;
  assert.equal(receipt.snapshot.draft.quantity, 5);
  assert.equal(JSON.parse(String(f.writes()[0].init.body)).orderLegCollection[0].quantity, 5);
  await rejectsCode(f.broker.submit(review), "reviewExpired");
});

test("quick submission aborted by disconnect never crosses the order write boundary", async () => {
  const f = fixture();
  await f.authorize();
  const gate = deferred<void>(), entered = deferred<void>();
  f.state.onRequest = async (url, init) => {
    if (init.method === "GET" && url.endsWith("/accountNumbers")) {
      entered.resolve(); await gate.promise;
    }
    return undefined;
  };
  const pending = f.broker.submitQuick(ACCOUNT, draft);
  await entered.promise;
  await f.broker.disconnect();
  gate.resolve();
  await rejectsCode(pending, "sessionChanged");
  assert.equal(f.writes().length, 0);
});


test("quick submission rejects validation aged over a minute before any write", async () => {
  const f = fixture();
  await f.authorize();
  f.state.onRequest = async (url, init) => {
    if (init.method === "GET" && url.includes("/orders?")) f.clock.value += 60_001;
    return undefined;
  };
  await rejectsCode(f.broker.submitQuick(ACCOUNT, draft), "reviewExpired");
  assert.equal(f.writes().length, 0);
});

test("late 401 from an older token reuses the completed refresh without a second exchange", async () => {
  const f = fixture();
  await f.authorize();
  const entered = deferred<void>(), gate = deferred<void>();
  let staleReads = 0, refreshes = 0;
  f.state.onRequest = async (url, init) => {
    if (url.includes("/oauth/token")) {
      refreshes++;
      return response(url, { access_token: "new_access", expires_in: 1800 });
    }
    if ((init.headers as Record<string, string>).Authorization === "Bearer fixture_access_token") {
      if (++staleReads === 1) { entered.resolve(); await gate.promise; }
      return response(url, {}, 401);
    }
    return undefined;
  };
  const late = f.broker.accounts();
  await entered.promise;
  await f.broker.accounts();
  gate.resolve();
  await late;
  assert.equal(refreshes, 1);
});


test("quick submission rechecks freshness after token renewal before marking or sending", async () => {
  const f = fixture();
  f.state.tokenSeconds = 61;
  await f.authorize();
  f.state.onRequest = async (url, init) => {
    if (init.method === "GET" && url.includes("/orders?")) f.clock.value += 2000;
    if (new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token")
      f.clock.value += 60_001;
    return undefined;
  };
  await rejectsCode(f.broker.submitQuick(ACCOUNT, draft), "reviewExpired");
  assert.equal(f.writes().length, 0);
  assert.equal(f.vault.values.has(MARKER), false);
});

test("quick submission rechecks freshness after slow marker storage and cleans definite unsent state", async () => {
  for (const cleanupFails of [false, true]) {
    const f = fixture();
    await f.authorize();
    const set = f.vault.set.bind(f.vault);
    f.vault.set = async (key, value) => {
      await set(key, value);
      if (key === MARKER) f.clock.value += 60_001;
    };
    f.vault.failRemove = cleanupFails;
    await rejectsCode(f.broker.submitQuick(ACCOUNT, draft), cleanupFails ? "orderOutcomeUnknown" : "reviewExpired");
    assert.equal(f.writes().length, 0);
    assert.equal(f.vault.values.has(MARKER), cleanupFails);
    assert.equal((await f.broker.status()).unresolvedOperation, cleanupFails);
  }
});


test("opt-in phase timings expose only bounded metadata and observer throws cannot change acceptance", async () => {
  const f = fixture();
  const samples: { phase: string; durationMs: number; outcome: string }[] = [];
  const broker = new SchwabBroker(f.vault, {
    fetch: f.fetcher, now: () => f.clock.value, randomState: () => "a".repeat(64),
    onTiming: sample => { samples.push(sample); throw new Error(SECRET); },
  });
  await f.authorize(broker);
  f.state.onRequest = async (_url, init) => {
    f.clock.value += init.method === "POST" ? 25 : 10;
    return undefined;
  };
  const result = await broker.submitQuick(ACCOUNT, draft);
  assert.equal(result.result.orderID, "456");
  assert.equal((await broker.status()).unresolvedOperation, false);
  assert.deepEqual(samples.map(s => [s.phase, s.outcome]), [["validation", "ok"], ["submit", "ok"]]);
  assert.equal(samples[1].durationMs, 25);
  for (const sample of samples) {
    assert.deepEqual(Object.keys(sample).sort(), ["durationMs", "outcome", "phase"]);
    assert.ok(Number.isFinite(sample.durationMs) && sample.durationMs >= 0 && sample.durationMs <= 300_000);
  }
  assert.equal(JSON.stringify(samples).includes(SECRET), false);
});

test("phase timings include validation, refresh and write failures without provider text", async () => {
  const f = fixture();
  const samples: { phase: string; durationMs: number; outcome: string }[] = [];
  const broker = new SchwabBroker(f.vault, {
    fetch: f.fetcher, now: () => f.clock.value, randomState: () => "a".repeat(64),
    onTiming: sample => { samples.push(sample); },
  });
  await f.authorize(broker);
  f.state.accounts = accountDTO(0);
  await rejectsCode(broker.submitQuick(ACCOUNT, draft), "insufficientFunds");
  assert.equal(samples.at(-1)?.outcome, "error");
  f.state.accounts = accountDTO();
  f.clock.value += 1_800_000;
  f.state.onRequest = async (url) => { f.clock.value -= 100; return response(url, { error: "invalid_client", error_description: SECRET }, 400); };
  await rejectsCode(broker.maintainAuthorization(), "httpStatus");
  assert.deepEqual(samples.at(-1), { phase: "refresh", outcome: "error", durationMs: 0 });
  f.state.onRequest = undefined;
  await broker.maintainAuthorization();
  assert.equal(samples.at(-1)?.phase, "refresh");
  assert.equal(samples.at(-1)?.outcome, "ok");
  f.state.onRequest = async (url, init) => {
    if (init.method === "POST") { f.clock.value += 900_000; return response(url, { description: SECRET }, 503); }
    return undefined;
  };
  await rejectsCode(broker.submitQuick(ACCOUNT, draft), "orderOutcomeUnknown");
  assert.deepEqual(samples.at(-1), { phase: "submit", outcome: "error", durationMs: 300_000 });
  assert.equal(JSON.stringify(samples).includes(SECRET), false);
});
