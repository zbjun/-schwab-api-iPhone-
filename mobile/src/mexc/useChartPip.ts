import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChartPriceLine } from "../chartLines.ts";
import { barMilliseconds } from "../chartCountdown.ts";
import type { MexcClient } from "../MexcClient.ts";
import type { MexcContract } from "../mexcRules.ts";
import type { History, HistoryRange, Palette } from "../types.ts";
import type { MexcState } from "./useMexc.ts";
import { PIP_KEY, pipCandles, priceDecimals } from "./mexcView.ts";

interface PipNative {
  isSupported(): boolean;
  prepare(config: unknown): Promise<void>;
  update(candles: unknown, lines: unknown): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  release(): Promise<void>;
  addListener(event: "onPipState", listener: (event: { state: string; message?: string }) => void): { remove(): void };
}
// Absent on the web and in Expo Go, where the button simply does not appear.
const native = Platform.OS === "ios" ? requireOptionalNativeModule<PipNative>("ThsChartPip") : null;

/**
 * The floating chart for the contract on screen: it opens by itself on going home, and from the button.
 * Everything it does is read-only. It sends the last candles over while the app is in front,
 * and native code keeps them current through the gateway's `live` call while it floats.
 */
export function useChartPip({ m, contract, history, range, rangeLabel, priceLines, palette: p }: {
  m: MexcState; contract: MexcContract; history?: History; range: HistoryRange; rangeLabel: string; priceLines: ChartPriceLine[]; palette: Palette;
}) {
  const available = !m.isDemo && !!native && native.isSupported();
  // Unknown until the saved choice is read, so turning it off holds from the first moment.
  const [enabled, setEnabled] = useState<boolean>();
  const [prepared, setPrepared] = useState(false);
  const [active, setActive] = useState(false);
  const sentAt = useRef(0);
  const lines = priceLines.map(({ label, price, color }) => ({ label, price, color }));
  const hasHistory = !!history && history.symbol === contract.symbol;

  useEffect(() => {
    let live = true;
    void AsyncStorage.getItem(PIP_KEY).then(value => { if (live) setEnabled(value !== "off"); }).catch(() => { if (live) setEnabled(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!available) return;
    const subscription = native!.addListener("onPipState", ({ state, message }) => {
      setActive(state === "active");
      if (state === "failed") m.setMessage(`小窗打开失败${message ? `：${message}` : "。"}`);
    });
    return () => subscription.remove();
  }, [available, m.setMessage]);
  useEffect(() => {
    if (!available || !enabled || !hasHistory) return;
    let live = true;
    void (m.api as MexcClient).liveConnection().then(connection => {
      if (!live || !connection) return;
      const period = barMilliseconds(range);
      return native!.prepare({
        origin: connection.origin, deviceKey: connection.deviceKey, symbol: contract.symbol, title: contract.displayName, range, rangeLabel,
        barSeconds: period === undefined ? null : period / 1000, decimals: priceDecimals(contract.priceUnit), up: p.up, down: p.down,
        candles: pipCandles(history!.candles), lines,
      }).then(() => { if (live) { setPrepared(true); sentAt.current = Date.now(); } });
    }).catch(() => {});
    return () => {
      live = false;
      setPrepared(false);
      setActive(false);
      void native!.release().catch(() => {});
    };
  }, [available, enabled, hasHistory, m.api, contract.symbol, range]);
  // Fresh when the app goes to the background; it need not be this second, and native takes over from there.
  useEffect(() => {
    if (!prepared || !history || Date.now() - sentAt.current < 5_000) return;
    sentAt.current = Date.now();
    void native!.update(pipCandles(history.candles), lines).catch(() => {});
  }, [prepared, history]);
  // A level that has just been set or removed should not wait for that.
  useEffect(() => {
    if (prepared && history) void native!.update(pipCandles(history.candles), lines).catch(() => {});
  }, [prepared, priceLines]);

  const remember = (on: boolean) => {
    setEnabled(on);
    void AsyncStorage.setItem(PIP_KEY, on ? "on" : "off").catch(() => {});
  };
  return {
    available,
    enabled: !!enabled,
    active,
    /** First press opens it now, and a press while it floats closes it and stops it opening by itself. */
    toggle: () => {
      if (!enabled) { remember(true); m.setMessage("小窗已开启，回到桌面时会自动打开。"); return; }
      if (active) { void native!.stop().catch(() => {}); remember(false); return; }
      if (!prepared) { m.setMessage("K 线还没读完，稍后再开小窗。"); return; }
      void native!.start().catch(() => {});
    },
  };
}
