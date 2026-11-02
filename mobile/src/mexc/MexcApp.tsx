import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, Text, useColorScheme, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { createMexcClient } from "../device.ts";
import type { MexcApi } from "../MexcClient.ts";
import type { MexcAction, MexcPosition } from "../mexcRules.ts";
import { Glass, Icon, dark, light, radius, styles, tabBar, Button } from "../ui.tsx";
import { MexcDemo } from "./mexcDemo.ts";
import { LOCK_BANNER, closeActionFor } from "./mexcView.ts";
import { useMexc } from "./useMexc.ts";
import MexcPositions from "./MexcPositions.tsx";
import MexcMarkets from "./MexcMarkets.tsx";
import MexcTrade, { type TradeSeed } from "./MexcTrade.tsx";
import MexcOrders from "./MexcOrders.tsx";
import MexcConnection from "./MexcConnection.tsx";
import { DemoBadge, RoundButton } from "./parts.tsx";

type Tab = "positions" | "markets" | "trade" | "orders";
const tabs: [Tab, string, string][] = [
  ["positions", "持仓", "pie"],
  ["markets", "行情", "chart"],
  ["trade", "交易", "trade"],
  ["orders", "委托", "orders"],
];

/** Real client on a phone; in-memory demo on the web, where the device vault does not exist. */
function createApi(): MexcApi {
  if (Platform.OS === "web") return new MexcDemo();
  return createMexcClient();
}

