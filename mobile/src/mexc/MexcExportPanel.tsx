import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { MexcOrder } from "../mexcRules.ts";
import { shareTextFile } from "../shareFile.ts";
import type { Palette } from "../types.ts";
import { Button, Chip, radius, styles } from "../ui.tsx";
import { mexcExportFileName, mexcOrdersCSV } from "./mexcExport.ts";
import { batches, contractShort } from "./mexcView.ts";
import type { MexcState } from "./useMexc.ts";

const RANGES = [
  [7, "近 7 天"],
  [30, "近 30 天"],
  [60, "近 60 天"],
] as const;

/** Same panel as the Schwab export. Reads only. */
export function MexcExportPanel({ m, palette: p, symbols, onClose }: {
  m: MexcState; palette: Palette; symbols: readonly string[]; onClose: () => void;
}) {
  const [days, setDays] = useState(30);
  const [result, setResult] = useState("");
  const [working, setWorking] = useState(false);
  const exportOrders = async () => {
    if (working) return;
    setWorking(true);
    setResult("");
    try {
      const to = Date.now(), from = to - days * 86_400_000;
      const orders: MexcOrder[] = [], missing: string[] = [];
      for (const group of batches(symbols, 4))
        await Promise.all(group.map(symbol => m.api.closedOrders(symbol, from, to)
          .then(rows => { orders.push(...rows); })
          .catch(() => { missing.push(symbol); })));
      const { csv, rows } = mexcOrdersCSV(orders);
      const failed = missing.length ? `${missing.map(contractShort).join("、")} 读取失败，没有包含在内。` : "";
      if (!rows) { setResult(`所选范围内没有成交记录。${failed}`); return; }
      await shareTextFile(mexcExportFileName(from, to), csv);
      setResult(`已导出 ${rows} 笔有成交的委托。${failed}`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : "导出失败，请稍后重试。");
    } finally {
      setWorking(false);
    }
  };
  return (
    <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: 12, gap: 10 }}>
      <View style={styles.spread}>
        <Text style={{ color: p.text, fontSize: 15, fontWeight: "700" }}>导出 MEXC 成交委托 · CSV</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭 MEXC 导出" hitSlop={10} onPress={onClose}>
          <Text style={{ color: p.secondary, fontSize: 20, lineHeight: 22 }}>×</Text>
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {RANGES.map(([value, label]) => (
          <Chip key={value} label={label} palette={p} active={days === value} style={{ flex: 1 }} disabled={working} onPress={() => setDays(value)} />
        ))}
      </View>
      <Text style={{ color: p.secondary, fontSize: 12, lineHeight: 18 }}>
        每个有成交的委托一行：本地与 UTC 时间、合约、方向、委托价、张数、成交均价、手续费和盈亏。MEXC 按委托汇总，不是逐笔成交；只包含持仓、挂单、近期交易过和收藏的合约（这次 {symbols.length} 个）。
      </Text>
      <Button label={working ? "正在读取委托…" : "导出并分享"} palette={p} active disabled={working || !symbols.length} onPress={() => void exportOrders()} />
      {!!result && <Text style={{ color: p.accent, fontSize: 12 }}>{result}</Text>}
    </View>
  );
}
