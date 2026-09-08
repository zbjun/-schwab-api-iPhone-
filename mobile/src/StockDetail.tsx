import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import type { Candle, HistoryRange, Palette, Side } from "./types.ts";
import type { TradingState } from "./useTrading.ts";
import MarketChart from "./MarketChart.tsx";
import { primaryRanges, minuteRanges, rangeTitle, hasMissingOvernightData } from "./chartData.ts";
import { compactNumber, money, signed } from "./ui.tsx";
import { selectedActivity, selectedChangePercent, selectedReferencePrice } from "./marketStatistics.ts";
import { positionAverageCost } from "./tradeMarkers.ts";
import { useLiveMarket } from "./useLiveMarket.ts";
import { TradePanel } from "./TradePanel.tsx";

export default function StockDetail({
  symbol,
  state: s,
  palette: p,
}: {
  symbol: string;
  state: TradingState;
  palette: Palette;
}) {
  const [range, setRange] = useState<HistoryRange>("intraday"),
    [more, setMore] = useState(false);
  const { history, quote, ratio, loading, error, streamStatus, provisional } =
    useLiveMarket(
      s.broker,
      symbol,
      range,
      s.revision,
      s.isDemo,
      s.status.authenticated,
    );
  const [panel, setPanel] = useState<Side | "CANCEL">(),
    [keyboard, setKeyboard] = useState(false);
  const { height, width } = useWindowDimensions();
  const wideQuote = width >= 600;
  const [availableHeight, setAvailableHeight] = useState(height - 140);
  const [tradePanelHeight, setTradePanelHeight] = useState(382);
  const [metricNotes, setMetricNotes] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [selectedCandle, setSelectedCandle] = useState<Candle>();
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [panel]);
  useEffect(() => {
    const a = Keyboard.addListener("keyboardDidShow", () => setKeyboard(true));
    const b = Keyboard.addListener("keyboardDidHide", () => setKeyboard(false));
    return () => {
      a.remove();
      b.remove();
    };
  }, []);
  const selectedPercent = selectedChangePercent(history, selectedCandle, range);
  const activity = selectedActivity(selectedCandle, quote?.sharesOutstanding);
  const summaryHigh = selectedCandle ? selectedCandle.high : quote?.highPrice;
  const summaryLow = selectedCandle ? selectedCandle.low : quote?.lowPrice;
  const summaryOpen = selectedCandle ? selectedCandle.open : quote?.openPrice;
  const summaryReference = selectedCandle
    ? selectedReferencePrice(history, selectedCandle, range) : quote?.closePrice;
  const summaryVolume = selectedCandle ? activity.volume : quote?.totalVolume;
  const summaryTurnover = selectedCandle ? activity.turnoverPercent
    : quote?.totalVolume !== undefined && quote.sharesOutstanding && quote.sharesOutstanding > 0
      ? quote.totalVolume / quote.sharesOutstanding * 100 : undefined;
  const displayChange = selectedCandle ? selectedPercent : quote?.netChange;
  const color =
    displayChange === undefined || displayChange === 0
      ? p.text
      : displayChange > 0
        ? p.up
        : p.down;
  const compact = panel !== undefined;
  const chartSectionHeight = compact
    ? keyboard
      ? 172
      : Math.max(220, Math.min(460, availableHeight - 64 - tradePanelHeight))
    : Math.max(420, Math.min(650, availableHeight * 0.65)) + (wideQuote ? 0 : 36);
  const line = range === "intraday" || range === "fiveDay";
  const chartHeight =
    chartSectionHeight -
    44 -
    (line && !keyboard ? 18 : 0) -
    (!keyboard ? 18 : 0);
  const priceColor = (value?: number) =>
    value === undefined || summaryReference === undefined
      ? p.secondary
      : value > summaryReference
        ? p.up
        : value < summaryReference
          ? p.down
          : p.secondary;
  const statistic = (label: string, value: string, tint = p.text, dense = false) => (
    <View key={label} testID={`detail.metric.${label}`} style={[local.statistic, dense && { gap: 2 }]}>
      <Text numberOfLines={1} style={{ color: p.secondary, fontSize: dense ? 11 : 12 }}>
        {label}
      </Text>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        style={{
          color: tint,
          fontSize: dense ? 11 : 12,
          fontVariant: ["tabular-nums"],
          flexShrink: 1,
        }}
      >
        {value}
      </Text>
    </View>
  );
  const closePanel = () => {
    Keyboard.dismiss();
    setPanel(undefined);
  };
  const holding = s.account?.positions.find((value) => value.symbol === symbol);
  const averageCost = positionAverageCost(s.account?.positions, symbol);
  const executions = useMemo(
    () =>
      s.ordersLoaded ? s.orders.flatMap((order) => order.executions ?? []) : [],
    [s.ordersLoaded, s.orders, s.accountID],
  );
  const quoteStatus = s.isDemo
    ? "演示行情 · 换手与量比为估算"
    : `${quote?.isRealtime ? "实时权限" : "时效未确认"} · ${quote?.quoteTime ? new Date(quote.quoteTime).toLocaleTimeString() : "时间未提供"}`;
  const nightMissing = !s.isDemo && (line || range.startsWith("minute")) && !loading &&
    hasMissingOvernightData(history?.candles ?? [], Date.now());
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: p.background }}
      onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}
    >
      <ScrollView
        ref={scroll}
        testID="detail.scroll"
        scrollEnabled={!compact && !inspecting}
        directionalLockEnabled
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={
          compact
            ? { flexGrow: 0, flexShrink: 0, height: 64 + chartSectionHeight }
            : { flex: 1 }
        }
      >
        <View
          testID={compact ? "detail.quote.compact" : "detail.quote.summary"}
          style={{
            backgroundColor: p.surface,
            paddingHorizontal: !compact && !wideQuote ? 10 : 16,
            paddingVertical: compact ? 7 : 10,
            gap: compact ? 5 : 6,
            ...(compact ? { height: 64 } : {}),
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: !compact && !wideQuote ? 6 : 12 }}>
            <View style={compact ? { flex: 1 } : { width: wideQuote ? 144 : 90 }}>
              <Text
                testID="detail.lastPrice"
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.6}
                style={{
                  color,
                  fontSize: compact ? 24 : wideQuote ? 32 : 28,
                  lineHeight: compact ? 28 : 38,
                  fontWeight: "600",
                  fontVariant: ["tabular-nums"],
                  letterSpacing: -0.6,
                }}
              >
                {money(selectedCandle?.close ?? quote?.lastPrice)}
              </Text>
              <Text
                testID="detail.priceContext"
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                style={{
                  color,
                  fontSize: !compact && !wideQuote ? 11 : 13,
                  fontWeight: "600",
                  marginTop: 4,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {selectedCandle
                  ? signed(selectedPercent, "%")
                  : `${signed(quote?.netChange)} ${signed(quote?.netPercentChange, "%")}`}
              </Text>
            </View>
            <View style={compact ? { width: 86, gap: 6 } : { flex: 0.8, gap: 8 }}>
              {statistic(
                "高",
                money(summaryHigh),
                priceColor(summaryHigh),
                !compact && !wideQuote,
              )}
              {statistic(
                "低",
                money(summaryLow),
                priceColor(summaryLow),
                !compact && !wideQuote,
              )}
              {!compact &&
                statistic(
                  "开",
                  money(summaryOpen),
                  priceColor(summaryOpen),
                  !wideQuote,
                )}
            </View>
            <View style={compact ? { width: 86, gap: 6 } : { flex: 1, gap: 8 }}>
                {compact && statistic(
                  "开",
                  money(summaryOpen),
                  priceColor(summaryOpen),
                )}
                {statistic(selectedCandle ? "前收" : "昨收", money(summaryReference), p.secondary, !compact && !wideQuote)}
                {!compact && <>
                  {statistic(selectedCandle ? "市值今" : "市值", quote?.marketCap !== undefined && quote.marketCap >= 1e12
                    ? `${money(quote.marketCap / 1e12)}万亿` : compactNumber(quote?.marketCap), p.text, !wideQuote)}
                  {statistic(selectedCandle ? "市盈今" : wideQuote ? "市盈率" : "市盈", money(quote?.peRatio), p.text, !wideQuote)}
                </>}
            </View>
            {!compact && (
              <View style={{ flex: 1, gap: 8 }}>
                {selectedCandle
                  ? statistic(wideQuote ? "成交额估" : "额估", compactNumber(activity.amountEstimate), p.text, !wideQuote)
                  : statistic(wideQuote ? "量比估" : "量比", money(ratio), p.text, !wideQuote)}
                {statistic(wideQuote || selectedCandle ? "换手估" : "换手", summaryTurnover !== undefined
                  ? `${money(summaryTurnover, selectedCandle && summaryTurnover > 0 && summaryTurnover < 0.01 ? 6 : 2)}%` : "—", p.text, !wideQuote)}
                {statistic(wideQuote ? "成交量" : "量", compactNumber(summaryVolume), p.text, !wideQuote)}
              </View>
            )}
          </View>
          {!compact && (
            <>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
              >
                <View
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: s.isDemo ? "#9a6500" : p.down,
                  }}
                />
                <Text
                  numberOfLines={1}
                  style={{ flex: 1, color: p.secondary, fontSize: 10 }}
                >
                  {error ||
                    (nightMissing ? "当前夜盘数据尚未返回，图中为已有历史行情" : undefined) ||
                    (selectedCandle
                      ? `${rangeTitle(range)} · ${new Date(selectedCandle.time).toLocaleString("zh-CN", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} 美东 · 已选${selectedCandle.provisional ? "（形成中）" : ""}`
                      : s.isDemo
                      ? quoteStatus
                      : `${streamStatus === "live" ? "推送已连接" : streamStatus === "connecting" ? "推送连接中" : "轮询更新"}${provisional ? " · 形成中K线估算，量待校准" : ""} · ${quoteStatus}`)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="行情指标说明"
                  testID="detail.metricInfo"
                  hitSlop={10}
                  onPress={() => setMetricNotes(!metricNotes)}
                >
                  <Text
                    style={{ color: p.secondary, fontSize: 15, lineHeight: 18 }}
                  >
                    ⓘ
                  </Text>
                </Pressable>
              </View>
              {metricNotes && (
                <Text
                  style={{ color: p.secondary, fontSize: 11, lineHeight: 16 }}
                >
                  十字线选中时，高低开、成交量均来自该根 K 线；成交额按高低开收均价乘该根成交量估算，并非实际成交额。换手估按该根成交量除以当前总股本计算，历史总股本变化未还原。市值今与市盈今仍是当前基本面。取消选中后恢复最新行情；选中时量比位置显示成交额估。平时量比对比此前五个交易日的平均成交量。黄色线根据分钟价格和成交量估算均价，每个交易日重置。缺失数据显示
                  —。
                </Text>
              )}
            </>
          )}
        </View>
        <View
          style={{
            height: chartSectionHeight,
            backgroundColor: p.background,
            position: "relative",
          }}
        >
          <View style={local.periods}>
            {primaryRanges.map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{
                  selected: range === value,
                  disabled: s.busy,
                }}
                testID={`history.${value}`}
                disabled={s.busy}
                onPress={() => {
                  setRange(value);
                  setMore(false);
                }}
                style={local.period}
              >
                <Text
                  style={{
                    color: range === value ? p.text : p.secondary,
                    fontSize: 15,
                    fontWeight: range === value ? "600" : "400",
                  }}
                >
                  {rangeTitle(value)}
                </Text>
                <View
                  style={{
                    height: 3,
                    width: 18,
                    borderRadius: 2,
                    marginTop: 7,
                    backgroundColor: range === value ? p.up : "transparent",
                  }}
                />
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="更多K线周期"
              testID="history.more"
              accessibilityState={{
                expanded: more,
                selected: minuteRanges.includes(range),
                disabled: s.busy,
              }}
              disabled={s.busy}
              onPress={() => setMore(!more)}
              style={local.period}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: minuteRanges.includes(range) ? p.text : p.secondary,
                  fontSize: 15,
                  fontWeight: minuteRanges.includes(range) ? "600" : "400",
                }}
              >
                {minuteRanges.includes(range)
                  ? rangeTitle(range).replace("分钟", "分")
                  : "更多"}
                ⌄
              </Text>
              <View
                style={{
                  height: 3,
                  width: 18,
                  borderRadius: 2,
                  marginTop: 7,
                  backgroundColor: minuteRanges.includes(range)
                    ? p.up
                    : "transparent",
                }}
              />
            </Pressable>
          </View>
          <View style={{ paddingHorizontal: 12 }}>
            {loading ? (
              <View style={{ height: chartHeight, justifyContent: "center" }}>
                <ActivityIndicator color={p.secondary} />
                <Text
                  style={{
                    color: p.secondary,
                    textAlign: "center",
                    fontSize: 12,
                    marginTop: 10,
                  }}
                >
                  正在读取完整交易时段…
                </Text>
              </View>
            ) : history ? (
              <MarketChart
                history={history}
                range={range}
                palette={p}
                height={chartHeight}
                onInspectChange={setInspecting}
                onSelectionChange={setSelectedCandle}
                executions={executions}
                averageCost={averageCost}
              />
            ) : (
              <View style={{ height: chartHeight, justifyContent: "center" }}>
                <Text
                  style={{
                    color: p.secondary,
                    textAlign: "center",
                    padding: 20,
                  }}
                >
                  {error || "此区间暂无价格数据"}
                </Text>
              </View>
            )}
            {line && !keyboard && (
              <Text
                numberOfLines={1}
                style={{ fontSize: 10, color: p.secondary, lineHeight: 18 }}
              >
                黄色均价估算 · 每个交易日重新计算
              </Text>
            )}
            {!keyboard && (
              <Text
                testID="chart.tradeLegend"
                style={{ fontSize: 10, color: p.secondary, lineHeight: 18 }}
              >
                B 买入 · S 卖出 · {s.ordersLoaded ? "近30天成交" : "成交待加载"}
                {averageCost !== undefined ? " · 虚线成本" : ""}
              </Text>
            )}
          </View>
          {more && (
            <>
              <Pressable
                accessibilityLabel="关闭周期菜单"
                style={[StyleSheet.absoluteFill, { top: 44 }]}
                onPress={() => setMore(false)}
              />
              <View
                style={{
                  position: "absolute",
                  top: 4,
                  right: 8,
                  width: 244,
                  borderRadius: 28,
                  backgroundColor: p.surface,
                  paddingVertical: 12,
                  zIndex: 10,
                  boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
                  borderWidth: 1,
                  borderColor: p.separator,
                }}
              >
                {minuteRanges.map((value) => (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    testID={`history.${value}`}
                    accessibilityState={{ selected: range === value }}
                    onPress={() => {
                      setRange(value);
                      setMore(false);
                    }}
                    style={{
                      paddingHorizontal: 26,
                      height: 42,
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <Text style={{ color: p.text, fontSize: 18 }}>
                      {rangeTitle(value)}
                    </Text>
                    {range === value && (
                      <Text style={{ color: p.text }}>✓</Text>
                    )}
                  </Pressable>
                ))}
              </View>
            </>
          )}
        </View>
        {!compact && (
          <View
            style={{
              backgroundColor: p.surface,
              borderTopWidth: 1,
              borderColor: p.separator,
              padding: 16,
              gap: 16,
            }}
          >
            <View style={local.statisticRow}>
              <Text
                style={{
                  color: p.text,
                  fontSize: 17,
                  fontWeight: "600",
                  flex: 1,
                }}
              >
                报价与统计
              </Text>
              <Text style={{ color: p.secondary, fontSize: 12 }}>USD</Text>
            </View>
            <View style={local.statisticRow}>
              {statistic("买价", money(quote?.bidPrice))}
              {statistic("卖价", money(quote?.askPrice))}
            </View>
            <View style={local.statisticRow}>
              {statistic("52周高", money(quote?.high52Week))}
              {statistic("52周低", money(quote?.low52Week))}
            </View>
            {holding && (
              <View style={local.statisticRow}>
                {statistic("持有股数", money(holding.quantity, 0))}
                {statistic("持仓成本", money(holding.averagePrice))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
      {compact ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={{
            flex: 1,
            backgroundColor: p.surface,
            borderTopWidth: 1,
            borderColor: p.separator,
          }}
          onContentSizeChange={(_, contentHeight) => {
            // Reserve the ticket's actual height; longer forms remain scrollable.
            setTradePanelHeight(Math.max(160, Math.min(382, Math.ceil(contentHeight) + 1)));
          }}
        >
          <TradePanel
            key={panel}
            state={s}
            symbol={symbol}
            quote={quote}
            palette={p}
            initialSide={panel}
            inline
            onClose={closePanel}
          />
        </ScrollView>
      ) : (
        <View
          style={{
            flexDirection: "row",
            paddingHorizontal: 16,
            paddingTop: 10,
            paddingBottom: 14,
            gap: 12,
            backgroundColor: p.surface,
            borderTopWidth: 1,
            borderColor: p.separator,
          }}
        >
          {(["BUY", "SELL", "CANCEL"] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={
                value === "BUY" ? "买入" : value === "SELL" ? "卖出" : "撤单"
              }
              testID={`detail.${value.toLowerCase()}`}
              disabled={s.busy}
              onPress={() => {
                setMore(false);
                setPanel(value);
              }}
              style={{
                flex: 1,
                height: 46,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 9,
                opacity: s.busy ? 0.45 : 1,
                backgroundColor:
                  value === "BUY"
                    ? p.up
                    : value === "SELL"
                      ? "#368fb9"
                      : p.background,
              }}
            >
              <Text
                style={{
                  fontSize: 19,
                  fontWeight: "600",
                  color: value === "CANCEL" ? p.text : "#fff",
                }}
              >
                {value === "BUY" ? "买" : value === "SELL" ? "卖" : "撤"}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const local = StyleSheet.create({
  statistic: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 5,
  },
  statisticRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  periods: { height: 44, flexDirection: "row", alignItems: "center" },
  period: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 8,
  },
});
