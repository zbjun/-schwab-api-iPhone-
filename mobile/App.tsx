import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useTrading, type TradingState } from "./src/useTrading.ts";
import type { Order, Palette, Quote } from "./src/types.ts";
import {
  Button,
  dark,
  elevated,
  Icon,
  Input,
  light,
  money,
  radius,
  signed,
  styles,
} from "./src/ui.tsx";
import { FillExportPanel } from "./src/FillExportPanel.tsx";
import { OrderList, TradePanel } from "./src/TradePanel.tsx";
import Settings from "./src/Settings.tsx";
import StockDetail from "./src/StockDetail.tsx";
import Watchlist from "./src/Watchlist.tsx";
import Accounts, { AccountSelector } from "./src/Accounts.tsx";
import { DemoNotice } from "./src/DemoNotice.tsx";
import { PageRefreshControl } from "./src/PageRefreshControl.tsx";
import { validSymbol } from "./src/orderRules.ts";
import FormingCandlePreview from "./src/FormingCandlePreview.tsx";
import HistorySnapshotPreview from "./src/HistorySnapshotPreview.tsx";

type Tab = "accounts" | "watchlist" | "trade" | "orders" | "settings";
const tabs: [Tab, string, string][] = [
  ["accounts", "账户", "pie"],
  ["watchlist", "自选", "star"],
  ["trade", "交易", "trade"],
  ["orders", "订单", "orders"],
  ["settings", "设置", "settings"],
];
export default function App() {
  if (__DEV__ && Platform.OS === "web" &&
    new URLSearchParams(window.location.search).get("preview") === "history")
    return <SafeAreaProvider><HistorySnapshotPreview /></SafeAreaProvider>;
  if (
    __DEV__ &&
    Platform.OS === "web" &&
    new URLSearchParams(window.location.search).get("preview") === "forming"
  )
    return (
      <SafeAreaProvider>
        <FormingCandlePreview />
      </SafeAreaProvider>
    );
  return (
    <SafeAreaProvider>
      <TradingApp />
    </SafeAreaProvider>
  );
}
function TradingApp() {
  const s = useTrading(),
    systemScheme = useColorScheme();
  // Web-only development previews can compare both native appearances without changing the phone setting.
  const previewScheme =
    Platform.OS === "web" && __DEV__
      ? new URLSearchParams(window.location.search).get("appearance")
      : null;
  const p =
    previewScheme === "dark" ||
    (previewScheme !== "light" && systemScheme === "dark")
      ? dark
      : light;
  const [tab, setTab] = useState<Tab>("accounts"),
    [stock, setStock] = useState<string>();
  useEffect(() => {
    s.setAccountVisible(tab === "accounts" && !stock);
    return () => s.setAccountVisible(false);
  }, [tab, stock, s.setAccountVisible]);
  useEffect(() => {
    s.setOrdersVisible(!!stock || tab === "orders");
    return () => s.setOrdersVisible(false);
  }, [tab, stock, s.setOrdersVisible]);
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState(false),
    [adding, setAdding] = useState(false);
  const [watchlistSearch, setWatchlistSearch] = useState("");
  const [watchlistCharts, setWatchlistCharts] = useState(false);
  const [replacement, setReplacement] = useState<Order>(),
    [tradeSymbol, setTradeSymbol] = useState("AAPL");
  const [lookedUp, setLookedUp] = useState<Quote>(),
    [detailName, setDetailName] = useState("");
  useEffect(() => {
    setReplacement(undefined);
    setLookedUp(undefined);
  }, [s.accountID, s.isDemo]);
  useEffect(() => {
    let active = true;
    setDetailName(stock ? (s.quotes[stock]?.description ?? stock) : "");
    if (stock && !s.quotes[stock])
      void s.broker
        .quotes([stock])
        .then((q) => {
          if (active) setDetailName(q[0]?.description ?? stock);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [stock, s.broker, s.quotes]);
  const go = (value: Tab) => {
    if (s.busy) return;
    Keyboard.dismiss();
    setStock(undefined);
    setReplacement(undefined);
    setTab(value);
  };
  const openStock = (symbol: string) => {
    Keyboard.dismiss();
    setStock(symbol);
  };
  const background = p.background;
  const quote =
    lookedUp?.symbol === tradeSymbol ? lookedUp : s.quotes[tradeSymbol];
  async function lookup() {
    if (!validSymbol(tradeSymbol))
      throw new Error("请输入有效的股票或 ETF 代码。");
    const values = await s.broker.quotes([tradeSymbol]);
    setLookedUp(values[0]);
    if (!values.length) throw new Error("未找到此股票或 ETF 的报价。");
  }
  const change = quote?.netPercentChange ?? 0;
  const changeColor = change > 0 ? p.up : change < 0 ? p.down : p.text;
  return (
    <SafeAreaView
      edges={["top", "bottom"]}
      style={{
        flex: 1,
        backgroundColor: background,
        paddingTop: Platform.OS === "web" ? 8 : 0,
      }}
    >
      <StatusBar style={p === dark ? "light" : "dark"} />
      <View
        style={{ flex: 1, width: "100%", maxWidth: 760, alignSelf: "center" }}
      >
        {stock ? (
          <View style={[styles.pageHeader, { minHeight: 52 }]}>
            <RoundButton label="返回" icon="back" palette={p} bare disabled={s.busy}
              onPress={() => setStock(undefined)} />
            <View style={{ flex: 1, alignItems: "center", minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: p.text, fontSize: 16, fontWeight: "700" }}>
                {detailName}
              </Text>
              <Text style={{ color: p.secondary, fontSize: 11, marginTop: 2 }}>{stock} · USD</Text>
            </View>
            <View style={[styles.row, { gap: 0 }]}>
              <RoundButton label={s.watchlist.includes(stock) ? "移除自选" : "添加自选"}
                icon={s.watchlist.includes(stock) ? "star" : "star-outline"}
                color={s.watchlist.includes(stock) ? "#F5B400" : undefined}
                palette={p} bare disabled={s.busy} onPress={() => {
                  if (s.watchlist.includes(stock)) s.setWatchlist(s.watchlist.filter(v => v !== stock));
                  else if (s.watchlist.length < 50) s.setWatchlist([...s.watchlist, stock]);
                  else s.setMessage("自选最多 50 个。");
                }} />
              <RoundButton label="刷新" icon="refresh" palette={p} bare disabled={s.busy}
                onPress={() => void s.run(s.refresh)} />
            </View>
          </View>
        ) : (
          <View testID="page.header" style={styles.pageHeader}>
            <View style={[styles.row, { gap: 10, flexShrink: 1 }]}>
              <Text accessibilityRole="header" testID="page.title" style={[styles.pageTitle, { color: p.text }]}>
                {tabs.find(t => t[0] === tab)?.[1]}
              </Text>
              {s.isDemo && (
                <Text style={{ color: "#ff8a19", fontSize: 11, fontWeight: "600", borderWidth: 1,
                  borderColor: "#ff8a1966", borderRadius: radius.control, paddingHorizontal: 6, paddingVertical: 2 }}>
                  模拟
                </Text>
              )}
              {s.busy && <ActivityIndicator color={p.accent} size="small" />}
            </View>
            {tab === "watchlist" && <View style={[styles.row, { gap: 0 }]}>
              <Pressable accessibilityRole="button" accessibilityLabel={editing ? "完成" : "编辑"}
                disabled={s.busy} onPress={() => setEditing(!editing)}
                style={{ paddingHorizontal: 12, minHeight: 40, justifyContent: "center" }}>
                <Text style={{ color: p.accent, fontSize: 15, fontWeight: "600" }}>{editing ? "完成" : "编辑"}</Text>
              </Pressable>
              <RoundButton label="添加自选" icon="plus" palette={p} bare disabled={s.busy}
                onPress={() => setAdding(true)} />
            </View>}
            {tab === "orders" && (
              <Pressable accessibilityRole="button" accessibilityLabel="导出成交记录"
                disabled={s.busy} onPress={() => setExporting(!exporting)}
                style={{ paddingHorizontal: 12, minHeight: 40, justifyContent: "center" }}>
                <Text style={{ color: p.accent, fontSize: 15, fontWeight: "600" }}>{exporting ? "收起" : "导出 CSV"}</Text>
              </Pressable>
            )}
          </View>
        )}
        {!!s.message && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭提示"
            onPress={() => s.setMessage("")}
            style={[styles.spread, {
              alignItems: "flex-start",
              backgroundColor: elevated(p),
              paddingHorizontal: 12,
              paddingVertical: 9,
              borderRadius: radius.control,
              marginHorizontal: 12,
              marginBottom: 6,
            }]}
          >
            <Text style={{ color: p.text, fontSize: 13, lineHeight: 18, flex: 1 }}>{s.message}</Text>
            <Text style={{ color: p.secondary, fontSize: 15, lineHeight: 18 }}>×</Text>
          </Pressable>
        )}
        {s.status.unresolvedOperation && (
          <Text
            style={{
              color: p.up,
              backgroundColor: p.up + "14",
              fontSize: 12,
              paddingHorizontal: 12,
              paddingVertical: 8,
              marginHorizontal: 12,
              marginBottom: 6,
              borderRadius: radius.control,
              overflow: "hidden",
            }}
          >
            有交易结果待核实：请在券商确认后到设置中的连接处理。
          </Text>
        )}
        {stock ? (
          <StockDetail
            key={`${s.isDemo}-${s.accountID}-${stock}`}
            symbol={stock}
            state={s}
            palette={p}
          />
        ) : (
          <>
            <View style={{ flex: 1 }}>
              {tab === "accounts" && (
                <Accounts
                  state={s}
                  palette={p}
                  onStock={openStock}
                  onTrade={() => go("trade")}
                />
              )}
              {tab === "watchlist" && (
                <Watchlist
                  state={s}
                  palette={p}
                  onStock={openStock}
                  editing={editing}
                  adding={adding}
                  search={watchlistSearch}
                  setSearch={setWatchlistSearch}
                  charts={watchlistCharts}
                  setCharts={setWatchlistCharts}
                  onCloseAdd={() => setAdding(false)}
                />
              )}
              {tab === "trade" && (
                <KeyboardAvoidingView
                  behavior={Platform.OS === "ios" ? "padding" : undefined}
                  style={{ flex: 1 }}
                >
                  <TradePanel
                    key={`${s.isDemo}-${s.accountID}-${tradeSymbol}-${replacement?.id}`}
                    symbol={tradeSymbol}
                    quote={quote}
                    state={s}
                    palette={p}
                    initialSide={replacement?.side}
                    replacement={replacement}
                    onDone={() => setReplacement(undefined)}
                    refreshControl={<PageRefreshControl state={s} palette={p} refresh={async () => {
                      await s.refresh();
                      await lookup();
                    }} />}
                    header={
                      <>
                        {s.isDemo && <DemoNotice palette={p} card />}
                        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, paddingHorizontal: 12 }}>
                          <AccountSelector state={s} palette={p} />
                        </View>
                        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: 12, gap: 8 }}>
                          <View style={styles.row}>
                            <Input
                              palette={p}
                              accessibilityLabel="交易股票代码"
                              placeholder="股票 / ETF 代码"
                              value={tradeSymbol}
                              editable={!s.busy && !replacement}
                              autoCapitalize="characters"
                              returnKeyType="search"
                              onSubmitEditing={() => void s.run(lookup)}
                              onChangeText={(value) => setTradeSymbol(value.toUpperCase().trim())}
                              style={{ flex: 1, fontWeight: "700", fontSize: 17 }}
                            />
                            <Button label="查价" palette={p} variant="tinted" disabled={s.busy}
                              onPress={() => void s.run(lookup)} />
                          </View>
                          <View style={styles.spread}>
                            <Text numberOfLines={1} style={{ flex: 1, color: p.secondary, fontSize: 13 }}>
                              {quote?.description ?? tradeSymbol}
                            </Text>
                            <Text style={[styles.number, { color: changeColor, fontSize: 20 }]}>
                              {money(quote?.lastPrice)}
                            </Text>
                            <Text style={[styles.number, { color: changeColor, fontSize: 13, minWidth: 58, textAlign: "right" }]}>
                              {signed(quote?.netPercentChange, "%")}
                            </Text>
                          </View>
                        </View>
                        {replacement && (
                          <Button label="退出修改订单" palette={p} variant="tinted" color={p.secondary}
                            disabled={s.busy} onPress={() => setReplacement(undefined)} />
                        )}
                      </>
                    }
                  />
                </KeyboardAvoidingView>
              )}
              {tab === "orders" && (
                <ScrollView
                  showsVerticalScrollIndicator={false}
                  alwaysBounceVertical
                  refreshControl={<PageRefreshControl state={s} palette={p} />}
                  contentContainerStyle={[styles.pageContent, { gap: 10 }]}
                >
                  {s.isDemo && <DemoNotice palette={p} card />}
                  {exporting && (
                    <FillExportPanel state={s} palette={p} onClose={() => setExporting(false)} />
                  )}
                  <OrderList
                    state={s}
                    palette={p}
                    onStock={openStock}
                    onReplace={(order) => {
                      setReplacement(order);
                      setTradeSymbol(order.symbol);
                      setTab("trade");
                    }}
                  />
                </ScrollView>
              )}
              {tab === "settings" && <Settings state={s} palette={p} />}
            </View>
            <View
              style={{
                flexDirection: "row",
                height: 54,
                backgroundColor: p.surface,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderColor: p.separator,
              }}
            >
              {tabs.map(([id, label, icon]) => (
                <Pressable
                  key={id}
                  accessibilityRole="tab"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: tab === id }}
                  disabled={s.busy}
                  onPress={() => go(id)}
                  style={{
                    flex: 1,
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 2,
                  }}
                >
                  <Icon
                    name={icon}
                    color={tab === id ? p.accent : p.secondary}
                    size={23}
                  />
                  <Text
                    style={{
                      color: tab === id ? p.accent : p.secondary,
                      fontSize: 10,
                      fontWeight: tab === id ? "700" : "500",
                    }}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
function RoundButton({
  label,
  icon,
  palette: p,
  color,
  bare = false,
  disabled = false,
  onPress,
}: {
  label: string;
  icon: string;
  palette: Palette;
  color?: string;
  bare?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        bare ? {} : { backgroundColor: p.surface, borderRadius: radius.control + 2 },
        {
          width: 40,
          height: 40,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Icon name={icon} color={color ?? p.text} size={22} />
    </Pressable>
  );
}
