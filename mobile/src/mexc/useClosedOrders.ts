import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MexcOrder } from "../mexcRules.ts";
import type { MexcState } from "./useMexc.ts";
import { batches, closedOrderSymbols, closedOrderWindow, noteRecentContracts, parseRecentContracts, RECENT_CONTRACTS_KEY, type RecentContract } from "./mexcView.ts";

const AT_ONCE = 4;
const RELOAD_MS = 60_000;

/** Closed orders across the contracts worth asking about, while the orders page is on screen. Reads only. */
export function useClosedOrders(m: Pick<MexcState, "api" | "account" | "openOrders" | "configured">, favorites: readonly string[], active: boolean) {
  const [recent, setRecent] = useState<RecentContract[]>([]);
  const [orders, setOrders] = useState<MexcOrder[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(RECENT_CONTRACTS_KEY).then(raw => { if (live) setRecent(parseRecentContracts(raw)); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const held = (m.account?.positions ?? []).filter(position => position.holdVol > 0);
  const current = useMemo(() => [...held.map(position => position.symbol), ...m.openOrders.map(order => order.symbol)], [m.account, m.openOrders]);
  const currentKey = [...new Set(current)].sort().join();
  useEffect(() => {
    if (!currentKey) return;
    setRecent(previous => {
      const next = noteRecentContracts(previous, currentKey.split(","), Date.now());
      AsyncStorage.setItem(RECENT_CONTRACTS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [currentKey]);
  const symbols = useMemo(() => closedOrderSymbols(current, recent, favorites), [current, recent, favorites]);
  const symbolsKey = symbols.join();
  // Asked for again as soon as a position or a working order moves, since that is when an order has just closed.
  const moved = [...held.map(row => `${row.id}:${row.holdVol}`), ...m.openOrders.map(order => `${order.id}:${order.dealVol}`)].join();
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    const list = symbolsKey ? symbolsKey.split(",") : [];
    const { from, to } = closedOrderWindow(Date.now());
    const found: MexcOrder[] = [], missing: string[] = [];
    for (const group of batches(list, AT_ONCE)) {
      await Promise.all(group.map(symbol => m.api.closedOrders(symbol, from, to)
        .then(rows => { found.push(...rows); })
        .catch(() => { missing.push(symbol); })));
      if (mine !== generation.current) return;
    }
    setOrders(found);
    setFailed(missing);
    setLoaded(true);
  }, [m.api, symbolsKey]);
  useEffect(() => {
    if (!active || m.configured === false) return;
    void load();
    const timer = setInterval(() => void load(), RELOAD_MS);
    return () => { clearInterval(timer); generation.current++; };
  }, [active, load, moved, m.configured]);
  return { orders, failed, loaded, symbols, reload: load };
}
