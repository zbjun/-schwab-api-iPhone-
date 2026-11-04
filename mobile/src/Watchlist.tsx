import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { History, HistoryRange, Palette } from "./types.ts";
import type { TradingState } from "./useTrading.ts";
import { Button, Chip, elevated, Icon, Input, money, signed, styles } from "./ui.tsx";
import type { MexcContract, MexcTicker } from "./mexcRules.ts";
import type { MexcState } from "./mexc/useMexc.ts";
import { useTickers } from "./mexc/useMexc.ts";
import { contractTitle, demoNotice, FAVORITE_COLOR, priceText, signedPercent } from "./mexc/mexcView.ts";
import {
  allContractItems,
  contractChange,
  contractsAvailable,
  createLimiter,
  filterItems,
  heldContracts,
  itemCounts,
  itemKey,
  searchContracts,
  trendOf,
  watchlistItems,
  type WatchFilter,
} from "./watchlistItems.ts";
import { DemoNotice } from "./DemoNotice.tsx";
import { PageRefreshControl } from "./PageRefreshControl.tsx";
import { validSymbol } from "./orderRules.ts";
import MarketChart from "./MarketChart.tsx";
import {
  overnightReference,
  overnightReferenceFresh,
  OVERNIGHT_CHECKED_ON,
  OVERNIGHT_HOLDINGS_AS_OF,
} from "./overnightEligibility.ts";

const PAGE = 30;
const STAR_WIDTH = 26;

