import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
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
  Icon,
  Input,
  light,
  money,
  signed,
  styles,
} from "./src/ui.tsx";
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
  return (
    <SafeAreaView
      edges={["top", "bottom"]}
      style={{
        flex: 1,
        backgroundColor: background,
        paddingTop: Platform.OS === "web" ? 8 : 0,
        paddingBottom: Platform.OS === "web" ? 12 : 0,
      }}
    >
      <StatusBar style={p === dark ? "light" : "dark"} />
      <View
        style={{ flex: 1, width: "100%", maxWidth: 760, alignSelf: "center" }}
      >
        {stock ? (
          <View style={[styles.pageHeader, { minHeight: 60 }]}>
            <RoundButton label="返回" icon="back" palette={p} disabled={s.busy}
              onPress={() => setStock(undefined)} />
            <View style={{ flex: 1, alignItems: "center", minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: p.text, fontSize: 17, fontWeight: "600" }}>
                {detailName}
              </Text>
              <Text style={{ color: p.secondary, fontSize: 11, marginTop: 3 }}>{stock} · USD</Text>
            </View>
            <View style={[capsule(p), styles.row, { gap: 0 }]}>
              <RoundButton label={s.watchlist.includes(stock) ? "移除自选" : "添加自选"}
                icon={s.watchlist.includes(stock) ? "star" : "star-outline"}
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
            <Text accessibilityRole="header" testID="page.title" style={[styles.pageTitle, { color: p.text }]}>
              {tabs.find(t => t[0] === tab)?.[1]}
            </Text>
            {tab === "watchlist" && <View style={[capsule(p), styles.row, { gap: 0 }]}>
              <Pressable accessibilityRole="button" accessibilityLabel={editing ? "完成" : "编辑"}
                disabled={s.busy} onPress={() => setEditing(!editing)}
                style={{ paddingHorizontal: 14, minHeight: 44, justifyContent: "center" }}>
                <Text style={{ color: p.accent, fontSize: 15, fontWeight: "600" }}>{editing ? "完成" : "编辑"}</Text>
              </Pressable>
              <RoundButton label="添加自选" icon="plus" palette={p} bare disabled={s.busy}
                onPress={() => setAdding(true)} />
            </View>}
          </View>
        )}
        {s.busy && <ActivityIndicator color={p.accent} size="small" />}
        {!!s.message && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭提示"
            onPress={() => s.setMessage("")}
            style={{
              backgroundColor: p.surface,
              padding: 12,
              borderRadius: 18,
              marginHorizontal: 16,
              marginBottom: 8,
            }}
          >
            <Text style={{ color: p.text, fontSize: 12 }}>{s.message}　×</Text>
          </Pressable>
        )}
        {s.status.unresolvedOperation && (
          <Text
            style={{
              color: p.up,
              fontSize: 12,
              paddingHorizontal: 16,
              paddingVertical: 8,
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
                <ScrollView
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  alwaysBounceVertical
                  refreshControl={<PageRefreshControl state={s} palette={p} refresh={async () => {
                    await s.refresh();
                    await lookup();
                  }} />}
                  contentContainerStyle={styles.pageContent}
                >
                  <View
                    style={{
                      backgroundColor: p.surface,
                      borderRadius: 26,
                      paddingHorizontal: 16,
                      paddingVertical: 8,
                    }}
                  >
                    {s.isDemo && (
                      <>
                        <DemoNotice palette={p} />
                        <View
                          style={{
                            height: 1,
                            backgroundColor: p.separator,
                            marginLeft: 40,
                          }}
                        />
                      </>
                    )}
                    <AccountSelector state={s} palette={p} />
                  </View>
                  <Text style={sectionCaption(p)}>证券</Text>
                  <View
                    style={{
                      backgroundColor: p.surface,
                      borderRadius: 26,
                      padding: 16,
                      gap: 16,
                    }}
                  >
                    <View style={styles.row}>
                      <Input
                        palette={p}
                        accessibilityLabel="交易股票代码"
                        placeholder="股票 / ETF 代码"
                        value={tradeSymbol}
                        editable={!s.busy && !replacement}
                        autoCapitalize="characters"
                        onChangeText={(value) =>
                          setTradeSymbol(value.toUpperCase().trim())
                        }
                        style={{
                          flex: 1,
                          backgroundColor: "transparent",
                          paddingHorizontal: 0,
                          fontWeight: "600",
                          fontSize: 18,
                        }}
                      />
                      <Button
                        label="查价"
                        palette={p}
                        disabled={s.busy}
                        onPress={() => void s.run(lookup)}
                      />
                    </View>
                    <View style={styles.spread}>
                      <Text
                        numberOfLines={1}
                        style={{ flex: 1, color: p.secondary, fontSize: 13 }}
                      >
                        {quote?.description ?? tradeSymbol}
                      </Text>
                      <Text
                        style={[styles.number, { color: p.text, fontSize: 18 }]}
                      >
                        ${money(quote?.lastPrice)}
                      </Text>
                    </View>
                    <View style={styles.row}>
                      {[
                        ["买价 Bid", quote?.bidPrice],
                        ["卖价 Ask", quote?.askPrice],
                      ].map(([label, value]) => (
                        <View key={String(label)} style={{ flex: 1, gap: 5 }}>
                          <Text style={{ color: p.secondary, fontSize: 12 }}>
                            {label}
                          </Text>
                          <Text
                            style={[
                              styles.number,
                              { color: p.text, fontSize: 17 },
                            ]}
                          >
                            ${money(value as number | undefined)}
                          </Text>
                        </View>
                      ))}
                    </View>
                    <View style={styles.spread}>
                      <Text style={{ color: p.secondary, fontSize: 13 }}>
                        涨跌幅
                      </Text>
                      <Text
                        style={{
                          color:
                            (quote?.netPercentChange ?? 0) >= 0 ? p.up : p.down,
                          fontSize: 17,
                          fontWeight: "600",
                        }}
                      >
                        {signed(quote?.netPercentChange, "%")}
                      </Text>
                    </View>
                    <Text style={{ color: p.secondary, fontSize: 12 }}>
                      {s.isDemo ? "演示报价" : "Schwab 报价"}
                    </Text>
                  </View>
                  <Text style={sectionCaption(p)}>订单指令</Text>
                  <TradePanel
                    key={`${s.isDemo}-${s.accountID}-${tradeSymbol}-${replacement?.id}`}
                    symbol={tradeSymbol}
                    quote={quote}
                    state={s}
                    palette={p}
                    initialSide={replacement?.side}
                    replacement={replacement}
                    onDone={() => setReplacement(undefined)}
                  />
                  {replacement && (
                    <Button
                      label="退出修改订单"
                      palette={p}
                      disabled={s.busy}
                      onPress={() => setReplacement(undefined)}
                    />
                  )}
                </ScrollView>
              </KeyboardAvoidingView>
            )}
            {tab === "orders" && (
              <ScrollView
                showsVerticalScrollIndicator={false}
                alwaysBounceVertical
                refreshControl={<PageRefreshControl state={s} palette={p} />}
                contentContainerStyle={styles.pageContent}
              >
                {s.isDemo && (
                  <View style={{ marginBottom: 12 }}>
                    <DemoNotice palette={p} card />
                  </View>
                )}
                <OrderList
                  state={s}
                  palette={p}
                  onReplace={(order) => {
                    setReplacement(order);
                    setTradeSymbol(order.symbol);
                    setTab("trade");
                  }}
                />
              </ScrollView>
            )}
            {tab === "settings" && <Settings state={s} palette={p} />}
            <View
              style={[
                capsule(p),
                {
                  position: "absolute",
                  left: 20,
                  right: 20,
                  bottom: 0,
                  height: 64,
                  padding: 4,
                  flexDirection: "row",
                  borderWidth: 1,
                  borderColor: p.surface,
                },
              ]}
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
                    borderRadius: 32,
                    backgroundColor:
                      tab === id
                        ? p === light
                          ? "#e9e9ed"
                          : "#333438"
                        : "transparent",
                  }}
                >
                  <Icon
                    name={icon}
                    color={tab === id ? p.accent : p.text}
                    size={27}
                  />
                  <Text
                    style={{
                      color: tab === id ? p.accent : p.text,
                      fontSize: 11,
                      fontWeight: tab === id ? "600" : "400",
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
function capsule(p: Palette) {
  return {
    backgroundColor: p === light ? "#FDFEFFED" : "#26272BEC",
    borderRadius: 36,
    shadowColor: "#000",
    shadowOpacity: 0.055,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  };
}
function sectionCaption(p: Palette) {
  return {
    color: p.secondary,
    fontSize: 16,
    fontWeight: "600" as const,
    marginTop: 24,
    marginBottom: 12,
    paddingHorizontal: 16,
  };
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
        bare ? {} : capsule(p),
        {
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Icon name={icon} color={color ?? p.text} size={25} />
    </Pressable>
  );
}
