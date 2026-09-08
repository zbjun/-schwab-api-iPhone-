import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import type { History, Palette, Quote } from "./types.ts";
import type { TradingState } from "./useTrading.ts";
import { Button, elevated, Icon, Input, money, signed, styles } from "./ui.tsx";
import { DemoNotice } from "./DemoNotice.tsx";
import { validSymbol } from "./orderRules.ts";
import MarketChart from "./MarketChart.tsx";
import {
  overnightReference,
  overnightReferenceFresh,
  OVERNIGHT_CHECKED_ON,
  OVERNIGHT_HOLDINGS_AS_OF,
} from "./overnightEligibility.ts";

export default function Watchlist({
  state: s,
  palette: p,
  onStock,
  editing,
  adding,
  search,
  setSearch,
  charts,
  setCharts,
  onCloseAdd,
}: {
  state: TradingState;
  palette: Palette;
  onStock: (symbol: string) => void;
  editing: boolean;
  adding: boolean;
  search: string;
  setSearch: (value: string) => void;
  charts: boolean;
  setCharts: (value: boolean) => void;
  onCloseAdd: () => void;
}) {
  const [newSymbol, setNewSymbol] = useState("");
  const [showLegend, setShowLegend] = useState(false);
  const blockedUntil = useRef(0);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 25 && Math.abs(g.dx) > Math.abs(g.dy) * 1.7,
      onPanResponderGrant: () => {
        blockedUntil.current = Date.now() + 300;
      },
      onPanResponderMove: () => {
        blockedUntil.current = Date.now() + 300;
      },
      onPanResponderRelease: (_, g) => {
        blockedUntil.current = Date.now() + 300;
        if (g.dx < -50) setCharts(true);
        if (g.dx > 50) setCharts(false);
      },
    }),
  ).current;
  function lookup() {
    const symbol = search.trim().toUpperCase();
    if (!validSymbol(symbol)) {
      s.setMessage("请输入有效的股票或 ETF 代码，例如 AAPL。");
      return;
    }
    onStock(symbol);
  }
  function add() {
    const symbol = newSymbol.trim().toUpperCase();
    if (!validSymbol(symbol)) {
      s.setMessage("请输入有效的股票或 ETF 代码。");
      return;
    }
    if (s.watchlist.length >= 50 && !s.watchlist.includes(symbol)) {
      s.setMessage("自选最多 50 个。");
      return;
    }
    s.setWatchlist([...new Set([...s.watchlist, symbol])]);
    setNewSymbol("");
    onCloseAdd();
  }
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        {...pan.panHandlers}
        contentContainerStyle={{ paddingBottom: 104 }}
      >
        <View
          style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 }}
        >
          <View
            style={{
              ...styles.row,
              backgroundColor: elevated(p),
              borderRadius: 10,
              paddingHorizontal: 12,
              height: 44,
            }}
          >
            <Icon name="search" color={p.secondary} size={21} />
            <Input
              palette={p}
              accessibilityLabel="添加自选代码"
              placeholder="输入股票 / ETF 代码"
              value={search}
              autoCapitalize="characters"
              onChangeText={setSearch}
              onSubmitEditing={lookup}
              style={{
                flex: 1,
                paddingHorizontal: 0,
                fontSize: 16,
                minHeight: 40,
              }}
            />
            <Button
              label="查价"
              color={p.up}
              palette={p}
              disabled={!search.trim() || s.busy}
              onPress={lookup}
            />
          </View>
          <View style={[styles.spread, { paddingTop: 20, paddingBottom: 16 }]}>
            <View style={[styles.row, { gap: 8 }]}>
              <Text style={{ color: p.text, fontSize: 20, fontWeight: "600" }}>
                自选股
              </Text>
              <Text style={{ color: p.secondary, fontSize: 16 }}>
                {s.watchlist.length}
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 3 }}>
              {[false, true].map((mode) => (
                <Pressable
                  key={String(mode)}
                  accessibilityRole="button"
                  accessibilityLabel={mode ? "多股同列" : "行情列表"}
                  accessibilityState={{ selected: charts === mode }}
                  onPress={() => setCharts(mode)}
                  style={{
                    width: 40,
                    height: 30,
                    borderRadius: 7,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor:
                      charts === mode ? elevated(p) : "transparent",
                  }}
                >
                  <Icon
                    name={mode ? "chart" : "list"}
                    size={20}
                    color={charts === mode ? p.text : p.secondary}
                  />
                </Pressable>
              ))}
            </View>
          </View>
          {s.isDemo ? (
            <DemoNotice palette={p} />
          ) : (
            <Text
              style={{ color: p.secondary, fontSize: 12, paddingVertical: 10 }}
            >
              Schwab · {s.status.authenticated ? "已连接" : "尚未连接"}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="自选持仓与24小时标记说明"
            onPress={() => setShowLegend(true)}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30 }}
          >
            <Text style={{ color: p.accent, fontSize: 11 }}>蓝色名称 · 当前持仓</Text>
            <Text style={{ color: p.secondary, fontSize: 11 }}>
              {overnightReferenceFresh() ? "24 · 隔夜交易参考" : "24 · 参考名单待更新"}
            </Text>
            <Icon name="info" color={p.secondary} size={13} />
          </Pressable>
        </View>
        <View style={{ backgroundColor: p.surface, paddingHorizontal: 16 }}>
          <View
            style={{
              flexDirection: "row",
              height: 51,
              alignItems: "center",
              borderBottomWidth: 1,
              borderColor: p.separator,
            }}
          >
            <Text style={{ width: "30%", color: p.secondary, fontSize: 11 }}>
              名称 / 代码
            </Text>
            {charts ? (
              <>
                <Text
                  style={{
                    width: "43%",
                    textAlign: "center",
                    color: p.secondary,
                    fontSize: 11,
                  }}
                >
                  多股同列
                </Text>
                <Text
                  style={{
                    width: "27%",
                    textAlign: "right",
                    color: p.secondary,
                    fontSize: 11,
                  }}
                >
                  涨幅 / 最新
                </Text>
              </>
            ) : (
              <>
                {[
                  ["最新", "25%"],
                  ["涨幅", "24%"],
                  ["涨跌", "21%"],
                ].map(([label, width]) => (
                  <Text
                    key={label}
                    style={{
                      width: width as `${number}%`,
                      textAlign: "right",
                      color: p.secondary,
                      fontSize: 11,
                    }}
                  >
                    {label}
                  </Text>
                ))}
              </>
            )}
          </View>
          {s.watchlist.map((symbol) => (
            <WatchRow
              key={`${s.isDemo}-${symbol}`}
              state={s}
              palette={p}
              symbol={symbol}
              quote={s.quotes[symbol]}
              charts={charts}
              editing={editing}
              onPress={() => {
                if (Date.now() > blockedUntil.current && !s.busy)
                  onStock(symbol);
              }}
            />
          ))}
        </View>
        <View style={{ padding: 16, gap: 5 }}>
          <Text style={{ color: p.secondary, fontSize: 11 }}>
            {charts ? "右滑返回行情列表 · 分时走势" : "左滑查看多股同列走势"}
          </Text>
          <Text style={{ color: p.secondary, fontSize: 11 }}>
            {s.isDemo
              ? "演示数据 · 不连接真实账户"
              : "报价以券商返回时间为准，点击右上角刷新"}
          </Text>
        </View>
      </ScrollView>
      <Modal
        visible={showLegend}
        transparent
        animationType="fade"
        onRequestClose={() => setShowLegend(false)}
      >
        <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#0008" }}>
          <View style={{ backgroundColor: p.surface, padding: 20, borderRadius: 18, gap: 14 }}>
            <Text style={{ color: p.text, fontSize: 18, fontWeight: "600" }}>自选标记</Text>
            <Text style={{ color: p.accent, fontSize: 14, lineHeight: 21 }}>
              蓝色名称和代码：当前所选账户持有该股票或 ETF。涨跌报价仍按涨跌颜色显示。
            </Text>
            <Text style={{ color: p.text, fontSize: 14, lineHeight: 21 }}>
              24：Schwab 每周 5 天、每天 24 小时交易的参考标记，不是 7 天全天交易，也不表示本 App 已支持隔夜下单。
            </Text>
            <Text style={{ color: p.secondary, fontSize: 12, lineHeight: 19 }}>
              依据 Schwab 公布的资格规则、标普 500 成分参考和官网列举的部分 ETF。覆盖并不完整；未标记不代表不支持。最终以 thinkorswim 的 Public → 24 Hour Trading 名单为准。
            </Text>
            <Text style={{ color: p.secondary, fontSize: 12, lineHeight: 19 }}>
              资料核对：{OVERNIGHT_CHECKED_ON}；成分参考：{OVERNIGHT_HOLDINGS_AS_OF}。参考资料超过 30 天后暂停显示标记，等待更新。
            </Text>
            <Button label="知道了" palette={p} active onPress={() => setShowLegend(false)} />
          </View>
        </View>
      </Modal>
      <Modal
        transparent
        visible={adding}
        animationType="fade"
        onRequestClose={onCloseAdd}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "#00000055",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <View
            style={{
              backgroundColor: p.surface,
              borderRadius: 28,
              padding: 22,
              gap: 20,
            }}
          >
            <Text style={{ color: p.text, fontSize: 20, fontWeight: "600" }}>
              添加自选
            </Text>
            <Input
              palette={p}
              accessibilityLabel="新自选股票代码"
              placeholder="例如 AAPL、SPY"
              value={newSymbol}
              onChangeText={setNewSymbol}
              autoCapitalize="characters"
              onSubmitEditing={add}
            />
            <View
              style={{
                flexDirection: "row",
                justifyContent: "flex-end",
                gap: 14,
              }}
            >
              <Button label="取消" palette={p} onPress={onCloseAdd} />
              <Button label="添加" palette={p} active onPress={add} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
