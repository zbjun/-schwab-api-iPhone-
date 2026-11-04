import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { chartHeightFor } from "../chartCountdown.ts";
import { isLineRange } from "../chartData.ts";
import { DemoNotice } from "../DemoNotice.tsx";
import type { Candle, History, HistoryRange, Palette } from "../types.ts";
import { mexcActionLabels } from "../mexcRules.ts";
import type { MexcAction, MexcContract, MexcOrder, MexcPosition, MexcStopOrder, MexcTicker } from "../mexcRules.ts";
import MarketChart, { ChartControls, dateTime, type ChartControlHandle } from "../MarketChart.tsx";
import { Button, Chip, Icon, Input, compactNumber, elevated, radius, styles } from "../ui.tsx";
import { useTickers, type MexcState } from "./useMexc.ts";
import {
  candleMove, chartFillWindow, closableOf, closeActionFor, favoriteContracts, hasClosable, isStockContract, mergeLiveCandles, mexcExecutions, percent, positionPriceLines, priceText, signedPercent, sortContracts, STOCK_NOTE,
} from "./mexcView.ts";
import MexcOrderPanel from "./MexcOrderPanel.tsx";
import MexcStopEditor from "./MexcStopEditor.tsx";
import { useChartPip } from "./useChartPip.ts";
import { EmptyState, Notice, Segmented } from "./parts.tsx";

const PAGE = 30;
const STAR_WIDTH = 26;
export const FAVORITE_COLOR = "#F5B400";
const RANGES: [HistoryRange, string][] = [
  ["minute1", "1分"], ["minute5", "5分"], ["minute15", "15分"], ["minute60", "1时"], ["daily", "日"],
];

export default function MexcMarkets({ m, palette: p, detail, setDetail, favorites, onToggleFavorite }: {
  m: MexcState; palette: Palette; detail?: string; setDetail: (symbol?: string) => void;
  favorites: string[]; onToggleFavorite: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<"favorites" | "all">();
  // Opens on the favourites once there are any; a search always looks through everything.
  const view = picked ?? (favorites.length ? "favorites" : "all");
  const searching = query.trim() !== "";
  const sorted = useMemo(() => sortContracts(m.contracts, query), [m.contracts, query]);
  const list = useMemo(() => (searching || view === "all" ? sorted : favoriteContracts(favorites, m.contracts)), [searching, view, sorted, favorites, m.contracts]);
  useEffect(() => setShown(PAGE), [query, view]);
  const visible = list.slice(0, shown);
  // Quotes are requested only for the rows on screen (plus the open detail).
  const symbols = useMemo(() => detail ? [detail] : visible.map(c => c.symbol), [detail, visible]);
  const tickers = useTickers(m, symbols);
  const selected = detail ? m.contracts.find(c => c.symbol === detail) : undefined;
  if (detail && selected)
    return <Detail m={m} palette={p} contract={selected} ticker={tickers[detail]} />;
  const rateColor = (rate?: number) => (rate ?? 0) > 0 ? p.up : (rate ?? 0) < 0 ? p.down : p.secondary;
  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.pageContent, { gap: 10 }]}>
      {m.isDemo && <DemoNotice palette={p} />}
      <View style={[styles.row, { backgroundColor: elevated(p), borderRadius: 10, paddingHorizontal: 12, height: 44, gap: 8 }]}>
        <Icon name="search" color={p.secondary} size={18} />
        <Input palette={p} accessibilityLabel="搜索合约" placeholder="搜索合约，例如 QQQ" autoCapitalize="characters"
          value={query} onChangeText={setQuery} style={{ flex: 1, backgroundColor: "transparent", paddingHorizontal: 0 }} />
      </View>
      {!m.contracts.length && <EmptyState palette={p} text={m.offline ? "还没有连上 MEXC 网关，无法读取合约。" : "正在读取合约…"} />}
      {!!m.contracts.length && !searching && (
        <Segmented<"favorites" | "all"> palette={p} value={view} onChange={setPicked}
          options={[{ id: "favorites", label: `收藏 ${favorites.length}` }, { id: "all", label: "全部" }]} />
      )}
      {!!m.contracts.length && searching && !sorted.length && <EmptyState palette={p} text="没有匹配的合约。" />}
      {!!m.contracts.length && !searching && view === "favorites" && !list.length && <EmptyState palette={p} text="还没有收藏的合约。点列表左边的星标，或合约详情页右上角的星标。" />}
      {!!list.length && (
        <View style={{ borderRadius: radius.card, backgroundColor: p.surface, paddingHorizontal: 12, overflow: "hidden" }}>
          <View style={{ flexDirection: "row", alignItems: "center", height: 34, paddingLeft: STAR_WIDTH }}>
            <Text style={{ width: "42%", color: p.secondary, fontSize: 11 }}>合约 {list.length}</Text>
            <Text style={{ width: "30%", color: p.secondary, fontSize: 11, textAlign: "right" }}>最新</Text>
            <Text style={{ width: "28%", color: p.secondary, fontSize: 11, textAlign: "right" }}>涨幅</Text>
          </View>
          {visible.map(c => {
            const t = tickers[c.symbol], rate = t?.riseFallRate, favorite = favorites.includes(c.symbol);
            return (
              <View key={c.symbol} style={{ flexDirection: "row", alignItems: "center", minHeight: 65, borderTopWidth: 1, borderTopColor: p.separator }}>
                <Pressable accessibilityRole="button" accessibilityLabel={`${favorite ? "取消收藏" : "收藏"} ${c.symbol}`} accessibilityState={{ selected: favorite }}
                  onPress={() => { setPicked(view); onToggleFavorite(c.symbol); }} style={{ width: STAR_WIDTH, alignSelf: "stretch", justifyContent: "center" }}>
                  <Icon name={favorite ? "star" : "star-outline"} color={favorite ? FAVORITE_COLOR : p.secondary} size={17} />
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`${c.symbol} 详情`} onPress={() => setDetail(c.symbol)}
                  style={{ flex: 1, flexDirection: "row", alignItems: "center", alignSelf: "stretch" }}>
                <View style={{ width: "42%", paddingRight: 6 }}>
                  <Text numberOfLines={1} style={{ color: p.text, fontSize: 15, fontWeight: "500" }}>{c.symbol}</Text>
                  <Text numberOfLines={1} style={{ color: p.secondary, fontSize: 11, marginTop: 2 }}>
                    {isStockContract(c) ? "美股类" : "加密"} · 最高 {c.maxLeverage}x
                  </Text>
                </View>
                <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.number, { width: "30%", color: p.text, fontSize: 16, fontWeight: "600", textAlign: "right" }]}>
                  {priceText(t?.lastPrice, c.priceUnit)}
                </Text>
                <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.number, { width: "28%", color: rateColor(rate), fontSize: 14, fontWeight: "600", textAlign: "right" }]}>
                  {signedPercent(rate)}
                </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
      {list.length > shown && <Button label={`显示更多（还有 ${list.length - shown} 个）`} palette={p} variant="tinted" onPress={() => setShown(shown + PAGE)} />}
    </ScrollView>
  );
}

