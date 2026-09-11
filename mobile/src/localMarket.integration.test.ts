import test from "node:test";
import assert from "node:assert/strict";
import { DemoBroker } from "./demo.ts";
import { executeLocalMarket } from "./localMarket.ts";

test("local market uses the actual demo broker's one-use preparation and confirms timed cancellation", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    const broker = new DemoBroker();
    const [account] = await broker.accounts();
    let elapsed = 0;
    const result = await executeLocalMarket({
      broker, accountID: account.id, symbol: "AAPL", side, quantity: 1,
      session: "PM", settings: { boundaryPercent: 0.7, durationSeconds: 3, slippagePercent: 0.1 },
      isDemo: true, isCurrent: () => true, shouldStop: () => false,
      onProgress: () => {}, now: () => Date.now() + elapsed, sleep: async ms => { elapsed += ms; },
    });
    assert.equal(result.orderIDs.length, 1, result.message);
    const order = await broker.orderDetail(account.id, result.orderIDs[0]);
    assert.equal(order.status, "CANCELED");
    assert.equal(order.side, side);
    assert.equal(order.kind, "LIMIT");
    assert.equal(order.session, "PM");
    assert.equal(order.duration, "DAY");
    assert.equal(result.filledQuantity, 0);
    assert.match(result.message, /已确认撤销/);
  }
});
