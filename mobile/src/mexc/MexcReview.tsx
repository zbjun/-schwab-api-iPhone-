import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { DemoNotice } from "../DemoNotice.tsx";
import type { Palette } from "../types.ts";
import { isBuying, isOpening, mexcActionLabels } from "../mexcRules.ts";
import type { MexcLimits, MexcPrepared } from "../mexcRules.ts";
import { Button, Glass, money, radius, styles, tabBar, tabClearance } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { CONFIRM_ARM_DELAY, closeEstimate, confirmArmed, findPosition, marginFor, openTypeLabel, orderEntryBlocked, percent, reviewExpired, reviewRemainingSeconds } from "./mexcView.ts";
import { Line, Notice, profitColor, profitText } from "./parts.tsx";

/**
 * Shows what the server returned for this review, plus profit estimates worked out here and labelled as estimates.
 * Confirm can be pressed once: whatever the outcome, the review is spent and a new one is needed. Never retries.
 */
export default function MexcReview({ m, palette: p, prepared, limits, embedded = false, onBack, onRecheck, onPlaced }: {
  m: MexcState; palette: Palette; prepared: MexcPrepared; limits?: MexcLimits;
  /** Inside the contract page's panel, where no tab bar sits underneath. */
  embedded?: boolean;
  onBack: () => void; onRecheck: () => void; onPlaced: (orderID: string) => void;
}) {
  const clearance = embedded ? 6 : tabClearance;
  const [now, setNow] = useState(Date.now());
  const [failure, setFailure] = useState("");
  const [floatingHeight, setFloatingHeight] = useState(96);
  const used = useRef(false);
  const shownAt = useRef(Date.now());
  // Stays set after the lock is lifted: this review belongs to an order whose outcome was never known.
  const outcomeUnknown = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    const arm = setTimeout(() => setNow(Date.now()), CONFIRM_ARM_DELAY);
    return () => { clearInterval(timer); clearTimeout(arm); };
  }, []);
  const remaining = reviewRemainingSeconds(prepared.preparedAt, now);
  const expired = remaining === 0;
  const spent = used.current || !!failure;
  const draft = prepared.draft, opening = isOpening(draft.action);
  const market = draft.kind === "MARKET";
  const sending = m.sending;
  const entryBlocked = orderEntryBlocked(m.blockedCode, draft.action);
  const disabled = !confirmArmed(shownAt.current, now) || expired || sending || spent || m.locked || entryBlocked;
  const confirm = async () => {
    // Checked again at the moment of the press; a blocked press does not spend the review.
    if (used.current || !confirmArmed(shownAt.current, Date.now()) || m.sending || m.locked || orderEntryBlocked(m.blockedCode, prepared.draft.action) ||
        reviewExpired(prepared.preparedAt, Date.now())) return;
    used.current = true; // One review, one confirmation.
    const result = await m.place(prepared);
    if (result.orderID) { onPlaced(result.orderID); return; }
    if (result.unknown) outcomeUnknown.current = true;
    setFailure(result.error ?? "操作失败，请稍后重试。");
  };
  const tradeColor = isBuying(draft.action) ? p.up : p.down;
  // A market order is valued at the quote it was reviewed against, not at its protection price.
  const fill = market ? prepared.referencePrice : Number(prepared.orderPrice);
  const contractSize = m.contracts.find(contract => contract.symbol === draft.symbol)?.contractSize;
  const closing = opening ? undefined : findPosition(m.account?.positions ?? [], draft.symbol, draft.action);
  const closeProfit = closing && contractSize !== undefined ? closeEstimate(closing, contractSize, draft.vol, fill) : undefined;
  const entry = { direction: isBuying(draft.action) ? "LONG" as const : "SHORT" as const, averagePrice: fill };
  const atStop = (price: string | undefined) => (price !== undefined && contractSize !== undefined ? closeEstimate(entry, contractSize, draft.vol, price) : undefined);
  const atTakeProfit = atStop(draft.takeProfitPrice), atStopLoss = atStop(draft.stopLossPrice);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.pageContent, { gap: 10, paddingBottom: clearance + floatingHeight + 16 }]}>
        {prepared.isDemo && <DemoNotice palette={p} card />}
        {/* Above the details: confirm is always on screen, so what it means must be too. An unknown outcome must not invite another attempt. */}
        {!!failure && <Notice palette={p} text={outcomeUnknown.current ? failure : failure + " 本次核对已作废，如需继续请重新核对。"} />}
        {m.locked && <Notice palette={p} text="交易已锁定，不能确认。" />}
        {!m.locked && entryBlocked && !!m.blockedText && <Notice palette={p} text={m.blockedText} />}
        {!prepared.isDemo && <Notice palette={p} text="真实账户：确认后会发送到 MEXC。" />}
        {prepared.isDemo && <Notice palette={p} tone="info" text="演示账户，不会发送到交易所。" />}
        {opening && <Notice palette={p} text="杠杆交易可能被强平，亏损可能超过预期。" />}
        {(draft.takeProfitPrice !== undefined || draft.stopLossPrice !== undefined) && (
          <Notice palette={p} text="止盈止损随委托一起提交，成交后才生效，按标记价触发，触发后按市价平仓。部分成交时，以持仓上显示的为准。" />
        )}
        {market && (
          <Notice palette={p}
            text={`市价单按保护价成交，最多偏离 ${limits ? percent(limits.marketProtection, 2) : "—"}，超出部分取消。`} />
        )}
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: 12, gap: 8 }}>
          <Text style={{ color: p.secondary, fontSize: 12 }}>核对委托</Text>
          <Text style={{ color: tradeColor, fontSize: 19, fontWeight: "700" }}>
            {`${mexcActionLabels[draft.action]} ${prepared.displayName || draft.symbol} · ${draft.vol} 张`}
          </Text>
          <View style={{ height: 1, backgroundColor: p.separator }} />
          <View>
            <Line palette={p} label="方向" value={mexcActionLabels[draft.action]} strong color={tradeColor} />
            <Line palette={p} label="合约" value={prepared.displayName || draft.symbol} />
            <Line palette={p} label="代码" value={draft.symbol} />
            <Line palette={p} label="张数" value={draft.vol} />
            <Line palette={p} label={market ? "保护价（限价 IOC）" : "限价"} value={prepared.orderPrice} />
            <Line palette={p} label="折算金额（最大）" value={`${money(prepared.notional)} USDT`} />
            <Line palette={p} label="保证金模式" value={openTypeLabel(prepared.openType)} />
            {opening && <>
              <Line palette={p} label="杠杆" value={`${prepared.leverage ?? "—"}x`} />
              <Line palette={p} label="所需保证金" value={prepared.margin === undefined ? "—" : `${money(prepared.margin)} USDT`} />
              <Line palette={p} label="可用保证金" value={prepared.available === undefined ? "—" : `${money(prepared.available)} USDT`} />
              {draft.takeProfitPrice !== undefined && <Line palette={p} label="止盈价" value={draft.takeProfitPrice} />}
              {atTakeProfit !== undefined && <Line palette={p} label="止盈时盈亏（估算）" value={profitText(atTakeProfit, prepared.margin)} color={profitColor(p, atTakeProfit)} />}
              {draft.stopLossPrice !== undefined && <Line palette={p} label="止损价" value={draft.stopLossPrice} />}
              {atStopLoss !== undefined && <Line palette={p} label="止损时盈亏（估算）" value={profitText(atStopLoss, prepared.margin)} color={profitColor(p, atStopLoss)} />}
            </>}
            {!opening && <Line palette={p} label="可平张数" value={prepared.closable === undefined ? "—" : String(prepared.closable)} />}
            {closeProfit !== undefined && <Line palette={p} label="预计盈亏（估算，未扣手续费）" value={profitText(closeProfit, closing && marginFor(closing, Number(draft.vol)))} color={profitColor(p, closeProfit)} />}
            <Line palette={p} label="吃单 / 挂单手续费率" value={`${percent(prepared.takerFeeRate, 3)} / ${percent(prepared.makerFeeRate, 3)}`} />
            <Line palette={p} label="资金费率" value={percent(prepared.fundingRate, 4)} />
          </View>
        </View>
      </ScrollView>
      <Glass palette={p} style={{ position: "absolute", left: tabBar.inset, right: tabBar.inset, bottom: clearance, borderRadius: 20 }}>
        <View onLayout={event => setFloatingHeight(Math.ceil(event.nativeEvent.layout.height))} style={{ padding: 8, gap: 6 }}>
          <Text style={{ color: expired || spent ? p.up : p.secondary, fontSize: 12, textAlign: "center" }}>
            {spent ? "本次核对已作废" : expired ? "核对已过期，请重新核对" : `核对有效，还剩 ${remaining} 秒`}
          </Text>
          <View style={[styles.row, { gap: 8 }]}>
            <View style={{ flex: 1 }}><Button label="返回修改" palette={p} variant="tinted" color={p.secondary} disabled={sending} onPress={onBack} /></View>
            {!outcomeUnknown.current && (
              <View style={{ flex: 2 }}>
                {expired || failure
                  ? <Button label="重新核对" palette={p} variant="filled" disabled={sending || m.locked || entryBlocked} onPress={onRecheck} />
                  : <Button label={sending ? "发送中…" : `确认${mexcActionLabels[draft.action]}`} palette={p} variant="filled" color={tradeColor} disabled={disabled} onPress={() => void confirm()} />}
              </View>
            )}
          </View>
        </View>
      </Glass>
    </View>
  );
}
