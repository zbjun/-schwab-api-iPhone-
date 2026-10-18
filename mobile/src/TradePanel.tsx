import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type RefreshControlProps,
} from "react-native";
import type {
  Draft,
  Order,
  OrderKind,
  OrderSession,
  Palette,
  Prepared,
  Quote,
  Side,
} from "./types.ts";
import type { TradingState } from "./useTrading.ts";
import {
  isStockHolding,
  FINAL_STATUSES,
  maximumBuy,
  maximumSell,
  parsePrice,
  sharesForBudget,
  validSymbol,
  orderSessionLabels,
} from "./orderRules.ts";
import { Button, Chip, elevated, money, radius, Stepper, styles } from "./ui.tsx";
import { submitQuickOrder } from "./quickTrading.ts";
import { completeQuickOrder, type QuickOrderFeedback } from "./quickOrderFeedback.ts";
import { executeLocalMarket, quoteMidpoint, type LocalMarketSettings } from "./localMarket.ts";
import { readLocalMarketSettings } from "./localMarketPreferences.ts";

const kindLabels: Record<OrderKind, string> = {
  MARKET: "市价",
  LIMIT: "限价",
  STOP: "止损",
  STOP_LIMIT: "止损限价",
};
type TicketKind = OrderKind | "LOCAL_MARKET";
const ticketLabels = { ...kindLabels, LOCAL_MARKET: "本地市价" };
export function TradePanel({
  state: s,
  symbol,
  quote,
  palette: p,
  initialSide = "BUY",
  replacement,
  onDone,
  inline = false,
  onClose,
  header,
  refreshControl,
  onMeasure,
}: {
  state: TradingState;
  symbol: string;
  quote?: Quote;
  palette: Palette;
  initialSide?: Side | "CANCEL";
  replacement?: Order;
  onDone?: () => void;
  inline?: boolean;
  onClose?: () => void;
  /** Page mode: content scrolled above the ticket (account, symbol lookup). */
  header?: React.ReactNode;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  /** Inline mode: preferred height so the chart above can give back unused space. */
  onMeasure?: (height: number) => void;
}) {
  const [side, setSide] = useState<Side | "CANCEL">(initialSide);
  const bodyHeight = useRef(0),
    footerHeight = useRef(0);
  const [kind, setKind] = useState<TicketKind>(replacement?.kind ?? "LIMIT");
  const { boundaryPercent, startSpreadPercent, durationSeconds } = s.localMarketPreferences;
  const localSettingsReady = s.localMarketPreferencesReady;
  const [localReview, setLocalReview] = useState<LocalMarketSettings>();
  const [localRunning, setLocalRunning] = useState(false);
  const [localMessage, setLocalMessage] = useState("");
  const localStop = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener("change", (value) => {
      if (value !== "active") localStop.current = true;
    });
    return () => { mounted.current = false; localStop.current = true; listener.remove(); };
  }, []);
  const [price, setPrice] = useState(
    replacement?.limitPrice?.toString() ?? quote?.lastPrice?.toFixed(2) ?? "",
  );
  const [stop, setStop] = useState(replacement?.stopPrice?.toString() ?? "");
  const [quantity, setQuantity] = useState(
    replacement?.quantity?.toString() ?? "",
  );
  const [budget, setBudget] = useState("");
  const [byAmount, setByAmount] = useState(false);
  const [gtc, setGTC] = useState(replacement?.duration === "GOOD_TILL_CANCEL");
  const [session, setSession] = useState<OrderSession>("NORMAL");
  const gtcAllowed = kind !== "MARKET" && kind !== "LOCAL_MARKET" && session !== "AM" && session !== "PM";
  const [prepared, setPrepared] = useState<Prepared>();
  const [quickFeedback, setQuickFeedback] = useState<QuickOrderFeedback>();
  const context = useRef(0);
  useLayoutEffect(() => {
    setPrepared(undefined);
    setLocalReview(undefined);
    ++context.current;
  }, [
    side,
    kind,
    s.localMarketPreferences,
    price,
    stop,
    quantity,
    budget,
    byAmount,
    gtc,
    session,
    symbol,
    s.accountID,
    s.broker,
    s.status.authenticated,
    s.status.unresolvedOperation,
    s.isDemo,
    s.quickMode,
    replacement?.id,
  ]);
  useLayoutEffect(
    () => () => {
      ++context.current;
    },
    [],
  );
  useEffect(() => {
    if (!["LIMIT", "STOP_LIMIT"].includes(kind)) setByAmount(false);
  }, [kind]);
  useEffect(() => {
    if (prepared) {
      const timer = setTimeout(
        () => setPrepared(undefined),
        Math.max(0, 60000 - (Date.now() - prepared.preparedAt)),
      );
      return () => clearTimeout(timer);
    }
  }, [prepared]);
  const midpoint = quote?.symbol === symbol ? quoteMidpoint(quote) : undefined;
  const reference =
    kind === "LIMIT" || kind === "STOP_LIMIT"
      ? price
      : kind === "STOP"
        ? stop
        : kind === "LOCAL_MARKET" && side === "BUY"
          ? (midpoint === undefined ? undefined : midpoint * (1 + (Number(boundaryPercent) || 0) / 100))
          : (quote?.askPrice ?? quote?.lastPrice);
  const max =
    side === "BUY"
      ? maximumBuy(s.account, reference)
      : maximumSell(
          s.account,
          symbol,
          s.orders,
          s.ordersLoaded,
          replacement?.id,
          quote,
        );
  const shares =
    byAmount && side === "BUY"
      ? sharesForBudget(budget, reference)
      : Number(quantity);
  const permitted =
    s.status.authenticated &&
    Boolean(s.accountID) &&
    !s.status.unresolvedOperation;
  const quickOrder = s.quickMode && !replacement;
  const kindOptions = (session === "NORMAL" ? Object.keys(kindLabels) : ["LIMIT"])
    .concat(replacement ? [] : ["LOCAL_MARKET"])
    .map(value => ({ value, label: `${ticketLabels[value as TicketKind]}单` }));
  async function startLocal(settings: LocalMarketSettings) {
    const version = context.current;
    localStop.current = AppState.currentState === "background" || AppState.currentState === "inactive";
    setLocalReview(undefined);
    setLocalRunning(true);
    setLocalMessage("正在读取启动报价…");
    try {
      const result = await executeLocalMarket({
        broker: s.broker, accountID: s.accountID, symbol, side: side as Side,
        quantity: Number(quantity), settings, session, isDemo: s.isDemo,
        isCurrent: () => mounted.current && permitted && context.current === version,
        shouldStop: () => localStop.current,
        onProgress: message => { if (mounted.current) setLocalMessage(message); },
      });
      if (mounted.current) { setLocalMessage(result.message); setQuantity(""); }
      s.setMessage(result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "本地市价执行中断，请核对订单状态。";
      if (mounted.current) setLocalMessage(message);
      s.setMessage(message);
    } finally {
      if (mounted.current) setLocalRunning(false);
      s.syncAfterTrade();
    }
  }
  async function review() {
    if (kind === "LOCAL_MARKET") {
      let settings: LocalMarketSettings;
      try {
        if (!localSettingsReady) throw new Error("正在恢复本地市价参数，请稍后重试。");
        settings = readLocalMarketSettings(s.localMarketPreferences);
        if (!Number.isSafeInteger(Number(quantity)) || Number(quantity) <= 0)
          throw new Error("请输入大于 0 的整股数量。");
      } catch (error) {
        setLocalMessage(error instanceof Error ? error.message : "请检查本地市价参数。");
        throw error;
      }
      setLocalMessage("");
      if (quickOrder) await startLocal(settings);
      else setLocalReview(Object.freeze({ ...settings }));
      return;
    }
    const version = context.current;
    const draft: Draft = {
      symbol,
      side: side as Side,
      kind,
      quantity: shares ?? 0,
      duration: gtcAllowed && gtc ? "GOOD_TILL_CANCEL" : "DAY",
      session,
      ...(["LIMIT", "STOP_LIMIT"].includes(kind) ? { limitPrice: price } : {}),
      ...(["STOP", "STOP_LIMIT"].includes(kind) ? { stopPrice: stop } : {}),
    };
    if (quickOrder) {
      await completeQuickOrder({
        submit: () => submitQuickOrder({
          broker: s.broker,
          accountID: s.accountID,
          draft,
          isDemo: s.isDemo,
          isCurrent: () => permitted && context.current === version,
        }),
        refresh: async () => { s.syncAfterTrade(); },
        onAccepted: () => {
          setQuantity("");
          setBudget("");
        },
        onFeedback: (value) => {
          setQuickFeedback(value);
          if (value.phase !== "pending") s.setMessage(value.message);
        },
      });
      onDone?.();
      return;
    }
    const value = await s.broker.prepare(s.accountID, draft, replacement?.id);
    if (context.current === version) setPrepared(value);
  }
  const tradeColor = side === "SELL" ? p.down : p.up;
  const buyMax = maximumBuy(s.account, reference);
  const matchedPositions = s.account?.positions.filter(
    (position) => position.symbol === symbol,
  );
  const heldShares = matchedPositions?.reduce(
    (total, position) => total + position.quantity,
    0,
  );
  const unsupportedHolding = matchedPositions?.find(
    (position) => !isStockHolding(position, quote),
  );
  const sellMax = maximumSell(
    s.account,
    symbol,
    s.orders,
    s.ordersLoaded,
    replacement?.id,
    quote,
  );
  const amountAllowed =
    side === "BUY" && ["LIMIT", "STOP_LIMIT"].includes(kind);
  const fillMaximum = (fraction = 1) => {
    setByAmount(false);
    setQuantity(String(Math.floor((max ?? 0) * fraction)));
  };
  const quoted = quote?.symbol === symbol ? quote : undefined;
  const limitLike = kind === "LIMIT" || kind === "STOP_LIMIT";
  const amountMode = byAmount && side === "BUY";
  const referencePrice =
    typeof reference === "string" ? parsePrice(reference) : reference;
  const estimate =
    shares !== undefined && Number.isFinite(shares) && shares > 0 && referencePrice !== undefined
      ? shares * referencePrice
      : undefined;
  const stepPrice = (text: string, set: (value: string) => void, direction: 1 | -1) => {
    const current = parsePrice(text);
    if (current === undefined) {
      const start = quoted?.lastPrice ?? (side === "SELL" ? quoted?.bidPrice : quoted?.askPrice);
      if (start !== undefined && Number.isFinite(start) && start > 0)
        set(start.toFixed(start < 1 ? 4 : 2));
      return;
    }
    // Whole-cent ticks at $1 and above, 0.0001 below; snap to the tick before stepping.
    const units = Math.round(current * 10_000),
      tick = units < 10_000 ? 1 : 100;
    const next = direction > 0
      ? Math.floor(units / tick) * tick + tick
      : Math.ceil(units / tick) * tick - tick;
    if (next > 0) set((next / 10_000).toFixed(next < 10_000 ? 4 : 2));
  };
  const stepQuantity = (direction: 1 | -1) => {
    if (amountMode) {
      const current = Number(budget),
        base = Number.isFinite(current) && current > 0 ? current : 0;
      const next = direction > 0
        ? Math.floor(base / 100) * 100 + 100
        : Math.ceil(base / 100) * 100 - 100;
      setBudget(next > 0 ? String(next) : "");
      return;
    }
    const current = Number(quantity),
      next = (Number.isSafeInteger(current) && current > 0 ? current : 0) + direction;
    setQuantity(next > 0 ? String(next) : "");
  };
  const chooseSession = (value: string) => {
    const next = value as OrderSession;
    setSession(next);
    if (next !== "NORMAL" && kind !== "LOCAL_MARKET") setKind("LIMIT");
    if (next === "AM" || next === "PM") setGTC(false);
  };
  const sideLabel = side === "BUY" ? "买入" : "卖出";
  const sharesLabel =
    shares !== undefined && Number.isSafeInteger(shares) && shares > 0 ? ` ${shares} 股` : "";
  const note = (text: string, color = p.secondary) => (
    <Text style={{ color, fontSize: 11, lineHeight: 16 }}>{text}</Text>
  );
  const sideTabs = (
    <View
      style={{
        flexDirection: "row",
        borderRadius: radius.control,
        backgroundColor: elevated(p),
        padding: 2,
      }}
    >
      {([
        ["BUY", "买入", p.up],
        ["SELL", "卖出", p.down],
        ["CANCEL", "撤单", p.accent],
      ] as const).map(([value, label, color]) => {
        const selected = side === value,
          disabled = s.busy || Boolean(replacement);
        return (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => {
              setSide(value);
              if (!s.status.unresolvedOperation) s.setMessage("");
            }}
            style={{
              flex: 1,
              minHeight: 34,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.control - 1,
              backgroundColor: selected ? color : "transparent",
              opacity: disabled && !selected ? 0.5 : 1,
            }}
          >
            <Text
              style={{
                color: selected ? "#fff" : p.text,
                fontSize: 14,
                fontWeight: selected ? "700" : "500",
              }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
  const quoteTiles = (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {([
          { label: "买一", value: quoted?.bidPrice, color: p.up },
          { label: "卖一", value: quoted?.askPrice, color: p.down },
          {
            label: "最新",
            value: quoted?.lastPrice,
            color:
              (quoted?.netChange ?? 0) > 0 ? p.up : (quoted?.netChange ?? 0) < 0 ? p.down : p.text,
          },
        ]).map(({ label, value, color }) => {
          const valid = value !== undefined && Number.isFinite(value) && value > 0;
          const quotedPrice = valid ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : "—";
          const canFill = valid && limitLike && !s.busy;
          return (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={`${label} ${quotedPrice}${canFill ? "，填入限价" : ""}`}
              accessibilityState={{ disabled: !canFill }}
              disabled={!canFill}
              onPress={() => setPrice(quotedPrice)}
              style={({ pressed }) => ({
                flex: 1,
                gap: 1,
                paddingVertical: 6,
                paddingHorizontal: 8,
                borderRadius: radius.control,
                backgroundColor: elevated(p),
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ color: p.secondary, fontSize: 11 }}>{label}</Text>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                style={{
                  color: valid ? color : p.secondary,
                  fontSize: 16,
                  fontWeight: "700",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {quotedPrice}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {note(
        `${s.isDemo ? "模拟报价" : "报价"} · USD${quoted?.quoteTime ? ` · ${new Date(quoted.quoteTime).toLocaleTimeString()}` : ""}${limitLike ? " · 点报价填入限价" : ""}`,
      )}
    </View>
  );
  const form = (
    <>
      {quoteTiles}
      <Options
        palette={p}
        disabled={s.busy}
        items={[
          {
            key: "kind",
            label: `${ticketLabels[kind]}单`,
            value: kind,
            options: kindOptions,
            onChange: (value) => setKind(value as TicketKind),
          },
          {
            key: "session",
            label: orderSessionLabels[session],
            value: session,
            options: Object.entries(orderSessionLabels).map(([value, label]) => ({ value, label })),
            onChange: chooseSession,
            disabled: Boolean(replacement),
          },
          {
            key: "duration",
            label: gtc && gtcAllowed ? "撤销前有效" : "当日有效",
            value: gtc ? "GTC" : "DAY",
            options: [
              { value: "DAY", label: "当日有效" },
              { value: "GTC", label: "撤销前有效" },
            ],
            onChange: (value) => setGTC(value === "GTC"),
            disabled: !gtcAllowed,
          },
        ]}
      />
      {session !== "NORMAL" && note("延长时段仅限价单，不含夜盘；实际可交易时段以券商为准。")}
      {kind === "MARKET" || kind === "LOCAL_MARKET" ? (
        <View style={styles.row}>
          <Text style={{ color: p.secondary, fontSize: 13, width: 50 }}>
            {kind === "LOCAL_MARKET" ? "中间价" : "市价"}
          </Text>
          <View
            style={{
              flex: 1,
              height: 44,
              borderRadius: radius.control,
              backgroundColor: elevated(p),
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: p.secondary, fontSize: 16, fontVariant: ["tabular-nums"] }}>
              ≈ ${money(kind === "LOCAL_MARKET" ? midpoint : quoted?.lastPrice, kind === "LOCAL_MARKET" ? 4 : 2)}
            </Text>
          </View>
        </View>
      ) : (
        <>
          {(kind === "STOP" || kind === "STOP_LIMIT") && (
            <Stepper
              palette={p}
              label="触发价"
              placeholder="触发价格"
              keyboardType="decimal-pad"
              value={stop}
              onChangeText={setStop}
              disabled={s.busy}
              onStep={(direction) => stepPrice(stop, setStop, direction)}
            />
          )}
          {limitLike && (
            <Stepper
              palette={p}
              label="限价"
              placeholder="限价"
              keyboardType="decimal-pad"
              value={price}
              onChangeText={setPrice}
              disabled={s.busy}
              onStep={(direction) => stepPrice(price, setPrice, direction)}
            />
          )}
        </>
      )}
      <Stepper
        palette={p}
        label={amountMode ? "金额" : "数量"}
        accessibilityLabel={amountMode ? "买入金额" : "股数"}
        placeholder={amountMode ? "买入金额 USD" : "整股数量"}
        keyboardType={amountMode ? "decimal-pad" : "number-pad"}
        value={amountMode ? budget : quantity}
        onChangeText={amountMode ? setBudget : setQuantity}
        disabled={s.busy}
        onStep={stepQuantity}
      />
      <View style={{ flexDirection: "row", gap: 6 }}>
        {[0.25, 1 / 3, 0.5, 1].map((fraction, i) => (
          <Chip
            key={i}
            label={["1/4", "1/3", "1/2", side === "SELL" ? "全部" : "全仓"][i]}
            palette={p}
            style={{ flex: 1 }}
            disabled={max === undefined || s.busy}
            onPress={() => fillMaximum(fraction)}
          />
        ))}
        {amountAllowed && (
          <Chip
            label="按金额"
            accessibilityLabel={byAmount ? "按股数买入" : "按金额买入"}
            palette={p}
            active={byAmount}
            color={tradeColor}
            style={{ flex: 1.3 }}
            disabled={s.busy}
            onPress={() => setByAmount(!byAmount)}
          />
        )}
      </View>
      <View style={styles.spread}>
        <Text style={{ color: p.secondary, fontSize: 12, flexShrink: 1 }}>
          {side === "SELL"
            ? `持有 ${heldShares ?? "—"} 股 · 可卖 ${sellMax === undefined ? "待核对" : `${sellMax} 股`}`
            : `可买 ${buyMax ?? "—"} 股 · 可卖 ${sellMax ?? "—"} 股`}
        </Text>
        <Text style={{ color: p.text, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          预估 {estimate === undefined ? "—" : `$${money(estimate)}`}
        </Text>
      </View>
      {amountMode && note(`按限价折算 ${shares ?? "—"} 股`)}
      {side === "SELL" && sellMax === undefined && (
        <View style={[styles.spread, { alignItems: "flex-start" }]}>
          <Text style={{ color: p.secondary, fontSize: 12, flex: 1 }}>
            {unsupportedHolding
              ? `已读取持仓，但类型 ${unsupportedHolding.assetType.slice(0, 40)} 尚不支持核对可卖数量。`
              : s.ordersError ||
                (s.ordersLoaded
                  ? "存在无法核对的委托，可卖数量暂不可用。"
                  : "正在等待订单核对，持股数量不代表当前可卖数量。")}
          </Text>
          <Button
            label="刷新核对"
            palette={p}
            disabled={s.busy}
            onPress={() => void s.run(s.refresh)}
          />
        </View>
      )}
      {side === "BUY" && buyMax === 0 &&
        note(`购买力 $${money(s.account?.buyingPower)}，不足买入 1 股。`)}
      {kind === "LOCAL_MARKET" && (
        <View style={{ gap: 4 }}>
          <Text testID="trade.local.settings-summary" style={{ color: p.text, fontSize: 12 }}>
            价格优先 · 起挂 {startSpreadPercent}% 价差 → 中间价 · 最长 {durationSeconds.trim() ? `${durationSeconds} 秒` : "未设置"}
          </Text>
          {note(`边界 ${boundaryPercent.trim() ? `${boundaryPercent}%` : "未设置"}，参数在设置 → 本地市价单调整。突变、价差超限或超时停止；请保持前台，断网或退出后核对未完成委托。`)}
        </View>
      )}
      {note(
        inline
          ? "数量为估算，以券商核定为准。"
          : "按当前购买力、持仓与已读取委托估算，实际可交易数量以券商为准。",
      )}
    </>
  );
  const confirmRow = (back: () => void, confirm: React.ReactNode) => (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Button label="返回修改" palette={p} variant="tinted" color={p.secondary} disabled={s.busy} onPress={back} />
      </View>
      <View style={{ flex: 2 }}>{confirm}</View>
    </View>
  );
  let body: React.ReactNode, actions: React.ReactNode;
  if (localReview && !quickOrder) {
    body = (
      <View style={{ gap: 8 }}>
        <Text style={{ color: tradeColor, fontSize: 19, fontWeight: "700" }}>
          本地市价{sideLabel} {symbol} · {quantity} 股
        </Text>
        <SummaryRow label="账户" value={s.account?.displayNumber ?? "—"} palette={p} />
        <SummaryRow label="交易时段" value={orderSessionLabels[session]} palette={p} />
        <SummaryRow label="价格优先起挂" value={`${localReview.startSpreadPercent}% 价差 → 中间价`} palette={p} />
        <SummaryRow label="相对启动中间价最大偏离" value={`${localReview.boundaryPercent}%`} palette={p} />
        <SummaryRow label="最长执行" value={`${localReview.durationSeconds} 秒`} palette={p} />
        <SummaryRow label="改单门槛" value={`${localReview.repriceIntervalSeconds} 秒 · ${localReview.minRepriceTicks} 个价位`} palette={p} />
        <SummaryRow label="停止条件" value={`3 秒突变 > ${localReview.jumpPercent}% · 价差 > ${localReview.maxSpreadPercent}%`} palette={p} />
        {note(`起挂价为${side === "BUY" ? "买一 +" : "卖一 −"} 价差 × 起挂比例；首次等待后最多让到中间价。价格边界固定基于启动中间价；先确认撤单及已成交数量，再调整剩余委托。可能无法成交，请保持 App 前台运行。`)}
      </View>
    );
    actions = confirmRow(
      () => setLocalReview(undefined),
      <Button
        label={`确认${s.isDemo ? "模拟" : ""}本地市价${sideLabel}`}
        palette={p}
        active
        color={tradeColor}
        disabled={s.busy || !permitted}
        onPress={() => void s.run(() => startLocal(localReview))}
      />,
    );
  } else if (prepared && !quickOrder) {
    body = (
      <View style={{ gap: 8 }}>
        <Text style={{ color: tradeColor, fontSize: 19, fontWeight: "700" }}>
          {prepared.draft.side === "BUY" ? "买入" : "卖出"} {prepared.draft.symbol} · {prepared.draft.quantity} 股
        </Text>
        <SummaryRow label="账户" value={prepared.accountDisplay} palette={p} />
        <SummaryRow label="类型" value={`${kindLabels[prepared.draft.kind]}单`} palette={p} />
        {prepared.draft.limitPrice && (
          <SummaryRow label="限价" value={`$${prepared.draft.limitPrice}`} palette={p} />
        )}
        {prepared.draft.stopPrice && (
          <SummaryRow label="触发价" value={`$${prepared.draft.stopPrice}`} palette={p} />
        )}
        <SummaryRow
          label="交易时段"
          value={orderSessionLabels[prepared.draft.session ?? "NORMAL"]}
          palette={p}
        />
        <SummaryRow
          label="有效期"
          value={prepared.draft.duration === "DAY" ? "当日有效" : "撤销前有效"}
          palette={p}
        />
        <SummaryRow label="预估金额" value={`$${money(prepared.estimatedValue)}`} palette={p} />
        {note(`${prepared.isDemo ? "模拟订单，不会发送到券商。" : "真实订单，成交金额以券商为准。"}预览 60 秒内有效。`)}
      </View>
    );
    actions = confirmRow(
      () => setPrepared(undefined),
      <Button
        label={
          s.busy
            ? "提交中…"
            : prepared.isDemo
              ? "确认模拟下单"
              : `确认${prepared.replacementOrderID ? "修改" : prepared.draft.side === "BUY" ? "买入" : "卖出"}`
        }
        palette={p}
        active
        color={tradeColor}
        disabled={s.busy}
        onPress={() =>
          void s.run(async () => {
            const snapshot = prepared;
            setPrepared(undefined);
            if (
              snapshot.accountID !== s.accountID ||
              snapshot.isDemo !== s.isDemo ||
              Date.now() - snapshot.preparedAt > 60000
            )
              throw new Error("账户或订单预览已变化，请重新预览。");
            const result = await s.broker.submit(snapshot);
            s.setMessage(
              `${snapshot.isDemo ? "演示" : ""}订单已提交${result.orderID ? ` #${result.orderID}` : ""}，请查看订单状态。`,
            );
            s.syncAfterTrade();
            onDone?.();
          })
        }
      />,
    );
  } else {
    body = (
      <>
        {sideTabs}
        {replacement && (
          <Text style={{ color: p.accent, fontSize: 13 }}>
            修改订单 #{replacement.id} · {symbol}
          </Text>
        )}
        {side === "CANCEL" ? (
          <OrderList state={s} palette={p} symbol={symbol} cancelOnly />
        ) : (
          form
        )}
      </>
    );
    actions =
      side === "CANCEL" ? (
        <Button label="刷新委托" palette={p} disabled={s.busy} onPress={() => void s.run(s.refresh)} />
      ) : (
        <>
          {kind !== "LOCAL_MARKET" && quickOrder && quickFeedback && (
            <Text
              testID="trade.quick.feedback"
              accessibilityLiveRegion="polite"
              style={{ color: quickFeedback.phase === "error" ? p.up : p.accent, fontSize: 12 }}
            >
              {quickFeedback.message}
            </Text>
          )}
          {kind === "LOCAL_MARKET" && localMessage && (
            <Text testID="trade.local.feedback" accessibilityLiveRegion="polite" style={{ color: p.accent, fontSize: 12 }}>
              {localMessage}
            </Text>
          )}
          {!permitted &&
            note(
              s.status.unresolvedOperation
                ? "有待核实的交易，请先到连接页核实处理。"
                : "连接账户后可预览订单。",
            )}
          {localRunning && (
            <Button
              label="停止追价并撤剩余委托"
              testID="trade.local.stop"
              palette={p}
              onPress={() => {
                localStop.current = true;
                setLocalMessage("正在停止追价并核实剩余委托…");
              }}
            />
          )}
          <Button
            label={
              localRunning
                ? "本地市价执行中…"
                : s.busy
                  ? quickOrder
                    ? "正在核对并提交…"
                    : "正在获取最新账户与报价…"
                  : replacement
                    ? "核对修改"
                    : quickOrder
                      ? `${s.isDemo ? "模拟" : ""}${sideLabel}${sharesLabel}`
                      : `核对${sideLabel}${sharesLabel}`
            }
            active
            color={tradeColor}
            palette={p}
            disabled={s.busy || !permitted || (kind === "LOCAL_MARKET" && !localSettingsReady)}
            onPress={() => void s.run(review)}
          />
        </>
      );
  }
  const footer = (
    <View
      onLayout={(event) => {
        footerHeight.current = event.nativeEvent.layout.height;
        onMeasure?.(bodyHeight.current + footerHeight.current);
      }}
      style={{
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 10,
        gap: 6,
        backgroundColor: p.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: p.separator,
      }}
    >
      {actions}
    </View>
  );
  if (inline)
    return (
      <View style={{ flex: 1, backgroundColor: p.surface }}>
        <View style={[styles.spread, { paddingHorizontal: 12, paddingTop: 8, minHeight: 28 }]}>
          <Text style={{ color: p.secondary, fontSize: 11, fontWeight: "600" }}>
            {s.account?.displayNumber ?? "尚未连接账户"}
          </Text>
          <View style={styles.row}>
            <Text style={{ color: s.isDemo ? "#ff8a19" : p.secondary, fontSize: 11 }}>
              {s.isDemo ? "模拟交易" : "真实交易"}
              {s.quickMode ? " · 快速" : ""}
            </Text>
            {onClose && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭交易面板"
                disabled={s.busy}
                onPress={onClose}
                hitSlop={10}
              >
                <Text style={{ color: p.text, fontSize: 22, lineHeight: 24 }}>×</Text>
              </Pressable>
            )}
          </View>
        </View>
        <ScrollView
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 10, gap: 10 }}
          onContentSizeChange={(_, height) => {
            // Header row + scrollable ticket + pinned actions.
            bodyHeight.current = height + 36;
            onMeasure?.(bodyHeight.current + footerHeight.current);
          }}
        >
          {body}
        </ScrollView>
        {footer}
      </View>
    );
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
        refreshControl={refreshControl}
        contentContainerStyle={{ padding: 12, gap: 10 }}
      >
        {header}
        {s.quickMode && !replacement && (
          <Text style={{ color: p.accent, fontSize: 11 }}>快速模式：点按后直接核对并提交</Text>
        )}
        <View
          style={{
            backgroundColor: p.surface,
            borderRadius: radius.card,
            padding: 12,
            gap: 12,
          }}
        >
          {body}
        </View>
      </ScrollView>
      {footer}
    </View>
  );
}

function SummaryRow({
  label,
  value,
  palette: p,
}: {
  label: string;
  value: string;
  palette: Palette;
}) {
  return (
    <View style={[styles.spread, { minHeight: 26 }]}>
      <Text style={{ color: p.secondary, fontSize: 13 }}>{label}</Text>
      <Text
        style={{
          color: p.text,
          fontSize: 14,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
          flexShrink: 1,
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
/** Compact dropdown pills; the open one lists its choices as chips underneath. */
function Options({
  items,
  disabled = false,
  palette: p,
}: {
  items: {
    key: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    disabled?: boolean;
  }[];
  disabled?: boolean;
  palette: Palette;
}) {
  const [open, setOpen] = useState<string>();
  const current = disabled ? undefined : items.find((item) => item.key === open && !item.disabled);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {items.map((item) => {
          const off = disabled || item.disabled,
            expanded = current?.key === item.key;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={{ expanded, disabled: off }}
              disabled={off}
              onPress={() => setOpen(expanded ? undefined : item.key)}
              style={{
                flex: 1,
                minHeight: 34,
                paddingHorizontal: 6,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                borderRadius: radius.control,
                borderWidth: 1,
                borderColor: expanded ? p.accent : p.separator,
                opacity: off ? 0.45 : 1,
              }}
            >
              <Text numberOfLines={1} style={{ color: expanded ? p.accent : p.text, fontSize: 13, flexShrink: 1 }}>
                {item.label}
              </Text>
              <Text style={{ color: p.secondary, fontSize: 9 }}>{expanded ? "▲" : "▼"}</Text>
            </Pressable>
          );
        })}
      </View>
      {current && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {current.options.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              palette={p}
              active={option.value === current.value}
              onPress={() => {
                current.onChange(option.value);
                setOpen(undefined);
              }}
            />
          ))}
        </View>
      )}
    </View>
  );
}

export function OrderList({
  state: s,
  palette: p,
  symbol,
  cancelOnly = false,
  onReplace,
  onStock,
}: {
  state: TradingState;
  palette: Palette;
  symbol?: string;
  cancelOnly?: boolean;
  onReplace?: (order: Order) => void;
  onStock?: (symbol: string) => void;
}) {
  const [selected, setSelected] = useState<Order>();
  const [filter, setFilter] = useState("全部");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const generation = useRef(0);
  useLayoutEffect(() => {
    ++generation.current;
    setSelected(undefined);
    setConfirmCancel(false);
  }, [s.accountID, s.broker, s.quickMode, symbol]);
  useLayoutEffect(
    () => () => {
      ++generation.current;
    },
    [],
  );
  const cancelPermitted =
    s.status.authenticated && Boolean(s.accountID) && !s.status.unresolvedOperation;
  function viewOrder(order: Order) {
    void s.run(async () => {
      const version = generation.current;
      const latest = await s.broker.orderDetail(s.accountID, order.id);
      if (version === generation.current) {
        setSelected(latest);
        setConfirmCancel(false);
      }
    });
  }
  function cancelOrder(order: Order) {
    const accountID = s.accountID;
    const orderID = order.id;
    const broker = s.broker;
    const version = generation.current;
    void s.run(async () => {
      if (!order.cancelable || !cancelPermitted || version !== generation.current)
        throw new Error("订单或账户状态已变化，请刷新后重试。");
      await broker.cancel(accountID, orderID);
      if (version === generation.current) {
        setSelected(undefined);
        setConfirmCancel(false);
      }
      s.syncAfterTrade();
      s.setMessage("撤单请求已提交，请以最新订单状态为准。");
    });
  }
  const orders = s.orders.filter(
    (o) =>
      (!symbol || o.symbol.split(" / ").includes(symbol)) &&
      (!cancelOnly || !FINAL_STATUSES.has(o.status)) &&
      (filter === "全部" ||
        (filter === "待成交" && !FINAL_STATUSES.has(o.status)) ||
        (filter === "已成交" && o.status === "FILLED") ||
        (filter === "已结束" &&
          ["CANCELED", "REJECTED", "EXPIRED", "REPLACED"].includes(o.status))),
  );
  const statusLabel = (status: string) =>
    ({
      WORKING: "委托中",
      QUEUED: "排队中",
      ACCEPTED: "已受理",
      PENDING_ACTIVATION: "待触发",
      FILLED: "已成交",
      CANCELED: "已撤销",
      REJECTED: "已拒绝",
      EXPIRED: "已过期",
      REPLACED: "已修改",
    })[status] ?? status;
  const statusColor = (status: string) =>
    status === "FILLED"
      ? p.accent
      : ["CANCELED", "REJECTED", "EXPIRED", "REPLACED"].includes(status)
        ? p.secondary
        : "#ff8a19";
  const listBackground = cancelOnly ? elevated(p) : p.surface;
  return (
    <View style={{ gap: cancelOnly ? 8 : 10 }}>
      {!cancelOnly && (
        <View style={{ flexDirection: "row", gap: 6 }}>
          {[
            ["全部", "全部"],
            ["待成交", "未完成"],
            ["已成交", "已成交"],
            ["已结束", "已结束"],
          ].map(([value, label]) => (
            <Chip
              key={value}
              label={label}
              palette={p}
              active={filter === value}
              style={{ flex: 1 }}
              onPress={() => setFilter(value)}
            />
          ))}
        </View>
      )}
      <View style={[styles.spread, { paddingHorizontal: 2 }]}>
        <Text style={{ color: p.secondary, fontSize: 12, fontWeight: "600" }}>
          {cancelOnly
            ? `${symbol ?? "当前账户"} · 未完成委托`
            : `${s.account?.displayNumber ?? "尚未连接账户"} · 最近 30 天`}
        </Text>
        <Text style={{ color: p.secondary, fontSize: 12 }}>
          {s.ordersLoaded ? `${orders.length} 笔` : "待加载"}
        </Text>
      </View>
      {!s.ordersLoaded && (
        <Text style={{ color: p.secondary, fontSize: 13, padding: 12 }}>
          {s.ordersError ||
            (s.status.authenticated
              ? "订单尚未完成核对，请刷新重试。"
              : "请先连接账户，再读取订单。")}
        </Text>
      )}
      {s.ordersLoaded && orders.length === 0 && (
        <View style={{ backgroundColor: listBackground, padding: 20, borderRadius: radius.card }}>
          <Text style={{ color: p.secondary, textAlign: "center" }}>
            {cancelOnly ? "没有未完成委托" : "暂无订单"}
          </Text>
        </View>
      )}
      {orders.length > 0 && (
        <View style={{ backgroundColor: listBackground, borderRadius: radius.card, paddingHorizontal: 12 }}>
          {orders.map((o, index) => {
            const sideColor = o.side === "BUY" ? p.up : p.down;
            const showDetail = !!onStock && !cancelOnly && validSymbol(o.symbol);
            return (
              <View
                key={o.id}
                style={{
                  paddingVertical: 10,
                  borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
                  borderColor: p.separator,
                  gap: 6,
                }}
              >
                <View style={[styles.row, { alignItems: "center", gap: 10 }]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={showDetail ? `订单 #${o.id}，查看 ${o.symbol} 行情` : `查看 #${o.id}`}
                    disabled={s.busy}
                    onPress={() => (showDetail ? onStock!(o.symbol) : viewOrder(o))}
                    style={{ flex: 1, gap: 4, minWidth: 0 }}
                  >
                    <View style={[styles.row, { gap: 6 }]}>
                      {o.side && (
                        <Text
                          style={{
                            color: sideColor,
                            backgroundColor: sideColor + "1F",
                            fontSize: 11,
                            fontWeight: "700",
                            borderRadius: 3,
                            overflow: "hidden",
                            paddingHorizontal: 4,
                            paddingVertical: 1,
                          }}
                        >
                          {o.side === "BUY" ? "买" : "卖"}
                        </Text>
                      )}
                      <Text numberOfLines={1} style={{ color: p.text, fontSize: 15, fontWeight: "700", flexShrink: 1 }}>
                        {o.symbol}
                      </Text>
                      <Text style={{ color: p.secondary, fontSize: 12 }}>
                        {o.kind ? kindLabels[o.kind] : "复杂订单"}
                      </Text>
                      <Text style={{ color: p.secondary, fontSize: 11, fontVariant: ["tabular-nums"] }}>
                        {cancelOnly
                          ? `#${o.id}`
                          : o.enteredAt
                            ? new Date(o.enteredAt).toLocaleString("zh-CN", {
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                                hour12: false,
                              })
                            : "时间未知"}
                      </Text>
                    </View>
                    <Text numberOfLines={1} style={{ color: p.text, fontSize: 13, fontVariant: ["tabular-nums"] }}>
                      {o.limitPrice === undefined ? "市价" : `$${money(o.limitPrice)}`} × {o.quantity ?? "—"}
                      <Text style={{ color: p.secondary }}>
                        {"  "}已成 {o.filledQuantity ?? "—"}
                        {cancelOnly ? ` · 待成交 ${o.remainingQuantity ?? "—"}` : ""}
                      </Text>
                    </Text>
                  </Pressable>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <Text style={{ color: statusColor(o.status), fontSize: 12, fontWeight: "600" }}>
                      {statusLabel(o.status)}
                    </Text>
                    {cancelOnly ? (
                      <Pressable accessibilityRole="button" accessibilityLabel={`查看 #${o.id} 撤单`}
                        disabled={s.busy} onPress={() => viewOrder(o)} hitSlop={6}>
                        <Text style={{ color: o.cancelable ? p.up : p.secondary, fontSize: 12 }}>
                          {o.cancelable ? (s.quickMode ? "查看详情 ›" : "撤单核对 ›") : "不可撤原因 ›"}
                        </Text>
                      </Pressable>
                    ) : (
                      <View style={[styles.row, { gap: 6 }]}>
                        {s.quickMode && o.cancelable && (
                          <Chip
                            label={s.isDemo ? "模拟撤单" : "撤单"}
                            palette={p}
                            color={p.up}
                            active
                            disabled={s.busy || !cancelPermitted}
                            onPress={() => cancelOrder(o)}
                          />
                        )}
                        {showDetail && (
                          <Chip
                            label="详情"
                            accessibilityLabel={`订单 #${o.id} 详情`}
                            palette={p}
                            disabled={s.busy}
                            onPress={() => viewOrder(o)}
                          />
                        )}
                      </View>
                    )}
                  </View>
                </View>
                {selected?.id === o.id && (
                  <View
                    style={{
                      backgroundColor: cancelOnly ? p.surface : elevated(p),
                      borderRadius: radius.control,
                      padding: 10,
                      gap: 8,
                    }}
                  >
                    <View style={styles.spread}>
                      <Text style={{ color: p.text, fontWeight: "600", fontSize: 13 }}>
                        #{selected.id} · {statusLabel(selected.status)}
                      </Text>
                      <Button
                        label="收起"
                        palette={p}
                        disabled={s.busy}
                        onPress={() => {
                          setSelected(undefined);
                          setConfirmCancel(false);
                        }}
                      />
                    </View>
                    <Text style={{ color: p.secondary, fontSize: 12 }}>
                      剩余 {selected.remainingQuantity ?? "—"} 股 ·{" "}
                      {selected.enteredAt ? new Date(selected.enteredAt).toLocaleString() : "时间未知"}
                    </Text>
                    {confirmCancel && !s.quickMode ? (
                      <>
                        <Text style={{ color: p.text, fontSize: 13 }}>
                          确认撤销 {selected.symbol} 的{s.isDemo ? "演示" : "真实"}订单 #{selected.id}？
                        </Text>
                        <View style={styles.row}>
                          <View style={{ flex: 1 }}>
                            <Button
                              label="返回"
                              palette={p}
                              variant="tinted"
                              color={p.secondary}
                              disabled={s.busy}
                              onPress={() => setConfirmCancel(false)}
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Button
                              label="确认撤单"
                              palette={p}
                              active
                              color={p.up}
                              disabled={s.busy || s.status.unresolvedOperation}
                              onPress={() => cancelOrder(selected)}
                            />
                          </View>
                        </View>
                      </>
                    ) : (
                      <>
                        {!selected.cancelable && (
                          <Text style={{ color: p.secondary, fontSize: 12 }}>
                            {selected.cancelUnavailableReason ?? "此订单当前不可撤销，请刷新状态。"}
                          </Text>
                        )}
                        <View style={styles.row}>
                          <View style={{ flex: 1 }}>
                            <Button
                              label={s.quickMode && s.isDemo ? "模拟撤单" : "撤单"}
                              palette={p}
                              variant="tinted"
                              color={p.up}
                              disabled={!selected.cancelable || s.busy || s.status.unresolvedOperation}
                              onPress={() => (s.quickMode ? cancelOrder(selected) : setConfirmCancel(true))}
                            />
                          </View>
                          {onReplace && (
                            <View style={{ flex: 1 }}>
                              <Button
                                label="修改订单"
                                palette={p}
                                variant="tinted"
                                disabled={
                                  !selected.editable ||
                                  !selected.isSimpleEquity ||
                                  s.busy ||
                                  s.status.unresolvedOperation
                                }
                                onPress={() => onReplace(selected)}
                              />
                            </View>
                          )}
                        </View>
                      </>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
      <Text style={{ color: p.secondary, fontSize: 11, lineHeight: 16, paddingHorizontal: 2 }}>
        {cancelOnly
          ? "显示最近 30 天、最多 200 笔订单中的未完成委托。点开可核对撤单状态；更早的委托请在 Schwab 查看。"
          : "点订单查看股票行情，点订单详情核对或管理委托。订单自动更新，最终状态以券商记录为准。"}
      </Text>
    </View>
  );
}
