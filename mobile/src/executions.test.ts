import test from "node:test";
import assert from "node:assert/strict";
import { decodeOrder } from "./orderRules.ts";

// Synthetic fills only: these tests never connect to a brokerage account.
const leg = (legId = 1, instruction = "BUY", assetType = "EQUITY") => ({
  legId,
  instruction,
  quantity: 25,
  instrument: { symbol: "SNDU", assetType },
});
const fill = (overrides: Record<string, unknown> = {}) => ({
  legId: 1,
  price: 24.1,
  quantity: 10,
  time: "2026-09-04T09:31:00-0400",
  ...overrides,
});
const activity = (
  executionLegs: unknown[] = [fill()],
  activityId?: number,
) => ({
  activityType: "EXECUTION",
  executionType: "FILL",
  activityId,
  executionLegs,
});
const order = (overrides: Record<string, unknown> = {}) => ({
  orderId: "123",
  status: "WORKING",
  orderType: "LIMIT",
  session: "NORMAL",
  duration: "DAY",
  orderStrategyType: "SINGLE",
  quantity: 25,
  filledQuantity: 10,
  remainingQuantity: 15,
  price: 24.5,
  cancelable: true,
  editable: false,
  enteredTime: "2026-09-04T09:00:00-0400",
  orderLegCollection: [leg()],
  ...overrides,
});

test("partial fills use actual execution price and time, with stable IDs", () => {
  const payload = order({
    orderActivityCollection: [
      activity(
        [fill({ quantity: 2, price: 24.2, time: "2026-09-04T13:32:00+0000" })],
        2,
      ),
      activity([fill()], 1),
    ],
  });
  const decoded = decodeOrder(payload);
  assert.equal(decoded.cancelable, true);
  assert.deepEqual(
    decoded.executions?.map(({ id, ...details }) => details),
    [
      {
        symbol: "SNDU",
        side: "BUY",
        time: Date.parse("2026-09-04T13:31:00Z"),
        price: 24.1,
        quantity: 10,
      },
      {
        symbol: "SNDU",
        side: "BUY",
        time: Date.parse("2026-09-04T13:32:00Z"),
        price: 24.2,
        quantity: 2,
      },
    ],
  );
  assert.deepEqual(decodeOrder(payload).executions, decoded.executions);
});

test("fills link to each execution leg, including ETF collective investment sells", () => {
  const decoded = decodeOrder(
    order({
      orderLegCollection: [
        leg(1, "BUY", "ETF"),
        leg(2, "SELL", "COLLECTIVE_INVESTMENT"),
        leg(3, "SELL", "OPTION"),
        leg(4, "SELL_SHORT"),
      ],
      orderActivityCollection: [
        activity([
          fill(),
          fill({ legId: 2 }),
          fill({ legId: 3 }),
          fill({ legId: 4 }),
          fill({ legId: 99 }),
        ]),
      ],
    }),
  );
  assert.deepEqual(
    decoded.executions?.map((f) => f.side),
    ["BUY", "SELL"],
  );
  assert.equal(decoded.executions?.length, 2);
});

test("entered order price and filled totals never fabricate executions", () => {
  for (const orderActivityCollection of [
    undefined,
    [],
    null,
    {},
    [
      { ...activity(), activityType: "ORDER_ACTION" },
      { ...activity(), executionType: "CANCELED" },
    ],
  ]) {
    const decoded = decodeOrder(order({ orderActivityCollection }));
    assert.deepEqual(decoded.executions, []);
    assert.equal(decoded.cancelable, true);
  }
});

test("malformed optional fills do not erase a valid fill or disable cancellation", () => {
  const bad = [
    null,
    {},
    fill({ price: -1 }),
    fill({ price: "24.1" }),
    fill({ quantity: 0 }),
    fill({ time: "invalid" }),
    fill({ time: undefined }),
    fill({ legId: undefined }),
    fill({ quantity: Infinity }),
  ];
  const decoded = decodeOrder(
    order({
      orderActivityCollection: [
        null,
        {},
        { ...activity(), executionLegs: {} },
        activity([...bad, fill()]),
      ],
    }),
  );
  assert.equal(decoded.executions?.length, 1);
  assert.equal(decoded.cancelable, true);
});

test("duplicate activities and fill rows do not inflate markers, distinct activity IDs survive", () => {
  const a = activity([fill(), fill()], 1);
  const decoded = decodeOrder(
    order({ orderActivityCollection: [a, a, activity([fill()], 2)] }),
  );
  assert.equal(decoded.executions?.length, 2);
  assert.equal(new Set(decoded.executions?.map((f) => f.id)).size, 2);
  assert.equal(
    decodeOrder(order({ orderActivityCollection: [activity(), activity()] }))
      .executions?.length,
    1,
  );
});

test("conflicting activity IDs and ambiguous order leg IDs are omitted conservatively", () => {
  assert.deepEqual(
    decodeOrder(
      order({
        orderActivityCollection: [
          activity([fill()], 1),
          activity([fill({ price: 99 })], 1),
        ],
      }),
    ).executions,
    [],
  );
  assert.deepEqual(
    decodeOrder(
      order({
        orderLegCollection: [leg(), leg(1, "SELL")],
        orderActivityCollection: [activity()],
      }),
    ).executions,
    [],
  );
});
