import React, { useState } from "react";
import { ScrollView, View } from "react-native";
import { DemoNotice } from "./DemoNotice.tsx";
import { FillExportPanel } from "./FillExportPanel.tsx";
import { PageRefreshControl } from "./PageRefreshControl.tsx";
import { ScheduledOrders } from "./ScheduledOrders.tsx";
import { OrderList } from "./TradePanel.tsx";
import type { Order, Palette } from "./types.ts";
import { Chip, styles } from "./ui.tsx";
import type { TradingState } from "./useTrading.ts";
import { MexcExportPanel } from "./mexc/MexcExportPanel.tsx";
import { useMexcOrderRows } from "./mexc/MexcOrders.tsx";
import { demoNotice, venueDemoNotice } from "./mexc/mexcView.ts";
import type { MexcState } from "./mexc/useMexc.ts";

type Filter = "all" | "schwab" | "mexc";
const FILTERS: [Filter, string][] = [["all", "全部"], ["schwab", "Schwab"], ["mexc", "MEXC"]];

/** One order list for both venues. Each row keeps its own venue's cancel; nothing about sending is shared. */
export default function UnifiedOrders({ state: s, m, palette: p, favorites, exporting, onCloseExport, onStock, onContract, onReplace }: {
  state: TradingState; m: MexcState; palette: Palette; favorites: readonly string[]; exporting: boolean; onCloseExport: () => void;
  onStock: (symbol: string) => void; onContract: (symbol: string) => void; onReplace: (order: Order) => void;
}) {
  const [picked, setPicked] = useState<Filter>("all");
  const hasMexc = m.configured !== false;
  const filter = hasMexc ? picked : "schwab";
  const mexc = useMexcOrderRows({ m, palette: p, favorites, active: hasMexc, onContract });
  const notice = filter === "all" ? demoNotice(s.isDemo, m.isDemo, true)
    : (filter === "mexc" ? m.isDemo : s.isDemo) ? venueDemoNotice(filter) : undefined;
  const schwabLine = `Schwab ${s.account?.displayNumber ?? "尚未连接"} · 最近 30 天`;
  const schwabNote = "点订单查看行情，点详情核对或管理委托。订单自动更新，最终状态以券商和交易所记录为准。";
  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical keyboardShouldPersistTaps="handled"
      refreshControl={<PageRefreshControl state={s} palette={p} refresh={async () => {
        // Only Schwab's read holds Schwab's lock and reports through it; a stuck MEXC gateway must not freeze Schwab.
        void m.refresh();
        void mexc.reload();
        await s.refresh();
      }} />}
      contentContainerStyle={[styles.pageContent, { gap: 10 }]}>
      {!!notice && <DemoNotice palette={p} card text={notice} />}
      {exporting && filter !== "mexc" && <FillExportPanel state={s} palette={p} onClose={onCloseExport} />}
      {exporting && filter !== "schwab" && <MexcExportPanel m={m} palette={p} symbols={mexc.symbols} onClose={onCloseExport} />}
      {filter !== "mexc" && <ScheduledOrders state={s} palette={p} />}
      {hasMexc && (
        <View style={{ flexDirection: "row", gap: 6 }}>
          {FILTERS.map(([id, label]) => (
            <Chip key={id} label={label} accessibilityLabel={`只看 ${label}`} palette={p} active={filter === id} style={{ flex: 1 }} onPress={() => setPicked(id)} />
          ))}
        </View>
      )}
      <OrderList state={s} palette={p} onStock={onStock} onReplace={onReplace} quickCancel={filter === "schwab"}
        extraRows={filter === "schwab" ? [] : mexc.rows} hideOwn={filter === "mexc"}
        headline={filter === "all" ? "Schwab 最近 30 天 · MEXC 最近 7 天" : filter === "mexc" ? "MEXC · 最近 7 天" : schwabLine}
        footnote={filter === "schwab" ? schwabNote : `${schwabNote} ${mexc.note}`} />
    </ScrollView>
  );
}
