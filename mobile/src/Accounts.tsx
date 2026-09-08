import React, { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { Palette } from "./types.ts";
import type { TradingState } from "./useTrading.ts";
import { Button, Icon, money, signed, styles } from "./ui.tsx";
import { DemoNotice } from "./DemoNotice.tsx";

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
        style={[styles.spread, { minHeight: 44 }]}
      >
        <Text style={{ color: p.text, fontSize: 16 }}>账户</Text>
        <View style={styles.row}>
          <Text style={{ color: p.secondary, fontSize: 16 }}>
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
              borderRadius: 26,
              padding: 20,
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
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 110 }}
    >
      {s.isDemo && <DemoNotice palette={p} card />}
      <View
        style={{
          backgroundColor: p.surface,
          borderRadius: 26,
          paddingHorizontal: 16,
          paddingBottom: 20,
          marginTop: 35,
        }}
      >
        <AccountSelector state={s} palette={p} />
        <View
          style={{ height: 1, backgroundColor: p.separator, marginBottom: 24 }}
        />
        <View style={styles.spread}>
          <Text style={{ color: p.secondary, fontSize: 14 }}>账户净值</Text>
          <Text style={{ color: p.secondary, fontSize: 12, fontWeight: "600" }}>
            USD
          </Text>
        </View>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          style={[
            styles.number,
            {
              color: p.text,
              fontSize: 35,
              fontWeight: "600",
              marginTop: 20,
              marginBottom: 20,
            },
          ]}
        >
          ${money(account?.liquidationValue)}
        </Text>
        <View style={styles.row}>
          {[
            ["现金余额", account?.cashBalance],
            ["购买力", account?.buyingPower],
          ].map(([label, value]) => (
            <View key={String(label)} style={{ flex: 1, gap: 5 }}>
              <Text style={{ color: p.secondary, fontSize: 12 }}>{label}</Text>
              <Text style={[styles.number, { color: p.text, fontSize: 17 }]}>
                ${money(value as number | undefined)}
              </Text>
            </View>
          ))}
        </View>
        <View style={[styles.spread, { marginTop: 18 }]}>
          <View style={[styles.row, { gap: 15 }]}>
            <Icon name="bank" size={18} color={p.secondary} />
            <Text style={{ color: p.secondary, fontSize: 12 }}>
              {s.isDemo
                ? "演示账户"
                : account?.accountType === "CASH"
                  ? "现金账户"
                  : "保证金账户"}
            </Text>
          </View>
          <Text style={{ color: p.secondary, fontSize: 12 }}>
            {account?.positions.length ?? 0} 项持仓
          </Text>
        </View>
      </View>
      <View
        style={[
          styles.spread,
          { paddingHorizontal: 16, marginTop: 38, marginBottom: 10 },
        ]}
      >
        <Text style={{ color: p.secondary, fontSize: 16, fontWeight: "600" }}>
          持仓
        </Text>
        <Text style={{ color: p.secondary, fontSize: 16, fontWeight: "600" }}>
          市值 / 当日盈亏
        </Text>
      </View>
      <View
        style={{
          backgroundColor: p.surface,
          borderRadius: 26,
          paddingHorizontal: 16,
        }}
      >
        {account?.positions.map((position, i) => (
          <Pressable
            key={`${position.symbol}-${i}`}
            accessibilityRole="button"
            accessibilityLabel={`持仓 ${position.symbol}`}
            disabled={s.busy}
            onPress={() => onStock(position.symbol)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 22,
              gap: 10,
              borderBottomWidth: i === account.positions.length - 1 ? 0 : 1,
              borderColor: p.separator,
            }}
          >
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ color: p.text, fontSize: 17, fontWeight: "600" }}>
                {position.symbol}
              </Text>
              <Text style={{ color: p.secondary, fontSize: 12 }}>
                {money(position.quantity, 0)} 股 · 成本 $
                {money(position.averagePrice)}
              </Text>
              <Text
                numberOfLines={1}
                style={{ color: p.secondary, fontSize: 12 }}
              >
                {position.description}
              </Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 6 }}>
              <Text style={[styles.number, { color: p.text, fontSize: 16 }]}>
                ${money(position.marketValue)}
              </Text>
              <Text
                style={{
                  color: (position.dayProfitLoss ?? 0) >= 0 ? p.up : p.down,
                  fontSize: 15,
                }}
              >
                {position.dayProfitLoss === undefined
                  ? "—"
                  : `${position.dayProfitLoss > 0 ? "+" : ""}$${money(position.dayProfitLoss)}`}
              </Text>
              <Text
                style={{
                  color:
                    (s.quotes[position.symbol]?.netPercentChange ?? 0) >= 0
                      ? p.up
                      : p.down,
                  fontSize: 12,
                }}
              >
                {signed(s.quotes[position.symbol]?.netPercentChange, "%")}
              </Text>
            </View>
            <Icon name="chevron" size={16} color={p.separator} />
          </Pressable>
        ))}
        {!account?.positions.length && (
          <Text
            style={{
              color: p.secondary,
              paddingVertical: 28,
              textAlign: "center",
            }}
          >
            暂无持仓
          </Text>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="股票 / ETF 交易"
        onPress={onTrade}
        style={{
          backgroundColor: p.surface,
          borderRadius: 24,
          padding: 18,
          marginTop: 30,
          flexDirection: "row",
          gap: 16,
        }}
      >
        <Icon name="trade" color={p.accent} />
        <Text style={{ color: p.accent, fontSize: 16 }}>股票 / ETF 交易</Text>
      </Pressable>
    </ScrollView>
  );
}
