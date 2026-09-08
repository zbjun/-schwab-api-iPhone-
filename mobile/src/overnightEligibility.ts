import {
  OVERNIGHT_CHECKED_ON,
  OVERNIGHT_HOLDINGS_AS_OF,
  SCHWAB_OVERNIGHT_EXAMPLES,
  SP500_REFERENCE_SYMBOLS,
} from "./overnightReference.ts";

export { OVERNIGHT_CHECKED_ON, OVERNIGHT_HOLDINGS_AS_OF };
const stocks = new Set(SP500_REFERENCE_SYMBOLS);
const examples = new Set(SCHWAB_OVERNIGHT_EXAMPLES);
const checked = Date.parse(`${OVERNIGHT_CHECKED_ON}T00:00:00Z`);
// Fail closed when the bundled reference is old. Never treat a quote or the
// presence of extended-session candles as evidence of overnight eligibility.
export function overnightReferenceFresh(now = Date.now()): boolean {
  return Number.isFinite(now) && now >= checked && now < checked + 30 * 86400000;
}

export function overnightReference(
  symbol: string,
  now = Date.now(),
): "index-reference" | "schwab-example" | undefined {
  if (!overnightReferenceFresh(now)) return undefined;
  let key = symbol.trim().toUpperCase();
  // Known class-share notation only; never collapse arbitrary ticker suffixes.
  if (key === "BRK/B") key = "BRK.B";
  if (key === "BF/B") key = "BF.B";
  if (stocks.has(key)) return "index-reference";
  if (examples.has(key)) return "schwab-example";
  return undefined;
}
