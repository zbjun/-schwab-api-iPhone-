import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { DemoNotice } from "../DemoNotice.tsx";
import type { Palette } from "../types.ts";
import type { MexcContract, MexcLeverageDraft, MexcLeveragePrepared, MexcPosition } from "../mexcRules.ts";
import { Button, Glass, Stepper, money, radius, styles, tabBar } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import {
  CONFIRM_ARM_DELAY, clampLeverage, confirmArmed, leverageChoice, orderEntryBlocked, priceText, reviewExpired, reviewRemainingSeconds,
} from "./mexcView.ts";
import { Line, Notice } from "./parts.tsx";

const directionLabel = (direction: "LONG" | "SHORT") => (direction === "LONG" ? "多仓" : "空仓");
const leverageBlocked = (m: MexcState) => orderEntryBlocked(m.blockedCode, "OPEN_LONG");

/**
 * Changes the leverage of the position already held. It follows an order's rules: one review
 * from the server, valid 60 seconds and usable once, and an unknown outcome locks trading.
 */
export default function MexcLeverageEditor({ m, palette: p, contract, position, maxHeight, onClose }: {
  m: MexcState; palette: Palette; contract: MexcContract; position: MexcPosition; maxHeight: number; onClose: () => void;
}) {
  const [prepared, setPrepared] = useState<MexcLeveragePrepared>();
  const [reviewing, setReviewing] = useState(false);
  // positions is left out on purpose: here the held position's leverage is what is being changed, not a fixed value.
  const choice = m.limits ? leverageChoice(contract, m.limits, [], "OPEN_LONG") : undefined;
  // undefined means the field was cleared and is waiting for a number.
  const [value, setValue] = useState<number | undefined>(() => (choice ? clampLeverage(position.leverage, choice) : position.leverage));
  const leverage = choice ? clampLeverage(value ?? choice.min, choice) : value;
  const key = `${position.id}:${value === undefined ? "" : leverage}`;
  const latestKey = useRef(key);
  latestKey.current = key;
  const panel = { backgroundColor: p.surface, borderTopWidth: 1, borderTopColor: p.separator } as const;
  const unchanged = leverage === position.leverage;
  const disabled = m.locked || leverageBlocked(m) || m.sending || reviewing || !choice || value === undefined || unchanged;

  const review = async () => {
    if (disabled || leverage === undefined) return;
    const draft: MexcLeverageDraft = { kind: "LEVERAGE", symbol: contract.symbol, positionId: position.id, leverage };
    setReviewing(true);
    try {
      const result = await m.run(() => m.api.reviewLeverage(draft));
      // Changed while the review was on its way: that review is not what the form now says. It expires unused.
      if (result && latestKey.current === key) setPrepared(result);
    } finally {
      setReviewing(false);
    }
  };

  if (prepared)
    return (
      <View style={[panel, { height: maxHeight }]}>
        <LeverageReview m={m} palette={p} prepared={prepared} onBack={() => setPrepared(undefined)}
          onRecheck={() => { setPrepared(undefined); void review(); }} onChanged={onClose} />
      </View>
    );
  const small = { color: p.secondary, fontSize: 12, lineHeight: 17 } as const;
  const ordersOpen = m.openOrders.some(order => order.symbol === contract.symbol);
  return (
    <View style={[panel, { maxHeight, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, gap: 6 }]}>
      <View style={styles.spread}>
        <Text style={{ color: p.text, fontSize: 15, fontWeight: "700" }}>修改杠杆 · {directionLabel(position.direction)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="返回下单" hitSlop={6} disabled={m.sending || reviewing} onPress={onClose}
          style={{ width: 28, height: 32, alignItems: "center", justifyContent: "center", opacity: m.sending || reviewing ? 0.4 : 1 }}>
          <Text style={{ color: p.secondary, fontSize: 20, lineHeight: 24 }}>×</Text>
        </Pressable>
      </View>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 6 }}>
        <View style={styles.spread}>
          <Text style={[small, styles.number]}>当前 {position.leverage}x · 持仓 {position.holdVol} 张</Text>
          <Text style={[small, styles.number]}>强平价 {priceText(position.liquidatePrice, contract.priceUnit)}</Text>
        </View>
        <View style={styles.spread}>
          <Text style={[small, styles.number]}>保证金 {position.margin === undefined ? "—" : `${money(position.margin)} USDT`}</Text>
          <Text style={[small, styles.number]}>可用 {m.account ? `${money(m.account.asset.availableOpen)} USDT` : "—"}</Text>
        </View>
        {choice
          ? <Stepper compact palette={p} label="杠杆" value={value === undefined ? "" : String(leverage)} keyboardType="number-pad"
            onChangeText={text => { const digits = text.replace(/\D/g, ""); setValue(digits ? Number(digits) : undefined); }}
            onStep={direction => setValue(clampLeverage((leverage ?? choice.min) + direction, choice))} />
          : <Text style={small}>尚未读取到服务器杠杆上限，暂不能核对。</Text>}
        {!!choice && <Text style={small}>可选 {choice.min}x–{choice.max}x（取服务器上限和合约上限的较小值）</Text>}
        <Notice palette={p} tone="info" text="提高杠杆，强平价可能更接近现价。降低杠杆可能要追加保证金，可用不够时 MEXC 会拒绝。" />
        {ordersOpen && <Notice palette={p} tone="info" text="该合约还有未成交的委托，MEXC 不允许修改杠杆，需要先撤单。" />}
        {leverageBlocked(m) && !!m.blockedText && <Notice palette={p} text={m.blockedText} />}
      </ScrollView>
      {unchanged && !m.locked && <Text style={{ color: p.secondary, fontSize: 12, textAlign: "center" }}>请选择和当前不同的杠杆。</Text>}
      <Button label={reviewing ? "正在核对…" : m.locked ? "交易已锁定" : "核对修改"} palette={p} variant="filled" disabled={disabled} onPress={() => void review()} />
    </View>
  );
}

