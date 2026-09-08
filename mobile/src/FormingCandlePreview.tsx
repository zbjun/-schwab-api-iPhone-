import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import MarketChart from "./MarketChart.tsx";
import { mergeFormingCandle } from "./liveHistory.ts";
import { dark } from "./ui.tsx";
import type { Candle } from "./types.ts";

// Development-only visual fixture. Never instantiated by the native trading UI.
const start = Date.parse("2026-09-08T14:20:00Z");
const past: Candle[] = Array.from({ length: 40 }, (_, i) => ({
  time: start - (40 - i) * 60000,
  open: 100,
  close: 100 + Math.sin(i) * 0.8,
  high: 102,
  low: 98,
  volume: 100 + i,
}));
const steps = [
  { offset: 0, price: 100 },
  { offset: 0, price: 105 },
  { offset: 0, price: 97 },
  { offset: 0, price: 103 },
  { offset: 60000, price: 102 },
  { offset: 60000, price: 106 },
];
export default function FormingCandlePreview() {
  const [index, setIndex] = useState(0);
  const [bars, setBars] = useState<Candle[]>([
    {
      time: start,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      provisional: true,
    },
  ]);
  const [playing, setPlaying] = useState(false);
  const advance = () => setIndex((value) => (value + 1) % steps.length);
  useEffect(() => {
    const step = steps[index];
    if (index === 0)
      setBars([
        {
          time: start,
          open: 100,
          high: 100,
          low: 100,
          close: 100,
          provisional: true,
        },
      ]);
    else
      setBars((previous) =>
        mergeFormingCandle(
          previous,
          {
            time: start + step.offset,
            open: step.price,
            high: step.price,
            low: step.price,
            close: step.price,
            provisional: true,
          },
          start + step.offset + 1000,
        ),
      );
  }, [index]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(advance, 1000);
    return () => clearInterval(timer);
  }, [playing]);
  const last = bars.at(-1)!;
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: dark.background,
        padding: 20,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View style={{ width: "100%", maxWidth: 760, gap: 14 }}>
        <Text style={{ color: dark.text, fontSize: 22, fontWeight: "600" }}>
          动态蜡烛演示 · 模拟价格
        </Text>
        <Text testID="preview.ohlc" style={{ color: dark.secondary }}>
          开 {last.open.toFixed(2)}　高 {last.high.toFixed(2)}　低{" "}
          {last.low.toFixed(2)}　现价 {last.close.toFixed(2)}　{bars.length}{" "}
          根演示蜡烛
        </Text>
        <MarketChart
          history={{ symbol: "DEMO", candles: [...past, ...bars] }}
          range="minute1"
          palette={dark}
          height={330}
        />
        <View style={{ flexDirection: "row", gap: 20 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="下一笔模拟成交"
            onPress={advance}
          >
            <Text style={{ color: dark.accent, fontSize: 18 }}>下一笔成交</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setPlaying(!playing)}
          >
            <Text style={{ color: dark.accent, fontSize: 18 }}>
              {playing ? "暂停" : "播放模拟行情"}
            </Text>
          </Pressable>
        </View>
        <Text style={{ color: dark.secondary }}>
          同一分钟保持开盘价，实体和影线随成交变化；第5步进入下一分钟。
        </Text>
      </View>
    </View>
  );
}