export default function MexcApp({ onExit }: { onExit?: () => void }) {
  const system = useColorScheme();
  const preview = Platform.OS === "web" && __DEV__ ? new URLSearchParams(window.location.search).get("appearance") : null;
  const p = preview === "dark" || (preview !== "light" && system === "dark") ? dark : light;
  const [api] = useState(createApi);
  const m = useMexc(api);
  const [tab, setTab] = useState<Tab>("positions");
  const [detail, setDetail] = useState<string>();
  const [settings, setSettings] = useState(false);
  const [confirmAck, setConfirmAck] = useState(false);
  const [seed, setSeed] = useState<TradeSeed>({ nonce: 0 });
  // The second tap must follow within 5 seconds, and only while the lock still exists.
  useEffect(() => { if (!m.unconfirmed) setConfirmAck(false); }, [m.unconfirmed]);
  useEffect(() => {
    if (!confirmAck) return;
    const timer = setTimeout(() => setConfirmAck(false), 5_000);
    return () => clearTimeout(timer);
  }, [confirmAck]);
  const trade = (symbol: string, action?: MexcAction) => {
    if (m.sending) return;
    setSeed({ nonce: seed.nonce + 1, symbol, action });
    setDetail(undefined);
    setTab("trade");
  };
  const closePosition = (position: MexcPosition) => trade(position.symbol, closeActionFor(position));
  const title = settings ? "MEXC 设置" : tabs.find(t => t[0] === tab)?.[1];
  return (
    <SafeAreaView edges={["top", "bottom"]} style={{ flex: 1, backgroundColor: p.background, paddingTop: Platform.OS === "web" ? 8 : 0 }}>
      <StatusBar style={p === dark ? "light" : "dark"} />
      <View style={{ flex: 1, width: "100%", maxWidth: 760, alignSelf: "center" }}>
        <View style={styles.pageHeader}>
          <View style={[styles.row, { gap: 10, flexShrink: 1 }]}>
            <Text accessibilityRole="header" style={[styles.pageTitle, { color: p.text }]}>{title}</Text>
            <Text style={{ color: p.secondary, fontSize: 11, borderWidth: 1, borderColor: p.separator, borderRadius: radius.control, paddingHorizontal: 6, paddingVertical: 2 }}>MEXC</Text>
            {m.isDemo && <DemoBadge palette={p} />}
          </View>
          {!settings && <RoundButton label="MEXC 设置" icon="settings" palette={p} disabled={m.sending} onPress={() => setSettings(true)} />}
        </View>
        {m.unconfirmed && (
          <View accessibilityRole="alert" style={{ marginHorizontal: 12, marginBottom: 6, padding: 10, gap: 8,
            borderRadius: radius.control, backgroundColor: p.up + "22", borderWidth: 1, borderColor: p.up }}>
            <Text style={{ color: p.up, fontSize: 14, fontWeight: "700", lineHeight: 20 }}>{LOCK_BANNER}</Text>
            <Button label={confirmAck ? "确认已在 MEXC 核实，解除锁定" : "我已核实"} palette={p} variant="tinted" color={p.up}
              onPress={() => {
                if (!confirmAck) { setConfirmAck(true); return; }
                setConfirmAck(false);
                void m.acknowledge();
              }} />
          </View>
        )}
        {!!m.blockedText && !m.locked && m.blockedCode !== "keyCheckFailed" && (
          <Text style={{ color: p.up, backgroundColor: p.up + "14", fontSize: 13, lineHeight: 19, padding: 10, marginHorizontal: 12,
            marginBottom: 6, borderRadius: radius.control, overflow: "hidden" }}>{m.blockedText}</Text>
        )}
        {m.offline && (
          <Text accessibilityRole="alert" style={{ color: p.up, backgroundColor: p.up + "14", fontSize: 13, lineHeight: 19, padding: 10,
            marginHorizontal: 12, marginBottom: 6, borderRadius: radius.control, overflow: "hidden" }}>
            连接中断，以下是上次的数据。
          </Text>
        )}
        {m.writeInProgress && !m.unconfirmed && (
          <Text style={{ color: p.secondary, fontSize: 13, paddingHorizontal: 12, marginBottom: 6 }}>服务器正在处理一笔委托，暂时不能下单或撤单。</Text>
        )}
        {!!m.message && (
          <Pressable accessibilityRole="button" accessibilityLabel="关闭提示" onPress={() => m.setMessage("")}
            style={[styles.spread, { alignItems: "flex-start", backgroundColor: p.surface, paddingHorizontal: 12, paddingVertical: 9,
              borderRadius: radius.control, marginHorizontal: 12, marginBottom: 6 }]}>
            <Text style={{ color: p.text, fontSize: 13, lineHeight: 18, flex: 1 }}>{m.message}</Text>
            <Text style={{ color: p.secondary, fontSize: 15, lineHeight: 18 }}>×</Text>
          </Pressable>
        )}
        <View style={{ flex: 1 }}>
          {settings ? (
            <MexcConnection m={m} palette={p} onExit={m.sending ? undefined : onExit} onClose={() => setSettings(false)} />
          ) : tab === "positions" ? (
            <MexcPositions m={m} palette={p} onClose={closePosition} onSettings={() => { if (!m.sending) setSettings(true); }} />
          ) : tab === "markets" ? (
            <MexcMarkets m={m} palette={p} detail={detail} setDetail={setDetail} onTrade={symbol => trade(symbol)} />
          ) : tab === "trade" ? (
            <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
              <MexcTrade m={m} palette={p} seed={seed} />
            </KeyboardAvoidingView>
          ) : (
            <MexcOrders m={m} palette={p} active />
          )}
        </View>
        <Glass palette={p} interactive style={{ position: "absolute", left: tabBar.inset, right: tabBar.inset, bottom: tabBar.bottom,
          height: tabBar.height, padding: 4, borderRadius: tabBar.height / 2, flexDirection: "row" }}>
          {tabs.map(([id, label, icon]) => (
            <Pressable key={id} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: tab === id && !settings, disabled: m.sending }}
              disabled={m.sending}
              onPress={() => { if (m.sending) return; setSettings(false); setDetail(undefined); setTab(id); }}
              style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 2, borderRadius: (tabBar.height - 8) / 2, opacity: m.sending ? 0.5 : 1,
                backgroundColor: tab === id && !settings ? p.accent + (p === light ? "1A" : "26") : "transparent" }}>
              <Icon name={icon} color={tab === id && !settings ? p.accent : p.text} size={24} />
              <Text style={{ color: tab === id && !settings ? p.accent : p.text, fontSize: 10, fontWeight: tab === id && !settings ? "700" : "500" }}>
                {label}
              </Text>
            </Pressable>
          ))}
        </Glass>
      </View>
    </SafeAreaView>
  );
}
