import React from "react";
import { Text, View } from "react-native";
import type { Palette } from "./types.ts";
import { Icon } from "./Icon.tsx";
export function DemoNotice({
  palette: p,
  card = false,
}: {
  palette: Palette;
  card?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 18,
        paddingVertical: card ? 16 : 12,
        paddingHorizontal: card ? 20 : 4,
        backgroundColor: card ? p.surface : "transparent",
        borderRadius: 28,
      }}
    >
      <Icon name="sparkles" size={20} color="#FF8A16" />
      <Text style={{ color: "#FF8A16", fontSize: 13, fontWeight: "600" }}>
        演示模式 · 所有交易均为模拟
      </Text>
    </View>
  );
}
