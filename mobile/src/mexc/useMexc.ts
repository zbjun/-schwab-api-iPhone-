import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { MexcApi, MexcStatus } from "../MexcClient.ts";
import type { MexcAccount, MexcContract, MexcDraft, MexcLeveragePrepared, MexcLimits, MexcOrder, MexcPrepared, MexcStopPrepared, MexcTicker } from "../mexcRules.ts";
import { batches, blockMessage, lockUnconfirmed, parseQuickMode, QUICK_MODE_KEY, tradingLocked, writeInProgress } from "./mexcView.ts";
import { MexcController } from "./mexcController.ts";

export { errorText } from "./mexcController.ts";

export interface MexcState {
  api: MexcApi;
  isDemo: boolean;
  status?: MexcStatus;
  account?: MexcAccount;
  contracts: MexcContract[];
  limits?: MexcLimits;
  openOrders: MexcOrder[];
  /** The last refresh failed, so what is shown is old data. */
  offline: boolean;
  /** False when this phone has no saved MEXC connection; undefined until that is known. */
  configured?: boolean;
  /** When the account was last read successfully. */
  updatedAt?: number;
  message: string;
  setMessage: (value: string) => void;
  /** Writes are disabled: an unconfirmed order exists, or the server is still processing one. */
  locked: boolean;
  /** Show the "outcome unconfirmed" banner. False while a write is merely in flight. */
  unconfirmed: boolean;
  writeInProgress: boolean;
  /** Server-side closure of order entry. Cancels and viewing stay available. */
  blockedCode?: string;
  blockedText?: string;
  refresh: () => Promise<void>;
  /** Runs one action, shows any error as text, and notes an unknown outcome. Never retries. */
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
  noteError: (error: unknown) => void;
  /** A background poll failed. The same text is not shown again until a poll from that source succeeds. */
  pollError: (source: string, error: unknown) => void;
  pollOk: (source: string) => void;
  acknowledge: () => Promise<void>;
  /** Forgets the account, positions and orders shown. */
  clear: () => void;
  /** A place or cancel is on the wire. Leaving the screen is not allowed meanwhile. */
  sending: boolean;
  place: (prepared: MexcPrepared) => Promise<{ orderID?: string; error?: string; unknown?: boolean }>;
  /** On: a press on the form reviews and sends, and one press cancels. Off by default, and whenever it cannot be read. */
  quickMode: boolean;
  quickModeReady: boolean;
  changeQuickMode: (value: boolean) => Promise<void>;
  quickPlace: (draft: MexcDraft, isCurrent: () => boolean) => Promise<{ orderID?: string; error?: string; unknown?: boolean }>;
  cancel: (orderID: string) => Promise<boolean>;
  /** A cancel for this order was accepted a moment ago and the list has not caught up. */
  cancelSent: (orderID: string) => boolean;
  changeLeverage: (prepared: MexcLeveragePrepared) => Promise<{ leverage?: number; error?: string; unknown?: boolean }>;
  changeStop: (prepared: MexcStopPrepared) => Promise<{ done?: boolean; error?: string; unknown?: boolean }>;
}

/** Thin React wrapper; every rule lives in MexcController. */
export function useMexc(api: MexcApi): MexcState {
  const controller = useMemo(() => new MexcController(api), [api]);
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [quickMode, setQuickMode] = useState(false);
  const [quickModeReady, setQuickModeReady] = useState(false);
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(QUICK_MODE_KEY)
      .then(raw => { if (active) { setQuickMode(parseQuickMode(raw)); setQuickModeReady(true); } })
      .catch(() => { if (active) setQuickModeReady(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    void controller.refresh();
    const timer = setInterval(() => void controller.refresh(), 15_000);
    return () => { clearInterval(timer); controller.dispose(); };
  }, [controller]);
  return useMemo(() => ({
    api, isDemo: api.isDemo, status: snap.status, account: snap.account, contracts: snap.contracts, limits: snap.limits,
    openOrders: snap.openOrders, offline: snap.offline, configured: snap.configured, updatedAt: snap.updatedAt, message: snap.message, setMessage: controller.setMessage,
    locked: tradingLocked(snap.status, snap.sawUnknown),
    unconfirmed: lockUnconfirmed(snap.status, snap.sawUnknown, snap.sending),
    writeInProgress: writeInProgress(snap.status),
    blockedCode: snap.status?.tradingBlocked, blockedText: blockMessage(snap.status?.tradingBlocked),
    refresh: controller.refresh, run: controller.run, noteError: controller.noteError, pollError: controller.pollError,
    pollOk: controller.pollOk, acknowledge: () => controller.acknowledge(), clear: () => controller.reset(),
    sending: snap.sending, place: p => controller.place(p), cancel: id => controller.cancel(id), cancelSent: controller.cancelSent,
    quickMode, quickModeReady, quickPlace: (draft, isCurrent) => controller.quickPlace(draft, isCurrent),
    changeQuickMode: async value => {
      // Turning it off counts at once, even if saving fails. Turning it on waits, so it never shows on and then comes back off.
      if (!value) setQuickMode(false);
      await AsyncStorage.setItem(QUICK_MODE_KEY, value ? "true" : "false");
      setQuickMode(value);
    },
    changeLeverage: p => controller.changeLeverage(p),
    changeStop: p => controller.changeStop(p),
  }), [api, controller, snap, quickMode, quickModeReady]);
}

/** Latest quotes for only the symbols on screen, in batches of at most 100. */
export function useTickers(m: Pick<MexcState, "api" | "pollError" | "pollOk">, symbols: string[], refreshMs = 10_000) {
  const [tickers, setTickers] = useState<Record<string, MexcTicker>>({});
  const key = symbols.join(",");
  useEffect(() => {
    let active = true, loading = false;
    const load = async () => {
      // One at a time, so a slow answer can never land after a newer one and show an older price.
      if (!key || loading) return;
      loading = true;
      try {
        const rows = (await Promise.all(batches(key.split(",")).map(group => m.api.tickers(group)))).flat();
        // Only what was just asked for: a quote kept from an earlier visit could fill a stale price into an order form.
        if (active) { setTickers(Object.fromEntries(rows.map(t => [t.symbol, t]))); m.pollOk("tickers"); }
      } catch (error) {
        if (active) m.pollError("tickers", error);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => { active = false; clearInterval(timer); };
  }, [m.api, m.pollError, m.pollOk, key, refreshMs]);
  return tickers;
}
