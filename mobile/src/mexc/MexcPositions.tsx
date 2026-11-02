import React from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import type { MexcPosition } from "../mexcRules.ts";
import { Button, Meta, money, signed, styles } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { closableOf, openTypeLabel, priceText } from "./mexcView.ts";
import { Notice } from "./parts.tsx";

export default function MexcPositions({ m, palette: p, onClose, onSettings }: {
  m: MexcState; palette: Palette; onClose: (position: MexcPosition) => void; onSettings: () => void;
}) {
  const [refreshing, setRefreshing] = React.useState(false);
  const asset = m.account?.asset;
  const unit = (symbol: string) => m.contracts.find(c => c.symbol === symbol)?.priceUnit;
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.pageContent, { gap: 10, opacity: m.offline ? 0.45 : 1 }]}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.secondary}
        onRefresh={() => { setRefreshing(true); void m.refresh().finally(() => setRefreshing(false)); }} />}>
      {!m.account && (
        <View style={[styles.card, { backgroundColor: p.surface, gap: 10 }]}>
          <Text style={{ color: p.text, fontSize: 15 }}>{m.offline ? "还没有连上 MEXC 网关" : "正在读取账户…"}</Text>
          {m.offline && <>
            <Text style={{ color: p.secondary, fontSize: 13, lineHeight: 19 }}>请先保存服务器地址和设备访问密钥。</Text>
            <Button label="连接设置" palette={p} variant="tinted" onPress={onSettings} />
          </>}
        </View>
      )}
      {asset && (
        <View style={[styles.card, { backgroundColor: p.surface, gap: 12 }]}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Meta label={`权益 ${asset.currency}`} value={money(asset.equity)} palette={p} />
            <Meta label="可用" value={money(asset.availableBalance)} palette={p} />
          </View>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Meta label="持仓保证金" value={money(asset.positionMargin)} palette={p} />
            <Meta label="未实现盈亏" value={signed(asset.unrealized)} palette={p} />
          </View>
        </View>
      )}
      {m.account && m.account.positions.length === 0 && (
        <Notice palette={p} tone="info" text="当前没有持仓。" />
      )}
      {m.account?.positions.map(position => {
        const long = position.direction === "LONG";
        const color = long ? p.up : p.down;
        const pnl = position.unrealized;
        return (
          <Pressable key={position.id} accessibilityRole="button"
            accessibilityLabel={`${position.symbol} ${long ? "多" : "空"} 平仓`} onPress={() => onClose(position)}
            style={[styles.card, { backgroundColor: p.surface, gap: 10, marginBottom: 0 }]}>
            <View style={styles.spread}>
              <View style={[styles.row, { flexShrink: 1 }]}>
                <Text numberOfLines={1} style={{ color: p.text, fontSize: 16, fontWeight: "700", flexShrink: 1 }}>{position.symbol}</Text>
                <Text style={{ color, fontSize: 12, fontWeight: "700" }}>{long ? "多" : "空"}</Text>
                <Text style={{ color: p.secondary, fontSize: 12 }}>{openTypeLabel(position.openType)} {position.leverage}x</Text>
              </View>
              <Text style={[styles.number, { color: (pnl ?? 0) > 0 ? p.up : (pnl ?? 0) < 0 ? p.down : p.text, fontSize: 16 }]}>
                {signed(pnl)}
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Meta label="张数" value={String(position.holdVol)} palette={p} />
              <Meta label="均价" value={priceText(position.averagePrice, unit(position.symbol))} palette={p} />
              <Meta label="强平价" value={priceText(position.liquidatePrice, unit(position.symbol))} palette={p} />
            </View>
            <Text style={{ color: p.secondary, fontSize: 12 }}>
              可平 {closableOf(position)} 张 · 点一下去平仓
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
