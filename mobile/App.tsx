import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useTrading } from "./src/useTrading.ts";
import type { Order, Quote } from "./src/types.ts";
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
  Glass,
  tabBar,
} from "./src/ui.tsx";
import { TradePanel } from "./src/TradePanel.tsx";
import Settings from "./src/Settings.tsx";
import StockDetail from "./src/StockDetail.tsx";
import Watchlist from "./src/Watchlist.tsx";
import { AccountSelector } from "./src/Accounts.tsx";
import UnifiedAccounts from "./src/UnifiedAccounts.tsx";
import UnifiedOrders from "./src/UnifiedOrders.tsx";
import { DemoNotice } from "./src/DemoNotice.tsx";
import { PageRefreshControl } from "./src/PageRefreshControl.tsx";
import { validSymbol } from "./src/orderRules.ts";
import FormingCandlePreview from "./src/FormingCandlePreview.tsx";
import HistorySnapshotPreview from "./src/HistorySnapshotPreview.tsx";
import { createMexcClient } from "./src/device.ts";
import type { MexcApi } from "./src/MexcClient.ts";
import { MexcDemo } from "./src/mexc/mexcDemo.ts";
import { useMexc } from "./src/mexc/useMexc.ts";
import { ContractDetail } from "./src/mexc/MexcMarkets.tsx";
import MexcTrade, { type TradeSeed } from "./src/mexc/MexcTrade.tsx";
import { DemoBadge, Notice, RoundButton, Segmented } from "./src/mexc/parts.tsx";
import { readFavorites, writeFavorites } from "./src/mexc/favorites.ts";
import { readVenue, writeVenue } from "./src/mexc/venue.ts";
import { contractTitle, demoBadge, FAVORITE_COLOR, LOCK_BANNER, MAX_FAVORITES, toggleFavorite, venueDemoNotice, type Venue } from "./src/mexc/mexcView.ts";

type Tab = "accounts" | "watchlist" | "trade" | "orders" | "settings";
const tabs: [Tab, string, string][] = [
  ["accounts", "账户", "pie"],
  ["watchlist", "自选", "star"],
  ["trade", "交易", "trade"],
  ["orders", "订单", "orders"],
  ["settings", "设置", "settings"],
];
const NO_SEED: TradeSeed = { nonce: 0 };

/**
 * In-memory demo on the web and in development bundles such as Expo Go, so a normal dev session does not
 * reach the real account. Release builds have __DEV__ false and always get the real client.
 */
function createMexcApi(): MexcApi {
  // `?preview=no-mexc` shows the web preview as a phone with no MEXC connection saved.
  if (Platform.OS === "web" && new URLSearchParams(window.location.search).get("preview") === "no-mexc")
    return Object.assign(new MexcDemo(), { configuration: async () => null });
  if (Platform.OS === "web" || __DEV__) return new MexcDemo();
  return createMexcClient();
}

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
  return <SafeAreaProvider><TradingApp /></SafeAreaProvider>;
}

/**
 * One set of pages over both venues. Only what is shown is merged: each venue keeps its own client, review,
 * write lock and banner, and a lock on one does not touch the other.
 */