function WatchRow({
  state: s,
  palette: p,
  symbol,
  quote: q,
  charts,
  editing,
  onPress,
}: {
  state: TradingState;
  palette: Palette;
  symbol: string;
  quote?: Quote;
  charts: boolean;
  editing: boolean;
  onPress: () => void;
}) {
  const [history, setHistory] = useState<History>();
  useEffect(() => {
    let active = true;
    if (charts && s.status.authenticated)
      void s.broker
        .history(symbol, "intraday")
        .then((value) => {
          if (active) setHistory(value);
        })
        .catch(() => {
          if (active) setHistory(undefined);
        });
    return () => {
      active = false;
    };
  }, [s.broker, s.status.authenticated, s.revision, symbol, charts]);
  const held = s.account?.positions.some(
    (position) =>
      position.symbol.trim().toUpperCase() === symbol.trim().toUpperCase() &&
      Number.isFinite(position.quantity) && position.quantity !== 0,
  ) ?? false;
  const overnight = overnightReference(symbol);
  const color =
    q?.netChange === undefined || q.netChange === 0
      ? p.secondary
      : q.netChange > 0
        ? p.up
        : p.down;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        borderBottomWidth: 1,
        borderColor: p.separator,
        minHeight: 65,
      }}
    >
      {editing && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`移除 ${symbol}`}
          onPress={() =>
            s.setWatchlist(s.watchlist.filter((v) => v !== symbol))
          }
          style={{ width: 30 }}
        >
          <View
            style={{
              backgroundColor: p.up,
              borderRadius: 12,
              width: 22,
              height: 22,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="minus" color="#fff" size={16} />
          </View>
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`行情 ${symbol}`}
        accessibilityHint={[held && "当前账户持仓", overnight && "24小时交易参考标记"].filter(Boolean).join("，") || undefined}
        onPress={onPress}
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          minHeight: 65,
        }}
      >
        <View style={{ width: "30%", paddingRight: 8, gap: 5 }}>
          <Text
            numberOfLines={1}
            style={{ color: held ? p.accent : p.text, fontSize: 15, fontWeight: held ? "600" : "500" }}
          >
            {q?.description ?? symbol}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            <Text
              style={{
                color: "#231e27",
                fontSize: 10,
                backgroundColor: "#e9c9df",
                borderRadius: 2,
                paddingHorizontal: 3,
              }}
            >
              US
            </Text>
            <Text style={{ color: held ? p.accent : p.secondary, fontSize: 11 }}>{symbol}</Text>
            {overnight && (
              <Text
                accessibilityLabel="24小时交易参考标记"
                style={{ color: p.premarket, borderColor: p.premarket, borderWidth: 1,
                  borderRadius: 4, paddingHorizontal: 3, fontSize: 9, lineHeight: 12, fontWeight: "700" }}
              >24</Text>
            )}
          </View>
        </View>
        {charts ? (
          <>
            <View style={{ width: "43%", paddingHorizontal: 5 }}>
              {history ? (
                <MarketChart
                  history={history}
                  range="intraday"
                  palette={p}
                  compact
                  height={45}
                />
              ) : (
                <Text style={{ color: p.secondary, fontSize: 11 }}>
                  暂无走势
                </Text>
              )}
            </View>
            <View style={{ width: "27%", alignItems: "flex-end", gap: 4 }}>
              <Text
                style={[
                  styles.number,
                  {
                    color: "#fff",
                    backgroundColor: color,
                    borderRadius: 3,
                    paddingVertical: 4,
                    paddingHorizontal: 7,
                    fontSize: 15,
                  },
                ]}
              >
                {signed(q?.netPercentChange, "%")}
              </Text>
              <Text style={{ color: p.secondary, fontSize: 11 }}>
                {money(q?.lastPrice)}
              </Text>
            </View>
          </>
        ) : (
          <>
            {[
              [money(q?.lastPrice), "25%"],
              [signed(q?.netPercentChange, "%"), "24%"],
              [signed(q?.netChange), "21%"],
            ].map(([text, width], i) => (
              <Text
                key={i}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.75}
                style={[
                  styles.number,
                  {
                    width: width as `${number}%`,
                    textAlign: "right",
                    color,
                    fontSize: 17,
                    fontWeight: "600",
                  },
                ]}
              >
                {text}
              </Text>
            ))}
          </>
        )}
      </Pressable>
    </View>
  );
}
