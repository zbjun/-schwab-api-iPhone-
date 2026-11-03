import React, { useEffect, useRef } from "react";
import { PanResponder, Pressable, Text, View, type StyleProp, type TextStyle } from "react-native";
import { tick } from "../haptics.ts";
import type { Palette } from "../types.ts";
import { Glass, Icon, elevated, radius, styles } from "../ui.tsx";

/** One label and value line, as in the Schwab order review (`SummaryRow`). */
export function Line({ label, value, palette: p, color, strong }: {
  label: string; value: string; palette: Palette; color?: string; strong?: boolean;
}) {
  return (
    <View style={[styles.spread, { minHeight: 26 }]}>
      <Text style={{ color: p.secondary, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: color ?? p.text, fontSize: strong ? 15 : 14, fontWeight: "600", fontVariant: ["tabular-nums"],
        flexShrink: 1, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

/** Same mark as the Schwab header for a simulated account. */
export function DemoBadge(_: { palette: Palette }) {
  return (
    <Text style={{ color: "#ff8a19", fontSize: 11, fontWeight: "600", borderWidth: 1, borderColor: "#ff8a1966",
      borderRadius: radius.control, paddingHorizontal: 6, paddingVertical: 2 }}>
      模拟
    </Text>
  );
}

export function RoundButton({ label, icon, palette: p, color, bare = false, disabled = false, onPress }: {
  label: string; icon: string; palette: Palette; color?: string; bare?: boolean; disabled?: boolean; onPress: () => void;
}) {
  const button = (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.4 : 1 }}>
      <Icon name={icon} color={color ?? p.text} size={22} />
    </Pressable>
  );
  return bare ? button : <Glass palette={p} interactive style={{ borderRadius: 22 }}>{button}</Glass>;
}

/**
 * "warn" matches the Schwab banner for an unresolved result; "info" matches its small grey note.
 * Pass `style` for the page-level margins used under the header.
 */
export function Notice({ text, palette: p, tone = "warn", style }: {
  text: string; palette: Palette; tone?: "warn" | "info"; style?: StyleProp<TextStyle>;
}) {
  if (tone === "info")
    return <Text style={[{ color: p.secondary, fontSize: 11, lineHeight: 16 }, style]}>{text}</Text>;
  return (
    <Text style={[{ color: p.up, backgroundColor: p.up + "14", fontSize: 12, lineHeight: 17, paddingHorizontal: 12,
      paddingVertical: 8, borderRadius: radius.control, overflow: "hidden" }, style]}>
      {text}
    </Text>
  );
}

/** One choice out of a few, on a single row. */
export function Segmented<T extends string>({ options, value, onChange, palette: p }: {
  options: { id: T; label: string; color?: string }[]; value: T; onChange: (id: T) => void; palette: Palette;
}) {
  return (
    <View style={{ flexDirection: "row", backgroundColor: elevated(p), borderRadius: radius.control, padding: 2 }}>
      {options.map(({ id, label, color }) => {
        const selected = id === value;
        return (
          <Pressable key={id} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={() => onChange(id)}
            style={{ flex: 1, minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: radius.control - 2,
              backgroundColor: selected ? color ?? p.separator : "transparent" }}>
            <Text style={{ color: selected && color ? "#fff" : p.text, fontSize: 13, fontWeight: "700" }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const SLIDER_MARKS = [0, 0.25, 0.5, 0.75, 1];
const THUMB = 18;
/**
 * Drag or tap to choose how much of the available size to use. `value` comes from the order size,
 * so the thumb always shows what would really be sent, including rounding to whole contracts.
 */
export function PositionSlider({ value, onChange, onDragStart, onDragEnd, palette: p, color, disabled = false }: {
  value: number; onChange: (fraction: number) => void; palette: Palette; color: string; disabled?: boolean;
  onDragStart?: () => void;
  /** `cancelled` when something else took the gesture over, and the size should go back to what it was. */
  onDragEnd?: (cancelled: boolean) => void;
}) {
  const width = useRef(0), origin = useRef(0);
  // A press alone changes nothing: sideways is a drag, up or down is a scroll passing over, and a tap counts on release.
  const gesture = useRef<"pressed" | "drag" | "scroll">("pressed");
  const latest = useRef({ onChange, onDragStart, onDragEnd, disabled });
  latest.current = { onChange, onDragStart, onDragEnd, disabled };
  const responder = useRef((() => {
    const pick = (x: number) => {
      const span = width.current - THUMB;
      if (latest.current.disabled || span <= 0) return;
      const raw = Math.min(1, Math.max(0, (x - THUMB / 2) / span));
      // The marks are sticky, so a finger can hit 25% or 100% exactly.
      latest.current.onChange(SLIDER_MARKS.find(mark => Math.abs(mark - raw) < 0.02) ?? raw);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !latest.current.disabled,
      onMoveShouldSetPanResponder: () => !latest.current.disabled,
      onPanResponderTerminationRequest: () => gesture.current !== "drag",
      onPanResponderGrant: event => { gesture.current = "pressed"; origin.current = event.nativeEvent.locationX; },
      onPanResponderMove: (_, { dx, dy }) => {
        if (gesture.current === "pressed") {
          if (Math.abs(dx) >= 4 && Math.abs(dx) >= Math.abs(dy)) { gesture.current = "drag"; latest.current.onDragStart?.(); }
          else if (Math.abs(dy) >= 8) gesture.current = "scroll";
        }
        if (gesture.current === "drag") pick(origin.current + dx);
      },
      onPanResponderRelease: () => {
        if (gesture.current === "drag") latest.current.onDragEnd?.(false);
        else if (gesture.current === "pressed") { pick(origin.current); tick(); }
        gesture.current = "pressed";
      },
      onPanResponderTerminate: () => {
        if (gesture.current === "drag") latest.current.onDragEnd?.(true);
        gesture.current = "pressed";
      },
    });
  })()).current;
  const shown = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const shownPercent = Math.round(shown * 100);
  // One tick for every 5% of the size that would really be sent, a firmer one on the marks. A moving quote also
  // moves the thumb, so only a finger on the slider counts.
  const step = Math.round(shown * 20), lastStep = useRef(step);
  useEffect(() => {
    if (step !== lastStep.current && gesture.current === "drag") tick(step % 5 === 0);
    lastStep.current = step;
  }, [step]);
  const tint = disabled ? p.secondary : color;
  return (
    <View style={[styles.row, { gap: 6 }]}>
      <Text numberOfLines={1} style={{ color: p.secondary, fontSize: 13, width: 34 }}>仓位</Text>
      <View {...responder.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel="仓位比例"
        accessibilityState={{ disabled }} accessibilityValue={{ min: 0, max: 100, now: shownPercent, text: `${shownPercent}%` }}
        accessibilityActions={[{ name: "increment", label: "增加仓位" }, { name: "decrement", label: "减少仓位" }]}
        onAccessibilityAction={event => {
          if (disabled) return;
          onChange(Math.min(1, Math.max(0, shown + (event.nativeEvent.actionName === "increment" ? 0.1 : -0.1))));
        }}
        onLayout={event => { width.current = event.nativeEvent.layout.width; }}
        style={{ flex: 1, height: 32, justifyContent: "center", paddingHorizontal: THUMB / 2 }}>
        <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: elevated(p) }}>
          <View style={{ width: `${shown * 100}%`, height: 4, borderRadius: 2, backgroundColor: tint }} />
          {SLIDER_MARKS.map(mark => (
            <View key={mark} style={{ position: "absolute", top: -1, left: `${mark * 100}%`, marginLeft: -3, width: 6, height: 6, borderRadius: 3,
              backgroundColor: mark <= shown ? tint : p.separator }} />
          ))}
          <View testID="mexc.sizeThumb" style={{ position: "absolute", top: (4 - THUMB) / 2, left: `${shown * 100}%`, marginLeft: -THUMB / 2,
            width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: "#fff", borderWidth: 3, borderColor: tint }} />
        </View>
      </View>
      <Text numberOfLines={1} style={[styles.number, { color: p.text, fontSize: 13, fontWeight: "600", width: 38, textAlign: "right" }]}>{shownPercent}%</Text>
    </View>
  );
}

/** The Schwab empty list: a card with one centred grey line. */
export function EmptyState({ text, palette: p }: { text: string; palette: Palette }) {
  return (
    <View style={{ backgroundColor: p.surface, padding: 20, borderRadius: radius.card }}>
      <Text style={{ color: p.secondary, textAlign: "center" }}>{text}</Text>
    </View>
  );
}
