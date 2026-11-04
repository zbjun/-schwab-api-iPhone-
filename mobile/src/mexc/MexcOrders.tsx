import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import { isBuying, mexcActionLabels } from "../mexcRules.ts";
import type { MexcContract, MexcOrder } from "../mexcRules.ts";
import type { OrderListExtra } from "../TradePanel.tsx";
import { Button, Chip, elevated, money, orderStamp, radius, signed, styles } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { useClosedOrders } from "./useClosedOrders.ts";
import { CLOSED_ORDER_DAYS, contractShort, contractTitle, openTypeLabel, orderGroup, orderStateLabel, priceText } from "./mexcView.ts";

/** Laid out like a row of the Schwab order list: tap for the chart, "详情" for the rest and for cancelling. */
function OrderRow({ order, contract, palette: p, first, disabled, open, onOpen, onContract, children }: {
  order: MexcOrder; contract?: MexcContract; palette: Palette; first: boolean; disabled: boolean; open: boolean;
  onOpen: () => void; onContract: (symbol: string) => void; children?: React.ReactNode;
}) {
  const color = isBuying(order.action) ? p.up : p.down;
  const group = orderGroup(order);
  const statusColor = group === "已成交" ? p.accent : group === "已结束" ? p.secondary : "#ff8a19";
  const unit = contract?.priceUnit;
  const name = contract ? contractTitle(contract) : `${contractShort(order.symbol)} 永续`;
  return (
    <View style={{ paddingVertical: 10, gap: 6, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, borderColor: p.separator }}>
      <View style={[styles.row, { alignItems: "center", gap: 10 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`委托 ${order.id}，查看 ${order.symbol} 行情`} disabled={disabled}
          onPress={() => onContract(order.symbol)} style={{ flex: 1, gap: 4, minWidth: 0 }}>
          <View style={[styles.row, { gap: 6 }]}>
            <Text style={{ color, backgroundColor: color + "1F", fontSize: 11, fontWeight: "700", borderRadius: 3, overflow: "hidden", paddingHorizontal: 4, paddingVertical: 1 }}>
              {mexcActionLabels[order.action]}
            </Text>
            <Text numberOfLines={1} style={{ color: p.text, fontSize: 15, fontWeight: "700", flexShrink: 1 }}>{name}</Text>
            <Text style={{ color: p.secondary, fontSize: 12 }}>{order.orderType === 5 ? "市价" : "限价"}</Text>
            <Text style={{ color: p.secondary, fontSize: 11, fontVariant: ["tabular-nums"] }}>{orderStamp(order.createdAt ?? order.updatedAt)}</Text>
          </View>
          <Text numberOfLines={1} style={{ color: p.text, fontSize: 13, fontVariant: ["tabular-nums"] }}>
            {order.orderType === 5 ? "市价" : priceText(order.price, unit)} × {order.vol}
            <Text style={{ color: p.secondary }}>{"  "}已成 {order.dealVol}</Text>
          </Text>
        </Pressable>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <Text style={{ color: statusColor, fontSize: 12, fontWeight: "600" }}>{orderStateLabel(order)}</Text>
          <Chip label="详情" accessibilityLabel={`委托 ${order.id} 详情`} palette={p} disabled={disabled} onPress={onOpen} />
        </View>
      </View>
      {open && (
        <View style={{ backgroundColor: elevated(p), borderRadius: radius.control, padding: 10, gap: 8 }}>
          <View style={styles.spread}>
            <Text style={{ color: p.text, fontWeight: "600", fontSize: 13, flexShrink: 1 }}>#{order.id} · {orderStateLabel(order)}</Text>
            <Button label="收起" palette={p} disabled={disabled} onPress={onOpen} />
          </View>
          <Text style={{ color: p.secondary, fontSize: 12, lineHeight: 18 }}>
            {order.symbol} · {`${openTypeLabel(order.openType)}${order.leverage ? " " + order.leverage + "x" : ""}`} · 更新 {orderStamp(order.updatedAt ?? order.createdAt)}
            {order.takeProfitPrice !== undefined ? ` · 止盈 ${priceText(order.takeProfitPrice, unit)}` : ""}
            {order.stopLossPrice !== undefined ? ` · 止损 ${priceText(order.stopLossPrice, unit)}` : ""}
            {order.dealAvgPrice !== undefined && order.dealVol > 0
              ? ` · 成交均价 ${priceText(order.dealAvgPrice, unit)}${order.profit !== undefined ? ` · 盈亏 ${signed(order.profit)}` : ""}${order.fee ? ` · 手续费 ${money(order.fee, 4)}` : ""}`
              : ""}
          </Text>
          {children}
        </View>
      )}
    </View>
  );
}

/**
 * MEXC orders as rows for the shared order list, with their cancel. A cancel takes a press and then a second one
 * within 5 seconds, while that order is still open, or one press in quick mode. A failed one is shown and never retried.
 */
export function useMexcOrderRows({ m, palette: p, favorites, active, onContract }: {
  m: MexcState; palette: Palette; favorites: readonly string[]; active: boolean; onContract: (symbol: string) => void;
}) {
  const closed = useClosedOrders(m, favorites, active);
  const [armed, setArmed] = useState<string>();
  const [opened, setOpened] = useState<string>();
  const gate = useRef(false);
  useEffect(() => { if (active) void m.refresh(); }, [active]);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(undefined), 5_000);
    return () => clearTimeout(timer);
  }, [armed]);
  useEffect(() => {
    if (armed && !m.openOrders.some(o => o.id === armed)) setArmed(undefined);
  }, [armed, m.openOrders]);
  const cancel = async (order: MexcOrder) => {
    if (gate.current || m.sending || m.locked) return; // The ref stops a double tap within one frame.
    if (!m.quickMode && armed !== order.id) { setArmed(order.id); return; }
    gate.current = true;
    setArmed(undefined);
    try {
      await m.cancel(order.id);
    } finally {
      gate.current = false;
    }
  };
  const contracts = useMemo(() => new Map(m.contracts.map(c => [c.symbol, c])), [m.contracts]);
  const working = new Set(m.openOrders.map(order => order.id));
  const orders = [...m.openOrders, ...closed.orders.filter(order => !working.has(order.id))];
  const rows: OrderListExtra[] = orders.map(order => ({
    key: `mexc-${order.id}`,
    time: order.createdAt ?? order.updatedAt ?? 0,
    group: orderGroup(order),
    render: first => (
      <OrderRow order={order} contract={contracts.get(order.symbol)} palette={p} first={first} disabled={m.sending}
        open={opened === order.id} onContract={onContract}
        onOpen={() => { setOpened(opened === order.id ? undefined : order.id); setArmed(undefined); }}>
        {working.has(order.id) && (m.locked
          ? <Text style={{ color: p.secondary, fontSize: 12 }}>MEXC 交易已锁定，暂不能撤单。</Text>
          : m.cancelSent(order.id)
            ? <Text style={{ color: p.secondary, fontSize: 12 }}>撤单已发送，正在等列表更新。</Text>
            : order.cancelable
              ? <Button label={armed === order.id ? "再点一次确认撤单" : m.quickMode ? (m.isDemo ? "模拟撤单" : "立即撤单") : "撤单"} palette={p} variant="tinted" color={p.up}
                  disabled={m.sending} onPress={() => void cancel(order)} />
              : <Text style={{ color: p.secondary, fontSize: 12 }}>此委托当前不可撤销。</Text>)}
      </OrderRow>
    ),
  }));
  const coverage = `MEXC 已结束委托显示最近 ${CLOSED_ORDER_DAYS} 天，只查持仓、挂单、近期交易过和收藏的合约（这次查了 ${closed.symbols.length} 个）。`;
  const failure = closed.failed.length ? ` ${closed.failed.map(contractShort).join("、")} 的已结束委托读取失败，这里可能不全。` : "";
  return { rows, note: coverage + failure, symbols: closed.symbols, reload: closed.reload };
}
