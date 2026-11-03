import React, { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import { MEXC_MESSAGES, validateMexcStopDraft } from "../mexcRules.ts";
import type { MexcContract, MexcPosition, MexcStopDraft, MexcStopOrder, MexcStopPrepared, MexcTicker } from "../mexcRules.ts";
import { Button, Stepper, signed, styles } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { closableOf, orderEntryBlocked, priceText, stepDecimal, stopDraftKey, stopEstimate, stopSideIssue } from "./mexcView.ts";
import { Line, Notice } from "./parts.tsx";
import MexcWriteReview from "./MexcWriteReview.tsx";

const directionLabel = (direction: "LONG" | "SHORT") => (direction === "LONG" ? "多仓" : "空仓");
const shown = (value: string | number | undefined) => (value === undefined ? "未设置" : String(value));
const KIND_LABEL: Record<MexcStopDraft["kind"], string> = { STOP_PLACE: "设置", STOP_CHANGE: "修改", STOP_CANCEL: "取消" };

/**
 * The take-profit and stop-loss of a position already held. Each change follows an order's rules:
 * one review from the server, valid 60 seconds and usable once, and an unknown outcome locks trading.
 */
export default function MexcStopEditor({ m, palette: p, contract, position, stops, ticker, maxHeight, onClose, onChanged }: {
  m: MexcState; palette: Palette; contract: MexcContract; position: MexcPosition; stops: MexcStopOrder[]; ticker?: MexcTicker; maxHeight: number;
  onClose: () => void; onChanged: () => void;
}) {
  const existing = stops[0];
  const [takeProfit, setTakeProfit] = useState(existing?.takeProfitPrice === undefined ? "" : String(existing.takeProfitPrice));
  const [stopLoss, setStopLoss] = useState(existing?.stopLossPrice === undefined ? "" : String(existing.stopLossPrice));
  const [prepared, setPrepared] = useState<MexcStopPrepared>();
  const [reviewing, setReviewing] = useState(false);
  const fair = ticker?.fairPrice ?? ticker?.lastPrice;
  const prices = {
    ...(takeProfit.trim() ? { takeProfitPrice: takeProfit.trim() } : {}),
    ...(stopLoss.trim() ? { stopLossPrice: stopLoss.trim() } : {}),
  };
  const base = { symbol: contract.symbol, positionId: position.id };
  const draft: MexcStopDraft = existing ? { ...base, kind: "STOP_CHANGE", stopOrderId: existing.id, ...prices } : { ...base, kind: "STOP_PLACE", ...prices };
  const key = stopDraftKey(draft);
  const latestKey = useRef(key);
  latestKey.current = key;
  let issue = "";
  try { validateMexcStopDraft(draft); } catch (error) { issue = error instanceof Error ? error.message : "止盈价或止损价无效。"; }
  if (!issue && stopSideIssue(position.direction, takeProfit, stopLoss, { takeProfit: fair, stopLoss: fair })) issue = MEXC_MESSAGES.stopPriceSide;
  if (!issue && existing && Number(takeProfit || 0) === (existing.takeProfitPrice ?? 0) && Number(stopLoss || 0) === (existing.stopLossPrice ?? 0))
    issue = "价格和现有的相同。";
  // A failed key lookup lets this through as it does a close.
  const blocked = orderEntryBlocked(m.blockedCode, "CLOSE_LONG");
  const busy = m.sending || reviewing;

  const review = async (target: MexcStopDraft) => {
    if (busy || m.locked) return;
    const sentKey = stopDraftKey(target);
    setReviewing(true);
    try {
      const result = await m.run(() => m.api.reviewStop(target));
      // Changed while the review was on its way: that review is not what the form now says. It expires unused.
      if (result && (target.kind === "STOP_CANCEL" || latestKey.current === sentKey)) setPrepared(result);
    } finally {
      setReviewing(false);
    }
  };
  const panel = { backgroundColor: p.surface, borderTopWidth: 1, borderTopColor: p.separator } as const;
  if (prepared)
    return (
      <View style={[panel, { height: maxHeight }]}>
        <StopReview m={m} palette={p} prepared={prepared} onBack={() => setPrepared(undefined)}
          onRecheck={() => { const target = prepared.draft; setPrepared(undefined); void review(target); }} onDone={onChanged} />
      </View>
    );
  const small = { color: p.secondary, fontSize: 12, lineHeight: 17 } as const;
  const unit = contract.priceUnit;
  const step = (value: string, direction: 1 | -1) => stepDecimal(value || String(fair ?? unit), unit, direction);
  // What this covers can be less than what is held: resting closes reserve some, and a position can grow after one is set.
  const covered = existing?.vol ?? Number(closableOf(position));
  const atTakeProfit = stopEstimate({ ...position, holdVol: covered }, contract.contractSize, takeProfit);
  const atStopLoss = stopEstimate({ ...position, holdVol: covered }, contract.contractSize, stopLoss);
  return (
    <View style={[panel, { maxHeight, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, gap: 6 }]}>
      <View style={styles.spread}>
        <Text style={{ color: p.text, fontSize: 15, fontWeight: "700" }}>止盈止损 · {directionLabel(position.direction)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭止盈止损" hitSlop={6} disabled={busy} onPress={onClose}
          style={{ width: 28, height: 32, alignItems: "center", justifyContent: "center", opacity: busy ? 0.4 : 1 }}>
          <Text style={{ color: p.secondary, fontSize: 20, lineHeight: 24 }}>×</Text>
        </Pressable>
      </View>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 6 }}>
        <View style={styles.spread}>
          <Text style={[small, styles.number]}>持仓 {position.holdVol} 张 · 覆盖 {covered} 张 · 均价 {priceText(position.averagePrice, unit)}</Text>
          <Text style={[small, styles.number]}>标记价 {priceText(ticker?.fairPrice, unit)}</Text>
        </View>
        <Stepper compact palette={p} label="止盈" value={takeProfit} placeholder="不设置" keyboardType="decimal-pad" onChangeText={setTakeProfit}
          onStep={direction => setTakeProfit(step(takeProfit, direction))} />
        <Stepper compact palette={p} label="止损" value={stopLoss} placeholder="不设置" keyboardType="decimal-pad" onChangeText={setStopLoss}
          onStep={direction => setStopLoss(step(stopLoss, direction))} />
        <View style={styles.spread}>
          <Text style={[small, styles.number]}>止盈约 {atTakeProfit === undefined ? "—" : `${signed(atTakeProfit)} USDT`}</Text>
          <Text style={[small, styles.number]}>止损约 {atStopLoss === undefined ? "—" : `${signed(atStopLoss)} USDT`}</Text>
        </View>
        <Notice palette={p} tone="info" text="按标记价触发，触发后按市价平掉覆盖的张数，不反手。实际成交价可能和触发价不同。盈亏是从均价估算的，不含手续费。" />
        {covered < position.holdVol && <Notice palette={p} tone="info" text={`只覆盖 ${covered} 张，持仓有 ${position.holdVol} 张，没覆盖的部分不受保护。`} />}
        {stops.length > 1 && <Notice palette={p} tone="info" text={`这个持仓在 MEXC 上有 ${stops.length} 个止盈止损，这里只修改第一个，其余请到 MEXC 处理。`} />}
        {blocked && !!m.blockedText && <Notice palette={p} text={m.blockedText} />}
      </ScrollView>
      {!!issue && !m.locked && <Text numberOfLines={2} style={{ color: p.secondary, fontSize: 12, textAlign: "center" }}>{issue}</Text>}
      <View style={[styles.row, { gap: 8 }]}>
        {!!existing && (
          <View style={{ flex: 1 }}>
            <Button label="取消止盈止损" palette={p} variant="tinted" color={p.secondary} disabled={busy || m.locked}
              onPress={() => void review({ ...base, kind: "STOP_CANCEL", stopOrderId: existing.id })} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Button label={reviewing ? "正在核对…" : m.locked ? "交易已锁定" : existing ? "核对修改" : "核对设置"} palette={p} variant="filled"
            disabled={busy || m.locked || blocked || !!issue} onPress={() => void review(draft)} />
        </View>
      </View>
    </View>
  );
}

function StopReview({ m, palette: p, prepared, onBack, onRecheck, onDone }: {
  m: MexcState; palette: Palette; prepared: MexcStopPrepared; onBack: () => void; onRecheck: () => void; onDone: () => void;
}) {
  const { draft, existing } = prepared;
  const cancelling = draft.kind === "STOP_CANCEL";
  const change = (next: string | undefined, before: number | undefined) =>
    cancelling ? shown(before) : existing && String(before) !== next ? `${shown(before)} → ${shown(next)}` : shown(next);
  return (
    <MexcWriteReview m={m} palette={p} isDemo={prepared.isDemo} preparedAt={prepared.preparedAt}
      blocked={!cancelling && orderEntryBlocked(m.blockedCode, "CLOSE_LONG")}
      heading={`核对${KIND_LABEL[draft.kind]}止盈止损`}
      title={`${KIND_LABEL[draft.kind]} · ${directionLabel(prepared.direction)} ${prepared.vol} 张`}
      warning={cancelling ? "取消后，这个持仓就没有这组止盈止损了。" : "按标记价触发，触发后按市价平仓，不反手。实际成交价可能和触发价不同，行情剧烈时可能偏离较大。"}
      confirmLabel={`确认${KIND_LABEL[draft.kind]}`}
      send={() => m.changeStop(prepared)} onBack={onBack} onRecheck={onRecheck} onDone={onDone}>
      <Line palette={p} label="合约" value={prepared.displayName || draft.symbol} />
      <Line palette={p} label="代码" value={draft.symbol} />
      <Line palette={p} label="持仓方向" value={directionLabel(prepared.direction)} />
      <Line palette={p} label="持仓张数" value={String(prepared.holdVol)} />
      <Line palette={p} label="开仓均价" value={String(prepared.averagePrice)} />
      <Line palette={p} label="当前标记价" value={prepared.fairPrice === undefined ? "—" : String(prepared.fairPrice)} />
      <Line palette={p} label="止盈价" value={change(draft.takeProfitPrice, existing?.takeProfitPrice)} />
      <Line palette={p} label="止损价" value={change(draft.stopLossPrice, existing?.stopLossPrice)} />
      {prepared.atTakeProfit !== undefined && <Line palette={p} label="止盈时盈亏（估算）" value={`${signed(prepared.atTakeProfit)} USDT`} />}
      {prepared.atStopLoss !== undefined && <Line palette={p} label="止损时盈亏（估算）" value={`${signed(prepared.atStopLoss)} USDT`} />}
      <Line palette={p} label="当前强平价" value={prepared.liquidatePrice === undefined ? "—" : String(prepared.liquidatePrice)} />
    </MexcWriteReview>
  );
}
