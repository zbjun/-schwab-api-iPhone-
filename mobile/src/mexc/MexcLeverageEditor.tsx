import React, { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import type { MexcContract, MexcLeverageDraft, MexcLeveragePrepared, MexcPosition } from "../mexcRules.ts";
import { Button, Stepper, money, styles } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { clampLeverage, leverageChoice, orderEntryBlocked, priceText } from "./mexcView.ts";
import { Line, Notice } from "./parts.tsx";
import MexcWriteReview from "./MexcWriteReview.tsx";

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

function LeverageReview({ m, palette: p, prepared, onBack, onRecheck, onChanged }: {
  m: MexcState; palette: Palette; prepared: MexcLeveragePrepared; onBack: () => void; onRecheck: () => void; onChanged: () => void;
}) {
  const { draft } = prepared;
  const raising = draft.leverage > prepared.previousLeverage;
  const send = async () => {
    const result = await m.changeLeverage(prepared);
    return { done: result.leverage !== undefined, error: result.error, unknown: result.unknown };
  };
  return (
    <MexcWriteReview m={m} palette={p} isDemo={prepared.isDemo} preparedAt={prepared.preparedAt} blocked={leverageBlocked(m)}
      heading="核对杠杆修改" title={`${prepared.previousLeverage}x → ${draft.leverage}x`}
      warning={raising ? "提高杠杆后，强平价可能更接近现价，亏损可能超过预期。" : "降低杠杆可能要追加保证金，可用不够时 MEXC 会拒绝。"}
      confirmLabel="确认修改" send={send} onBack={onBack} onRecheck={onRecheck} onDone={onChanged}>
      <Line palette={p} label="合约" value={prepared.displayName || draft.symbol} />
      <Line palette={p} label="代码" value={draft.symbol} />
      <Line palette={p} label="持仓方向" value={`${directionLabel(prepared.direction)}（逐仓）`} />
      <Line palette={p} label="持仓张数" value={String(prepared.holdVol)} />
      <Line palette={p} label="开仓均价" value={String(prepared.averagePrice)} />
      <Line palette={p} label="当前保证金" value={prepared.margin === undefined ? "—" : `${money(prepared.margin)} USDT`} />
      <Line palette={p} label="当前强平价" value={prepared.liquidatePrice === undefined ? "—" : String(prepared.liquidatePrice)} />
      <Line palette={p} label="可用保证金" value={`${money(prepared.available)} USDT`} />
    </MexcWriteReview>
  );
}