/** Shows only what the server returned. Confirm can be pressed once, and never retries. */
function LeverageReview({ m, palette: p, prepared, onBack, onRecheck, onChanged }: {
  m: MexcState; palette: Palette; prepared: MexcLeveragePrepared; onBack: () => void; onRecheck: () => void; onChanged: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [failure, setFailure] = useState("");
  const [floatingHeight, setFloatingHeight] = useState(96);
  const used = useRef(false);
  const shownAt = useRef(Date.now());
  // Stays set after the lock is lifted: this review belongs to a change whose outcome was never known.
  const outcomeUnknown = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    const arm = setTimeout(() => setNow(Date.now()), CONFIRM_ARM_DELAY);
    return () => { clearInterval(timer); clearTimeout(arm); };
  }, []);
  const remaining = reviewRemainingSeconds(prepared.preparedAt, now);
  const expired = remaining === 0;
  const spent = used.current || !!failure;
  const blocked = leverageBlocked(m);
  const disabled = !confirmArmed(shownAt.current, now) || expired || m.sending || spent || m.locked || blocked;
  const confirm = async () => {
    // Checked again at the moment of the press; a blocked press does not spend the review.
    if (used.current || !confirmArmed(shownAt.current, Date.now()) || m.sending || m.locked || leverageBlocked(m) || reviewExpired(prepared.preparedAt, Date.now())) return;
    used.current = true; // One review, one confirmation.
    const result = await m.changeLeverage(prepared);
    if (result.leverage !== undefined) { onChanged(); return; }
    if (result.unknown) outcomeUnknown.current = true;
    setFailure(result.error ?? "操作失败，请稍后重试。");
  };
  const { draft } = prepared;
  const raising = draft.leverage > prepared.previousLeverage;
  return (
    <View style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.pageContent, { gap: 10, paddingBottom: floatingHeight + 22 }]}>
        {prepared.isDemo && <DemoNotice palette={p} card />}
        {/* Above the details: confirm is always on screen, so what it means must be too. An unknown outcome must not invite another attempt. */}
        {!!failure && <Notice palette={p} text={outcomeUnknown.current ? failure : failure + " 本次核对已作废，如需继续请重新核对。"} />}
        {m.locked && <Notice palette={p} text="交易已锁定，不能确认。" />}
        {!m.locked && blocked && !!m.blockedText && <Notice palette={p} text={m.blockedText} />}
        {!prepared.isDemo && <Notice palette={p} text="真实账户：确认后会发送到 MEXC。" />}
        {prepared.isDemo && <Notice palette={p} tone="info" text="演示账户，不会发送到交易所。" />}
        <Notice palette={p} text={raising ? "提高杠杆后，强平价可能更接近现价，亏损可能超过预期。" : "降低杠杆可能要追加保证金，可用不够时 MEXC 会拒绝。"} />
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: 12, gap: 8 }}>
          <Text style={{ color: p.secondary, fontSize: 12 }}>核对杠杆修改</Text>
          <Text style={{ color: p.text, fontSize: 19, fontWeight: "700" }}>{prepared.previousLeverage}x → {draft.leverage}x</Text>
          <View style={{ height: 1, backgroundColor: p.separator }} />
          <View>
            <Line palette={p} label="合约" value={prepared.displayName || draft.symbol} />
            <Line palette={p} label="代码" value={draft.symbol} />
            <Line palette={p} label="持仓方向" value={`${directionLabel(prepared.direction)}（逐仓）`} />
            <Line palette={p} label="持仓张数" value={String(prepared.holdVol)} />
            <Line palette={p} label="开仓均价" value={String(prepared.averagePrice)} />
            <Line palette={p} label="当前保证金" value={prepared.margin === undefined ? "—" : `${money(prepared.margin)} USDT`} />
            <Line palette={p} label="当前强平价" value={prepared.liquidatePrice === undefined ? "—" : String(prepared.liquidatePrice)} />
            <Line palette={p} label="可用保证金" value={`${money(prepared.available)} USDT`} />
          </View>
        </View>
      </ScrollView>
      <Glass palette={p} style={{ position: "absolute", left: tabBar.inset, right: tabBar.inset, bottom: 6, borderRadius: 20 }}>
        <View onLayout={event => setFloatingHeight(Math.ceil(event.nativeEvent.layout.height))} style={{ padding: 8, gap: 6 }}>
          <Text style={{ color: expired || spent ? p.up : p.secondary, fontSize: 12, textAlign: "center" }}>
            {spent ? "本次核对已作废" : expired ? "核对已过期，请重新核对" : `核对有效，还剩 ${remaining} 秒`}
          </Text>
          <View style={[styles.row, { gap: 8 }]}>
            <View style={{ flex: 1 }}><Button label="返回修改" palette={p} variant="tinted" color={p.secondary} disabled={m.sending} onPress={onBack} /></View>
            {!outcomeUnknown.current && (
              <View style={{ flex: 2 }}>
                {expired || failure
                  ? <Button label="重新核对" palette={p} variant="filled" disabled={m.sending || m.locked || blocked} onPress={onRecheck} />
                  : <Button label={m.sending ? "发送中…" : "确认修改"} palette={p} variant="filled" disabled={disabled} onPress={() => void confirm()} />}
              </View>
            )}
          </View>
        </View>
      </Glass>
    </View>
  );
}
