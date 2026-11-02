import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { History, HistoryRange, Palette } from "../types.ts";
import type { MexcContract } from "../mexcRules.ts";
import MarketChart from "../MarketChart.tsx";
import { Button, Chip, Input, Meta, styles } from "../ui.tsx";
import { useTickers, type MexcState } from "./useMexc.ts";
import { isStockContract, percent, priceText, signedPercent, sortContracts, STOCK_NOTE } from "./mexcView.ts";
import { Notice } from "./parts.tsx";

const PAGE = 30;
const RANGES: [HistoryRange, string][] = [
  ["minute1", "1分"], ["minute5", "5分"], ["minute15", "15分"], ["minute60", "1时"], ["daily", "日"],
];

export default function MexcMarkets({ m, palette: p, detail, setDetail, onTrade }: {
  m: MexcState; palette: Palette; detail?: string; setDetail: (symbol?: string) => void; onTrade: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const sorted = useMemo(() => sortContracts(m.contracts, query), [m.contracts, query]);
  useEffect(() => setShown(PAGE), [query]);
  const visible = sorted.slice(0, shown);
  // Quotes are requested only for the rows on screen (plus the open detail).
  const symbols = useMemo(() => detail ? [detail] : visible.map(c => c.symbol), [detail, visible]);
  const tickers = useTickers(m, symbols);
  const selected = detail ? m.contracts.find(c => c.symbol === detail) : undefined;
  if (detail && selected)
    return <Detail m={m} palette={p} contract={selected} ticker={tickers[detail]} onBack={() => setDetail(undefined)} onTrade={() => onTrade(detail)} />;
  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.pageContent, { gap: 8 }]}>
      <Input palette={p} accessibilityLabel="搜索合约" placeholder="搜索合约，例如 QQQ" autoCapitalize="characters"
        value={query} onChangeText={setQuery} />
      {!m.contracts.length && <Notice palette={p} tone="info" text={m.offline ? "还没有连上 MEXC 网关，无法读取合约。" : "正在读取合约…"} />}
      {!!m.contracts.length && !sorted.length && <Notice palette={p} tone="info" text="没有匹配的合约。" />}
      <View style={{ borderRadius: 10, backgroundColor: p.surface, overflow: "hidden" }}>
        {visible.map((c, index) => {
          const t = tickers[c.symbol], rate = t?.riseFallRate;
          const color = (rate ?? 0) > 0 ? p.up : (rate ?? 0) < 0 ? p.down : p.text;
          return (
            <Pressable key={c.symbol} accessibilityRole="button" accessibilityLabel={`${c.symbol} 详情`} onPress={() => setDetail(c.symbol)}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12, minHeight: 56,
                borderTopWidth: index ? 1 : 0, borderTopColor: p.separator }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ color: p.text, fontSize: 15, fontWeight: "600" }}>{c.symbol}</Text>
                <Text numberOfLines={1} style={{ color: p.secondary, fontSize: 11, marginTop: 2 }}>
                  {isStockContract(c) ? "美股类" : "加密"} · 最高 {c.maxLeverage}x
                </Text>
              </View>
              <Text style={[styles.number, { color, fontSize: 15 }]}>{priceText(t?.lastPrice, c.priceUnit)}</Text>
              <Text style={[styles.number, { color, fontSize: 13, minWidth: 64, textAlign: "right" }]}>{signedPercent(rate)}</Text>
            </Pressable>
          );
        })}
      </View>
      {sorted.length > shown && <Button label={`显示更多（还有 ${sorted.length - shown} 个）`} palette={p} variant="tinted" onPress={() => setShown(shown + PAGE)} />}
    </ScrollView>
  );
}

function Detail({ m, palette: p, contract, ticker, onBack, onTrade }: {
  m: MexcState; palette: Palette; contract: MexcContract; ticker?: import("../mexcRules.ts").MexcTicker; onBack: () => void; onTrade: () => void;
}) {
  const [range, setRange] = useState<HistoryRange>("minute15");
  const [history, setHistory] = useState<History>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setHistory(undefined); setError("");
    m.api.chart(contract.symbol, range)
      .then(value => { if (active) setHistory(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "读取 K 线失败。"); });
    return () => { active = false; };
  }, [m.api, contract.symbol, range]);
  const rate = ticker?.riseFallRate, color = (rate ?? 0) > 0 ? p.up : (rate ?? 0) < 0 ? p.down : p.text;
  const unit = contract.priceUnit;
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.pageContent, { gap: 10 }]}>
      <View style={styles.row}>
        <Button label="返回" palette={p} onPress={onBack} />
        </View>
      <View style={[styles.card, { backgroundColor: p.surface, gap: 10, marginBottom: 0 }]}>
        <View style={styles.spread}>
          <View style={{ flexShrink: 1 }}>
            <Text numberOfLines={1} style={{ color: p.text, fontSize: 17, fontWeight: "700" }}>{contract.symbol}</Text>
            <Text numberOfLines={1} style={{ color: p.secondary, fontSize: 12 }}>{contract.displayName}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[styles.number, { color, fontSize: 22 }]}>{priceText(ticker?.lastPrice, unit)}</Text>
            <Text style={[styles.number, { color, fontSize: 13 }]}>{signedPercent(rate)}</Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Meta label="买一" value={priceText(ticker?.bid1, unit)} palette={p} />
          <Meta label="卖一" value={priceText(ticker?.ask1, unit)} palette={p} />
          <Meta label="资金费率" value={percent(ticker?.fundingRate, 4)} palette={p} />
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {RANGES.map(([id, label]) => <Chip key={id} label={label} palette={p} active={range === id} onPress={() => setRange(id)} />)}
      </View>
      {history ? (
        <MarketChart history={history} range={range} palette={p} height={280} />
      ) : (
        <View style={{ height: 280, justifyContent: "center" }}>
          {error ? <Text style={{ color: p.secondary, textAlign: "center", padding: 20 }}>{error}</Text> : <ActivityIndicator color={p.secondary} />}
        </View>
      )}
      {isStockContract(contract) && <Notice palette={p} tone="info" text={STOCK_NOTE} />}
      <Button label="去交易" palette={p} variant="filled" onPress={onTrade} />
    </ScrollView>
  );
}
