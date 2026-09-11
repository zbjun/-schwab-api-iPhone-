import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import MarketChart from "./MarketChart.tsx";
import { validCandle } from "./chartData.ts";
import { historyCoverage } from "./historyCoverage.ts";
import { dark, light } from "./ui.tsx";
import type { History } from "./types.ts";

// Local development only. Files contain market history, never account data or credentials.
// Missing snapshots fail visibly; do not fall back to generated candles.
export default function HistorySnapshotPreview() {
  const [symbol, setSymbol] = useState("QQQ");
  const [history, setHistory] = useState<History>();
  const [error, setError] = useState("");
  const { height } = useWindowDimensions();
  const p = new URLSearchParams(window.location.search).get("appearance") === "light" ? light : dark;
  useEffect(() => {
    const controller = new AbortController();
    setHistory(undefined);
    setError("");
    void fetch(`/market-preview/${symbol.toLowerCase()}.json`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("本地行情快照未准备好");
        const payload = await response.json();
        const value = payload.result;
        if (value?.symbol !== symbol || !Array.isArray(value.candles) ||
          !value.candles.length || !value.candles.every(validCandle))
          throw new Error("行情快照格式无效");
        if (!controller.signal.aborted) setHistory(value);
      })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message)); });
    return () => controller.abort();
  }, [symbol]);
  const coverage = React.useMemo(() => history ? historyCoverage(history.candles) : undefined, [history]);
  const nights = coverage?.days.reduce((sum, day) => sum + day.night, 0) ?? 0;
  return <ScrollView style={{ flex: 1, backgroundColor: p.background }}>
    <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", padding: 12, gap: 12 }}>
      <Text style={{ color: p.text, fontSize: 20, fontWeight: "600" }}>{symbol} · 真实历史行情预览</Text>
      <Text style={{ color: p.secondary }}>服务器读取快照 · 非实时 · 仅展示行情</Text>
      <View style={{ flexDirection: "row", gap: 24 }}>
        {["QQQ", "SNDK", "SNDU"].map(value => <Pressable key={value} accessibilityRole="button"
          accessibilityLabel={`预览 ${value} 真实历史`} onPress={() => setSymbol(value)}>
          <Text style={{ color: symbol === value ? p.accent : p.secondary, fontSize: 18 }}>{value}</Text>
        </Pressable>)}
      </View>
      {error ? <Text style={{ color: p.text }}>{error}</Text> : !history ?
        <Text style={{ color: p.secondary }}>正在读取本地快照…</Text> : <>
          <Text style={{ color: p.secondary }}>{coverage?.first} 至 {coverage?.last} 美东{"\n"}
            共 {coverage?.total} 根一分钟K线，其中夜盘 {nights} 根。点下方“夜盘”定位。</Text>
          <MarketChart key={symbol} history={history} range="minute1" palette={p}
            height={Math.max(240, Math.min(450, height - 310))} />
        </>}
      <Text style={{ color: p.secondary }}>使用 App 同一个图表组件。无夜盘数据时会明确提示，不能用模拟K线补齐。</Text>
    </View>
  </ScrollView>;
}
