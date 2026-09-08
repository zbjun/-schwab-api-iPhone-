import assert from "node:assert/strict";
import test from "node:test";
import { overnightReference, overnightReferenceFresh } from "./overnightEligibility.ts";
import { SP500_REFERENCE_SYMBOLS } from "./overnightReference.ts";

const checked = Date.parse("2026-09-07T00:00:00Z");

test("overnight references distinguish index inference from Schwab examples", () => {
  assert.equal(overnightReference(" aapl ", checked), "index-reference");
  assert.equal(overnightReference("QQQ", checked), "schwab-example");
  assert.equal(overnightReference("TLT", checked), "schwab-example");
  assert.equal(new Set(SP500_REFERENCE_SYMBOLS).size, 503);
  assert.equal(SP500_REFERENCE_SYMBOLS.length, 503);
});

test("related or unverified tickers do not inherit overnight eligibility", () => {
  // SNDU is a leveraged fund linked to SNDK, not the underlying index constituent.
  for (const symbol of ["SNDU", "AAPL1", "QQQM", "AAPL/WS", "", "USD", "CASH", "FAKE"]) {
    assert.equal(overnightReference(symbol, checked), undefined, symbol);
  }
  assert.equal(overnightReference("BRK/B", checked), "index-reference");
  assert.equal(overnightReference("BF/B", checked), "index-reference");
  assert.equal(overnightReference("BRK/B/WS", checked), undefined);
});

test("stale references and invalid clock values cannot show an eligibility badge", () => {
  assert.equal(overnightReferenceFresh(checked - 1), false);
  assert.equal(overnightReferenceFresh(checked + 30 * 86400000 - 1), true);
  for (const time of [checked + 30 * 86400000, NaN, Infinity]) {
    assert.equal(overnightReference("AAPL", time), undefined);
    assert.equal(overnightReference("QQQ", time), undefined);
  }
});
