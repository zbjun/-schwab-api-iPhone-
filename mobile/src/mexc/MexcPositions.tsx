import React from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import type { MexcPosition } from "../mexcRules.ts";
import { DemoNotice } from "../DemoNotice.tsx";
import { Button, Icon, money, radius, signed, styles } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { closableOf, openTypeLabel, priceText } from "./mexcView.ts";
import { EmptyState } from "./parts.tsx";

// Same structure as the Schwab accounts page: account card, big equity, three columns, then the position list.
export default function MexcPositions({ m, palette: p, onClose, onSettings, onTrade }: {
  m: MexcState; palette: Palette; onClose: (position: MexcPosition) => void; onSettings: () => void; onTrade: () => void;
}) {
  const [refreshing, setRefreshing] = React.useState(false);
  const asset = m.account?.asset;
  const unit = (symbol: string) => m.contracts.find(c => c.symbol === symbol)?.priceUnit;
  const pnlColor = (value?: number) => (value ?? 0) > 0 ? p.up : (value ?? 0) < 0 ? p.down : p.secondary;
  const positions = m.account?.positions ?? [];
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.pageContent, { gap: 10, opacity: m.offline ? 0.45 : 1 }]}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.secondary}
        onRefresh={() => { setRefreshing(true); void m.refresh().finally(() => setRefreshing(false)); }} />}>
      {m.isDemo && <DemoNotice palette={p} card />}
      {!m.account && (
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: 12, gap: 10 }}>
          <Text style={{ color: p.text, fontSize: 15 }}>{m.offline ? "还没有连上 MEXC 网关" : "正在读取账户…"}</Text>
          {m.offline && <>
            <Text style={{ color: p.secondary, fontSize: 13, lineHeight: 19 }}>请先保存服务器地址和设备访问密钥。</Text>
            <Button label="连接设置" palette={p} variant="tinted" onPress={onSettings} />
          </>}
        </View>
      )}
      {asset && (
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, paddingHorizontal: 12, paddingBottom: 12 }}>
          <View style={[styles.spread, { minHeight: 42 }]}>
            <Text style={{ color: p.text, fontSize: 15, fontWeight: "600" }}>账户</Text>
            <Text style={{ color: p.secondary, fontSize: 12 }}>MEXC 合约账户</Text>
          </View>
          <View style={{ height: 1, backgroundColor: p.separator }} />
          <View style={[styles.spread, { marginTop: 10 }]}>
            <Text style={{ color: p.secondary, fontSize: 12 }}>账户净值 · {asset.currency}{m.isDemo ? " · 演示账户" : ""}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="去交易" disabled={m.sending} onPress={onTrade}
              style={[styles.row, { gap: 4, opacity: m.sending ? 0.4 : 1 }]}>
              <Icon name="trade" color={p.accent} size={16} />
              <Text style={{ color: p.accent, fontSize: 12, fontWeight: "600" }}>交易</Text>
            </Pressable>
          </View>
          <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.number, { color: p.text, fontSize: 30, fontWeight: "700", marginTop: 4 }]}>
            {money(asset.equity)}
          </Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
            {([
              ["可用", money(asset.availableBalance), p.text],
              ["持仓保证金", money(asset.positionMargin), p.text],
              ["未实现盈亏", signed(asset.unrealized), pnlColor(asset.unrealized)],
            ] as const).map(([label, value, color]) => (
              <View key={label} style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: p.secondary, fontSize: 11 }}>{label}</Text>
                <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.number, { color, fontSize: 14, fontWeight: "600", marginTop: 2 }]}>{value}</Text>
              </View>
            ))}
          </View>
          <Text style={{ color: p.secondary, fontSize: 11, marginTop: 10 }}>下拉刷新账户</Text>
        </View>
      )}
      {m.account && (
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, paddingHorizontal: 12 }}>
          <View style={[styles.spread, { minHeight: 34 }]}>
            <Text style={{ color: p.secondary, fontSize: 12, fontWeight: "600" }}>持仓 {positions.length}</Text>
            <Text style={{ color: p.secondary, fontSize: 11 }}>张数 / 均价 · 盈亏 / 强平价</Text>
          </View>
          {positions.map(position => {
            const long = position.direction === "LONG";
            const pnl = position.unrealized;
            const u = unit(position.symbol);
            return (
              <Pressable key={position.id} accessibilityRole="button" disabled={m.sending}
                accessibilityLabel={`${position.symbol} ${long ? "多" : "空"} 平仓`} onPress={() => onClose(position)}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 65, paddingVertical: 8,
                  borderTopWidth: 1, borderTopColor: p.separator }}>
                <View style={{ flex: 1.3, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ color: p.text, fontSize: 15, fontWeight: "500" }}>{position.symbol}</Text>
                  <Text numberOfLines={1} style={{ color: p.secondary, fontSize: 11, marginTop: 2 }}>
                    <Text style={{ color: long ? p.up : p.down, fontWeight: "700" }}>{long ? "多" : "空"}</Text>
                    {` ${openTypeLabel(position.openType)} ${position.leverage}x · 可平 ${closableOf(position)}`}
                  </Text>
                </View>
                <View style={{ flex: 1, alignItems: "flex-end" }}>
                  <Text style={[styles.number, { color: p.text, fontSize: 15, fontWeight: "600" }]}>{String(position.holdVol)}</Text>
                  <Text style={[styles.number, { color: p.secondary, fontSize: 11, marginTop: 2 }]}>{priceText(position.averagePrice, u)}</Text>
                </View>
                <View style={{ flex: 1, alignItems: "flex-end" }}>
                  <Text style={[styles.number, { color: pnlColor(pnl), fontSize: 15, fontWeight: "600" }]}>{signed(pnl)}</Text>
                  <Text style={[styles.number, { color: p.secondary, fontSize: 11, marginTop: 2 }]}>{priceText(position.liquidatePrice, u)}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
      {m.account && positions.length === 0 && <EmptyState palette={p} text="暂无持仓" />}
      {positions.length > 0 && (
        <Text style={{ color: p.secondary, fontSize: 11, lineHeight: 16 }}>点持仓行可预填平仓方向，仍需核对后下单。</Text>
      )}
    </ScrollView>
  );
}
