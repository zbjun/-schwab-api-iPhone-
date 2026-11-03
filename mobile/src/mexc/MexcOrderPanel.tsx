import React, { useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import type { Palette } from "../types.ts";
import { isBuying, mexcActionLabels } from "../mexcRules.ts";
import type { MexcAction, MexcContract, MexcKind, MexcPosition, MexcTicker } from "../mexcRules.ts";
import { Button, Stepper, elevated, money, radius, styles } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { STOCK_NOTE, isStockContract, openTypeLabel, percent } from "./mexcView.ts";
import { Notice, PositionSlider, Segmented, StopFields } from "./parts.tsx";
import MexcLeverageEditor from "./MexcLeverageEditor.tsx";
import MexcReview from "./MexcReview.tsx";
import { useOrderTicket } from "./useOrderTicket.ts";

const OPEN_ACTIONS: MexcAction[] = ["OPEN_LONG", "OPEN_SHORT"];

/**
 * The order form inside the contract page. The same one-use review and confirmation as the trade page
 * still follow; this only moves them next to the chart.
 */
export default function MexcOrderPanel({ m, palette: p, contract, ticker, initialAction, onClose }: {
  m: MexcState; palette: Palette; contract: MexcContract; ticker?: MexcTicker; initialAction: MexcAction; onClose: () => void;
}) {
  const [action, setAction] = useState(initialAction);
  const [leverageTarget, setLeverageTarget] = useState<MexcPosition>();
  const t = useOrderTicket(m, contract.symbol, action, ticker);
  const maxHeight = Math.round(useWindowDimensions().height * 0.72);
  const panel = { backgroundColor: p.surface, borderTopWidth: 1, borderTopColor: p.separator } as const;
  if (leverageTarget)
    return (
      <MexcLeverageEditor m={m} palette={p} contract={contract} maxHeight={maxHeight} onClose={() => setLeverageTarget(undefined)}
        position={t.held?.id === leverageTarget.id ? t.held : leverageTarget} />
    );
  if (t.prepared)
    return (
      <View style={[panel, { height: maxHeight }]}>
        <MexcReview embedded m={m} palette={p} prepared={t.prepared} limits={m.limits}
          onBack={() => t.setPrepared(undefined)} onRecheck={t.recheck} onPlaced={onClose} />
      </View>
    );
  // The same rule as Schwab: buying is red and selling is green, so closing a long is green.
  const tradeColor = isBuying(action) ? p.up : p.down;
  const small = { color: p.secondary, fontSize: 12, lineHeight: 17 } as const;
  const tooSmall = t.capacity !== undefined && t.capacity < contract.minVol;
  return (
    <View style={[panel, { maxHeight, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, gap: 6 }]}>
      <View style={[styles.row, { gap: 8 }]}>
        <View style={{ flex: 1, justifyContent: "center" }}>
          {t.opening ? (
            <Segmented palette={p} value={action} onChange={setAction}
              options={OPEN_ACTIONS.map(id => ({ id, label: mexcActionLabels[id], color: isBuying(id) ? p.up : p.down }))} />
          ) : (
            <Text style={{ color: tradeColor, fontSize: 15, fontWeight: "700" }}>{mexcActionLabels[action]}</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Segmented<MexcKind> palette={p} value={t.kind} onChange={t.setKind}
            options={[{ id: "LIMIT", label: "限价" }, { id: "MARKET", label: "市价" }]} />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭下单面板" hitSlop={6} disabled={m.sending || t.reviewing} onPress={onClose}
          style={{ width: 28, height: 32, alignItems: "center", justifyContent: "center", opacity: m.sending || t.reviewing ? 0.4 : 1 }}>
          <Text style={{ color: p.secondary, fontSize: 20, lineHeight: 24 }}>×</Text>
        </Pressable>
      </View>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" scrollEnabled={!t.sizeDragging} style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 6 }}>
        {t.kind === "LIMIT" && (
          <Stepper compact palette={p} label="价格" value={t.price} keyboardType="decimal-pad" onChangeText={t.typePrice} onStep={t.stepPrice} />
        )}
        {t.opening && t.choice?.fixed !== undefined && t.held?.openType === 1 ? (
          <View style={styles.row}>
            <Text numberOfLines={1} style={{ color: p.secondary, fontSize: 13, width: 34 }}>杠杆</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`修改持仓杠杆，当前 ${t.choice.fixed}x`} disabled={m.sending || t.reviewing} onPress={() => setLeverageTarget(t.held)}
              style={({ pressed }) => ({ flex: 1, height: 36, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: radius.control,
                backgroundColor: elevated(p), opacity: pressed ? 0.6 : 1 })}>
              <Text style={[styles.number, { color: p.text, fontSize: 15, fontWeight: "600" }]}>{t.choice.fixed}x</Text>
              <Text style={{ color: p.accent, fontSize: 13, fontWeight: "600" }}>修改</Text>
            </Pressable>
          </View>
        ) : t.opening && t.choice && (
          <Stepper compact palette={p} label="杠杆" disabled={t.choice.fixed !== undefined} keyboardType="number-pad"
            value={t.leverage === undefined && t.choice.fixed === undefined ? "" : String(t.effectiveLeverage)}
            onChangeText={t.typeLeverage} onStep={t.stepLeverage} />
        )}
        <Stepper compact palette={p} label="张数" value={t.vol} keyboardType="decimal-pad" onChangeText={t.setVol} onStep={t.stepVol} />
        <PositionSlider palette={p} color={tradeColor} value={t.sizeFraction} disabled={t.sliderDisabled} onChange={t.chooseFraction}
          onDragStart={t.beginSizeDrag} onDragEnd={t.endSizeDrag} />
        {t.opening && !!t.held && !t.stopsWereDropped && <Text style={{ color: p.secondary, fontSize: 11, lineHeight: 15 }}>这个方向已有持仓，止盈止损请关闭面板后在持仓条上设置。</Text>}
        {t.stopsWereDropped && <Button label="清除价格" palette={p} variant="tinted" color={p.secondary} onPress={t.clearStops} />}
        {t.opening && !t.held && (
          <StopFields compact palette={p} on={t.stopsOn} onToggle={t.setStopsOn} takeProfit={t.takeProfit} stopLoss={t.stopLoss}
            onTakeProfit={t.setTakeProfit} onStopLoss={t.setStopLoss} onStepTakeProfit={t.stepTakeProfit} onStepStopLoss={t.stepStopLoss} />
        )}
        {t.opening ? (
          <View style={styles.spread}>
            <Text numberOfLines={1} style={[small, { flexShrink: 1 }]}>
              {!t.choice ? "尚未读取到服务器杠杆上限，暂不能核对。"
                : t.choice.fixed !== undefined ? `${openTypeLabel(t.held?.openType)} · 已有同向持仓，杠杆跟随持仓`
                  : contract.positionOpenType === 2 ? "该合约只支持全仓，暂不能开仓"
                    : `逐仓 · 可选 ${t.choice.min}x–${t.choice.max}x`}
            </Text>
            <Text numberOfLines={1} style={[small, styles.number]}>可用 {m.account ? `${money(m.account.asset.availableOpen)} USDT` : "—"}</Text>
          </View>
        ) : (
          <View style={styles.spread}>
            <Text numberOfLines={1} style={[small, styles.number]}>可平 {t.closable} 张</Text>
            <Text numberOfLines={1} style={[small, styles.number]}>{t.held ? `持仓 ${t.held.holdVol}，占用 ${t.held.frozenVol}` : "没有持仓"}</Text>
          </View>
        )}
        <View style={styles.spread}>
          <Text numberOfLines={1} style={[small, styles.number]}>折算（估算） {t.notional === undefined ? "—" : `${money(t.notional)} USDT`}</Text>
          {t.opening && <Text numberOfLines={1} style={[small, styles.number]}>保证金（估算） {t.margin === undefined ? "—" : `${money(t.margin)} USDT`}</Text>}
        </View>
        <Text numberOfLines={1} style={{ color: p.secondary, fontSize: 11, lineHeight: 15 }}>
          每张 {contract.contractSize} · 最小 {contract.minVol} 张 · 步长 {contract.volUnit}{t.opening && !tooSmall && t.capacity !== undefined ? ` · 最多可开 ${t.capacity} 张` : ""}
        </Text>
        {tooSmall && <Notice palette={p} tone="info" text={t.opening ? `可用保证金不够开最小 ${contract.minVol} 张。` : `可平张数低于最小 ${contract.minVol} 张，这里无法平仓。`} />}
        {t.kind === "MARKET" && (
          <Notice palette={p} tone="info" text={`市价单按保护价成交，最多偏离 ${m.limits ? percent(m.limits.marketProtection, 2) : "—"}，超出部分取消。`} />
        )}
        {t.opening && <Notice palette={p} tone="info" text={`杠杆交易可能被强平。${isStockContract(contract) ? STOCK_NOTE : ""}`} />}
        {t.entryBlocked && !!m.blockedText && <Notice palette={p} text={m.blockedText} />}
      </ScrollView>
      {!!t.draftIssue && !m.locked && <Text numberOfLines={2} style={{ color: p.secondary, fontSize: 12, textAlign: "center" }}>{t.draftIssue}</Text>}
      <Button label={t.reviewing ? "正在核对…" : m.locked ? "交易已锁定" : "核对委托"} palette={p} variant="filled" color={tradeColor}
        disabled={t.submitDisabled} onPress={() => void t.submit()} />
    </View>
  );
}
