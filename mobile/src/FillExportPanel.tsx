import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Palette } from "./types.ts";
import type { TradingState } from "./useTrading.ts";
import { Button, Chip, radius, styles } from "./ui.tsx";
import { collectOrderHistory, exportFileName, fillsCSV } from "./fillExport.ts";
import { shareTextFile } from "./shareFile.ts";

const RANGES = [
  [7, "近 7 天"],
  [30, "近 30 天"],
  [60, "近 60 天"],
] as const;

export function FillExportPanel({
  state: s,
  palette: p,
  onClose,
}: {
  state: TradingState;
  palette: Palette;
  onClose: () => void;
}) {
  const [days, setDays] = useState(30);
  const [result, setResult] = useState("");
  const exportFills = () =>
    void s.run(async () => {
      setResult("");
      if (!s.accountID) throw new Error("请先连接账户，再导出成交记录。");
      const history = await collectOrderHistory(s.broker, s.accountID, days);
      const { csv, fills, withoutDetail } = fillsCSV(history.orders, history.from, history.to);
      if (!fills && !withoutDetail) {
        setResult(history.limited ? "近 30 天内没有成交记录（服务器尚未更新，暂时只能读取 30 天）。" : "所选范围内没有成交记录。");
        return;
      }
      await shareTextFile(exportFileName(history.from, history.to), csv);
      const notes = [
        withoutDetail ? `${withoutDetail} 个已成交订单缺少逐笔明细，已在备注列标出` : "",
        history.limited ? "服务器尚未更新，只包含近 30 天" : "",
        history.complete ? "" : "部分时段订单超过 200 笔，结果可能不完整",
      ].filter(Boolean);
      setResult(`已导出 ${fills} 笔成交（${history.orders.length} 个订单）。${notes.length ? `${notes.join("；")}。` : ""}`);
    });
  return (
    <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: 12, gap: 10 }}>
      <View style={styles.spread}>
        <Text style={{ color: p.text, fontSize: 15, fontWeight: "700" }}>导出成交记录 · CSV</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭导出" hitSlop={10} onPress={onClose}>
          <Text style={{ color: p.secondary, fontSize: 20, lineHeight: 22 }}>×</Text>
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {RANGES.map(([value, label]) => (
          <Chip
            key={value}
            label={label}
            palette={p}
            active={days === value}
            style={{ flex: 1 }}
            disabled={s.busy}
            onPress={() => setDays(value)}
          />
        ))}
      </View>
      <Text style={{ color: p.secondary, fontSize: 12, lineHeight: 18 }}>
        当前账户 {s.account?.displayNumber ?? "—"}，每笔成交一行：美东、本地与 UTC 成交时间（精确到秒）、代码、方向、成交价、数量、金额和订单信息。来自券商订单的逐笔成交明细，不含手续费；Schwab 订单接口最多回溯 60 天。
      </Text>
      <Button
        label={s.busy ? "正在读取订单…" : "导出并分享"}
        palette={p}
        active
        disabled={s.busy}
        onPress={exportFills}
      />
      {!!result && <Text style={{ color: p.accent, fontSize: 12 }}>{result}</Text>}
    </View>
  );
}
