import test from "node:test";
import assert from "node:assert/strict";
import { tradeMarkers, positionAverageCost } from "./tradeMarkers.ts";
import type { Candle, Position, TradeExecution } from "./types.ts";
const candle = (time: string): Candle => ({
  time: Date.parse(time),
  open: 20,
  close: 21,
  high: 22,
  low: 19,
});
const fill = (
  time: string,
  extra: Partial<TradeExecution> = {},
): TradeExecution => ({
  id: time,
  symbol: "SNDU",
  side: "BUY",
  time: Date.parse(time),
  price: 20,
  quantity: 5,
  ...extra,
});
test("fills map to exact minute buckets and never jump gaps or sessions", () => {
  const candles = [
    candle("2026-09-04T13:30:00Z"),
    candle("2026-09-04T13:32:00Z"),
  ];
  const markers = tradeMarkers(candles, "minute1", "SNDU", [
    fill("2026-09-04T13:30:40Z"),
    fill("2026-09-04T13:31:20Z"),
    fill("2026-09-04T13:33:00Z"),
    fill("2026-09-04T13:32:10Z", { symbol: "SPY" }),
  ]);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].index, 0);
  assert.equal(
    tradeMarkers([candle("2026-09-04T19:30:00Z")], "minute60", "SNDU", [
      fill("2026-09-04T20:01:00Z"),
    ]).length,
    0,
  );
});
test("same-bar buys and sells remain separate and duplicate fills do not double count", () => {
  const a = fill("2026-09-04T13:30:10Z");
  const markers = tradeMarkers(
    [candle("2026-09-04T13:30:00Z")],
    "minute5",
    "SNDU",
    [
      a,
      a,
      fill("2026-09-04T13:31:00Z", { price: 22, quantity: 5 }),
      fill("2026-09-04T13:32:00Z", { side: "SELL", price: 23 }),
    ],
  );
  assert.deepEqual(
    markers.map((m) => [m.side, m.quantity, m.price, m.count]),
    [
      ["BUY", 10, 21, 2],
      ["SELL", 5, 23, 1],
    ],
  );
});
test("daily weekly monthly grouping uses New York dates across DST and calendar boundaries", () => {
  const executions = [fill("2026-11-02T15:00:00Z")];
  for (const range of ["daily", "weekly", "monthly"] as const)
    assert.equal(
      tradeMarkers(
        [candle("2026-11-02T05:00:00Z")],
        range,
        "SNDU",
        executions,
      )[0].index,
      0,
    );
  assert.equal(
    tradeMarkers([candle("2026-11-02T05:00:00Z")], "daily", "SNDU", [
      fill("2026-11-03T02:00:00Z"),
    ]).length,
    1,
  );
  assert.equal(
    tradeMarkers([candle("2026-11-02T05:00:00Z")], "weekly", "SNDU", [
      fill("2026-11-09T15:00:00Z"),
    ]).length,
    0,
  );
});
test("cost uses current long holdings and never fabricates missing cost or closed positions", () => {
  const p: Position = {
    symbol: "SNDU",
    assetType: "COLLECTIVE_INVESTMENT",
    quantity: 25,
    averagePrice: 24,
  };
  assert.equal(positionAverageCost([p], "SNDU"), 24);
  assert.equal(
    positionAverageCost([p, { ...p, quantity: 25, averagePrice: 26 }], "SNDU"),
    25,
  );
  for (const positions of [
    [],
    [{ ...p, quantity: 0 }],
    [{ ...p, averagePrice: undefined }],
    [{ ...p, quantity: -5 }],
  ])
    assert.equal(positionAverageCost(positions, "SNDU"), undefined);
});
