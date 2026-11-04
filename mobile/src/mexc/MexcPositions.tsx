import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import type { MexcStopOrder } from "../mexcRules.ts";
import { Button, Icon, money, radius, signed, styles } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { closableOf, contractShort, openTypeLabel, priceText, stopEstimate } from "./mexcView.ts";

/** MEXC account card and position list, laid out like the Schwab section. No ScrollView. */
export function MexcAccountSection({ m, palette: p, onContract, onSettings, onTrade }: {
  m: MexcState; palette: Palette; onContract: (symbol: string) => void; onSettings: () => void; onTrade: () => void;
}) {
  const asset = m.account?.asset;
  const unit = (symbol: string) => m.contracts.find(c => c.symbol === symbol)?.priceUnit;
  const pnlColor = (value?: number) => (value ?? 0) > 0 ? p.up : (value ?? 0) < 0 ? p.down : p.secondary;
  const positions = m.account?.positions ?? [];
  const caption = { color: p.secondary, fontSize: 11 } as const;
  const [stops, setStops] = React.useState<MexcStopOrder[]>([]);
  const [stopsFailed, setStopsFailed] = React.useState(false);
  React.useEffect(() => {
    if (!positions.length) { setStops([]); setStopsFailed(false); return; }
    let active = true;
    m.api.stopOrders()
      .then(rows => { if (active) { setStops(rows); setStopsFailed(false); } })
      // A failed read must not look like nothing set. Only a gateway without this feature stays quiet.
      .catch(error => { if (active) setStopsFailed((error as { code?: string })?.code !== "methodNotAllowed"); });
    return () => { active = false; };
  }, [m.api, m.account, positions.length]);
  const notice = (title: string, text: string | undefined, button: boolean) => (
    <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: 12, gap: 10 }}>
      <Text style={{ color: p.text, fontSize: 15 }}>{title}</Text>
      {!!text && <Text style={{ color: p.secondary, fontSize: 13, lineHeight: 19 }}>{text}</Text>}
      {button && <Button label="连接设置" palette={p} variant="tinted" onPress={onSettings} />}
    </View>
  );
  if (m.configured === false) return notice("MEXC 未连接", "请先保存服务器地址和设备访问密钥。", true);
  if (!m.account && m.offline) return notice("还没有连上 MEXC 网关", "请先保存服务器地址和设备访问密钥。", true);
  if (!m.account) return notice("正在读取账户…", undefined, false);
  return (
    <View style={{ gap: 10, opacity: m.offline ? 0.45 : 1 }}>
      {asset && (
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, paddingHorizontal: 12, paddingBottom: 12 }}>
          <View style={[styles.spread, { minHeight: 42 }]}>
            <Text style={{ color: p.text, fontSize: 14, fontWeight: "600" }}>账户</Text>
            <Text style={{ color: p.secondary, fontSize: 14 }}>MEXC 合约账户</Text>
          </View>
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.separator, marginBottom: 12 }} />
          <View style={styles.spread}>
            <Text style={caption}>账户净值 · {asset.currency}{m.isDemo ? " · 演示账户" : ""}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="去交易" disabled={m.sending} onPress={onTrade}
              style={[styles.row, { gap: 4, minHeight: 28, opacity: m.sending ? 0.4 : 1 }]}>
              <Icon name="trade" color={p.accent} size={15} />
              <Text style={{ color: p.accent, fontSize: 13, fontWeight: "600" }}>交易</Text>
            </Pressable>
          </View>
          <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.number, { color: p.text, fontSize: 30, fontWeight: "700", marginTop: 2, marginBottom: 12 }]}>
            {money(asset.equity)}
          </Text>
          <View style={styles.row}>
            {([
              ["可用", money(asset.availableBalance), p.text],
              ["持仓保证金", money(asset.positionMargin), p.text],
              ["未实现盈亏", signed(asset.unrealized), pnlColor(asset.unrealized)],
            ] as const).map(([label, value, color], i) => (
              <View key={label} style={{ flex: 1, gap: 3, minWidth: 0, alignItems: i === 2 ? "flex-end" : "flex-start" }}>
                <Text style={caption}>{label}</Text>
                <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.number, { color, fontSize: 15 }]}>{value}</Text>
              </View>
            ))}
          </View>
          <Text style={[caption, { marginTop: 10 }]}>
            {m.offline
              ? "连接中断，正在自动重试，显示上次数据。"
              : m.updatedAt
                ? `自动刷新 · ${new Date(m.updatedAt).toLocaleTimeString()} 更新 · 下拉刷新`
                : "下拉刷新账户"}
          </Text>
        </View>
      )}
      <View style={{ backgroundColor: p.surface, borderRadius: radius.card, paddingHorizontal: 12 }}>
        <View style={[styles.row, { minHeight: 34, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.separator }]}>
          <Text style={[caption, { flex: 1.25 }]}>持仓 {positions.length}</Text>
          <Text style={[caption, { flex: 1, textAlign: "right" }]}>张数 / 均价</Text>
          <Text style={[caption, { flex: 1.2, textAlign: "right" }]}>盈亏 / 强平价</Text>
        </View>
        {positions.map((position, i) => {
          const long = position.direction === "LONG";
          const u = unit(position.symbol);
          const stop = stops.find(row => row.positionId === position.id);
          const contractSize = m.contracts.find(c => c.symbol === position.symbol)?.contractSize;
          const level = (label: string, price: number | undefined) => {
            if (!stop || price === undefined) return null;
            const profit = contractSize === undefined ? undefined : stopEstimate({ ...position, holdVol: stop.vol }, contractSize, String(price));
            return (
              <Text numberOfLines={1} style={[styles.number, { color: p.secondary, fontSize: 11 }]}>
                {label} {priceText(price, u)}
                {profit !== undefined && <Text style={{ color: pnlColor(profit) }}> {signed(profit)}</Text>}
              </Text>
            );
          };
          return (
            <Pressable key={position.id} accessibilityRole="button" accessibilityLabel={`持仓 ${position.symbol}`}
              disabled={m.sending} onPress={() => onContract(position.symbol)}
              style={({ pressed }) => [styles.row, {
                paddingVertical: 10,
                borderTopWidth: i ? StyleSheet.hairlineWidth : 0,
                borderColor: p.separator,
                opacity: pressed ? 0.6 : 1,
              }]}>
              <View style={{ flex: 1.25, gap: 2, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ color: p.text, fontSize: 15, fontWeight: "700" }}>{contractShort(position.symbol)}</Text>
                <Text numberOfLines={1} style={caption}>
                  <Text style={{ color: long ? p.up : p.down, fontWeight: "700" }}>{long ? "多" : "空"}</Text>
                  {` ${openTypeLabel(position.openType)} ${position.leverage}x · 可平 ${closableOf(position)}`}
                </Text>
                {level("止盈", stop?.takeProfitPrice)}
                {level("止损", stop?.stopLossPrice)}
              </View>
              <View style={{ flex: 1, gap: 2, alignItems: "flex-end" }}>
                <Text style={[styles.number, { color: p.text, fontSize: 14, fontWeight: "500" }]}>{String(position.holdVol)}</Text>
                <Text style={[caption, { fontVariant: ["tabular-nums"] }]}>{priceText(position.averagePrice, u)}</Text>
              </View>
              <View style={{ flex: 1.2, gap: 2, alignItems: "flex-end" }}>
                <Text style={[styles.number, { color: pnlColor(position.unrealized), fontSize: 14 }]}>{signed(position.unrealized)}</Text>
                <Text style={[caption, { fontVariant: ["tabular-nums"] }]}>{priceText(position.liquidatePrice, u)}</Text>
              </View>
            </Pressable>
          );
        })}
        {!positions.length && (
          <Text style={{ color: p.secondary, paddingVertical: 24, textAlign: "center" }}>暂无持仓</Text>
        )}
      </View>
      {positions.length > 0 && (
        <Text style={{ color: p.secondary, fontSize: 11, lineHeight: 16 }}>止盈止损在合约详情页设置。{stopsFailed ? " 止盈止损读取失败，这里显示的可能不是最新的。" : ""}</Text>
      )}
    </View>
  );
}
