import { useEffect, useMemo, useRef, useState } from "react";
import { MEXC_MESSAGES, isBuying, isOpening, mexcActionLabels, orderStopReferences } from "../mexcRules.ts";
import type { MexcAction, MexcDraft, MexcKind, MexcPrepared, MexcTicker } from "../mexcRules.ts";
import type { MexcState } from "./useMexc.ts";
import {
  CONFIRM_ARM_DELAY, clampLeverage, closableOf, closeEstimate, createQuickGate, draftIssueOf, expectedFill, findPosition, fractionOfCapacity, hasClosable, leverageChoice, marginFor, marginOf, notionalOf, openCapacity,
  orderEntryBlocked, quickSendAllowed, quickSendClearsSize, snapToTick, stepDecimal, stopSideIssue, stopsDropped, ticketBlocked, valuationPrice, volForFraction,
} from "./mexcView.ts";

/**
 * The state and checks of one order form, shared by the trade page and the panel on the contract page.
 * Only the user changes the size: a moving quote moves the slider, never what would be sent.
 * `resetKey` re-seeds the form when something outside asks for a fresh ticket.
 * `onQuickPlaced` runs after quick mode sent an order, which has no review page to come back from.
 */
export function useOrderTicket(m: MexcState, symbol: string, action: MexcAction, ticker: MexcTicker | undefined, resetKey = 0, onQuickPlaced?: () => void) {
  const [kind, setKind] = useState<MexcKind>("LIMIT");
  const [vol, setVol] = useState("");
  const [price, setPrice] = useState("");
  // undefined means the field was cleared and is waiting for a number.
  const [leverage, setLeverage] = useState<number | undefined>(5);
  const [prepared, setPrepared] = useState<MexcPrepared>();
  const [reviewing, setReviewing] = useState(false);
  const [sizeDragging, setSizeDragging] = useState(false);
  const [stopsOn, setStopsOn] = useState(false);
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const sizeBeforeDrag = useRef("");
  // Once the user has touched the price (or it was prefilled), a quote update never overwrites it.
  const priceSettled = useRef(false);

  const contract = m.contracts.find(c => c.symbol === symbol);
  const positions = m.account?.positions ?? [];
  const opening = isOpening(action), buying = isBuying(action);
  const held = findPosition(positions, symbol, action);
  const closable = held ? closableOf(held) : "0";
  const choice = contract && m.limits ? leverageChoice(contract, m.limits, positions, action) : undefined;
  const leverageEmpty = opening && leverage === undefined && choice?.fixed === undefined;
  const effectiveLeverage = choice ? clampLeverage(leverage ?? choice.min, choice) : leverage ?? 1;

  useEffect(() => {
    setPrepared(undefined); setPrice(""); priceSettled.current = false;
  }, [resetKey]);
  // Default size when the contract or side changes: the whole closable amount when closing, else the minimum.
  useEffect(() => {
    if (!contract) return;
    setVol(!isOpening(action) && hasClosable(closable) ? closable : String(contract.minVol));
    setPrice(""); priceSettled.current = false;
    // Prices for one side would be on the wrong side of the other.
    setStopsOn(false); setTakeProfit(""); setStopLoss("");
  }, [symbol, action, contract?.symbol]);
  useEffect(() => {
    if (contract && ticker && !priceSettled.current) { priceSettled.current = true; setPrice(snapToTick(ticker.lastPrice, contract.priceUnit)); }
  }, [contract, ticker, symbol, action, price]);

  // A position already held keeps its stops on the position itself.
  const carriesStops = opening && stopsOn && !held;
  const draft: MexcDraft = {
    symbol, action, kind, vol: vol.trim(),
    ...(kind === "LIMIT" ? { price: price.trim() } : {}),
    ...(opening ? { leverage: effectiveLeverage } : {}),
    ...(carriesStops && takeProfit.trim() ? { takeProfitPrice: takeProfit.trim() } : {}),
    ...(carriesStops && stopLoss.trim() ? { stopLossPrice: stopLoss.trim() } : {}),
  };
  const draftKey = JSON.stringify(draft);
  const latestDraftKey = useRef(draftKey);
  latestDraftKey.current = draftKey;
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => { onScreen.current = false; };
  }, []);
  const quick = m.quickMode && quickSendAllowed(kind, price, ticker?.lastPrice, draft.takeProfitPrice !== undefined || draft.stopLossPrice !== undefined);
  // The review page ignores a press for its first moments, because one meant for the button that was just there must
  // not land on "confirm". Quick mode has no such page, so the form does the same whenever it appears, changes side
  // or comes back from a review.
  const gate = useMemo(() => createQuickGate(), []);
  const [, rearmed] = useState(0);
  useEffect(() => {
    gate.shown();
    if (!m.quickMode) return;
    const timer = setTimeout(() => rearmed(count => count + 1), CONFIRM_ARM_DELAY);
    return () => clearTimeout(timer);
  }, [gate, symbol, action, m.quickMode, !!prepared]);
  const submitting = useRef(false);
  const [sendingDirectly, setSendingDirectly] = useState(false);
  // As the server measures them.
  const stopReferences = orderStopReferences(kind, buying ? "LONG" : "SHORT", kind === "LIMIT" ? Number(price) : undefined, (buying ? ticker?.ask1 : ticker?.bid1) ?? ticker?.lastPrice, ticker?.fairPrice);
  const dropped = stopsDropped(opening, stopsOn, !!held, takeProfit, stopLoss);
  const draftIssue = (dropped ? MEXC_MESSAGES.stopsDropped : "") || draftIssueOf(draft, closable) ||
    (carriesStops && stopSideIssue(buying ? "LONG" : "SHORT", takeProfit, stopLoss, stopReferences) ? MEXC_MESSAGES.stopPriceSide : "");

  // The price the review will use, so the estimate here does not read lower than the review does.
  const unitPrice = contract ? valuationPrice(kind, buying, price, ticker, m.limits?.marketProtection ?? NaN) : undefined;
  const notional = contract && unitPrice !== undefined ? notionalOf(vol, contract.contractSize, unitPrice) : undefined;
  const margin = marginOf(notional, effectiveLeverage);
  // What this would make, for showing only: none of it goes into the draft.
  const fill = expectedFill(kind, buying, price, ticker);
  // More than can be closed is refused anyway, and has no profit to speak of.
  const closeProfit = contract && held && !opening && Number(vol) <= Number(closable) ? closeEstimate(held, contract.contractSize, vol, fill) : undefined;
  const closeMargin = held && !opening ? marginFor(held, Number(vol)) : undefined;
  const entry = fill === undefined ? undefined : { direction: buying ? "LONG" as const : "SHORT" as const, averagePrice: fill };
  const atTakeProfit = contract && entry && opening ? closeEstimate(entry, contract.contractSize, vol, takeProfit) : undefined;
  const atStopLoss = contract && entry && opening ? closeEstimate(entry, contract.contractSize, vol, stopLoss) : undefined;
  // Without the server limits the leverage cap is unknown, so opening waits for them.
  const limitsMissing = opening && !choice;
  const entryBlocked = orderEntryBlocked(m.blockedCode, action);
  const submitDisabled = ticketBlocked({
    locked: m.locked, entryBlocked, draftIssue, reviewing, hasContract: !!contract, limitsMissing, leverageEmpty, sending: m.sending,
    notArmed: quick && !gate.armed(),
  });

  const capacity = !contract
    ? undefined
    : opening
      ? m.limits && m.account
        ? openCapacity(m.account.asset.availableOpen, effectiveLeverage, unitPrice, contract, m.limits)
        : undefined
      : hasClosable(closable) ? Math.min(Number(closable), contract.maxVol) : undefined;
  const sizeFraction = fractionOfCapacity(vol, capacity);
  const sliderDisabled = !contract || capacity === undefined || capacity < contract.minVol || reviewing || m.sending;

  const submit = async (forceReview = false) => {
    if (submitting.current || submitDisabled) return;
    const direct = quick && !forceReview;
    // Asked again at the moment of the press: what was drawn can be a moment old.
    if (direct && !gate.mayPress()) return;
    submitting.current = true; // The ref stops a double tap within one frame.
    setSendingDirectly(direct);
    setReviewing(true);
    try {
      if (direct) {
        // Only what the form says right now goes out.
        const sent = await m.quickPlace(draft, () => onScreen.current && latestDraftKey.current === draftKey);
        if (quickSendClearsSize(sent)) setVol("");
        if (sent.orderID) onQuickPlaced?.();
        return;
      }
      const result = await m.run(() => m.api.review(draft));
      // Changed while the review was on its way: that review is not what the form now says. It expires unused.
      if (result && latestDraftKey.current === draftKey) setPrepared(result);
    } finally {
      submitting.current = false;
      setReviewing(false);
    }
  };

  // A button that sends says everything it will send.
  const submitLabel = m.locked ? "交易已锁定"
    : reviewing ? (sendingDirectly ? "正在核对并提交…" : "正在核对…")
      : quick ? `${m.isDemo ? "模拟" : ""}${mexcActionLabels[action]}${vol.trim() ? ` ${vol.trim()} 张` : ""} · ${kind === "MARKET" ? "市价" : `限价 ${price.trim()}`}`
        : `核对${mexcActionLabels[action]}`;

  return {
    quick, noteTouch: gate.touched, submitLabel, contract, kind, setKind, vol, setVol, price, leverage, setLeverage, prepared, setPrepared, reviewing,
    opening, buying, held, closable, choice, effectiveLeverage, notional, margin, closeProfit, closeMargin, atTakeProfit, atStopLoss, entryBlocked, draftIssue, submitDisabled, capacity, sizeFraction, sliderDisabled, sizeDragging, stopsOn, setStopsOn, takeProfit, setTakeProfit, stopLoss, setStopLoss, stopsWereDropped: dropped,
    clearStops: () => { setStopsOn(false); setTakeProfit(""); setStopLoss(""); },
    submit,
    // With quick mode on, an order that went out from a review, or might have, leaves no size for one press to repeat.
    placedFromReview: () => { setPrepared(undefined); if (m.quickMode) setVol(""); },
    backFromReview: () => { setPrepared(undefined); if (m.quickMode && m.locked) setVol(""); },
    // Coming from a review page, this goes to a review page, whatever quick mode says.
    recheck: () => { setPrepared(undefined); void submit(true); },
    typePrice: (value: string) => { priceSettled.current = true; setPrice(value); },
    fillPrice: (value: number) => { if (!contract) return; priceSettled.current = true; setPrice(snapToTick(value, contract.priceUnit)); },
    stepPrice: (direction: 1 | -1) => {
      if (!contract) return;
      priceSettled.current = true;
      setPrice(stepDecimal(price || String(ticker?.lastPrice ?? contract.priceUnit), contract.priceUnit, direction));
    },
    stepVol: (direction: 1 | -1) => {
      if (!contract) return;
      const next = stepDecimal(vol, contract.volUnit, direction, contract.minVol);
      setVol(!opening && hasClosable(closable) && Number(next) > Number(closable) ? closable : next);
    },
    stepTakeProfit: (direction: 1 | -1) => { if (contract) setTakeProfit(stepDecimal(takeProfit || price || String(ticker?.lastPrice ?? contract.priceUnit), contract.priceUnit, direction)); },
    stepStopLoss: (direction: 1 | -1) => { if (contract) setStopLoss(stepDecimal(stopLoss || price || String(ticker?.lastPrice ?? contract.priceUnit), contract.priceUnit, direction)); },
    typeLeverage: (value: string) => { const digits = value.replace(/\D/g, ""); setLeverage(digits ? Number(digits) : undefined); },
    stepLeverage: (direction: 1 | -1) => { if (choice) setLeverage(clampLeverage(effectiveLeverage + direction, choice)); },
    chooseFraction: (fraction: number) => {
      if (contract) setVol(volForFraction(fraction, capacity, contract, !opening && Number(closable) <= contract.maxVol ? closable : undefined));
    },
    beginSizeDrag: () => { sizeBeforeDrag.current = vol; setSizeDragging(true); },
    endSizeDrag: (cancelled: boolean) => { if (cancelled) setVol(sizeBeforeDrag.current); setSizeDragging(false); },
  };
}
