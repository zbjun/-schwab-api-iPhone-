import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Palette, ScheduledOrder, ScheduledStatus } from "./types.ts";
import type { TradingState } from "./useTrading.ts";
import { Chip, radius, styles } from "./ui.tsx";
import { easternClock } from "./easternTime.ts";
import { describeStop } from "./orderRules.ts";

const STATUS: Record<ScheduledStatus, string> = {
  pending: "待执行",
  submitting: "提交中",
  submitted: "已提交",
  failed: "未提交",
  cancelled: "已撤销",
  missed: "已错过",
  unknown: "结果未知",
  skipped: "已放弃",
};

/** Server-held timed orders for the current account, refreshed while visible. */
export function ScheduledOrders({ state: s, palette: p }: { state: TradingState; palette: Palette }) {
  const broker = s.broker;
  const [items, setItems] = useState<ScheduledOrder[]>();
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const load = useCallback(async () => {
    if (!broker.scheduled) return;
    try {
      setItems(await broker.scheduled());
      setError("");
    } catch (value) {
      if ((value as { code?: string })?.code === "methodNotAllowed") setUnsupported(true);
      else setError(value instanceof Error ? value.message : "无法读取定时单。");
    }
  }, [broker]);
  useEffect(() => {
    setItems(undefined);
    setUnsupported(false);
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load, s.revision]);
  if (!broker.scheduled || unsupported) return null;
  const mine = (items ?? []).filter((item) => item.accountID === s.accountID).slice(0, 10);
  if (!mine.length && !error) return null;
  const color = (status: ScheduledStatus) =>
    status === "pending" || status === "submitting"
      ? p.premarket
      : status === "submitted"
        ? p.accent
        : status === "failed" || status === "unknown"
          ? p.up
          : p.secondary;
  return (
    <View style={{ backgroundColor: p.surface, borderRadius: radius.card, paddingHorizontal: 12, paddingVertical: 8 }}>
      <Text style={{ color: p.text, fontSize: 14, fontWeight: "700", paddingVertical: 4 }}>⏱ 定时单</Text>
      {!!error && <Text style={{ color: p.up, fontSize: 12 }}>{error}</Text>}
      {mine.map((item, index) => {
        const d = item.draft,
          clock = easternClock(item.runAt);
        const what = d.kind === "EXIT" ? "止盈止损" : d.side === "BUY" ? "买入" : "卖出";
        const price = d.limitPrice ? `$${d.limitPrice}` : d.stopPrice ? `触发 $${d.stopPrice}` : d.kind === "EXIT" ? "" : "市价";
        const exits = [
          d.exit?.takeProfit ? `止盈 $${d.exit.takeProfit}` : "",
          d.exit?.stopLoss ? `止损 ${describeStop(d.exit.stopLoss)}` : "",
        ].filter(Boolean).join(" · ");
        return (
          <View
            key={item.id}
            style={{ paddingVertical: 8, gap: 4, borderTopWidth: index ? StyleSheet.hairlineWidth : 0, borderColor: p.separator }}
          >
            <View style={styles.spread}>
              <Text style={{ color: p.text, fontSize: 14, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
                {what} {d.symbol} × {d.quantity} {price && <Text style={{ fontWeight: "400" }}>{price}</Text>}
              </Text>
              <Text style={{ color: color(item.status), fontSize: 12, fontWeight: "600" }}>
                {STATUS[item.status] ?? item.status}
                {item.orderID ? ` #${item.orderID}` : ""}
              </Text>
            </View>
            <View style={styles.spread}>
              <Text style={{ color: p.secondary, fontSize: 12, fontVariant: ["tabular-nums"] }}>
                美东 {clock.date.slice(5)} {clock.time}
                {exits ? ` · ${exits}` : ""}
              </Text>
              {item.status === "pending" && (
                <Chip
                  label="撤销"
                  accessibilityLabel={`撤销定时单 ${d.symbol}`}
                  palette={p}
                  color={p.up}
                  disabled={s.busy}
                  onPress={() =>
                    void s.run(async () => {
                      await broker.cancelScheduled!(item.id);
                      await load();
                    })
                  }
                />
              )}
            </View>
            {!!item.message && item.status !== "pending" && (
              <Text style={{ color: p.secondary, fontSize: 11 }}>{item.message}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