const LIVE_INTERVAL = 1_000;
const FULL_RELOAD_INTERVAL = 60_000;
const STALE_AFTER_FAILURES = 3;

function Detail({ m, palette: p, contract, ticker: listTicker }: {
  m: MexcState; palette: Palette; contract: MexcContract; ticker?: MexcTicker;
}) {
  const windowHeight = useWindowDimensions().height;
  const fullChartHeight = chartHeightFor(windowHeight);
  const [range, setRange] = useState<HistoryRange>("minute15");
  const [history, setHistory] = useState<History>();
  const [selectedCandle, setSelectedCandle] = useState<Candle>();
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState("");
  const [liveTicker, setLiveTicker] = useState<MexcTicker>();
  const [stale, setStale] = useState(false);
  const [more, setMore] = useState(false);
  const chartControls = useRef<ChartControlHandle>(null);
  const [ticket, setTicket] = useState<MexcAction>();
  const [stopTarget, setStopTarget] = useState<MexcPosition>();
  const [stops, setStops] = useState<MexcStopOrder[]>([]);
  const [stopsVersion, setStopsVersion] = useState(0);
  const [stopsFailed, setStopsFailed] = useState(false);
  const [closedOrders, setClosedOrders] = useState<MexcOrder[]>([]);
  const [scrollHeight, setScrollHeight] = useState(0);
  const [chartTop, setChartTop] = useState(0);
  // With the order panel open the chart fits what is left above it, so the latest candle stays in view.
  const chartHeight = (ticket || stopTarget) && scrollHeight > 0 ? Math.min(fullChartHeight, Math.max(200, scrollHeight - chartTop - 4)) : fullChartHeight;
  const ticker = liveTicker?.symbol === contract.symbol ? liveTicker : listTicker;
  useEffect(() => {
    let active = true, loading = false, ticking = false, failures = 0;
    setHistory(undefined); setError(""); setStale(false);
    // The whole chart loads now and then to fill any gaps; the latest candles arrive every second.
    const load = () => {
      if (loading || AppState.currentState !== "active") return;
      loading = true;
      m.api.chart(contract.symbol, range)
        .then(value => { if (active) { setHistory(value); setError(""); } })
        .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "读取 K 线失败。"); })
        .finally(() => { loading = false; });
    };
    const tick = () => {
      if (ticking || AppState.currentState !== "active") return;
      ticking = true;
      m.api.live(contract.symbol, range)
        .then(value => {
          if (!Array.isArray(value?.candles)) throw new Error("Invalid live response");
          if (!active) return;
          // Recovering after an outage leaves a gap that only the whole chart can fill.
          if (failures >= STALE_AFTER_FAILURES) load();
          failures = 0;
          setStale(false);
          setLiveTicker(value.ticker);
          setHistory(previous => (previous ? mergeLiveCandles(previous, value.candles) : previous));
        })
        .catch(() => { if (active && ++failures >= STALE_AFTER_FAILURES) setStale(true); })
        .finally(() => { ticking = false; });
    };
    load();
    const reload = setInterval(load, FULL_RELOAD_INTERVAL), live = setInterval(tick, LIVE_INTERVAL);
    // Bars missed while the phone was locked would otherwise look like one continuous chart.
    const foreground = AppState.addEventListener("change", state => { if (state === "active") load(); });
    return () => { active = false; clearInterval(reload); clearInterval(live); foreground.remove(); };
  }, [m.api, contract.symbol, range]);
  const held = (m.account?.positions ?? []).filter(position => position.symbol === contract.symbol && position.holdVol > 0);
  // Asked for again whenever the account is, so a triggered or newly set one shows up without a visit elsewhere.
  useEffect(() => {
    if (!held.length) { setStops([]); setStopsFailed(false); return; }
    let active = true;
    m.api.stopOrders(contract.symbol)
      .then(rows => { if (active) { setStops(rows); setStopsFailed(false); } })
      // A failed read must not look like nothing set. Only a gateway without this feature stays quiet.
      .catch(error => { if (active) setStopsFailed((error as { code?: string })?.code !== "methodNotAllowed"); });
    return () => { active = false; };
  }, [m.api, contract.symbol, m.account, held.length, stopsVersion]);
  const working = m.openOrders.filter(order => order.symbol === contract.symbol);
  // Asked for again as soon as a position or a partial fill moves, and now and then for what closed on another device.
  const fillsKey = [...held.map(row => `${row.id}:${row.holdVol}`), ...working.map(order => `${order.id}:${order.dealVol}`)].join();
  useEffect(() => {
    let active = true;
    const load = () => {
      const { from, to } = chartFillWindow(Date.now());
      // Markers are a convenience on a chart: without them it is still right, so a failed read stays quiet.
      m.api.closedOrders(contract.symbol, from, to).then(rows => { if (active) setClosedOrders(rows); }).catch(() => {});
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [m.api, contract.symbol, fillsKey]);
  const executions = useMemo(() => mexcExecutions([...closedOrders, ...working]), [closedOrders, fillsKey]);
  // Both follow the account and the stops, not the live ticks, so the chart is not asked to redo them every second.
  const priceLines = useMemo(() => positionPriceLines(held, stops, { cost: p.accent, takeProfit: p.up, stopLoss: p.down }, contract.contractSize), [m.account, contract.symbol, contract.contractSize, stops, p]);
  const pip = useChartPip({
    m, contract, history, range, rangeLabel: RANGES.find(([id]) => id === range)?.[1] ?? (range === "intraday" ? "分时" : ""), priceLines, palette: p,
  });
  // With the crosshair on a candle, the header reads that candle instead of the live quote.
  const line = isLineRange(range);
  const move = selectedCandle && history ? candleMove(history.candles, selectedCandle, line) : undefined;
  const rate = selectedCandle ? move?.rate : ticker?.riseFallRate, color = (rate ?? 0) > 0 ? p.up : (rate ?? 0) < 0 ? p.down : p.secondary;
  const unit = contract.priceUnit;
  // Hedge mode can hold both directions in one contract, so each gets its own named button rather than a guess.
  const closable = (m.account?.positions ?? []).filter(position => position.symbol === contract.symbol && hasClosable(closableOf(position)));
  const minor = RANGES.filter(([id]) => id === "minute1" || id === "minute5" || id === "minute15");
  const minorLabel = minor.find(([id]) => id === range)?.[1];
  const quoteSide: [string, string][] = selectedCandle
    ? [["时间", dateTime(selectedCandle.time)], [line ? "起始" : "前收", priceText(move?.reference, unit)]]
    : [["买一", priceText(ticker?.bid1, unit)], ["卖一", priceText(ticker?.ask1, unit)]];
  const quoteStats: [string, string][] = selectedCandle
    ? [["开", priceText(selectedCandle.open, unit)], ["高", priceText(selectedCandle.high, unit)], ["低", priceText(selectedCandle.low, unit)], ["量", compactNumber(selectedCandle.volume)]]
    : [["高", priceText(ticker?.high24Price, unit)], ["低", priceText(ticker?.lower24Price, unit)],
      ["费率", percent(ticker?.fundingRate, 4)], ["标记", priceText(ticker?.fairPrice, unit)]];
  const underline = <View style={{ position: "absolute", bottom: 2, width: 18, height: 3, borderRadius: 2, backgroundColor: p.up }} />;
  const action = (label: string, background: string, onPress: () => void, disabled: boolean, flex = 1) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
      style={{ flex, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: background, opacity: disabled ? 0.4 : 1 }}>
      <Text style={{ color: background === elevated(p) ? p.text : "#fff", fontSize: 16, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ flex: 1 }}>
      {/* A chart drag must not move the page; without alwaysBounceVertical a page that already fits would still rubber-band. */}
      <ScrollView testID="mexc.detail.scroll" scrollEnabled={!inspecting} directionalLockEnabled alwaysBounceVertical={false} showsVerticalScrollIndicator={false}
        onLayout={event => setScrollHeight(event.nativeEvent.layout.height)} contentContainerStyle={{ paddingBottom: 12, gap: 4 }}>
        {/* Two lines whatever the price length: a long BTC price must not squeeze the numbers into "101,2...". */}
        <View style={{ backgroundColor: p.surface, paddingHorizontal: 12, paddingVertical: 6, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.number, { color, fontSize: 26, lineHeight: 30, fontWeight: "600", letterSpacing: -0.6, flexShrink: 1 }]}>
              {priceText(selectedCandle?.close ?? ticker?.lastPrice, unit)}
            </Text>
            <Text numberOfLines={1} style={[styles.number, { color, fontSize: 13, fontWeight: "600" }]}>{signedPercent(rate)}</Text>
            <View style={{ marginLeft: "auto", gap: 1 }}>
              {quoteSide.map(([label, value]) => (
                <View key={label} style={{ flexDirection: "row", justifyContent: "flex-end", gap: 4 }}>
                  <Text style={{ color: p.secondary, fontSize: 11, lineHeight: 14 }}>{label}</Text>
                  <Text numberOfLines={1} style={[styles.number, { color: p.text, fontSize: 11, lineHeight: 14 }]}>{value}</Text>
                </View>
              ))}
            </View>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 6 }}>
            {quoteStats.map(([label, value]) => (
              <View key={label} style={{ flexShrink: 1, minWidth: 0, flexDirection: "row", gap: 3 }}>
                <Text style={{ color: p.secondary, fontSize: 11, lineHeight: 14 }}>{label}</Text>
                <Text adjustsFontSizeToFit minimumFontScale={0.75} numberOfLines={1} style={[styles.number, { color: p.text, fontSize: 11, lineHeight: 14, flexShrink: 1 }]}>{value}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={{ height: 28, flexDirection: "row", alignItems: "stretch", zIndex: 10 }}>
          {([["intraday", "分时"], ["minute60", "1时"], ["daily", "日"]] as [HistoryRange, string][]).map(([id, label]) => (
            <Pressable key={id} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: range === id }}
              onPress={() => { setMore(false); setRange(id); }} style={{ paddingHorizontal: 14, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: range === id ? p.text : p.secondary, fontSize: 14, fontWeight: range === id ? "600" : "400" }}>{label}</Text>
              {range === id && underline}
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" accessibilityLabel="更多周期" onPress={() => setMore(!more)}
            style={{ paddingHorizontal: 14, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: minorLabel ? p.text : p.secondary, fontSize: 14, fontWeight: minorLabel ? "600" : "400" }}>{minorLabel ?? "更多"}⌄</Text>
            {!!minorLabel && underline}
          </Pressable>
          <View style={{ flex: 1 }} />
          {pip.available && (
            <Pressable accessibilityRole="button" accessibilityLabel={pip.active ? "关闭小窗" : pip.enabled ? "打开小窗" : "开启小窗"} accessibilityState={{ selected: pip.enabled }}
              onPress={pip.toggle} style={{ paddingHorizontal: 6, justifyContent: "center" }}>
              <Text style={{ color: pip.enabled ? p.accent : p.secondary, fontSize: 11, fontWeight: pip.active ? "700" : "500" }}>小窗</Text>
            </Pressable>
          )}
          <ChartControls controls={chartControls} palette={p} zoomable={!isLineRange(range)} />
        {more && (
            <View style={{ position: "absolute", top: 28, left: 8, width: 244, zIndex: 10, backgroundColor: p.surface, borderWidth: 1,
              borderColor: p.separator, borderRadius: radius.card, padding: 8, flexDirection: "row", gap: 6 }}>
              {minor.map(([id, label]) => (
                <Chip key={id} label={label} palette={p} active={range === id} onPress={() => { setMore(false); setRange(id); }} />
              ))}
            </View>
          )}
        </View>
        <View onLayout={event => setChartTop(event.nativeEvent.layout.y)} style={{ paddingLeft: 12, paddingRight: 4 }}>
          {history ? (
            <MarketChart history={history} range={range} palette={p} height={chartHeight} controlsRef={chartControls}
              continuousMarket executions={executions} priceLines={priceLines} onInspectChange={setInspecting} onSelectionChange={setSelectedCandle} />
          ) : (
            <View style={{ height: chartHeight, justifyContent: "center" }}>
              {error ? <Text style={{ color: p.secondary, textAlign: "center", padding: 20 }}>{error}</Text> : <ActivityIndicator color={p.secondary} />}
            </View>
          )}
        </View>
        {(stale || (!!error && !!history)) && <Notice palette={p} text="行情刷新失败，当前显示的价格和 K 线是旧数据。" style={{ marginHorizontal: 12 }} />}
        {isStockContract(contract) && <Notice palette={p} tone="info" text={STOCK_NOTE} style={{ marginHorizontal: 12 }} />}
      </ScrollView>
      {stopTarget ? (
        <MexcStopEditor key={`${stopTarget.id}:${stops.find(row => row.positionId === stopTarget.id)?.id ?? "new"}`} m={m} palette={p} contract={contract} ticker={ticker}
          position={held.find(row => row.id === stopTarget.id) ?? stopTarget} stops={stops.filter(row => row.positionId === stopTarget.id)}
          maxHeight={Math.round(windowHeight * 0.72)} onClose={() => setStopTarget(undefined)}
          onChanged={() => { setStopTarget(undefined); setStopsVersion(version => version + 1); }} />
      ) : ticket ? (
        <MexcOrderPanel key={ticket} m={m} palette={p} contract={contract} ticker={ticker} initialAction={ticket} onClose={() => setTicket(undefined)} />
      ) : (
        <>
        {held.map(position => {
          const stop = stops.find(row => row.positionId === position.id), long = position.direction === "LONG";
          return (
            <Pressable key={position.id} accessibilityRole="button" accessibilityLabel={`${long ? "多仓" : "空仓"}止盈止损`} disabled={m.sending} onPress={() => setStopTarget(position)}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 12, backgroundColor: p.surface, borderTopWidth: 1, borderTopColor: p.separator }}>
              <Text numberOfLines={1} style={[styles.number, { color: long ? p.up : p.down, fontSize: 12, fontWeight: "700" }]}>{long ? "多" : "空"} {position.holdVol} 张 · {position.leverage}x</Text>
              <Text numberOfLines={1} style={[styles.number, { flex: 1, color: p.secondary, fontSize: 12, textAlign: "right" }]}>
                {stopsFailed ? "止盈止损读取失败" : `止盈 ${priceText(stop?.takeProfitPrice, unit)}  止损 ${priceText(stop?.stopLossPrice, unit)}${stop && stop.vol !== position.holdVol ? `  覆盖 ${stop.vol} 张` : ""}`}
              </Text>
              <Text style={{ color: p.accent, fontSize: 12, fontWeight: "600" }}>设置</Text>
            </Pressable>
          );
        })}
        <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14, gap: 12,
          backgroundColor: p.surface, borderTopWidth: 1, borderTopColor: p.separator }}>
          {action("开多", p.up, () => setTicket("OPEN_LONG"), m.sending)}
          {action("开空", p.down, () => setTicket("OPEN_SHORT"), m.sending)}
          {closable.length
            ? closable.map(position => {
              const close = closeActionFor(position);
              return <React.Fragment key={position.id}>{action(mexcActionLabels[close], elevated(p), () => setTicket(close), m.sending, 0.7)}</React.Fragment>;
            })
            : action("平仓", elevated(p), () => {}, true, 0.7)}
        </View>
        </>
      )}
    </View>
  );
}