// The gateway's IP also places orders, so a chart for every contract must not arrive all at once. Read once per view.
const contractCharts = createLimiter(4);

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
  m,
  favorites,
  onToggleFavorite,
  onContract,
}: {
  m: MexcState;
  favorites: string[];
  onToggleFavorite: (symbol: string) => void;
  onContract: (symbol: string) => void;
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
  const [filter, setFilter] = useState<WatchFilter>("all");
  const [shown, setShown] = useState(PAGE);
  const blockedUntil = useRef(0);
  const hasContracts = contractsAvailable(m.configured);
  const demo = demoNotice(s.isDemo, m.isDemo, hasContracts || m.unconfirmed);
  const items = useMemo(
    () => watchlistItems(s.watchlist, favorites, m.contracts, m.configured),
    [s.watchlist, favorites, m.contracts, m.configured],
  );
  const counts = itemCounts(items);
  const activeFilter: WatchFilter = hasContracts ? filter : "all";
  const everything = useMemo(() => allContractItems(m.contracts, m.configured), [m.contracts, m.configured]);
  const listed = activeFilter === "allContracts" ? [] : filterItems(items, activeFilter);
  const allVisible = everything.slice(0, shown);
  const found = useMemo(() => searchContracts(m.contracts, search, m.configured), [m.contracts, search, m.configured]);
  const held = useMemo(() => heldContracts(m.account?.positions), [m.account]);
  // Quotes are requested only for the contract rows on screen.
  const symbols = useMemo(() => {
    const list = [
      ...found.map((c) => c.symbol),
      ...(activeFilter === "allContracts"
        ? allVisible.map((c) => c.symbol)
        : listed.flatMap((item) => (item.kind === "contract" ? [item.contract.symbol] : []))),
    ];
    return [...new Set(list)];
  }, [found, activeFilter, allVisible, listed]);
  const tickers = useTickers(m, symbols);
  useEffect(() => setShown(PAGE), [activeFilter]);
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
  function contractRow(c: MexcContract, star: boolean) {
    const t: MexcTicker | undefined = tickers[c.symbol];
    const change = contractChange(t);
    const favorite = favorites.includes(c.symbol);
    return (
      <Row
        key={`${star ? "star" : "list"}-${itemKey({ kind: "contract", contract: c })}`}
        palette={p}
        id={c.symbol}
        title={contractTitle(c)}
        code={c.symbol}
        badge="合约"
        held={held.has(c.symbol)}
        trend={trendOf(t?.riseFallRate)}
        last={priceText(t?.lastPrice, c.priceUnit)}
        percent={signedPercent(t?.riseFallRate)}
        change={change === undefined ? "—" : `${change > 0 ? "+" : change < 0 ? "-" : ""}${priceText(Math.abs(change), c.priceUnit)}`}
        charts={charts}
        range="intraday"
        load={(wanted) => contractCharts(() => (wanted() ? m.api.chart(c.symbol, "intraday") : Promise.reject(new Error("no longer on screen"))))}
        reload={0}
        editing={editing && !star}
        onRemove={() => onToggleFavorite(c.symbol)}
        star={star ? { on: favorite, onPress: () => onToggleFavorite(c.symbol) } : undefined}
        onPress={() => {
          if (Date.now() > blockedUntil.current) onContract(c.symbol);
        }}
      />
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        alwaysBounceVertical
        refreshControl={<PageRefreshControl state={s} palette={p} />}
        {...pan.panHandlers}
        contentContainerStyle={styles.pageContent}
      >
        <View
          style={{ paddingBottom: 12 }}
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
              placeholder={hasContracts ? "股票或合约，例如 QQQ" : "输入股票 / ETF 代码"}
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
          {hasContracts && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 10 }}>
              {(
                [
                  ["all", `全部 ${counts.all}`],
                  ["stock", `股票 ${counts.stock}`],
                  ["contract", `合约 ${counts.contract}`],
                  ["allContracts", "所有合约"],
                ] as [WatchFilter, string][]
              ).map(([id, label]) => (
                <Chip key={id} label={label} palette={p} active={activeFilter === id} onPress={() => setFilter(id)} />
              ))}
            </View>
          )}
          <View style={[styles.spread, { paddingTop: 10, paddingBottom: 8 }]}>
            <View style={[styles.row, { gap: 8 }]}>
              <Text style={{ color: p.text, fontSize: 15, fontWeight: "700" }}>
                自选股
              </Text>
              <Text style={{ color: p.secondary, fontSize: 14 }}>
                {counts.all}
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
          {demo ? (
            <DemoNotice palette={p} text={demo} />
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
        {found.length > 0 && (
          <View style={{ paddingBottom: 12 }}>
            <Text style={{ color: p.text, fontSize: 15, fontWeight: "700", paddingBottom: 8 }}>匹配的合约</Text>
            <View style={{ backgroundColor: p.surface, borderRadius: 10, paddingHorizontal: 12 }}>
              <ListHeader palette={p} charts={charts} inset={STAR_WIDTH} />
              {found.map((c) => contractRow(c, true))}
            </View>
          </View>
        )}
        {activeFilter === "allContracts" && !m.contracts.length ? (
          <Text style={{ color: p.secondary, fontSize: 13, padding: 16 }}>
            {m.offline ? "还没有连上 MEXC 网关，无法读取合约。" : "正在读取合约…"}
          </Text>
        ) : activeFilter === "contract" && !counts.contract ? (
          <Text style={{ color: p.secondary, fontSize: 13, padding: 16 }}>
            还没有收藏的合约。在‘所有合约’里点星标添加。
          </Text>
        ) : (
          <View style={{ backgroundColor: p.surface, borderRadius: 10, paddingHorizontal: 12 }}>
            <ListHeader palette={p} charts={charts} inset={activeFilter === "allContracts" ? STAR_WIDTH : 0} />
            {activeFilter === "allContracts"
              ? allVisible.map((c) => contractRow(c, true))
              : listed.map((item) =>
                  item.kind === "stock" ? (
                    <Row
                      key={`${s.isDemo}-${itemKey(item)}`}
                      palette={p}
                      id={item.symbol}
                      title={s.quotes[item.symbol]?.description ?? item.symbol}
                      code={item.symbol}
                      badge="US"
                      held={stockHeld(s, item.symbol)}
                      overnight={!!overnightReference(item.symbol)}
                      trend={trendOf(s.quotes[item.symbol]?.netChange)}
                      last={money(s.quotes[item.symbol]?.lastPrice)}
                      percent={signed(s.quotes[item.symbol]?.netPercentChange, "%")}
                      change={signed(s.quotes[item.symbol]?.netChange)}
                      charts={charts}
                      range="intraday"
                      load={s.status.authenticated ? () => s.broker.history(item.symbol, "intraday") : undefined}
                      reload={s.revision}
                      editing={editing}
                      onRemove={() => s.setWatchlist(s.watchlist.filter((v) => v !== item.symbol))}
                      onPress={() => {
                        if (Date.now() > blockedUntil.current && !s.busy) onStock(item.symbol);
                      }}
                    />
                  ) : (
                    contractRow(item.contract, false)
                  ),
                )}
          </View>
        )}
        {activeFilter === "allContracts" && everything.length > shown && (
          <View style={{ paddingTop: 10 }}>
            <Button
              label={`显示更多（还有 ${everything.length - shown} 个）`}
              palette={p}
              variant="tinted"
              onPress={() => setShown(shown + PAGE)}
            />
          </View>
        )}
        <View style={{ padding: 16, gap: 5 }}>
          <Text style={{ color: p.secondary, fontSize: 11 }}>
            {charts ? "右滑返回行情列表 · 分时走势" : "左滑查看多股同列走势"}
          </Text>
          <Text style={{ color: p.secondary, fontSize: 11 }}>
            {!demo
              ? "报价以券商返回时间为准，点击右上角刷新"
              : s.isDemo && (m.isDemo || m.configured === false)
                ? "演示数据 · 不连接真实账户"
                : s.isDemo
                  ? "股票是演示数据，合约是真实行情"
                  : "合约是演示数据，股票是真实行情"}
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
          <View style={{ backgroundColor: p.surface, padding: 18, borderRadius: 10, gap: 14 }}>
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
              borderRadius: 10,
              padding: 18,
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
            {hasContracts && (
              <Text style={{ color: p.secondary, fontSize: 12, marginTop: -8 }}>
                合约在搜索结果或‘所有合约’里点星标添加
              </Text>
            )}
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
function stockHeld(s: TradingState, symbol: string) {
  return (
    s.account?.positions.some(
      (position) =>
        position.symbol.trim().toUpperCase() === symbol.trim().toUpperCase() &&
        Number.isFinite(position.quantity) &&
        position.quantity !== 0,
    ) ?? false
  );
}

function ListHeader({ palette: p, charts, inset }: { palette: Palette; charts: boolean; inset: number }) {
  const cell = (label: string, width: string, align: "right" | "center" = "right") => (
    <Text key={label} style={{ width: width as `${number}%`, textAlign: align, color: p.secondary, fontSize: 11 }}>
      {label}
    </Text>
  );
  return (
    <View
      style={{
        flexDirection: "row",
        height: 34,
        alignItems: "center",
        paddingLeft: inset,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: p.separator,
      }}
    >
      <Text style={{ width: "30%", color: p.secondary, fontSize: 11 }}>名称 / 代码</Text>
      {charts ? (
        <>
          {cell("多股同列", "43%", "center")}
          {cell("涨幅 / 最新", "27%")}
        </>
      ) : (
        <>
          {cell("最新", "25%")}
          {cell("涨幅", "24%")}
          {cell("涨跌", "21%")}
        </>
      )}
    </View>
  );
}

/** One row for a stock or a contract: same columns, sizes and heights. */
function Row({
  palette: p,
  id,
  title,
  code,
  badge,
  held,
  overnight,
  trend,
  last,
  percent,
  change,
  charts,
  range,
  load,
  reload,
  editing,
  onRemove,
  star,
  onPress,
}: {
  palette: Palette;
  id: string;
  title: string;
  code: string;
  badge: string;
  held: boolean;
  overnight?: boolean;
  trend: "up" | "down" | "flat";
  last: string;
  percent: string;
  change: string;
  charts: boolean;
  range: HistoryRange;
  /** `wanted` says whether the row is still on screen, for a read that had to wait its turn. */
  load?: (wanted: () => boolean) => Promise<History>;
  reload: number;
  editing: boolean;
  onRemove: () => void;
  star?: { on: boolean; onPress: () => void };
  onPress: () => void;
}) {
  const [history, setHistory] = useState<History>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const canLoad = !!load;
  useEffect(() => {
    let active = true;
    const fetch = loadRef.current;
    if (charts && fetch)
      void fetch(() => active)
        .then((value) => {
          if (active) setHistory(value);
        })
        .catch(() => {
          if (active) setHistory(undefined);
        });
    return () => {
      active = false;
    };
  }, [charts, canLoad, id, reload]);
  const color = trend === "flat" ? p.secondary : trend === "up" ? p.up : p.down;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: p.separator,
        minHeight: 54,
      }}
    >
      {editing && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`移除 ${code}`}
          onPress={onRemove}
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
      {star && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${star.on ? "取消收藏" : "收藏"} ${code}`}
          accessibilityState={{ selected: star.on }}
          onPress={star.onPress}
          style={{ width: STAR_WIDTH, alignSelf: "stretch", justifyContent: "center" }}
        >
          <Icon name={star.on ? "star" : "star-outline"} color={star.on ? FAVORITE_COLOR : p.secondary} size={17} />
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`行情 ${code}`}
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
            {title}
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
              {badge}
            </Text>
            <Text style={{ color: held ? p.accent : p.secondary, fontSize: 11, flexShrink: 1 }}>{code}</Text>
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
                <MarketChart history={history} range={range} palette={p} compact height={45} />
              ) : (
                <Text style={{ color: p.secondary, fontSize: 11 }}>暂无走势</Text>
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
                {percent}
              </Text>
              <Text style={{ color: p.secondary, fontSize: 11 }}>{last}</Text>
            </View>
          </>
        ) : (
          <>
            {[
              [last, "25%"],
              [percent, "24%"],
              [change, "21%"],
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
                    fontSize: 16,
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
