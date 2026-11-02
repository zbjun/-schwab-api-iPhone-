import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import { isOpening, mexcActionLabels } from "../mexcRules.ts";
import type { MexcLimits, MexcPrepared } from "../mexcRules.ts";
import { Button, money, styles, tabClearance } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { openTypeLabel, orderEntryBlocked, percent, reviewExpired, reviewRemainingSeconds } from "./mexcView.ts";
import { Line, Notice } from "./parts.tsx";

/**
 * Shows only what the server returned for this review. Confirm can be pressed once:
 * whatever the outcome, the review is spent and a new one is needed. Never retries.
 */
export default function MexcReview({ m, palette: p, prepared, limits, onBack, onRecheck, onPlaced }: {
  m: MexcState; palette: Palette; prepared: MexcPrepared; limits?: MexcLimits;
  onBack: () => void; onRecheck: () => void; onPlaced: (orderID: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [failure, setFailure] = useState("");
  const used = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const remaining = reviewRemainingSeconds(prepared.preparedAt, now);
  const expired = remaining === 0;
  const spent = used.current || !!failure;
  const draft = prepared.draft, opening = isOpening(draft.action);
  const market = draft.kind === "MARKET";
  const sending = m.sending;
  const entryBlocked = orderEntryBlocked(m.blockedCode, draft.action);
  const disabled = expired || sending || spent || m.locked || entryBlocked;
  const confirm = async () => {
    // Checked again at the moment of the press; a blocked press does not spend the review.
    if (used.current || m.sending || m.locked || orderEntryBlocked(m.blockedCode, prepared.draft.action) || reviewExpired(prepared.preparedAt, Date.now())) return;
    used.current = true; // One review, one confirmation.
    const result = await m.place(prepared);
    if (result.orderID) onPlaced(result.orderID);
    else setFailure(result.error ?? "操作失败，请稍后重试。");
  };
  return (
    <View style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.pageContent, { gap: 10, paddingBottom: 24 + tabClearance + 100 }]}>
        <Text style={{ color: p.text, fontSize: 20, fontWeight: "700" }}>核对委托</Text>
        {!prepared.isDemo && <Notice palette={p} text="真实账户：确认后会发送到 MEXC。" />}
        {prepared.isDemo && <Notice palette={p} tone="info" text="演示账户，不会发送到交易所。" />}
        {opening && <Notice palette={p} text="杠杆交易可能被强平，亏损可能超过预期。" />}
        <View style={[styles.card, { backgroundColor: p.surface, gap: 10, marginBottom: 0 }]}>
          <Line palette={p} label="方向" value={mexcActionLabels[draft.action]} strong color={draft.action === "OPEN_LONG" || draft.action === "CLOSE_LONG" ? p.up : p.down} />
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
          </>}
          {!opening && <Line palette={p} label="可平张数" value={prepared.closable === undefined ? "—" : String(prepared.closable)} />}
          <Line palette={p} label="吃单 / 挂单手续费率" value={`${percent(prepared.takerFeeRate, 3)} / ${percent(prepared.makerFeeRate, 3)}`} />
          <Line palette={p} label="资金费率" value={percent(prepared.fundingRate, 4)} />
        </View>
        {market && (
          <Notice palette={p} tone="info"
            text={`市价单按保护价成交，最多偏离 ${limits ? percent(limits.marketProtection, 2) : "—"}，超出部分取消。`} />
        )}
        {/* An unknown outcome must not invite another attempt. */}
        {!!failure && <Notice palette={p} text={m.locked ? failure : failure + " 本次核对已作废，如需继续请重新核对。"} />}
        {m.locked && <Notice palette={p} text="交易已锁定，不能确认。" />}
        {!m.locked && entryBlocked && !!m.blockedText && <Notice palette={p} text={m.blockedText} />}
      </ScrollView>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, gap: 8, paddingTop: 8, paddingHorizontal: 12, paddingBottom: tabClearance, backgroundColor: p.background }}>
        <Text style={{ color: expired || spent ? p.up : p.secondary, fontSize: 12, textAlign: "center" }}>
          {spent ? "本次核对已作废" : expired ? "核对已过期，请重新核对" : `核对有效，还剩 ${remaining} 秒`}
        </Text>
        <View style={styles.row}>
          <View style={{ flex: 1 }}><Button label="返回修改" palette={p} variant="tinted" color={p.secondary} disabled={sending} onPress={onBack} /></View>
          <View style={{ flex: 1.4 }}>
            {expired || failure
              ? <Button label="重新核对" palette={p} variant="filled" disabled={sending || m.locked || entryBlocked} onPress={onRecheck} />
              : <Button label={sending ? "发送中…" : "确认下单"} palette={p} variant="filled" disabled={disabled} onPress={() => void confirm()} />}
          </View>
        </View>
      </View>
    </View>
  );
}
