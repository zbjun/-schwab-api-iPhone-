import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import type { Palette } from "./types.ts";

// Up/down keep the established red-up / green-down market colors used by charts.
export const light: Palette = {
  background: "#F2F3F5",
  surface: "#FFFFFF",
  text: "#17191C",
  secondary: "#6A717C",
  separator: "#E3E5E8",
  up: "#CF332D",
  down: "#12813F",
  accent: "#1F6FEB",
  premarket: "#B87815",
  postmarket: "#3475C7",
};
export const dark: Palette = {
  background: "#0E1013",
  surface: "#171A1F",
  text: "#ECEEF1",
  secondary: "#8B929C",
  separator: "#262A31",
  up: "#FF4A40",
  down: "#29BA59",
  accent: "#3D8BFD",
  premarket: "#E3B84E",
  postmarket: "#7299E8",
};
/** Compact trading-terminal geometry: cards, controls and pills. */
export const radius = { card: 10, control: 6, pill: 999 } as const;
export const money = (value?: number, digits = 2) =>
  value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
export const signed = (value?: number, suffix = "") =>
  value === undefined ? "—" : `${value > 0 ? "+" : ""}${money(value)}${suffix}`;
export const compactNumber = (value?: number) =>
  value === undefined
    ? "—"
    : Math.abs(value) >= 1e8
      ? `${money(value / 1e8)}亿`
      : Math.abs(value) >= 1e4
        ? `${money(value / 1e4)}万`
        : money(value, 0);
export const styles = StyleSheet.create({
  pageContent: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 24 },
  pageHeader: { minHeight: 52, paddingHorizontal: 16, paddingVertical: 6,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  spread: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  card: { borderRadius: radius.card, padding: 14, marginBottom: 10 },
  title: { fontSize: 28, fontWeight: "700", letterSpacing: 0 },
  heading: { fontSize: 16, fontWeight: "600" },
  small: { fontSize: 12, lineHeight: 18 },
  number: { fontVariant: ["tabular-nums"], fontWeight: "600" },
  input: {
    borderWidth: 0,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    minHeight: 42,
    fontSize: 16,
  },
});
export function Button({
  label,
  onPress,
  palette: p,
  active = false,
  disabled = false,
  color,
  testID,
  variant,
}: {
  label: string;
  onPress: () => void;
  palette: Palette;
  active?: boolean;
  disabled?: boolean;
  color?: string;
  testID?: string;
  variant?: "plain" | "filled" | "tinted";
}) {
  const filled = active || variant === "filled";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        borderWidth: 0,
        backgroundColor: filled
          ? (color ?? p.accent)
          : variant === "tinted"
            ? (color ?? p.accent) + "1F"
            : "transparent",
        borderRadius: radius.control + 2,
        paddingHorizontal: 12,
        minHeight: filled || variant === "tinted" ? 46 : 36,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          color: filled ? "#fff" : (color ?? p.accent),
          fontSize: filled ? 16 : 14,
          fontWeight: filled ? "700" : "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function Input({
  palette: p,
  ...props
}: TextInputProps & { palette: Palette }) {
  return (
    <TextInput
      placeholderTextColor={p.secondary}
      autoCorrect={false}
      {...props}
      style={[
        styles.input,
        {
          color: p.text,
          backgroundColor: elevated(p),
          borderColor: p.separator,
        },
        props.style,
      ]}
    />
  );
}
/** Numeric field with tick buttons on both sides, as on a broker order ticket. */
export function Stepper({
  palette: p,
  label,
  onStep,
  disabled = false,
  ...input
}: Omit<TextInputProps, "style"> & {
  palette: Palette;
  label: string;
  onStep: (direction: 1 | -1) => void;
  disabled?: boolean;
}) {
  const tick = (direction: 1 | -1) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}${direction > 0 ? "加一档" : "减一档"}`}
      disabled={disabled}
      onPress={() => onStep(direction)}
      style={({ pressed }) => ({
        width: 46,
        alignSelf: "stretch",
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.35 : pressed ? 0.5 : 1,
      })}
    >
      <Text style={{ color: p.text, fontSize: 22, lineHeight: 26 }}>
        {direction > 0 ? "+" : "−"}
      </Text>
    </Pressable>
  );
  return (
    <View style={styles.row}>
      <Text numberOfLines={1} style={{ color: p.secondary, fontSize: 13, width: 50 }}>
        {label}
      </Text>
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          height: 44,
          borderRadius: radius.control,
          backgroundColor: elevated(p),
        }}
      >
        {tick(-1)}
        <TextInput
          placeholderTextColor={p.secondary}
          autoCorrect={false}
          editable={!disabled}
          accessibilityLabel={label}
          {...input}
          style={{
            flex: 1,
            minWidth: 0,
            alignSelf: "stretch",
            textAlign: "center",
            color: p.text,
            fontSize: 18,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
            paddingVertical: 0,
          }}
        />
        {tick(1)}
      </View>
    </View>
  );
}
/** Small selectable pill used for quick sizes, filters and order options. */
export function Chip({
  label,
  onPress,
  palette: p,
  active = false,
  disabled = false,
  color,
  style,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  palette: Palette;
  active?: boolean;
  disabled?: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const tint = color ?? p.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: 32,
          paddingHorizontal: 10,
          borderRadius: radius.control,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: active ? tint : p.separator,
          backgroundColor: active ? tint + "1F" : "transparent",
          opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
        },
        style,
      ]}
    >
      <Text
        numberOfLines={1}
        style={{ color: active ? tint : p.text, fontSize: 13, fontWeight: active ? "600" : "400" }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function Meta({
  label,
  value,
  palette: p,
}: {
  label: string;
  value: string;
  palette: Palette;
}) {
  return (
    <View style={{ flex: 1, minWidth: 84 }}>
      <Text style={{ color: p.secondary, fontSize: 11 }}>{label}</Text>
      <Text
        style={[styles.number, { color: p.text, fontSize: 14, marginTop: 5 }]}
      >
        {value}
      </Text>
    </View>
  );
}

export { Icon } from "./Icon.tsx";
export const elevated = (p: Palette) =>
  p.background === light.background ? "#ECEEF1" : "#20242A";
export const groupBackground = (p: Palette) =>
  p.background === light.background ? "#F2F3F5" : "#0E1013";
export function GroupCaption({
  children,
  palette: p,
}: {
  children: React.ReactNode;
  palette: Palette;
}) {
  return (
    <Text
      style={{
        color: p.secondary,
        fontSize: 13,
        fontWeight: "600",
        marginTop: 18,
        marginBottom: 8,
        paddingHorizontal: 4,
      }}
    >
      {children}
    </Text>
  );
}
