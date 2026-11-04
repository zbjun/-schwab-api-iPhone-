import React from "react";
import { ScrollView, Text } from "react-native";
import type { Palette } from "./types.ts";
import type { TradingState } from "./useTrading.ts";
import type { MexcState } from "./mexc/useMexc.ts";
import type { Venue } from "./mexc/mexcView.ts";
import { styles } from "./ui.tsx";
import { DemoNotice } from "./DemoNotice.tsx";
import { demoNotice } from "./mexc/mexcView.ts";
import { PageRefreshControl } from "./PageRefreshControl.tsx";
import { SchwabAccountSection } from "./Accounts.tsx";
import { MexcAccountSection } from "./mexc/MexcPositions.tsx";

/** Schwab (USD) and MEXC (USDT) accounts stacked on one page. They are never added together. */
export default function UnifiedAccounts({ state: s, m, palette: p, onStock, onContract, onTrade, onSettings }: {
  state: TradingState; m: MexcState; palette: Palette;
  onStock: (symbol: string) => void; onContract: (symbol: string) => void;
  onTrade: (venue: Venue) => void; onSettings: () => void;
}) {
  const title = (text: string) => <Text style={{ color: p.secondary, fontSize: 13, fontWeight: "600" }}>{text}</Text>;
  // Only Schwab's read holds Schwab's lock and reports through it; a stuck MEXC gateway must not freeze Schwab.
  const refresh = async () => { void m.refresh(); await s.refresh(); };
  // A lock left behind by a real order counts as MEXC being here, even with the connection gone.
  const notice = demoNotice(s.isDemo, m.isDemo, m.configured !== false || m.unconfirmed);
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      refreshControl={<PageRefreshControl state={s} palette={p} refresh={refresh} />}
      contentContainerStyle={[styles.pageContent, { gap: 10 }]}
    >
      {!!notice && <DemoNotice palette={p} card text={notice} />}
      {title("Schwab 股票")}
      <SchwabAccountSection state={s} palette={p} onStock={onStock} onTrade={() => onTrade("schwab")} />
      {title("MEXC 合约")}
      <MexcAccountSection m={m} palette={p} onContract={onContract} onSettings={onSettings} onTrade={() => onTrade("mexc")} />
    </ScrollView>
  );
}
