import type { MexcContract, MexcPosition, MexcTicker } from "./mexcRules.ts";
import { favoriteContracts, sortContracts } from "./mexc/mexcView.ts";

export type WatchItem =
  | { kind: "stock"; symbol: string }
  | { kind: "contract"; contract: MexcContract };
export type WatchFilter = "all" | "stock" | "contract" | "allContracts";

export const SEARCH_RESULTS = 8;

/** Runs at most `max` reads at once; the rest wait their turn, and a failed one does not hold up the others. */
export function createLimiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return <T>(work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        running++;
        Promise.resolve().then(work).then(resolve, reject).finally(() => {
          running--;
          waiting.shift()?.();
        });
      };
      if (running < max) start();
      else waiting.push(start);
    });
}

/** False only when this phone is known to have no MEXC connection; then no contract appears anywhere. */
export const contractsAvailable = (configured: boolean | undefined) => configured !== false;

export const itemKey = (item: WatchItem) => (item.kind === "stock" ? `s:${item.symbol}` : `c:${item.contract.symbol}`);

/** Stocks first, then the favourite contracts; each keeps its own order. Without MEXC there are no contracts. */
export function watchlistItems(
  stocks: readonly string[],
  favorites: readonly string[],
  contracts: readonly MexcContract[],
  configured: boolean | undefined,
): WatchItem[] {
  const stockItems = stocks.map((symbol): WatchItem => ({ kind: "stock", symbol }));
  if (!contractsAvailable(configured)) return stockItems;
  return [...stockItems, ...favoriteContracts(favorites, contracts).map((contract): WatchItem => ({ kind: "contract", contract }))];
}

export function filterItems(items: readonly WatchItem[], filter: WatchFilter): WatchItem[] {
  if (filter === "stock") return items.filter(item => item.kind === "stock");
  if (filter === "contract") return items.filter(item => item.kind === "contract");
  return [...items];
}

export function itemCounts(items: readonly WatchItem[]) {
  const contract = items.filter(item => item.kind === "contract").length;
  return { all: items.length, stock: items.length - contract, contract };
}

/** The whole contract list for the "所有合约" view; empty when MEXC is not connected on this phone. */
export const allContractItems = (contracts: readonly MexcContract[], configured: boolean | undefined) =>
  contractsAvailable(configured) ? sortContracts(contracts) : [];

/** Contracts matching what is typed, shown above the list; at most `SEARCH_RESULTS`. */
export function searchContracts(contracts: readonly MexcContract[], query: string, configured: boolean | undefined): MexcContract[] {
  if (!query.trim() || !contractsAvailable(configured)) return [];
  return sortContracts(contracts, query).slice(0, SEARCH_RESULTS);
}

/** Codes of contracts with an open position. */
export function heldContracts(positions: readonly Pick<MexcPosition, "symbol" | "holdVol">[] | undefined): Set<string> {
  return new Set((positions ?? []).filter(position => position.holdVol > 0).map(position => position.symbol));
}

/** Price change in the quote's own units, worked back from the rise/fall rate; undefined when it cannot be known. */
export function contractChange(ticker: Pick<MexcTicker, "lastPrice" | "riseFallRate"> | undefined): number | undefined {
  const last = ticker?.lastPrice, rate = ticker?.riseFallRate;
  if (last === undefined || rate === undefined || !Number.isFinite(last) || !Number.isFinite(rate) || rate <= -1) return undefined;
  const change = last - last / (1 + rate);
  return Number.isFinite(change) ? change : undefined;
}

export const trendOf = (value: number | undefined): "up" | "down" | "flat" =>
  value === undefined || !Number.isFinite(value) || value === 0 ? "flat" : value > 0 ? "up" : "down";
