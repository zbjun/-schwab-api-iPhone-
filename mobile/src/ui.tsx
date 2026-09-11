import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import type { Palette } from "./types.ts";

export const light: Palette = {
  background: "#F4F6F9",
  surface: "#ffffff",
  text: "#202833",
  secondary: "#626B77",
  separator: "#DDE3EA",
  up: "#CF332D",
  down: "#12813F",
  accent: "#0088FF",
  premarket: "#B87815",
  postmarket: "#3475C7",
};
export const dark: Palette = {
  background: "#101113",
  surface: "#1A1C1F",
  text: "#F5F7FA",
  secondary: "#A0A4AD",
  separator: "#2C2F36",
  up: "#FF4A40",
  down: "#29BA59",
  accent: "#0088FF",
  premarket: "#E3B84E",
  postmarket: "#7299E8",
};
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
  pageContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 100 },
  pageHeader: { minHeight: 64, paddingHorizontal: 16, paddingVertical: 10,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  pageTitle: { fontSize: 28, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  spread: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  card: { borderRadius: 26, padding: 16, marginBottom: 12 },
  title: { fontSize: 34, fontWeight: "700", letterSpacing: 0 },
  heading: { fontSize: 17, fontWeight: "600" },
  small: { fontSize: 12, lineHeight: 18 },
  number: { fontVariant: ["tabular-nums"], fontWeight: "600" },
  input: {
    borderWidth: 0,
    borderRadius: 8,
    paddingHorizontal: 12,
    minHeight: 44,
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        borderWidth: 0,
        backgroundColor:
          active || variant === "filled"
            ? (color ?? p.accent)
            : variant === "tinted"
              ? (color ?? p.accent) + "18"
              : "transparent",
        borderRadius: 24,
        paddingHorizontal: 12,
        minHeight: active || variant === "filled" ? 48 : 36,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          color: active || variant === "filled" ? "#fff" : (color ?? p.accent),
          fontSize: active || variant === "filled" ? 17 : 15,
          fontWeight: "600",
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
  p.background === light.background ? "#E9EDF3" : "#25272B";
export const groupBackground = (p: Palette) =>
  p.background === light.background ? "#F2F2F7" : "#000000";
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
        fontSize: 15,
        fontWeight: "600",
        marginTop: 22,
        marginBottom: 10,
        paddingHorizontal: 16,
      }}
    >
      {children}
    </Text>
  );
}
