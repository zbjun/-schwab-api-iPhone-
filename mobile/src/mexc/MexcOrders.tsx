import React, { useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import { isBuying, mexcActionLabels } from "../mexcRules.ts";
import type { MexcOrder } from "../mexcRules.ts";
import { DemoNotice } from "../DemoNotice.tsx";
import { Button, Chip, money, radius, signed, styles } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { closedOrderWindow, openTypeLabel, orderStateLabel, priceText, sortContracts } from "./mexcView.ts";
import { EmptyState, Notice } from "./parts.tsx";

const stamp = (value?: number) => (value ? new Date(value).toLocaleString() : "—");

function OrderRow({ order, palette: p, unit, action, first }: { order: MexcOrder; palette: Palette; unit?: number; action?: React.ReactNode; first?: boolean }) {
  const color = isBuying(order.action) ? p.up : p.down;
  const label = orderStateLabel(order);
  const statusColor = order.state === 3 ? p.accent : order.state === 4 || order.state === 5 ? p.secondary : "#ff8a19";
  return (
    <View style={{ paddingVertical: 10, gap: 6, borderTopWidth: first ? 0 : 1, borderTopColor: p.separator }}>
      <View style={styles.spread}>
        <View style={[styles.row, { flexShrink: 1, gap: 6 }]}>
          <Text style={{ color, backgroundColor: color + "1F", fontSize: 11, fontWeight: "700", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: "hidden" }}>
            {mexcActionLabels[order.action]}
          </Text>
          <Text numberOfLines={1} style={{ color: p.text, fontSize: 15, fontWeight: "700", flexShrink: 1 }}>{order.symbol}</Text>
          <Text style={{ color: p.secondary, fontSize: 12 }}>{order.orderType === 5 ? "市价" : "限价"}</Text>
        </View>
        <Text style={{ color: p.secondary, fontSize: 11 }}>{stamp(order.updatedAt ?? order.createdAt)}</Text>
      </View>
      <View style={styles.spread}>
        <Text style={[styles.number, { color: p.text, fontSize: 13 }]}>
          {order.orderType === 5 ? "市价" : priceText(order.price, unit)} × {order.vol}
          <Text style={{ color: p.secondary }}>{`  已成 ${order.dealVol}`}</Text>
        </Text>
        <Text style={{ color: statusColor, fontSize: 12, fontWeight: "600" }}>{label}</Text>
      </View>
      <Text style={{ color: p.secondary, fontSize: 11 }}>
        {`${openTypeLabel(order.openType)}${order.leverage ? " " + order.leverage + "x" : ""}`}
        {order.dealAvgPrice !== undefined && order.dealVol > 0
          ? ` · 成交均价 ${priceText(order.dealAvgPrice, unit)}${order.profit !== undefined ? ` · 盈亏 ${signed(order.profit)}` : ""}${order.fee ? ` · 手续费 ${money(order.fee, 4)}` : ""}`
          : ""}
      </Text>
      {action}
    </View>
  );
}

export default function MexcOrders({ m, palette: p, active }: { m: MexcState; palette: Palette; active: boolean }) {
  const [refreshing, setRefreshing] = useState(false);
  const [armed, setArmed] = useState<string>();
  const gate = useRef(false);
  const [symbol, setSymbol] = useState("");
  const [closed, setClosed] = useState<MexcOrder[]>();
  const [searching, setSearching] = useState(false);
  const sorted = useMemo(() => sortContracts(m.contracts), [m.contracts]);
  useEffect(() => { if (!symbol && sorted.length) setSymbol(sorted[0].symbol); }, [symbol, sorted]);
  useEffect(() => { if (active) void m.refresh(); }, [active]);
  useEffect(() => { setClosed(undefined); }, [symbol]);
  const unit = (s: string) => m.contracts.find(c => c.symbol === s)?.priceUnit;

  // A second tap must come within 5 seconds, and only while that order is still open.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(undefined), 5_000);
    return () => clearTimeout(timer);
  }, [armed]);
  useEffect(() => {
    if (armed && !m.openOrders.some(o => o.id === armed)) setArmed(undefined);
  }, [armed, m.openOrders]);

  // One press arms, the second sends. A failed cancel is shown, never retried.
  const cancel = async (order: MexcOrder) => {
    if (gate.current || m.sending || m.locked) return; // The ref stops a double tap within one frame.
    if (armed !== order.id) { setArmed(order.id); return; }
    gate.current = true;
    setArmed(undefined);
    try {
      await m.cancel(order.id);
    } finally {
      gate.current = false;
    }
  };
  const search = async () => {
    if (!symbol || searching) return;
    setSearching(true);
    try {
      const { from, to } = closedOrderWindow(Date.now());
      const rows = await m.run(() => m.api.closedOrders(symbol, from, to));
      if (rows) setClosed([...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
    } finally {
      setSearching(false);
    }
  };
  const card = { backgroundColor: p.surface, borderRadius: radius.card, paddingHorizontal: 12 } as const;
  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.pageContent, { gap: 10, opacity: m.offline ? 0.45 : 1 }]}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.secondary}
        onRefresh={() => { setRefreshing(true); void m.refresh().finally(() => setRefreshing(false)); }} />}>
      {m.isDemo && <DemoNotice palette={p} card />}
      <View style={styles.spread}>
        <Text style={{ color: p.secondary, fontSize: 12, fontWeight: "600" }}>当前委托</Text>
        <Text style={{ color: p.secondary, fontSize: 12 }}>{m.openOrders.length}</Text>
      </View>
      {m.locked && <Notice palette={p} text="交易已锁定，暂不能撤单。" />}
      {!m.openOrders.length
        ? <EmptyState palette={p} text={m.offline ? "还没有连上 MEXC 网关。" : "当前没有挂单。"} />
        : <View style={card}>
          {m.openOrders.map((order, index) => (
            <OrderRow key={order.id} order={order} palette={p} unit={unit(order.symbol)} first={index === 0}
              action={order.cancelable ? (
                <Button label={armed === order.id ? "再点一次确认撤单" : "撤单"} palette={p} variant="tinted" color={p.up}
                  disabled={m.locked || m.sending} onPress={() => void cancel(order)} />
              ) : undefined} />
          ))}
        </View>}
      <View style={[styles.spread, { marginTop: 8 }]}>
        <Text style={{ color: p.secondary, fontSize: 12, fontWeight: "600" }}>已结束委托 · 最近 7 天</Text>
        {closed && <Text style={{ color: p.secondary, fontSize: 12 }}>{closed.length}</Text>}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {sorted.slice(0, 8).map(c => (
          <Chip key={c.symbol} label={c.symbol.replace("_USDT", "")} palette={p} active={c.symbol === symbol}
            accessibilityLabel={`查询合约 ${c.symbol}`} onPress={() => setSymbol(c.symbol)} />
        ))}
      </View>
      <Button label={searching ? "查询中…" : `查询 ${symbol || "合约"}`} palette={p} variant="tinted" disabled={!symbol || searching} onPress={() => void search()} />
      {closed && !closed.length && <EmptyState palette={p} text="最近 7 天没有已结束的委托。" />}
      {!!closed?.length && (
        <View style={card}>
          {closed.map((order, index) => <OrderRow key={order.id} order={order} palette={p} unit={unit(order.symbol)} first={index === 0} />)}
        </View>
      )}
      <Text style={{ color: p.secondary, fontSize: 11, lineHeight: 16 }}>撤单需连点两次确认；已结束委托只显示所选合约。</Text>
    </ScrollView>
  );
}
