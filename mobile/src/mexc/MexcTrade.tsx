import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { DemoNotice } from "../DemoNotice.tsx";
import type { Palette } from "../types.ts";
import { isBuying, mexcActionLabels } from "../mexcRules.ts";
import type { MexcAction } from "../mexcRules.ts";
import { Button, Chip, Glass, Input, Stepper, elevated, money, radius, styles, tabBar, tabClearance } from "../ui.tsx";
import { useTickers, type MexcState } from "./useMexc.ts";
import { percent, priceText, signedPercent, sortContracts, STOCK_NOTE, isStockContract } from "./mexcView.ts";
import { Line, Notice, PositionSlider } from "./parts.tsx";
import MexcReview from "./MexcReview.tsx";
import { useOrderTicket } from "./useOrderTicket.ts";

export interface TradeSeed { nonce: number; symbol?: string; action?: MexcAction }
const ACTIONS: MexcAction[] = ["OPEN_LONG", "OPEN_SHORT", "CLOSE_LONG", "CLOSE_SHORT"];

export default function MexcTrade({ m, palette: p, seed }: { m: MexcState; palette: Palette; seed: TradeSeed }) {
  const [symbol, setSymbol] = useState(seed.symbol ?? "");
  const [action, setAction] = useState<MexcAction>(seed.action ?? "OPEN_LONG");
  const [query, setQuery] = useState("");
  const [floatingHeight, setFloatingHeight] = useState(96);

  const sorted = useMemo(() => sortContracts(m.contracts, query), [m.contracts, query]);
  const tickers = useTickers(m, symbol ? [symbol] : [], 2_000);
  const ticker = tickers[symbol];
  const t = useOrderTicket(m, symbol, action, ticker, seed.nonce);
  const { contract, kind, setKind, vol, setVol, price, leverage, opening, held, closable, choice, effectiveLeverage, notional, margin, entryBlocked, draftIssue, reviewing, submitDisabled } = t;

  // A tap on a position or "go trade" re-seeds the ticket.
  useEffect(() => {
    if (seed.symbol) setSymbol(seed.symbol);
    if (seed.action) setAction(seed.action);
  }, [seed.nonce]);
  useEffect(() => { if (!symbol && sorted.length) setSymbol(sorted[0].symbol); }, [symbol, sorted]);

  if (t.prepared)
    return (
      <MexcReview m={m} palette={p} prepared={t.prepared} limits={m.limits}
        onBack={() => t.setPrepared(undefined)}
        onRecheck={t.recheck}
        onPlaced={() => t.setPrepared(undefined)} />
    );
  // The same rule as Schwab: buying is red and selling is green, so closing a long is green.
  const tradeColor = isBuying(action) ? p.up : p.down;
  const rate = ticker?.riseFallRate;
  return (
    <View style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" scrollEnabled={!t.sizeDragging}
        contentContainerStyle={[styles.pageContent, { gap: 10, paddingBottom: tabClearance + floatingHeight + 16 }]}>
        {m.isDemo && <DemoNotice palette={p} card />}
        <View style={[styles.spread, { backgroundColor: p.surface, borderRadius: radius.card, paddingHorizontal: 12, minHeight: 42 }]}>
          <Text style={{ color: p.text, fontSize: 15, fontWeight: "600" }}>账户</Text>
          <Text style={{ color: p.secondary, fontSize: 12 }}>MEXC 合约账户</Text>
        </View>
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: 12, gap: 8 }}>
          <Input palette={p} accessibilityLabel="选择合约" placeholder="搜索合约" autoCapitalize="characters" value={query} onChangeText={setQuery} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {(contract && !sorted.some(c => c.symbol === symbol) ? [contract] : []).concat(sorted.slice(0, 8)).map(c => (
              <Chip key={c.symbol} label={c.symbol.replace("_USDT", "")} palette={p} active={c.symbol === symbol}
                accessibilityLabel={`合约 ${c.symbol}`} onPress={() => setSymbol(c.symbol)} />
            ))}
          </View>
          {!contract && <Text style={{ color: p.secondary, fontSize: 13 }}>{m.offline ? "还没有连上 MEXC 网关。" : "请选择合约。"}</Text>}
          {contract && (
            <View style={styles.spread}>
              <Text numberOfLines={1} style={{ color: p.secondary, fontSize: 13, flex: 1 }}>{contract.displayName}</Text>
              <View style={[styles.row, { gap: 8 }]}>
                <Text style={[styles.number, { color: p.text, fontSize: 17, fontWeight: "600" }]}>{priceText(ticker?.lastPrice, contract.priceUnit)}</Text>
                <Text style={[styles.number, { color: (rate ?? 0) > 0 ? p.up : (rate ?? 0) < 0 ? p.down : p.secondary, fontSize: 13, fontWeight: "600" }]}>
                  {signedPercent(rate)}
                </Text>
              </View>
            </View>
          )}
        </View>

        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: 12, gap: 12 }}>
          <View style={{ flexDirection: "row", backgroundColor: elevated(p), borderRadius: radius.control, padding: 2 }}>
            {ACTIONS.map(a => {
              const selected = a === action, color = isBuying(a) ? p.up : p.down;
              return (
                <Pressable key={a} accessibilityRole="button" accessibilityLabel={mexcActionLabels[a]} accessibilityState={{ selected }}
                  onPress={() => setAction(a)}
                  style={{ flex: 1, minHeight: 34, alignItems: "center", justifyContent: "center", borderRadius: radius.control - 2,
                    backgroundColor: selected ? color : "transparent" }}>
                  <Text style={{ color: selected ? "#fff" : p.text, fontSize: 13, fontWeight: "700" }}>{mexcActionLabels[a]}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {([
              { label: "买一", value: ticker?.bid1, color: p.up },
              { label: "卖一", value: ticker?.ask1, color: p.down },
              { label: "最新", value: ticker?.lastPrice, color: (rate ?? 0) > 0 ? p.up : (rate ?? 0) < 0 ? p.down : p.text },
            ]).map(({ label, value, color }) => {
              const valid = value !== undefined && Number.isFinite(value) && value > 0 && !!contract;
              const canFill = valid && kind === "LIMIT" && !m.sending;
              const shown = priceText(valid ? value : undefined, contract?.priceUnit);
              return (
                <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label} ${shown}${canFill ? "，填入限价" : ""}`}
                  accessibilityState={{ disabled: !canFill }} disabled={!canFill}
                  onPress={() => t.fillPrice(value!)}
                  style={({ pressed }) => ({ flex: 1, gap: 1, paddingVertical: 6, paddingHorizontal: 8, borderRadius: radius.control,
                    backgroundColor: elevated(p), opacity: pressed ? 0.6 : 1 })}>
                  <Text style={{ color: p.secondary, fontSize: 11 }}>{label}</Text>
                  <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}
                    style={{ color: valid ? color : p.secondary, fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{shown}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Chip label="限价" palette={p} active={kind === "LIMIT"} style={{ flex: 1 }} onPress={() => setKind("LIMIT")} />
            <Chip label="市价" palette={p} active={kind === "MARKET"} style={{ flex: 1 }} onPress={() => setKind("MARKET")} />
          </View>
          {contract && <>
            <Stepper palette={p} label="张数" value={vol} keyboardType="decimal-pad" onChangeText={setVol} onStep={t.stepVol} />
            <PositionSlider palette={p} color={tradeColor} value={t.sizeFraction} disabled={t.sliderDisabled} onChange={t.chooseFraction}
              onDragStart={t.beginSizeDrag} onDragEnd={t.endSizeDrag} />
            {kind === "LIMIT" && (
              <Stepper palette={p} label="价格" value={price} keyboardType="decimal-pad" onChangeText={t.typePrice} onStep={t.stepPrice} />
            )}
            {opening && choice && (
              choice.fixed !== undefined
                ? <Line palette={p} label="杠杆" value={`${choice.fixed}x（跟随持仓，可在合约详情页修改）`} />
                : <Stepper palette={p} label="杠杆" value={leverage === undefined ? "" : String(effectiveLeverage)} keyboardType="number-pad"
                  onChangeText={t.typeLeverage} onStep={t.stepLeverage} />
            )}
            {opening && !choice && <Text style={{ color: p.secondary, fontSize: 12 }}>尚未读取到服务器杠杆上限，暂不能核对。</Text>}
            {opening && choice && choice.fixed === undefined && (
              <Text style={{ color: p.secondary, fontSize: 12 }}>可选 {choice.min}x–{choice.max}x（取服务器上限和合约上限的较小值）</Text>
            )}
            <View style={{ height: 1, backgroundColor: p.separator }} />
            <View>
              <Line palette={p} label="折算金额（估算）" value={notional === undefined ? "—" : `${money(notional)} USDT`} />
              {opening && <Line palette={p} label="所需保证金（估算）" value={margin === undefined ? "—" : `${money(margin)} USDT`} />}
              {opening && m.account && <Line palette={p} label="可用" value={`${money(m.account.asset.availableOpen)} USDT`} />}
              {!opening && <Line palette={p} label="可平张数" value={held ? `${closable}（持仓 ${held.holdVol}，占用 ${held.frozenVol}）` : "0"} />}
            </View>
            <Text style={{ color: p.secondary, fontSize: 11, lineHeight: 16 }}>
              每张 {contract.contractSize} · 最小 {contract.minVol} 张 · 步长 {contract.volUnit} · 最小价位 {contract.priceUnit} · 费率 {percent(contract.takerFeeRate, 3)}
            </Text>
          </>}
        </View>
        {kind === "MARKET" && (
          <Notice palette={p} tone="info"
            text={`市价单按保护价成交，最多偏离 ${m.limits ? percent(m.limits.marketProtection, 2) : "—"}，超出部分取消。`} />
        )}
        {contract && isStockContract(contract) && <Notice palette={p} tone="info" text={STOCK_NOTE} />}
        {opening && <Notice palette={p} text="杠杆交易可能被强平。" />}
        {entryBlocked && !!m.blockedText && <Notice palette={p} text={m.blockedText} />}
      </ScrollView>
      <Glass palette={p} style={{ position: "absolute", left: tabBar.inset, right: tabBar.inset, bottom: tabClearance, borderRadius: 20 }}>
        <View onLayout={event => setFloatingHeight(Math.ceil(event.nativeEvent.layout.height))} style={{ padding: 8, gap: 6 }}>
          {!!draftIssue && !m.locked && <Text numberOfLines={2} style={{ color: p.secondary, fontSize: 12, textAlign: "center" }}>{draftIssue}</Text>}
          <Button label={reviewing ? "正在核对…" : m.locked ? "交易已锁定" : "核对委托"} palette={p} variant="filled" color={tradeColor}
            disabled={submitDisabled} onPress={() => void t.submit()} />
        </View>
      </Glass>
    </View>
  );
}
