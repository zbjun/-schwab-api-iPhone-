import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, Pressable, Switch, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
  sharesForBudget,
  orderSessionLabels,
} from "./orderRules.ts";
import { Button, Input, money, styles } from "./ui.tsx";
import { submitQuickOrder } from "./quickTrading.ts";
import { completeQuickOrder, type QuickOrderFeedback } from "./quickOrderFeedback.ts";
import { executeLocalMarket, validateLocalMarketSettings, type LocalMarketSettings } from "./localMarket.ts";

const kindLabels: Record<OrderKind, string> = {
  MARKET: "市价",
  LIMIT: "限价",
  STOP: "止损",
  STOP_LIMIT: "止损限价",
};
type TicketKind = OrderKind | "LOCAL_MARKET";
const ticketLabels = { ...kindLabels, LOCAL_MARKET: "本地市价" };
const localSettingsKey = "ths.expo.localMarket.settings.v1";
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
}) {
  const [side, setSide] = useState<Side | "CANCEL">(initialSide);
  const [kind, setKind] = useState<TicketKind>(replacement?.kind ?? "LIMIT");
  const [boundaryPercent, setBoundaryPercent] = useState("");
  const [durationSeconds, setDurationSeconds] = useState("");
  const [localSettingsReady, setLocalSettingsReady] = useState(false);
  const [localReview, setLocalReview] = useState<LocalMarketSettings>();
  const [localRunning, setLocalRunning] = useState(false);
  const [localMessage, setLocalMessage] = useState("");
  const localStop = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(localSettingsKey).then((raw) => {
      if (!active || !raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.boundaryPercent === "string" && typeof saved.durationSeconds === "string") {
        setBoundaryPercent(saved.boundaryPercent);
        setDurationSeconds(saved.durationSeconds);
      }
    }).catch(() => { if (active) setLocalMessage("追价参数恢复失败，请重新填写。"); })
      .finally(() => { if (active) setLocalSettingsReady(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!localSettingsReady) return;
    void AsyncStorage.setItem(localSettingsKey, JSON.stringify({ boundaryPercent, durationSeconds }))
      .catch(() => { if (mounted.current) setLocalMessage("追价参数保存失败，本次仍使用输入值。"); });
  }, [boundaryPercent, durationSeconds, localSettingsReady]);
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
    boundaryPercent,
    durationSeconds,
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
  const reference =
    kind === "LIMIT" || kind === "STOP_LIMIT"
      ? price
      : kind === "STOP"
        ? stop
        : kind === "LOCAL_MARKET" && side === "BUY"
          ? (quote?.askPrice === undefined ? undefined : quote.askPrice * (1 + (Number(boundaryPercent) || 0) / 100))
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
      try { await s.refresh(); }
      catch { s.setMessage("交易状态刷新失败，请到订单页核对，勿重复下单。"); }
    }
  }
  async function review() {
    if (kind === "LOCAL_MARKET") {
      const settings = { boundaryPercent: Number(boundaryPercent), durationSeconds: Number(durationSeconds) };
      try {
        if (!localSettingsReady || !boundaryPercent.trim() || !durationSeconds.trim())
          throw new Error("请填写价格边界和追价时长。");
        validateLocalMarketSettings(settings);
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
        refresh: s.refresh,
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
  const quantityInput = (
    <Input
      palette={p}
      accessibilityLabel={byAmount && side === "BUY" ? "买入金额" : "股数"}
      placeholder={byAmount && side === "BUY" ? "输入买入金额" : "输入整股数量"}
      keyboardType={byAmount ? "decimal-pad" : "number-pad"}
      value={byAmount && side === "BUY" ? budget : quantity}
      onChangeText={byAmount && side === "BUY" ? setBudget : setQuantity}
      editable={!s.busy}
      style={{
        borderWidth: 0,
        backgroundColor: inline ? p.background : p.surface,
        paddingHorizontal: inline ? 10 : 0,
        fontSize: inline ? 19 : 17,
        fontWeight: inline ? "600" : "400",
        textAlign: inline ? "left" : "right",
        flex: 1,
        minWidth: 0,
      }}
    />
  );
  const priceInput = (trigger = false) => (
    <Input
      palette={p}
      accessibilityLabel={trigger ? "触发价" : "限价"}
      placeholder={trigger ? "触发价格" : "限价"}
      keyboardType="decimal-pad"
      value={trigger ? stop : price}
      onChangeText={trigger ? setStop : setPrice}
      editable={!s.busy}
      style={{
        borderWidth: 0,
        backgroundColor: inline ? p.background : p.surface,
        paddingHorizontal: inline ? 10 : 0,
        fontSize: inline ? 19 : 17,
        fontWeight: inline ? "600" : "400",
        textAlign: inline ? "left" : "right",
        flex: 1,
        minWidth: 0,
      }}
    />
  );
  return (
    <View
      style={{
        backgroundColor: p.surface,
        borderRadius: inline ? 0 : 26,
        padding: inline ? 8 : 16,
        gap: inline ? 4 : 0,
      }}
    >
      {inline && (
        <View style={[styles.spread, { minHeight: 22 }]}>
          <Text style={{ color: p.secondary, fontSize: 11, fontWeight: "600" }}>
            {s.account?.displayNumber ?? "尚未连接账户"}
          </Text>
          <View style={styles.row}>
            <Text
              style={{
                color: s.isDemo ? "#ff8a19" : p.secondary,
                fontSize: 11,
              }}
            >
              {s.isDemo ? "模拟交易" : "真实交易"}{s.quickMode ? " · 快速" : ""}
            </Text>
            {onClose && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭交易面板"
                disabled={s.busy}
                onPress={onClose}
                hitSlop={8}
              >
                <Text style={{ color: p.text, fontSize: 23, lineHeight: 24 }}>
                  ×
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
      {!inline && s.quickMode && (
        <Text style={{ color: p.accent, fontSize: 11, paddingBottom: 6 }}>
          快速模式
        </Text>
      )}
      {localReview && !quickOrder ? (
        <View style={{ gap: 8 }}>
          <Button label="返回修改" palette={p} disabled={s.busy} onPress={() => setLocalReview(undefined)} />
          <Text style={{ color: tradeColor, fontSize: 20, fontWeight: "700" }}>
            本地市价{side === "BUY" ? "买入" : "卖出"} {symbol} · {quantity} 股
          </Text>
          <SummaryRow label="账户" value={s.account?.displayNumber ?? "—"} palette={p} />
          <SummaryRow label="交易时段" value={orderSessionLabels[session]} palette={p} />
          <SummaryRow label="相对启动报价最大偏离" value={`${localReview.boundaryPercent}%`} palette={p} />
          <SummaryRow label="最长追价" value={`${localReview.durationSeconds} 秒`} palette={p} />
          <Text style={{ color: p.secondary, fontSize: 12 }}>
            确认时读取最新{side === "BUY" ? "卖一" : "买一"}作为固定基准，在边界内自动追价。超时停止并撤剩余委托；撤单需券商确认。请保持 App 前台运行。
          </Text>
          <Button label={`确认${s.isDemo ? "模拟" : ""}本地市价${side === "BUY" ? "买入" : "卖出"}`} palette={p}
            active color={tradeColor} disabled={s.busy || !permitted} onPress={() => void s.run(() => startLocal(localReview))} />
        </View>
      ) : prepared && !quickOrder ? (
        <View style={{ gap: 8 }}>
          <View style={{ alignItems: "flex-start" }}>
            <Button
              label="返回修改"
              palette={p}
              color={p.text}
              disabled={s.busy}
              onPress={() => setPrepared(undefined)}
            />
          </View>
          <Text style={{ color: tradeColor, fontSize: 22, fontWeight: "700" }}>
            {prepared.draft.side === "BUY" ? "买入" : "卖出"}{" "}
            {prepared.draft.symbol} · {prepared.draft.quantity} 股
          </Text>
          <SummaryRow
            label="账户"
            value={prepared.accountDisplay}
            palette={p}
          />
          <SummaryRow
            label="类型"
            value={`${kindLabels[prepared.draft.kind]}单`}
            palette={p}
          />
          {prepared.draft.limitPrice && (
            <SummaryRow
              label="限价"
              value={`$${prepared.draft.limitPrice}`}
              palette={p}
            />
          )}
          {prepared.draft.stopPrice && (
            <SummaryRow
              label="触发价"
              value={`$${prepared.draft.stopPrice}`}
              palette={p}
            />
          )}
          <SummaryRow
            label="交易时段"
            value={orderSessionLabels[prepared.draft.session ?? "NORMAL"]}
            palette={p}
          />
          <SummaryRow
            label="有效期"
            value={
              prepared.draft.duration === "DAY" ? "当日有效" : "撤销前有效"
            }
            palette={p}
          />
          <SummaryRow
            label="预估金额"
            value={`$${money(prepared.estimatedValue)}`}
            palette={p}
          />
          <Text style={{ color: p.secondary, fontSize: 12, lineHeight: 18 }}>
            {prepared.isDemo
              ? "模拟订单，不会发送到券商。"
              : "真实订单，成交金额以券商为准。"}
            预览 60 秒内有效。
          </Text>
          <View style={{ marginTop: inline ? 18 : 12 }}>
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
                  await s.refresh();
                  onDone?.();
                })
              }
            />
          </View>
        </View>
      ) : (
        <>
          <View
            style={[
              styles.row,
              {
                paddingVertical: inline ? 0 : 2,
                paddingBottom: inline ? 0 : 14,
              },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Segments
                options={[
                  { value: "BUY", label: inline ? "买" : "买入" },
                  { value: "SELL", label: inline ? "卖" : "卖出" },
                  { value: "CANCEL", label: inline ? "撤" : "撤单" },
                ]}
                value={side}
                onChange={(value) => {
                  setSide(value as Side | "CANCEL");
                  if (!s.status.unresolvedOperation) s.setMessage("");
                }}
                disabled={s.busy || Boolean(replacement)}
                palette={p}
              />
            </View>
            {inline &&
              (side === "CANCEL" ? (
                <Button
                  label="刷新"
                  palette={p}
                  disabled={s.busy}
                  onPress={() => void s.run(s.refresh)}
                />
              ) : (
                <Choice
                  label={`${ticketLabels[kind]}单`}
                  options={kindOptions}
                  value={kind}
                  onChange={(value) => setKind(value as TicketKind)}
                  palette={p}
                  disabled={s.busy}
                  color={tradeColor}
                  compact={inline}
                />
              ))}
          </View>
          {replacement && (
            <Text style={{ color: p.accent, paddingVertical: 8 }}>
              修改订单 #{replacement.id} · {symbol}
            </Text>
          )}
          {side === "CANCEL" ? (
            <OrderList state={s} palette={p} symbol={symbol} cancelOnly />
          ) : (
            <>
              <View style={{ gap: 3, paddingVertical: inline ? 0 : 8 }}>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {([
                    { label: "买一", value: quote?.bidPrice, color: p.up },
                    { label: "卖一", value: quote?.askPrice, color: p.down },
                  ]).map(({ label, value, color }) => {
                    const valid = quote?.symbol === symbol && value !== undefined && Number.isFinite(value) && value > 0;
                    const quotedPrice = valid ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : "—";
                    const canFill = valid && ["LIMIT", "STOP_LIMIT"].includes(kind) && !s.busy;
                    return (
                      <Pressable
                        key={label}
                        accessibilityRole="button"
                        accessibilityLabel={`${label} ${quotedPrice}${canFill ? "，填入限价" : ""}`}
                        accessibilityState={{ disabled: !canFill }}
                        disabled={!canFill}
                        onPress={() => setPrice(quotedPrice)}
                        style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6, backgroundColor: p.background, borderRadius: 8, paddingHorizontal: 10, minHeight: 36 }}
                      >
                        <Text style={{ color: p.secondary, fontSize: 12 }}>{label}</Text>
                        <Text style={{ color: valid ? color : p.secondary, fontSize: 17, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{quotedPrice}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={{ color: p.secondary, fontSize: 10 }}>
                  {s.isDemo ? "模拟报价" : "报价"} · USD
                  {quote?.symbol === symbol && quote.quoteTime ? ` · ${new Date(quote.quoteTime).toLocaleTimeString()}` : ""}
                  {["LIMIT", "STOP_LIMIT"].includes(kind) ? " · 点报价填限价" : ""}
                </Text>
              </View>
              {!inline && (
                <FormRow label="订单类型" palette={p}>
                  <Choice
                    label={`${ticketLabels[kind]}单`}
                    options={kindOptions}
                    value={kind}
                    onChange={(value) => setKind(value as TicketKind)}
                    palette={p}
                    disabled={s.busy}
                  />
                </FormRow>
              )}
              {!inline && amountAllowed && (
                <FormRow label="按金额买入" palette={p}>
                  <Switch
                    accessibilityLabel="按金额买入"
                    value={byAmount}
                    disabled={s.busy}
                    onValueChange={setByAmount}
                    trackColor={{ true: p.accent }}
                  />
                </FormRow>
              )}
              {!inline && <View style={styles.spread}>
                <Text style={{ color: p.secondary, fontSize: 12 }}>交易时段</Text>
                <Choice
                  label={orderSessionLabels[session]}
                  value={session}
                  options={Object.entries(orderSessionLabels).map(([value, label]) => ({ value, label }))}
                  disabled={s.busy || Boolean(replacement)}
                  palette={p}
                  onChange={(value) => {
                    const next = value as OrderSession;
                    setSession(next);
                    if (next !== "NORMAL" && kind !== "LOCAL_MARKET") setKind("LIMIT");
                    if (next === "AM" || next === "PM") setGTC(false);
                  }}
                />
              </View>}
              {!inline && session !== "NORMAL" && (
                <Text style={{ color: p.secondary, fontSize: 11 }}>
                  限价单 · 不含夜盘；实际可交易时段以券商为准。
                </Text>
              )}
              {inline ? (
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={{ color: p.secondary, fontSize: 12 }}>
                      {kind === "MARKET" || kind === "LOCAL_MARKET"
                        ? kind === "LOCAL_MARKET" ? "参考报价 · USD" : "市价 · USD"
                        : kind === "STOP"
                          ? "触发价 · USD"
                          : "限价 · USD"}
                    </Text>
                    {kind === "MARKET" || kind === "LOCAL_MARKET" ? (
                      <Text
                        style={{
                          color: p.text,
                          backgroundColor: p.background,
                          padding: 12,
                          borderRadius: 8,
                          fontSize: 19,
                        }}
                      >
                        ${money(kind === "LOCAL_MARKET" ? side === "BUY" ? quote?.askPrice : quote?.bidPrice : quote?.lastPrice)}
                      </Text>
                    ) : (
                      priceInput(kind === "STOP")
                    )}
                  </View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <View style={styles.spread}>
                      <Text style={{ color: p.secondary, fontSize: 12 }}>
                        {byAmount && side === "BUY" ? "金额 · USD" : "数量 · 股"}
                      </Text>
                      {amountAllowed && <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={byAmount ? "按股数买入" : "按金额买入"}
                        disabled={s.busy}
                        hitSlop={4}
                        onPress={() => setByAmount(!byAmount)}
                      ><Text style={{ color: tradeColor, fontSize: 11 }}>{byAmount ? "按股数" : "按金额"}</Text></Pressable>}
                    </View>
                    {quantityInput}
                  </View>
                </View>
              ) : (
                <FormRow
                  label={
                    byAmount && side === "BUY" ? "金额 · USD" : "数量 · 股"
                  }
                  palette={p}
                >
                  {quantityInput}
                </FormRow>
              )}
              {!inline && ["LIMIT", "STOP_LIMIT"].includes(kind) && (
                <FormRow label="限价 · USD" palette={p}>
                  {priceInput()}
                </FormRow>
              )}
              {(kind === "STOP_LIMIT" || (!inline && kind === "STOP")) && (
                <FormRow label="触发价 · USD" palette={p}>
                  {priceInput(true)}
                </FormRow>
              )}
              {kind === "LOCAL_MARKET" && (
                <View style={{ gap: 5, paddingVertical: 4 }}>
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={{ color: p.secondary, fontSize: 12 }}>价格边界 · 最大偏离 %</Text>
                      <Input palette={p} testID="trade.local.boundary" accessibilityLabel="价格边界百分比"
                        placeholder="例如 0.5" keyboardType="decimal-pad" value={boundaryPercent}
                        onChangeText={setBoundaryPercent} editable={!s.busy && localSettingsReady} />
                    </View>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={{ color: p.secondary, fontSize: 12 }}>追价时长 · 秒</Text>
                      <Input palette={p} testID="trade.local.duration" accessibilityLabel="追价时长秒数"
                        placeholder="例如 10" keyboardType="number-pad" value={durationSeconds}
                        onChangeText={setDurationSeconds} editable={!s.busy && localSettingsReady} />
                    </View>
                  </View>
                  <Text style={{ color: p.secondary, fontSize: 11, lineHeight: 16 }}>
                    参数自动保存。以启动时{side === "BUY" ? "卖一" : "买一"}为固定基准，{side === "BUY" ? "买价不超过基准 +" : "卖价不低于基准 −"}设定百分比；最长 3600 秒。
                    达到边界、超时或点停止，将停止追价并撤剩余委托。请保持前台；断网或退出 App 后无法保证及时撤单，须在订单页核实。
                  </Text>
                </View>
              )}
              <View
                style={[styles.spread, { paddingVertical: inline ? 0 : 12 }]}
              >
                <Text style={{ color: p.text, fontSize: 12 }}>
                  {side === "SELL"
                    ? `持有 ${heldShares ?? "—"} 股　可卖预估 ${sellMax === undefined ? "待核对" : `${sellMax} 股`}`
                    : `可买预估 ${buyMax ?? "—"} 股　可卖预估 ${sellMax ?? "—"} 股`}
                </Text>
                <Button
                  label="最大"
                  palette={p}
                  color={tradeColor}
                  disabled={max === undefined || s.busy}
                  onPress={() => fillMaximum()}
                />
              </View>
              {side === "SELL" && sellMax === undefined && (
                <View style={{ gap: 4 }}>
                  <Text style={{ color: p.secondary, fontSize: 12 }}>
                    {unsupportedHolding
                      ? `已读取持仓，但类型 ${unsupportedHolding.assetType.slice(0, 40)} 尚不支持核对可卖数量。`
                      : s.ordersError ||
                        (s.ordersLoaded
                          ? "存在无法核对的委托，可卖数量暂不可用。"
                          : "正在等待订单核对，持股数量不代表当前可卖数量。")}
                  </Text>
                  <Button
                    label="刷新核对可卖数量"
                    palette={p}
                    disabled={s.busy}
                    onPress={() => void s.run(s.refresh)}
                  />
                </View>
              )}
              {side === "BUY" && buyMax === 0 && (
                <Text style={{ color: p.secondary, fontSize: 12 }}>
                  购买力 ${money(s.account?.buyingPower)}，不足买入 1 股。
                </Text>
              )}
              {inline ? (
                <View style={styles.spread}>
                  <Choice
                    label={orderSessionLabels[session]}
                    value={session}
                    options={Object.entries(orderSessionLabels).map(([value, label]) => ({ value, label }))}
                    disabled={s.busy || Boolean(replacement)}
                    palette={p}
                    compact
                    onChange={(value) => {
                      const next = value as OrderSession;
                      setSession(next);
                      if (next !== "NORMAL" && kind !== "LOCAL_MARKET") setKind("LIMIT");
                      if (next === "AM" || next === "PM") setGTC(false);
                    }}
                  />
                  <Choice
                    label={gtc && gtcAllowed ? "撤销前有效" : "当日有效"}
                    value={gtc ? "GTC" : "DAY"}
                    options={[
                      { value: "DAY", label: "当日有效" },
                      { value: "GTC", label: "撤销前有效" },
                    ]}
                    disabled={!gtcAllowed || s.busy}
                    palette={p}
                    onChange={(value) => setGTC(value === "GTC")}
                    color={p.secondary}
                    compact
                  />
                </View>
              ) : (
                <>
                  <View style={[styles.row, { paddingBottom: 12 }]}>
                    {[1, 0.5, 1 / 3, 0.25].map((fraction, i) => (
                      <View key={fraction} style={{ flex: 1 }}>
                        <Button
                          label={["全仓", "1/2", "1/3", "1/4"][i]}
                          palette={p}
                          disabled={max === undefined || s.busy}
                          onPress={() => fillMaximum(fraction)}
                        />
                      </View>
                    ))}
                  </View>
                  <FormRow label="有效期" palette={p}>
                    <Choice
                      label={
                        gtc && gtcAllowed ? "撤销前有效" : "当日有效"
                      }
                      value={gtc ? "GTC" : "DAY"}
                      options={[
                        { value: "DAY", label: "当日有效" },
                        { value: "GTC", label: "撤销前有效" },
                      ]}
                      disabled={!gtcAllowed || s.busy}
                      palette={p}
                      onChange={(value) => setGTC(value === "GTC")}
                    />
                  </FormRow>
                </>
              )}
              {byAmount && side === "BUY" && (
                <Text style={{ color: p.secondary, fontSize: 12 }}>
                  按限价折算 {shares ?? "—"} 股
                </Text>
              )}
              <Text
                style={{
                  color: p.secondary,
                  fontSize: 11,
                  lineHeight: 17,
                  paddingVertical: inline ? 0 : 10,
                }}
              >
                {inline
                  ? `数量为估算，以券商核定为准。${session !== "NORMAL" ? "延长时段不含夜盘。" : ""}`
                  : "按当前购买力、持仓与已读取委托估算，实际可交易数量以券商为准。"}
              </Text>
              {!permitted && (
                <Text style={{ color: p.secondary, fontSize: 12 }}>
                  {s.status.unresolvedOperation
                    ? "有待核实的交易，请先到连接页核实处理。"
                    : "连接账户后可预览订单。"}
                </Text>
              )}
              <View
                style={{
                  paddingTop: inline ? 2 : 12,
                  gap: 8,
                }}
              >
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
                {localRunning && (
                  <Button label="停止追价并撤剩余委托" testID="trade.local.stop" palette={p}
                    onPress={() => { localStop.current = true; setLocalMessage("正在停止追价并核实剩余委托…"); }} />
                )}
                <Button
                  label={
                    localRunning ? "本地市价执行中…" : s.busy
                      ? quickOrder
                        ? "正在核对并提交…"
                        : "正在获取最新账户与报价…"
                      : replacement
                        ? "核对修改"
                        : quickOrder
                          ? `${s.isDemo ? "模拟" : ""}${side === "BUY" ? "买入" : "卖出"}`
                          : `核对${side === "BUY" ? "买入" : "卖出"}`
                  }
                  active
                  color={tradeColor}
                  palette={p}
                  disabled={s.busy || !permitted || (kind === "LOCAL_MARKET" && !localSettingsReady)}
                  onPress={() => void s.run(review)}
                />
              </View>
            </>
          )}
        </>
      )}
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
    <View style={styles.spread}>
      <Text style={{ color: p.text, fontSize: 14 }}>{label}</Text>
      <Text
        style={{
          color: p.secondary,
          fontSize: 14,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
    </View>
  );
}
function FormRow({
  label,
  children,
  palette: p,
}: {
  label: string;
  children: React.ReactNode;
  palette: Palette;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        minHeight: 52,
        borderTopWidth: 0.5,
        borderColor: p.separator,
      }}
    >
      <Text style={{ color: p.text, fontSize: 17 }}>{label}</Text>
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        {children}
      </View>
    </View>
  );
}
function Segments({
  options,
  value,
  onChange,
  disabled,
  palette: p,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  palette: Palette;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: p.separator,
        borderRadius: 22,
        padding: 2,
      }}
    >
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="button"
          accessibilityLabel={option.label}
          accessibilityState={{ selected: option.value === value, disabled }}
          disabled={disabled}
          onPress={() => onChange(option.value)}
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            minHeight: 29,
            borderRadius: 20,
            backgroundColor: value === option.value ? p.surface : "transparent",
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Text
            style={{
              color: p.text,
              fontSize: 14,
              fontWeight: value === option.value ? "600" : "400",
            }}
          >
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
function Choice({
  label,
  options,
  value,
  onChange,
  disabled,
  color,
  compact = false,
  palette: p,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  color?: string;
  compact?: boolean;
  palette: Palette;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ alignItems: "flex-end", maxWidth: 165 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => setOpen(!open)}
        style={{ paddingVertical: compact ? 4 : 6, minHeight: compact ? 32 : undefined, justifyContent: "center" }}
      >
        <Text
          style={{
            color: color ?? p.accent,
            fontSize: compact ? 13 : 16,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {label} ⌃⌄
        </Text>
      </Pressable>
      {open && !disabled && (
        <View
          style={{
            backgroundColor: p.background,
            borderRadius: 12,
            padding: 8,
          }}
        >
          {options.map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={{ selected: option.value === value }}
              onPress={() => {
                onChange(option.value);
                setOpen(false);
              }}
              style={{ padding: 8 }}
            >
              <Text style={{ color: p.text, fontSize: 14 }}>
                {option.label}
                {value === option.value ? " ✓" : ""}
              </Text>
            </Pressable>
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
}: {
  state: TradingState;
  palette: Palette;
  symbol?: string;
  cancelOnly?: boolean;
  onReplace?: (order: Order) => void;
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
      await s.refresh();
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
  return (
    <View style={{ gap: cancelOnly ? 10 : 20 }}>
      {!cancelOnly && (
        <View
          style={{
            backgroundColor: p.surface,
            padding: 16,
            borderRadius: 26,
            gap: 16,
          }}
        >
          <View
            style={[
              styles.spread,
              {
                paddingBottom: 15,
                borderBottomWidth: 0.5,
                borderColor: p.separator,
              },
            ]}
          >
            <Text style={{ color: p.text, fontSize: 17 }}>账户</Text>
            <Text style={{ color: p.secondary, fontSize: 17 }}>
              {s.account?.displayNumber ?? "尚未连接账户"}
            </Text>
          </View>
          <Segments
            options={[
              { value: "全部", label: "全部" },
              { value: "待成交", label: "未完成" },
              { value: "已成交", label: "已成交" },
              { value: "已结束", label: "已结束" },
            ]}
            value={filter}
            onChange={setFilter}
            palette={p}
          />
        </View>
      )}
      <View style={[styles.spread, { paddingHorizontal: cancelOnly ? 0 : 16 }]}>
        <Text
          style={{
            color: cancelOnly ? p.text : p.secondary,
            fontWeight: "600",
            fontSize: cancelOnly ? 16 : 15,
          }}
        >
          {cancelOnly
            ? `${symbol ?? "当前账户"} · 委托与撤单`
            : `最近 30 天 · ${s.ordersLoaded ? `${orders.length} 笔` : "待加载"}`}
        </Text>
        {cancelOnly && (
          <Text style={{ color: p.secondary, fontSize: 12 }}>
            {s.ordersLoaded ? `${orders.length} 笔` : "待加载"}
          </Text>
        )}
      </View>
      {!s.ordersLoaded && (
        <Text style={{ color: p.secondary, padding: 16 }}>
          {s.ordersError ||
            (s.status.authenticated
              ? "订单尚未完成核对，请刷新重试。"
              : "请先连接账户，再读取订单。")}
        </Text>
      )}
      {s.ordersLoaded && orders.length === 0 && (
        <View
          style={{ backgroundColor: p.surface, padding: 24, borderRadius: 26 }}
        >
          <Text style={{ color: p.secondary, textAlign: "center" }}>
            {cancelOnly ? "没有未完成委托" : "暂无订单"}
          </Text>
        </View>
      )}
      {orders.length > 0 && (
        <View
          style={{
            backgroundColor: cancelOnly ? p.background : p.surface,
            borderRadius: cancelOnly ? 10 : 26,
            paddingHorizontal: 16,
          }}
        >
          {orders.map((o, index) => (
            <View
              key={o.id}
              style={{
                paddingVertical: cancelOnly ? 14 : 20,
                borderTopWidth: index ? 0.5 : 0,
                borderColor: p.separator,
                gap: 6,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`查看 #${o.id}`}
                disabled={s.busy}
                onPress={() =>
                  void s.run(async () => {
                    const version = generation.current;
                    const latest = await s.broker.orderDetail(s.accountID, o.id);
                    if (version === generation.current) {
                      setSelected(latest);
                      setConfirmCancel(false);
                    }
                  })
                }
                style={{ gap: 6 }}
              >
                <View style={styles.spread}>
                  <View style={styles.row}>
                    <Text
                      style={{ color: p.text, fontSize: 18, fontWeight: "700" }}
                    >
                      {cancelOnly
                        ? `${o.side === "BUY" ? "买入" : "卖出"} · ${o.kind ? kindLabels[o.kind] : "复杂订单"}单`
                        : o.symbol}
                    </Text>
                    {!cancelOnly && (
                      <Text
                        style={{
                          color: o.side === "BUY" ? p.up : p.down,
                          fontSize: 12,
                        }}
                      >
                        {o.side === "BUY"
                          ? "买入"
                          : o.side === "SELL"
                            ? "卖出"
                            : ""}
                      </Text>
                    )}
                  </View>
                  <Text
                    style={{
                      color: o.status === "FILLED" ? p.accent : "#ff8a19",
                      backgroundColor:
                        o.status === "FILLED" ? `${p.accent}14` : "#ff8a1914",
                      fontSize: 12,
                      fontWeight: "600",
                      borderRadius: 6,
                      paddingHorizontal: 8,
                      paddingVertical: 5,
                    }}
                  >
                    {statusLabel(o.status)}
                  </Text>
                </View>
                <View style={styles.spread}>
                  <Text style={{ color: p.secondary, fontSize: 13 }}>
                    {cancelOnly
                      ? `待成交 ${o.remainingQuantity ?? "—"} 股`
                      : `${o.kind ? kindLabels[o.kind] : "复杂订单"}单 · ${o.quantity ?? "—"} 股`}
                  </Text>
                  <Text
                    style={{
                      color: p.text,
                      fontSize: 17,
                      fontWeight: "600",
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {o.limitPrice === undefined
                      ? "市价"
                      : `$${money(o.limitPrice)}`}{" "}
                    <Text style={{ color: p.secondary }}>›</Text>
                  </Text>
                </View>
                <View style={styles.spread}>
                  <Text style={{ color: p.secondary, fontSize: 12 }}>
                    {cancelOnly
                      ? `#${o.id}`
                      : o.enteredAt
                        ? new Date(o.enteredAt).toLocaleString("zh-CN", {
                            year: "numeric",
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "时间未知"}
                  </Text>
                  <Text
                    style={{
                      color: cancelOnly ? p.up : p.secondary,
                      fontSize: 12,
                    }}
                  >
                    {cancelOnly
                      ? o.cancelable
                        ? s.quickMode
                          ? "查看详情 ›"
                          : "撤单核对 ›"
                        : "查看不可撤原因 ›"
                      : `已成 ${o.filledQuantity ?? "—"} 股`}
                  </Text>
                </View>
              </Pressable>
              {s.quickMode && o.cancelable && (
                <View style={{ alignItems: "flex-end" }}>
                  <Button
                    label={s.isDemo ? "模拟撤单" : "撤单"}
                    palette={p}
                    disabled={s.busy || !cancelPermitted}
                    onPress={() => cancelOrder(o)}
                  />
                </View>
              )}
            </View>
          ))}
        </View>
      )}
      <Text
        style={{
          color: p.secondary,
          fontSize: 12,
          lineHeight: 18,
          paddingHorizontal: cancelOnly ? 0 : 16,
        }}
      >
        {cancelOnly
          ? "显示最近 30 天、最多 200 笔订单中的未完成委托。点开可核对撤单状态；更早的委托请在 Schwab 查看。"
          : "提交、撤单或修改的回执不代表最终状态。刷新后请以券商订单记录为准。"}
      </Text>
      {selected && (
        <View
          style={{
            backgroundColor: p.background,
            borderRadius: 12,
            padding: 12,
            gap: 10,
          }}
        >
          <View style={styles.spread}>
            <Text style={{ color: p.text, fontWeight: "600" }}>
              #{selected.id} · {selected.status}
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
            {selected.enteredAt
              ? new Date(selected.enteredAt).toLocaleString()
              : "时间未知"}
          </Text>
          {confirmCancel && !s.quickMode ? (
            <>
              <Text style={{ color: p.text }}>
                确认撤销 {selected.symbol} 的{s.isDemo ? "演示" : "真实"}订单 #
                {selected.id}？
              </Text>
              <View style={styles.row}>
                <Button
                  label="返回"
                  palette={p}
                  disabled={s.busy}
                  onPress={() => setConfirmCancel(false)}
                />
                <Button
                  label="确认撤单"
                  palette={p}
                  active
                  disabled={s.busy || s.status.unresolvedOperation}
                  onPress={() => cancelOrder(selected)}
                />
              </View>
            </>
          ) : (
            <>
              {!selected.cancelable && (
                <Text style={{ color: p.secondary, fontSize: 12 }}>
                  {selected.cancelUnavailableReason ??
                    "此订单当前不可撤销，请刷新状态。"}
                </Text>
              )}
              <View style={styles.row}>
                <Button
                  label={s.quickMode && s.isDemo ? "模拟撤单" : "撤单"}
                  palette={p}
                  disabled={
                    !selected.cancelable ||
                    s.busy ||
                    s.status.unresolvedOperation
                  }
                  onPress={() => s.quickMode ? cancelOrder(selected) : setConfirmCancel(true)}
                />
                {onReplace && (
                  <Button
                    label="修改订单"
                    palette={p}
                    disabled={
                      !selected.editable ||
                      !selected.isSimpleEquity ||
                      s.busy ||
                      s.status.unresolvedOperation
                    }
                    onPress={() => onReplace(selected)}
                  />
                )}
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}
