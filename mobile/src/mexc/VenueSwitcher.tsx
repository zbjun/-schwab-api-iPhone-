import React, { useRef, useState } from "react";
import { Modal, Pressable, Text, useWindowDimensions, View } from "react-native";
import type { Palette } from "../types.ts";
import { Icon, radius } from "../ui.tsx";
import type { Venue } from "./mexcView.ts";

const VENUES: [Venue, string, string][] = [
  ["schwab", "Schwab", "美股账户"],
  ["mexc", "MEXC", "永续合约"],
];
const MENU_WIDTH = 220;
const EDGE = 12;

/** The one way to change exchange: the same control in the page header on both sides, opening a menu under it. */
export default function VenueSwitcher({ venue, palette: p, disabled, onChange }: {
  venue: Venue; palette: Palette; disabled?: boolean; onChange: (venue: Venue) => void;
}) {
  const { width } = useWindowDimensions();
  const anchor = useRef<View>(null);
  const [menu, setMenu] = useState<{ top: number; left: number }>();
  const current = VENUES.find(([id]) => id === venue)!;
  const open = () => {
    const show = (x: number, y: number, height: number) =>
      // A failed measurement still opens near the header instead of off screen.
      setMenu(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(height)
        ? { top: y + height + 6, left: Math.max(EDGE, Math.min(x, width - MENU_WIDTH - EDGE)) }
        : { top: 64, left: EDGE });
    if (anchor.current) anchor.current.measureInWindow((x, y, _, height) => show(x, y, height));
    else show(Number.NaN, Number.NaN, Number.NaN);
  };
  const close = () => setMenu(undefined);
  return (
    <>
      <View ref={anchor} collapsable={false}>
        <Pressable accessibilityRole="button" accessibilityLabel={`切换账户，当前 ${current[1]}`}
          accessibilityState={{ disabled: !!disabled, expanded: !!menu }} disabled={disabled} onPress={open}
          style={{ flexDirection: "row", alignItems: "center", gap: 3, minHeight: 32, paddingLeft: 9, paddingRight: 6,
            borderWidth: 1, borderColor: p.separator, borderRadius: radius.pill, opacity: disabled ? 0.5 : 1 }}>
          <Text style={{ color: p.text, fontSize: 13, fontWeight: "600" }}>{current[1]}</Text>
          <Icon name="select" size={14} color={p.secondary} />
        </Pressable>
      </View>
      <Modal visible={!!menu} transparent animationType="fade" onRequestClose={close}>
        <View style={{ flex: 1 }}>
          {/* Beside the menu rather than around it, so a tap on the menu cannot also dismiss. */}
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={close}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
          <View style={{ position: "absolute", top: menu?.top ?? 0, left: menu?.left ?? 0, width: MENU_WIDTH,
            backgroundColor: p.surface, borderWidth: 1, borderColor: p.separator, borderRadius: radius.card, padding: 4,
            shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 }}>
            {VENUES.map(([id, name, detail]) => {
              const selected = id === venue;
              return (
                <Pressable key={id} accessibilityRole="button" accessibilityLabel={name} accessibilityState={{ selected }}
                  onPress={() => { close(); if (!selected) onChange(id); }}
                  style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 50,
                    paddingHorizontal: 10, borderRadius: radius.control, backgroundColor: selected ? p.accent + "1F" : "transparent" }}>
                  <View style={{ gap: 2 }}>
                    <Text style={{ color: p.text, fontSize: 15, fontWeight: "600" }}>{name}</Text>
                    <Text style={{ color: p.secondary, fontSize: 12 }}>{detail}</Text>
                  </View>
                  {selected && <Icon name="check" size={18} color={p.accent} />}
                </Pressable>
              );
            })}
          </View>
        </View>
      </Modal>
    </>
  );
}