function TradingApp() {
  const s = useTrading(),
    systemScheme = useColorScheme();
  const [mexcApi] = useState(createMexcApi);
  const m = useMexc(mexcApi);
  const hasMexc = m.configured !== false;
  const busy = s.busy || m.sending;
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
    [stock, setStock] = useState<string>(),
    [contract, setContract] = useState<string>();
  const detailOpen = !!stock || !!contract;
  useEffect(() => {
    s.setAccountVisible(tab === "accounts" && !detailOpen);
    return () => s.setAccountVisible(false);
  }, [tab, detailOpen, s.setAccountVisible]);
  useEffect(() => {
    s.setOrdersVisible(!!stock || (tab === "orders" && !detailOpen));
    return () => s.setOrdersVisible(false);
  }, [tab, stock, detailOpen, s.setOrdersVisible]);
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState(false),
    [adding, setAdding] = useState(false);
  const [watchlistSearch, setWatchlistSearch] = useState("");
  const [watchlistCharts, setWatchlistCharts] = useState(false);
  const [replacement, setReplacement] = useState<Order>(),
    [tradeSymbol, setTradeSymbol] = useState("AAPL");
  const [lookedUp, setLookedUp] = useState<Quote>(),
    [detailName, setDetailName] = useState("");
  const [picked, setPicked] = useState<Venue>("schwab");
  useEffect(() => { void readVenue().then(setPicked); }, []);
  const tradeVenue: Venue = hasMexc ? picked : "schwab";
  const chooseVenue = (value: Venue) => {
    if (busy) return;
    Keyboard.dismiss();
    setReplacement(undefined);
    setPicked(value);
    void writeVenue(value);
  };
  const [favorites, setFavorites] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void readFavorites().then(saved => { if (active) setFavorites(saved); });
    return () => { active = false; };
  }, []);
  const flipFavorite = (symbol: string) => {
    if (!favorites.includes(symbol) && favorites.length >= MAX_FAVORITES) { m.setMessage(`收藏最多 ${MAX_FAVORITES} 个。`); return; }
    const next = toggleFavorite(favorites, symbol);
    setFavorites(next);
    void writeFavorites(next);
  };
  // The second tap must follow within 5 seconds, and only while the lock still exists.
  const [confirmAck, setConfirmAck] = useState(false);
  useEffect(() => { if (!m.unconfirmed) setConfirmAck(false); }, [m.unconfirmed]);
  useEffect(() => {
    if (!confirmAck) return;
    const timer = setTimeout(() => setConfirmAck(false), 5_000);
    return () => clearTimeout(timer);
  }, [confirmAck]);
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
    if (busy) return;
    Keyboard.dismiss();
    setStock(undefined);
    setContract(undefined);
    setReplacement(undefined);
    setTab(value);
  };
  const openStock = (symbol: string) => {
    if (busy) return;
    Keyboard.dismiss();
    setStock(symbol);
  };
  const openContract = (symbol: string) => {
    if (busy) return;
    Keyboard.dismiss();
    setContract(symbol);
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
  const contractInfo = contract ? m.contracts.find(c => c.symbol === contract) : undefined;
  // A MEXC outage or closure only matters where MEXC is on screen. A lock on either venue shows everywhere.
  const tradingMexc = !!contract || (!detailOpen && tab === "trade" && tradeVenue === "mexc");
  const showsMexc = hasMexc && (stock ? false : tab !== "trade" || tradingMexc);
  // The trade page shows one venue, so only that venue decides whether it is simulated.
  const pageBadge = tab === "trade"
    ? demoBadge(tradeVenue === "mexc" ? m.isDemo : s.isDemo, false, false)
    : demoBadge(s.isDemo, m.isDemo, hasMexc || m.unconfirmed);
  const message = (venue: string, text: string, close: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="关闭提示"
      onPress={close}
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
      <Text style={{ color: p.text, fontSize: 13, lineHeight: 18, flex: 1 }}>{venue}：{text}</Text>
      <Text style={{ color: p.secondary, fontSize: 15, lineHeight: 18 }}>×</Text>
    </Pressable>
  );
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
          <View style={[styles.pageHeader, { minHeight: 44, paddingVertical: 0 }]}>
            <RoundButton label="返回" icon="back" palette={p} disabled={busy}
              onPress={() => setStock(undefined)} />
            <View style={{ flex: 1, alignItems: "center", minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: p.text, fontSize: 16, fontWeight: "700" }}>
                {detailName}
              </Text>
              <View style={[styles.row, { gap: 6, marginTop: 2 }]}>
                <Text style={{ color: p.secondary, fontSize: 11 }}>Schwab · {stock} · USD</Text>
                {s.isDemo && <DemoBadge palette={p} />}
              </View>
            </View>
            <Glass palette={p} interactive style={[styles.row, { gap: 0, borderRadius: 22 }]}>
              <RoundButton label={s.watchlist.includes(stock) ? "移除自选" : "添加自选"}
                icon={s.watchlist.includes(stock) ? "star" : "star-outline"}
                color={s.watchlist.includes(stock) ? FAVORITE_COLOR : undefined}
                palette={p} bare disabled={busy} onPress={() => {
                  if (s.watchlist.includes(stock)) s.setWatchlist(s.watchlist.filter(v => v !== stock));
                  else if (s.watchlist.length < 50) s.setWatchlist([...s.watchlist, stock]);
                  else s.setMessage("自选最多 50 个。");
                }} />
              <RoundButton label="刷新" icon="refresh" palette={p} bare disabled={busy}
                onPress={() => void s.run(s.refresh)} />
            </Glass>
          </View>
        ) : contract ? (
          <View style={[styles.pageHeader, { minHeight: 44, paddingVertical: 0 }]}>
            <RoundButton label="返回" icon="back" palette={p} disabled={busy} onPress={() => setContract(undefined)} />
            <View style={{ flex: 1, alignItems: "center", minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: p.text, fontSize: 16, fontWeight: "700" }}>
                {contractInfo ? contractTitle(contractInfo) : contract}
              </Text>
              <View style={[styles.row, { gap: 6, marginTop: 2 }]}>
                <Text style={{ color: p.secondary, fontSize: 11 }}>MEXC · {contract} · USDT</Text>
                {m.isDemo && <DemoBadge palette={p} />}
              </View>
            </View>
            <RoundButton label={favorites.includes(contract) ? "移除自选" : "添加自选"}
              icon={favorites.includes(contract) ? "star" : "star-outline"}
              color={favorites.includes(contract) ? FAVORITE_COLOR : undefined}
              palette={p} disabled={busy} onPress={() => flipFavorite(contract)} />
          </View>
        ) : (
          <View testID="page.header" style={styles.pageHeader}>
            <View style={[styles.row, { gap: 10, flexShrink: 1 }]}>
              <Text accessibilityRole="header" testID="page.title" style={[styles.pageTitle, { color: p.text }]}>
                {tabs.find(t => t[0] === tab)?.[1]}
              </Text>
              {!!pageBadge && <DemoBadge palette={p} label={pageBadge} />}
              {busy && <ActivityIndicator color={p.accent} size="small" />}
            </View>
            {tab === "watchlist" && <Glass palette={p} interactive style={[styles.row, { gap: 0, borderRadius: 22, paddingLeft: 4 }]}>
              <Pressable accessibilityRole="button" accessibilityLabel={editing ? "完成" : "编辑"}
                disabled={busy} onPress={() => setEditing(!editing)}
                style={{ paddingHorizontal: 10, minHeight: 40, justifyContent: "center" }}>
                <Text style={{ color: p.accent, fontSize: 15, fontWeight: "600" }}>{editing ? "完成" : "编辑"}</Text>
              </Pressable>
              <RoundButton label="添加自选" icon="plus" palette={p} bare disabled={busy}
                onPress={() => setAdding(true)} />
            </Glass>}
            {tab === "orders" && (
              <Glass palette={p} interactive style={{ borderRadius: 22 }}>
                <Pressable accessibilityRole="button" accessibilityLabel="导出成交记录"
                  disabled={busy} onPress={() => setExporting(!exporting)}
                  style={{ paddingHorizontal: 14, minHeight: 40, justifyContent: "center" }}>
                  <Text style={{ color: p.accent, fontSize: 15, fontWeight: "600" }}>{exporting ? "收起" : "导出 CSV"}</Text>
                </Pressable>
              </Glass>
            )}
          </View>
        )}
        {!!s.message && message("Schwab", s.message, () => s.setMessage(""))}
        {!!m.message && message("MEXC", m.message, () => m.setMessage(""))}
        {s.status.unresolvedOperation && (
          <Notice palette={p} text="有一笔 Schwab 交易结果待核实：请在券商确认后到设置中的连接处理。"
            style={{ marginHorizontal: 12, marginBottom: 6 }} />
        )}
        {m.unconfirmed && (
          <View accessibilityRole="alert" style={{ marginHorizontal: 12, marginBottom: 6, padding: 10, gap: 8,
            borderRadius: radius.control, backgroundColor: p.up + "22", borderWidth: 1, borderColor: p.up }}>
            <Text style={{ color: p.up, fontSize: 14, fontWeight: "700", lineHeight: 20 }}>{LOCK_BANNER}</Text>
            <Button label={confirmAck ? "确认已在 MEXC 核实，解除锁定" : "我已核实"} palette={p} variant="tinted" color={p.up}
              onPress={() => {
                if (!confirmAck) { setConfirmAck(true); return; }
                setConfirmAck(false);
                void m.acknowledge();
              }} />
          </View>
        )}
        {tradingMexc && !!m.blockedText && !m.locked && m.blockedCode !== "keyCheckFailed" && (
          <Notice palette={p} text={m.blockedText} style={{ marginHorizontal: 12, marginBottom: 6 }} />
        )}
        {showsMexc && m.offline && (
          <View accessibilityRole="alert">
            <Notice palette={p} text="MEXC 连接中断，这里显示的是上次的数据。" style={{ marginHorizontal: 12, marginBottom: 6 }} />
          </View>
        )}
        {tradingMexc && m.writeInProgress && !m.unconfirmed && (
          <Text style={{ color: p.secondary, fontSize: 13, paddingHorizontal: 12, marginBottom: 6 }}>服务器正在处理一笔委托，暂时不能下单或撤单。</Text>
        )}
        {stock ? (
          <StockDetail
            key={`${s.isDemo}-${s.accountID}-${stock}`}
            symbol={stock}
            state={s}
            palette={p}
          />
        ) : contract ? (
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
            <ContractDetail m={m} palette={p} symbol={contract} />
          </KeyboardAvoidingView>
        ) : (
          <>
            <View style={{ flex: 1 }}>
              {tab === "accounts" && (
                <UnifiedAccounts
                  state={s}
                  m={m}
                  palette={p}
                  onStock={openStock}
                  onContract={openContract}
                  onTrade={(venue) => {
                    chooseVenue(venue);
                    go("trade");
                  }}
                  onSettings={() => go("settings")}
                />
              )}
              {tab === "watchlist" && (
                <Watchlist
                  state={s}
                  m={m}
                  palette={p}
                  onStock={openStock}
                  onContract={openContract}
                  favorites={favorites}
                  onToggleFavorite={flipFavorite}
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
                  {hasMexc && (
                    <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
                      <Segmented<Venue> palette={p} value={tradeVenue} onChange={chooseVenue}
                        options={[{ id: "schwab", label: "Schwab 股票" }, { id: "mexc", label: "MEXC 合约" }]} />
                    </View>
                  )}
                  {tradeVenue === "mexc" ? (
                    <MexcTrade m={m} palette={p} seed={NO_SEED} />
                  ) : (
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
                        {s.isDemo && <DemoNotice palette={p} card text={venueDemoNotice("schwab")} />}
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
                  )}
                </KeyboardAvoidingView>
              )}
              {tab === "orders" && (
                <UnifiedOrders
                  state={s}
                  m={m}
                  palette={p}
                  favorites={favorites}
                  exporting={exporting}
                  onCloseExport={() => setExporting(false)}
                  onStock={openStock}
                  onContract={openContract}
                  onReplace={(order) => {
                    if (busy) return;
                    setReplacement(order);
                    setTradeSymbol(order.symbol);
                    setPicked("schwab");
                    setTab("trade");
                  }}
                />
              )}
              {tab === "settings" && <Settings state={s} m={m} palette={p} />}
            </View>
            <Glass
              palette={p}
              interactive
              style={{
                position: "absolute",
                left: tabBar.inset,
                right: tabBar.inset,
                bottom: tabBar.bottom,
                height: tabBar.height,
                padding: 4,
                borderRadius: tabBar.height / 2,
                flexDirection: "row",
              }}
            >
              {tabs.map(([id, label, icon]) => (
                <Pressable
                  key={id}
                  accessibilityRole="tab"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: tab === id, disabled: busy }}
                  disabled={busy}
                  onPress={() => go(id)}
                  style={{
                    flex: 1,
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 2,
                    borderRadius: (tabBar.height - 8) / 2,
                    backgroundColor: tab === id ? p.accent + (p === light ? "1A" : "26") : "transparent",
                  }}
                >
                  <Icon
                    name={icon}
                    color={tab === id ? p.accent : p.text}
                    size={24}
                  />
                  <Text
                    style={{
                      color: tab === id ? p.accent : p.text,
                      fontSize: 10,
                      fontWeight: tab === id ? "700" : "500",
                    }}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </Glass>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
