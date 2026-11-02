import React, { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import { isBuying, isOpening, mexcActionLabels, validateMexcDraft } from "../mexcRules.ts";
import type { MexcAction, MexcDraft, MexcKind, MexcPrepared } from "../mexcRules.ts";
import { Button, Chip, Input, Stepper, money, styles, tabClearance } from "../ui.tsx";
import { useTickers, type MexcState } from "./useMexc.ts";
import {
  clampLeverage, closableOf, estimatePrice, findPosition, hasClosable, leverageChoice, marginOf, notionalOf, percent, priceText,
  orderEntryBlocked, snapToTick, sortContracts, stepDecimal, STOCK_NOTE, isStockContract,
} from "./mexcView.ts";
import { Line, Notice } from "./parts.tsx";
import MexcReview from "./MexcReview.tsx";

export interface TradeSeed { nonce: number; symbol?: string; action?: MexcAction }
const ACTIONS: MexcAction[] = ["OPEN_LONG", "OPEN_SHORT", "CLOSE_LONG", "CLOSE_SHORT"];

export default function MexcTrade({ m, palette: p, seed }: { m: MexcState; palette: Palette; seed: TradeSeed }) {
  const [symbol, setSymbol] = useState(seed.symbol ?? "");
  const [action, setAction] = useState<MexcAction>(seed.action ?? "OPEN_LONG");
  const [kind, setKind] = useState<MexcKind>("LIMIT");
  const [vol, setVol] = useState("");
  const [price, setPrice] = useState("");
  // undefined means the field was cleared and is waiting for a number.
  const [leverage, setLeverage] = useState<number | undefined>(5);
  const [query, setQuery] = useState("");
  const [prepared, setPrepared] = useState<MexcPrepared>();
  const [reviewing, setReviewing] = useState(false);
  // Once the user has touched the price (or it was prefilled), a quote update never overwrites it.
  const priceSettled = useRef(false);

  const sorted = useMemo(() => sortContracts(m.contracts, query), [m.contracts, query]);
  const contract = m.contracts.find(c => c.symbol === symbol);
  const positions = m.account?.positions ?? [];
  const tickers = useTickers(m, symbol ? [symbol] : [], 5_000);
  const ticker = tickers[symbol];
  const opening = isOpening(action), buying = isBuying(action);
  const held = findPosition(positions, symbol, action);
  const closable = held ? closableOf(held) : "0";
  const choice = contract && m.limits ? leverageChoice(contract, m.limits, positions, action) : undefined;
  const leverageEmpty = opening && leverage === undefined && choice?.fixed === undefined;
  const effectiveLeverage = choice ? clampLeverage(leverage ?? choice.min, choice) : leverage ?? 1;

  // A tap on a position or "go trade" re-seeds the ticket.
  useEffect(() => {
    if (seed.symbol) setSymbol(seed.symbol);
    if (seed.action) setAction(seed.action);
    setPrepared(undefined); setPrice(""); priceSettled.current = false;
  }, [seed.nonce]);
  useEffect(() => { if (!symbol && sorted.length) setSymbol(sorted[0].symbol); }, [symbol, sorted]);
  // Default size when the contract or side changes: the whole closable amount when closing, else the minimum.
  useEffect(() => {
    if (!contract) return;
    setVol(!isOpening(action) && hasClosable(closable) ? closable : String(contract.minVol));
    setPrice(""); priceSettled.current = false;
  }, [symbol, action, contract?.symbol]);
  useEffect(() => {
    if (contract && ticker && !priceSettled.current) { priceSettled.current = true; setPrice(snapToTick(ticker.lastPrice, contract.priceUnit)); }
  }, [contract, ticker, symbol, action, price]);

  const draft: MexcDraft = {
    symbol, action, kind, vol: vol.trim(),
    ...(kind === "LIMIT" ? { price: price.trim() } : {}),
    ...(opening ? { leverage: effectiveLeverage } : {}),
  };
  let draftIssue = "";
  try { validateMexcDraft(draft); } catch (error) { draftIssue = error instanceof Error ? error.message : "委托参数无效。"; }
  if (!draftIssue && kind === "LIMIT" && !price.trim()) draftIssue = "请输入价格。";
  if (!draftIssue && !opening && !hasClosable(closable)) draftIssue = "该方向没有可平的持仓。";

  const estimate = contract ? estimatePrice(kind, buying, price, ticker) : undefined;
  const notional = contract ? notionalOf(vol, contract.contractSize, estimate) : undefined;
  const margin = marginOf(notional, effectiveLeverage);
  // Without the server limits the leverage cap is unknown, so opening waits for them.
  const limitsMissing = opening && !choice;
  const entryBlocked = orderEntryBlocked(m.blockedCode, action);
  const submitDisabled = m.locked || entryBlocked || !!draftIssue || reviewing || !contract || limitsMissing || leverageEmpty || m.sending;

  const submit = async () => {
    if (submitDisabled) return;
    setReviewing(true);
    try {
      const result = await m.run(() => m.api.review(draft));
      if (result) setPrepared(result);
    } finally {
      setReviewing(false);
    }
  };

  if (prepared)
    return (
      <MexcReview m={m} palette={p} prepared={prepared} limits={m.limits}
        onBack={() => setPrepared(undefined)}
        onRecheck={() => { setPrepared(undefined); void submit(); }}
        onPlaced={() => setPrepared(undefined)} />
    );
  return (
    <View style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.pageContent, { gap: 10, paddingBottom: 24 + tabClearance + 120 }]}>
        <View style={[styles.card, { backgroundColor: p.surface, gap: 8, marginBottom: 0 }]}>
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
              <Text style={[styles.number, { color: p.text, fontSize: 17 }]}>{priceText(ticker?.lastPrice, contract.priceUnit)}</Text>
            </View>
          )}
        </View>

        <View style={{ flexDirection: "row", gap: 6 }}>
          {ACTIONS.map(a => (
            <Chip key={a} label={mexcActionLabels[a]} palette={p} active={a === action} style={{ flex: 1 }}
              color={a === "OPEN_LONG" || a === "CLOSE_LONG" ? p.up : p.down} onPress={() => setAction(a)} />
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Chip label="限价" palette={p} active={kind === "LIMIT"} style={{ flex: 1 }} onPress={() => setKind("LIMIT")} />
          <Chip label="市价" palette={p} active={kind === "MARKET"} style={{ flex: 1 }} onPress={() => setKind("MARKET")} />
        </View>

        {contract && (
          <View style={[styles.card, { backgroundColor: p.surface, gap: 10, marginBottom: 0 }]}>
            <Stepper palette={p} label="张数" value={vol} keyboardType="decimal-pad" onChangeText={setVol}
              onStep={d => {
                const next = stepDecimal(vol, contract.volUnit, d, contract.minVol);
                setVol(!opening && hasClosable(closable) && Number(next) > Number(closable) ? closable : next);
              }} />
            {kind === "LIMIT" && (
              <Stepper palette={p} label="价格" value={price} keyboardType="decimal-pad" onChangeText={value => { priceSettled.current = true; setPrice(value); }}
                onStep={d => { priceSettled.current = true; setPrice(stepDecimal(price || String(ticker?.lastPrice ?? contract.priceUnit), contract.priceUnit, d)); }} />
            )}
            {opening && choice && (
              choice.fixed !== undefined
                ? <Line palette={p} label="杠杆" value={`${choice.fixed}x（同方向持仓，固定）`} />
                : <Stepper palette={p} label="杠杆" value={leverage === undefined ? "" : String(effectiveLeverage)} keyboardType="number-pad"
                  onChangeText={value => { const digits = value.replace(/\D/g, ""); setLeverage(digits ? Number(digits) : undefined); }}
                  onStep={d => setLeverage(clampLeverage(effectiveLeverage + d, choice))} />
            )}
            {opening && !choice && <Text style={{ color: p.secondary, fontSize: 12 }}>尚未读取到服务器杠杆上限，暂不能核对。</Text>}
            {opening && choice && choice.fixed === undefined && (
              <Text style={{ color: p.secondary, fontSize: 12 }}>可选 {choice.min}x–{choice.max}x（取服务器上限和合约上限的较小值）</Text>
            )}
            <Line palette={p} label={kind === "MARKET" ? "折算金额（估算）" : "折算金额"} value={notional === undefined ? "—" : `${money(notional)} USDT`} />
            {opening && <Line palette={p} label="所需保证金（估算）" value={margin === undefined ? "—" : `${money(margin)} USDT`} />}
            {opening && m.account && <Line palette={p} label="可用" value={`${money(m.account.asset.availableOpen)} USDT`} />}
            {!opening && <Line palette={p} label="可平张数" value={held ? `${closable}（持仓 ${held.holdVol}，占用 ${held.frozenVol}）` : "0"} />}
            <Text style={{ color: p.secondary, fontSize: 12 }}>
              每张 {contract.contractSize} · 最小 {contract.minVol} 张 · 步长 {contract.volUnit} · 最小价位 {contract.priceUnit} · 费率 {percent(contract.takerFeeRate, 3)}
            </Text>
          </View>
        )}
        {kind === "MARKET" && (
          <Notice palette={p} tone="info"
            text={`市价单按保护价成交，最多偏离 ${m.limits ? percent(m.limits.marketProtection, 2) : "—"}，超出部分取消。`} />
        )}
        {contract && isStockContract(contract) && <Notice palette={p} tone="info" text={STOCK_NOTE} />}
        {opening && <Notice palette={p} text="杠杆交易可能被强平。" />}
        {entryBlocked && !!m.blockedText && <Notice palette={p} text={m.blockedText} />}
      </ScrollView>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, gap: 6, paddingTop: 8, paddingHorizontal: 12, paddingBottom: tabClearance, backgroundColor: p.background }}>
        {!!draftIssue && !m.locked && <Text numberOfLines={2} style={{ color: p.secondary, fontSize: 12, textAlign: "center" }}>{draftIssue}</Text>}
        <Button label={reviewing ? "正在核对…" : m.locked ? "交易已锁定" : "核对委托"} palette={p} variant="filled"
          disabled={submitDisabled} onPress={() => void submit()} />
      </View>
    </View>
  );
}
