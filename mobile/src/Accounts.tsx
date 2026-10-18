import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Palette } from "./types.ts";
import type { TradingState } from "./useTrading.ts";
import { Button, Icon, money, radius, signed, styles } from "./ui.tsx";
import { DemoNotice } from "./DemoNotice.tsx";
import { PageRefreshControl } from "./PageRefreshControl.tsx";

export function AccountSelector({
  state: s,
  palette: p,
}: {
  state: TradingState;
  palette: Palette;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="选择账户"
        disabled={s.busy || s.accounts.length < 2}
        onPress={() => setOpen(true)}
        style={[styles.spread, { minHeight: 42 }]}
      >
        <Text style={{ color: p.text, fontSize: 14, fontWeight: "600" }}>账户</Text>
        <View style={styles.row}>
          <Text style={{ color: p.secondary, fontSize: 14 }}>
            {s.account?.displayNumber ?? "尚未连接"}
          </Text>
          {s.accounts.length > 1 && (
            <Icon name="select" size={16} color={p.secondary} />
          )}
        </View>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "#0006",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <View
            style={{
              backgroundColor: p.surface,
              borderRadius: radius.card,
              padding: 16,
              gap: 12,
            }}
          >
            <Text style={{ color: p.text, fontSize: 20, fontWeight: "600" }}>
              选择账户
            </Text>
            {s.accounts.map((a) => (
              <Button
                key={a.id}
                label={a.displayNumber}
                palette={p}
                active={a.id === s.accountID}
                onPress={() => {
                  s.selectAccount(a.id);
                  setOpen(false);
                }}
              />
            ))}
            <Button label="取消" palette={p} onPress={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </>
  );
}
export default function Accounts({
  state: s,
  palette: p,
  onStock,
  onTrade,
}: {
  state: TradingState;
  palette: Palette;
  onStock: (symbol: string) => void;
  onTrade: () => void;
}) {
  const account = s.account;
  const dayValues = account?.positions
    .map((position) => position.dayProfitLoss)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const dayTotal = dayValues?.length ? dayValues.reduce((a, b) => a + b, 0) : undefined;
  const tint = (value?: number) =>
    value === undefined || value === 0 ? p.text : value > 0 ? p.up : p.down;
  const caption = { color: p.secondary, fontSize: 11 } as const;
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      refreshControl={<PageRefreshControl state={s} palette={p} />}
      contentContainerStyle={[styles.pageContent, { gap: 10 }]}
    >
      {s.isDemo && <DemoNotice palette={p} card />}
      <View style={{ backgroundColor: p.surface, borderRadius: radius.card, paddingHorizontal: 12, paddingBottom: 12 }}>
        <AccountSelector state={s} palette={p} />
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.separator, marginBottom: 12 }} />
        <View style={styles.spread}>
          <Text style={caption}>
            账户净值 · USD ·{" "}
            {s.isDemo ? "演示账户" : account?.accountType === "CASH" ? "现金账户" : "保证金账户"}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="股票 / ETF 交易" onPress={onTrade}
            style={[styles.row, { gap: 4, minHeight: 28 }]}>
            <Icon name="trade" size={15} color={p.accent} />
            <Text style={{ color: p.accent, fontSize: 13, fontWeight: "600" }}>交易</Text>
          </Pressable>
        </View>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          style={[styles.number, { color: p.text, fontSize: 30, fontWeight: "700", marginTop: 2, marginBottom: 12 }]}
        >
          ${money(account?.liquidationValue)}
        </Text>
        <View style={styles.row}>
          {([
            ["现金余额", account?.cashBalance, p.text],
            ["购买力", account?.buyingPower, p.text],
            ["当日盈亏", dayTotal, tint(dayTotal)],
          ] as const).map(([label, value, color], i) => (
            <View key={label} style={{ flex: 1, gap: 3, alignItems: i === 2 ? "flex-end" : "flex-start" }}>
              <Text style={caption}>{label}</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.number, { color, fontSize: 15 }]}>
                {i === 2 ? signed(value) : `$${money(value)}`}
              </Text>
            </View>
          ))}
        </View>
        <Text style={[caption, { marginTop: 10 }]}>
          {s.accountRefreshError
            ? `${s.accountRefreshError} 正在自动重试，显示上次数据。`
            : s.accountsUpdatedAt
              ? `自动刷新 · ${new Date(s.accountsUpdatedAt).toLocaleTimeString()} 更新 · 下拉刷新`
              : "下拉刷新账户"}
        </Text>
      </View>
      <View style={{ backgroundColor: p.surface, borderRadius: radius.card, paddingHorizontal: 12 }}>
        <View style={[styles.row, { minHeight: 34, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.separator }]}>
          <Text style={[caption, { flex: 1.25 }]}>持仓 {account?.positions.length ?? 0}</Text>
          <Text style={[caption, { flex: 1, textAlign: "right" }]}>数量 / 成本</Text>
          <Text style={[caption, { flex: 1.2, textAlign: "right" }]}>市值 / 当日盈亏</Text>
        </View>
        {account?.positions.map((position, i) => {
          const change = s.quotes[position.symbol]?.netPercentChange;
          return (
            <Pressable
              key={`${position.symbol}-${i}`}
              accessibilityRole="button"
              accessibilityLabel={`持仓 ${position.symbol}`}
              disabled={s.busy}
              onPress={() => onStock(position.symbol)}
              style={({ pressed }) => [styles.row, {
                paddingVertical: 10,
                borderTopWidth: i ? StyleSheet.hairlineWidth : 0,
                borderColor: p.separator,
                opacity: pressed ? 0.6 : 1,
              }]}
            >
              <View style={{ flex: 1.25, gap: 2, minWidth: 0 }}>
                <Text style={{ color: p.text, fontSize: 15, fontWeight: "700" }}>{position.symbol}</Text>
                <Text numberOfLines={1} style={caption}>{position.description}</Text>
              </View>
              <View style={{ flex: 1, gap: 2, alignItems: "flex-end" }}>
                <Text style={[styles.number, { color: p.text, fontSize: 14, fontWeight: "500" }]}>
                  {money(position.quantity, 0)}
                </Text>
                <Text style={[caption, { fontVariant: ["tabular-nums"] }]}>{money(position.averagePrice)}</Text>
              </View>
              <View style={{ flex: 1.2, gap: 2, alignItems: "flex-end" }}>
                <Text style={[styles.number, { color: p.text, fontSize: 14 }]}>
                  ${money(position.marketValue)}
                </Text>
                <Text numberOfLines={1} style={{ color: tint(position.dayProfitLoss), fontSize: 12, fontVariant: ["tabular-nums"] }}>
                  {signed(position.dayProfitLoss)}
                  <Text style={{ color: tint(change) }}>  {signed(change, "%")}</Text>
                </Text>
              </View>
            </Pressable>
          );
        })}
        {!account?.positions.length && (
          <Text style={{ color: p.secondary, paddingVertical: 24, textAlign: "center" }}>
            暂无持仓
          </Text>
        )}
      </View>
    </ScrollView>
  );
}
