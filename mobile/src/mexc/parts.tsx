import React from "react";
import { Pressable, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import { Glass, Icon, radius, styles } from "../ui.tsx";

/** One label and value line, as on the Schwab order review. */
export function Line({ label, value, palette: p, color, strong }: {
  label: string; value: string; palette: Palette; color?: string; strong?: boolean;
}) {
  return (
    <View style={styles.spread}>
      <Text style={{ color: p.secondary, fontSize: 13 }}>{label}</Text>
      <Text style={[styles.number, { color: color ?? p.text, fontSize: strong ? 16 : 14, flexShrink: 1, textAlign: "right" }]}>
        {value}
      </Text>
    </View>
  );
}

export function DemoBadge({ palette: p }: { palette: Palette }) {
  return (
    <Text style={{ color: "#ff8a19", fontSize: 11, fontWeight: "600", borderWidth: 1, borderColor: "#ff8a1966",
      borderRadius: radius.control, paddingHorizontal: 6, paddingVertical: 2 }}>
      演示账户
    </Text>
  );
}

export function RoundButton({ label, icon, palette: p, disabled = false, onPress }: {
  label: string; icon: string; palette: Palette; disabled?: boolean; onPress: () => void;
}) {
  return (
    <Glass palette={p} interactive style={{ borderRadius: 22 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
        style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.4 : 1 }}>
        <Icon name={icon} color={p.text} size={22} />
      </Pressable>
    </Glass>
  );
}

export function Notice({ text, palette: p, tone = "warn" }: { text: string; palette: Palette; tone?: "warn" | "info" }) {
  const color = tone === "warn" ? p.up : p.secondary;
  return (
    <Text style={{ color, backgroundColor: color + "14", fontSize: 13, lineHeight: 19, padding: 10, borderRadius: radius.control, overflow: "hidden" }}>
      {text}
    </Text>
  );
}
