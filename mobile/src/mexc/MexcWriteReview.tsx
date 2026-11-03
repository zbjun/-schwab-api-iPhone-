import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { DemoNotice } from "../DemoNotice.tsx";
import type { Palette } from "../types.ts";
import { Button, Glass, radius, styles, tabBar } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { CONFIRM_ARM_DELAY, confirmArmed, reviewExpired, reviewRemainingSeconds } from "./mexcView.ts";
import { Notice } from "./parts.tsx";

export interface WriteOutcome { done?: boolean; error?: string; unknown?: boolean }

/**
 * The confirm step for a write that is not an order, shown inside the contract page's panel. The lines come from the
 * server's review. Confirm can be pressed once, after a short delay and before the review expires, and never retries.
 */
export default function MexcWriteReview({ m, palette: p, isDemo, preparedAt, blocked, heading, title, warning, confirmLabel, send, onBack, onRecheck, onDone, children }: {
  m: MexcState; palette: Palette; isDemo: boolean; preparedAt: number;
  /** Order entry is closed in a way that stops this particular write. */
  blocked: boolean;
  heading: string; title: string; warning: string; confirmLabel: string;
  send: () => Promise<WriteOutcome>; onBack: () => void; onRecheck: () => void; onDone: () => void;
  children: React.ReactNode;
}) {
  const [now, setNow] = useState(Date.now());
  const [failure, setFailure] = useState("");
  const [floatingHeight, setFloatingHeight] = useState(96);
  const used = useRef(false);
  const shownAt = useRef(Date.now());
  // Stays set after the lock is lifted: this review belongs to a write whose outcome was never known.
  const outcomeUnknown = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    const arm = setTimeout(() => setNow(Date.now()), CONFIRM_ARM_DELAY);
    return () => { clearInterval(timer); clearTimeout(arm); };
  }, []);
  const remaining = reviewRemainingSeconds(preparedAt, now);
  const expired = remaining === 0;
  const spent = used.current || !!failure;
  const disabled = !confirmArmed(shownAt.current, now) || expired || m.sending || spent || m.locked || blocked;
  const confirm = async () => {
    // Checked again at the moment of the press; a blocked press does not spend the review.
    if (used.current || !confirmArmed(shownAt.current, Date.now()) || m.sending || m.locked || blocked || reviewExpired(preparedAt, Date.now())) return;
    used.current = true; // One review, one confirmation.
    const result = await send();
    if (result.done) { onDone(); return; }
    if (result.unknown) outcomeUnknown.current = true;
    setFailure(result.error ?? "操作失败，请稍后重试。");
  };
  return (
    <View style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.pageContent, { gap: 10, paddingBottom: floatingHeight + 22 }]}>
        {isDemo && <DemoNotice palette={p} card />}
        {/* Above the details: confirm is always on screen, so what it means must be too. An unknown outcome must not invite another attempt. */}
        {!!failure && <Notice palette={p} text={outcomeUnknown.current ? failure : failure + " 本次核对已作废，如需继续请重新核对。"} />}
        {m.locked && <Notice palette={p} text="交易已锁定，不能确认。" />}
        {!m.locked && blocked && !!m.blockedText && <Notice palette={p} text={m.blockedText} />}
        {!isDemo && <Notice palette={p} text="真实账户：确认后会发送到 MEXC。" />}
        {isDemo && <Notice palette={p} tone="info" text="演示账户，不会发送到交易所。" />}
        <Notice palette={p} text={warning} />
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: 12, gap: 8 }}>
          <Text style={{ color: p.secondary, fontSize: 12 }}>{heading}</Text>
          <Text style={{ color: p.text, fontSize: 19, fontWeight: "700" }}>{title}</Text>
          <View style={{ height: 1, backgroundColor: p.separator }} />
          <View>{children}</View>
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
                  : <Button label={m.sending ? "发送中…" : confirmLabel} palette={p} variant="filled" disabled={disabled} onPress={() => void confirm()} />}
              </View>
            )}
          </View>
        </View>
      </Glass>
    </View>
  );
}
