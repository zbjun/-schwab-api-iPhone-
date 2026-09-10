import React, { useEffect, useState } from "react";
import { AppState, Linking, Platform, Switch, Text, View } from "react-native";
import type { TradingState } from "./useTrading.ts";
import type { Palette } from "./types.ts";
import { Button, Input, styles } from "./ui.tsx";

export default function ServerConnection({ state: s, palette: p }: { state: TradingState; palette: Palette }) {
  const [origin, setOrigin] = useState("");
  const [deviceKey, setDeviceKey] = useState("");
  const [callback, setCallback] = useState("");
  const [manual, setManual] = useState(false);
  const [reconcile, setReconcile] = useState(false);
  const [configured, setConfigured] = useState(false);
  const server = s.serverBroker;
  useEffect(() => {
    let active = true;
    void server?.configuration().then(value => { if (active) { setOrigin(value?.origin ?? ""); setConfigured(!!value); } }).catch(() => {});
    return () => { active = false; };
  }, [server]);
  // An HTTPS server callback completes OAuth in the browser; refresh when returning.
  useEffect(() => {
    const listener = AppState.addEventListener("change", value => {
      if (value === "active" && !s.isDemo && configured) void s.run(s.refresh);
    });
    return () => listener.remove();
  }, [s.run, s.refresh, s.isDemo, configured]);
  const disabled = s.busy || Platform.OS === "web";
  return <View style={{ gap: 12 }}>
    <View style={[styles.card, { backgroundColor: p.surface, gap: 10 }]}>
      <Text style={[styles.heading, { color: p.text }]}>两台设备，共享服务器授权</Text>
      <Text style={{ color: p.secondary, lineHeight: 20 }}>Schwab 授权由服务器统一保存和刷新。每台手机使用独立设备密钥；服务器已授权时，另一台无需再次登录 Schwab。</Text>
      <View style={styles.spread}><Text style={{ color: p.text }}>演示模式</Text><Switch accessibilityLabel="演示模式" value={s.isDemo} disabled={disabled} onValueChange={s.switchMode} /></View>
    </View>
    <View style={[styles.card, { backgroundColor: p.surface, gap: 10 }]}>
      <Text style={[styles.heading, { color: p.text }]}>本机设备连接</Text>
      <Input palette={p} accessibilityLabel="服务器地址" placeholder="HTTPS 服务器地址" autoCapitalize="none" value={origin} onChangeText={setOrigin} editable={!disabled} />
      <Input palette={p} accessibilityLabel="设备访问密钥" placeholder={configured ? "更换配置时填写设备访问密钥" : "服务器生成的本机设备访问密钥"} autoCapitalize="none" secureTextEntry value={deviceKey} onChangeText={setDeviceKey} editable={!disabled} />
      <Button label="保存设备连接" palette={p} disabled={disabled || !origin.trim() || !deviceKey.trim()} onPress={() => void s.run(async () => {
        if (!server) return;
        await server.configureServer(origin, deviceKey);
        setDeviceKey(""); setConfigured(true);
        if (!s.isDemo) await s.refresh();
        s.setMessage("设备连接已保存。关闭演示模式后使用服务器中的账户授权。");
      })} />
      <Text style={{ color: p.secondary, fontSize: 12 }}>这里填写设备访问密钥，不是 Schwab Client Secret。仅保存在本机钥匙串。</Text>
    </View>
    {!s.isDemo && <>
      <View style={[styles.card, { backgroundColor: p.surface, gap: 10 }]}>
        <Text style={{ color: s.status.authenticated ? p.down : p.text }}>{s.status.authenticated ? "服务器账户已授权，可直接使用" : "检查服务器账户授权"}</Text>
        <Button label="刷新服务器连接" palette={p} disabled={disabled || !configured} onPress={() => void s.run(s.refresh)} />
        {!s.status.authenticated && <>
          <Text style={{ color: p.secondary }}>先刷新检查共享授权；只有服务器确实尚未授权时，才需要登录。请勿在两台设备同时发起授权。</Text>
          <Button label="在官方页面授权服务器" palette={p} disabled={disabled || !configured} onPress={() => void s.run(async () => { await Linking.openURL(await s.broker.authorizationURL()); })} />
          <Button label={manual ? "隐藏手动回调" : "手动粘贴授权回调"} palette={p} disabled={disabled} onPress={() => setManual(!manual)} />
          {manual && <><Input palette={p} placeholder="完整授权回调网址" value={callback} onChangeText={setCallback} autoCapitalize="none" multiline editable={!disabled} />
            <Button label="完成服务器授权" palette={p} disabled={disabled || !callback.trim()} onPress={() => void s.run(async () => {
              const value = callback.trim(); setCallback(""); await s.broker.completeAuthorization(value); await s.refresh();
            })} /></>}
        </>}
      </View>
      {s.status.unresolvedOperation && <View style={[styles.card, { backgroundColor: p.surface, gap: 10 }]}>
        <Text style={{ color: p.up }}>有交易结果需要核实。先在券商检查订单；服务器的全局锁定须在服务器核实后解除。</Text>
        <Button label={reconcile ? "已核实，解除本机提示" : "我已核实券商订单"} palette={p} disabled={disabled} onPress={() => {
          if (!reconcile) return setReconcile(true);
          void s.run(async () => { await s.broker.acknowledgeReconciliation(); setReconcile(false); await s.refresh(); });
        }} />
      </View>}
    </>}
    <Button label="忘记本机服务器连接" palette={p} disabled={disabled || !configured} onPress={() => void s.run(async () => {
      await server?.disconnect(); setConfigured(false); setOrigin(""); setDeviceKey(""); if (!s.isDemo) await s.refresh();
    })} />
    <Text style={{ color: p.secondary, fontSize: 12 }}>忘记连接只删除此手机的设备配置，不退出服务器的 Schwab 授权，也不影响另一台设备。</Text>
  </View>;
}
