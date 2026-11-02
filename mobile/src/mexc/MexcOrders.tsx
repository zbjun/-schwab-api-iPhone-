import React, { useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import { mexcActionLabels } from "../mexcRules.ts";
import type { MexcOrder } from "../mexcRules.ts";
import { Button, Chip, Meta, money, signed, styles } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { closedOrderWindow, openTypeLabel, orderStateLabel, priceText, sortContracts } from "./mexcView.ts";
import { Notice } from "./parts.tsx";

const stamp = (value?: number) => (value ? new Date(value).toLocaleString() : "—");

function OrderRow({ order, palette: p, unit, action }: { order: MexcOrder; palette: Palette; unit?: number; action?: React.ReactNode }) {
  const long = order.action === "OPEN_LONG" || order.action === "CLOSE_LONG";
  return (
    <View style={[styles.card, { backgroundColor: p.surface, gap: 8, marginBottom: 0 }]}>
      <View style={styles.spread}>
        <View style={[styles.row, { flexShrink: 1 }]}>
          <Text numberOfLines={1} style={{ color: p.text, fontSize: 15, fontWeight: "700", flexShrink: 1 }}>{order.symbol}</Text>
          <Text style={{ color: long ? p.up : p.down, fontSize: 12, fontWeight: "700" }}>{mexcActionLabels[order.action]}</Text>
        </View>
        <Text style={{ color: p.secondary, fontSize: 12 }}>{orderStateLabel(order)}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Meta label="价格" value={order.orderType === 5 ? "市价" : priceText(order.price, unit)} palette={p} />
        <Meta label="成交 / 委托" value={`${order.dealVol} / ${order.vol}`} palette={p} />
        <Meta label="模式" value={`${openTypeLabel(order.openType)}${order.leverage ? " " + order.leverage + "x" : ""}`} palette={p} />
      </View>
      {order.dealAvgPrice !== undefined && order.dealVol > 0 && (
        <Text style={{ color: p.secondary, fontSize: 12 }}>
          成交均价 {priceText(order.dealAvgPrice, unit)}{order.profit !== undefined ? ` · 盈亏 ${signed(order.profit)}` : ""}{order.fee ? ` · 手续费 ${money(order.fee, 4)}` : ""}
        </Text>
      )}
      <Text style={{ color: p.secondary, fontSize: 11 }}>{stamp(order.updatedAt ?? order.createdAt)}</Text>
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
  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.pageContent, { gap: 10, opacity: m.offline ? 0.45 : 1 }]}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.secondary}
        onRefresh={() => { setRefreshing(true); void m.refresh().finally(() => setRefreshing(false)); }} />}>
      <Text style={{ color: p.secondary, fontSize: 13, fontWeight: "600" }}>当前委托</Text>
      {m.locked && <Notice palette={p} text="交易已锁定，暂不能撤单。" />}
      {!m.openOrders.length && <Notice palette={p} tone="info" text={m.offline ? "还没有连上 MEXC 网关。" : "当前没有挂单。"} />}
      {m.openOrders.map(order => (
        <OrderRow key={order.id} order={order} palette={p} unit={unit(order.symbol)}
          action={order.cancelable ? (
            <Button label={armed === order.id ? "再点一次确认撤单" : "撤单"} palette={p} variant="tinted" color={p.up}
              disabled={m.locked || m.sending} onPress={() => void cancel(order)} />
          ) : undefined} />
      ))}
      <Text style={{ color: p.secondary, fontSize: 13, fontWeight: "600", marginTop: 8 }}>已结束委托 · 最近 7 天</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {sorted.slice(0, 8).map(c => (
          <Chip key={c.symbol} label={c.symbol.replace("_USDT", "")} palette={p} active={c.symbol === symbol}
            accessibilityLabel={`查询合约 ${c.symbol}`} onPress={() => setSymbol(c.symbol)} />
        ))}
      </View>
      <Button label={searching ? "查询中…" : `查询 ${symbol || "合约"}`} palette={p} variant="tinted" disabled={!symbol || searching} onPress={() => void search()} />
      {closed && !closed.length && <Notice palette={p} tone="info" text="最近 7 天没有已结束的委托。" />}
      {closed?.map(order => <OrderRow key={order.id} order={order} palette={p} unit={unit(order.symbol)} />)}
    </ScrollView>
  );
}
