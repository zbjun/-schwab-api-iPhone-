import React, { useEffect, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import type { Palette } from "../types.ts";
import type { MexcClient } from "../MexcClient.ts";
import { Button, Input, styles } from "../ui.tsx";
import type { MexcState } from "./useMexc.ts";
import { Notice } from "./parts.tsx";

/** Server address and device key for the MEXC gateway, plus the way back to Schwab. */
export default function MexcConnection({ m, palette: p, onExit, onClose }: {
  m: MexcState; palette: Palette; onExit?: () => void; onClose: () => void;
}) {
  const client = m.api.isDemo ? undefined : (m.api as MexcClient);
  const [origin, setOrigin] = useState("");
  const [deviceKey, setDeviceKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [issue, setIssue] = useState("");
  useEffect(() => {
    let active = true;
    void client?.configuration().then(value => {
      if (active) { setOrigin(value?.origin ?? ""); setConfigured(!!value); setIssue(""); }
    }).catch(() => { if (active) setIssue("本机设备配置读取失败，请解锁手机后重新进入此页。"); });
    return () => { active = false; };
  }, [client]);
  const disabled = Platform.OS === "web" || !client;
  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.pageContent, { gap: 12 }]}>
      <View style={styles.row}>
        <Button label="返回" palette={p} onPress={onClose} />
        {onExit && <Button label="返回 Schwab" palette={p} variant="tinted" onPress={onExit} />}
      </View>
      {m.isDemo
        ? <Notice palette={p} tone="info" text="演示模式：数据只在本机内存里，不会连接 MEXC，也不会产生真实委托。真实连接请在 iPhone 上使用。" />
        : <View style={[styles.card, { backgroundColor: p.surface, gap: 10 }]}>
          <Text style={[styles.heading, { color: p.text }]}>MEXC 网关连接</Text>
          {!!issue && <Text accessibilityRole="alert" style={{ color: p.up }}>{issue}</Text>}
          {!configured && !issue && <Text style={{ color: p.secondary, fontSize: 12, lineHeight: 19 }}>
            此手机尚未保存 MEXC 网关的设备连接。它与 Schwab 的连接分开保存。
          </Text>}
          <Input palette={p} accessibilityLabel="MEXC 服务器地址" placeholder="HTTPS 服务器地址" autoCapitalize="none"
            value={origin} onChangeText={setOrigin} editable={!disabled} />
          <Input palette={p} accessibilityLabel="MEXC 设备访问密钥" autoCapitalize="none" secureTextEntry value={deviceKey}
            placeholder={configured ? "更换配置时填写设备访问密钥" : "服务器生成的本机设备访问密钥"}
            onChangeText={setDeviceKey} editable={!disabled} />
          <Button label="保存设备连接" palette={p} disabled={disabled || !origin.trim() || !deviceKey.trim()}
            onPress={() => void m.run(async () => {
              await client!.configureServer(origin, deviceKey);
              setDeviceKey(""); setConfigured(true); setIssue("");
              m.setMessage("设备连接已保存，正在检查服务器状态。");
              await m.refresh();
            })} />
          <Button label="刷新服务器连接" palette={p} disabled={disabled || !configured} onPress={() => void m.refresh()} />
          <Text style={{ color: p.secondary, fontSize: 12 }}>这里填写的是设备访问密钥，不是 MEXC 的 API Key。仅保存在本机钥匙串。</Text>
          <Button label="忘记本机 MEXC 连接" palette={p} disabled={disabled || !configured}
            onPress={() => void m.run(async () => {
              await client!.disconnect();
              setConfigured(false); setOrigin(""); setDeviceKey("");
              m.clear();
              await m.refresh();
            })} />
        </View>}
    </ScrollView>
  );
}
