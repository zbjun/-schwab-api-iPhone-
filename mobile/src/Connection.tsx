import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import type { TradingState } from "./useTrading.ts";
import type { Palette } from "./types.ts";
import { Button, Icon, Input, styles } from "./ui.tsx";
import { importConfiguration } from "./device.ts";
import ServerConnection from "./ServerConnection.tsx";

export default function Connection({
  state: s,
  palette: p,
}: {
  state: TradingState;
  palette: Palette;
}) {
  const [manual, setManual] = useState(false),
    [clientID, setClientID] = useState(""),
    [secret, setSecret] = useState(""),
    [callback, setCallback] = useState("");
  const [reset, setReset] = useState(false),
    [reconcile, setReconcile] = useState(false);
  const native = Platform.OS !== "web";
  const transportPicker = <View style={[styles.row, { gap: 8, marginBottom: 16 }]}>
    <Button label="手机直连" palette={p} active={s.transport === "direct"} disabled={s.busy || !s.storageReady}
      onPress={() => void s.run(() => s.changeTransport("direct"))} />
    <Button label="服务器共享" palette={p} active={s.transport === "server"} disabled={s.busy || !s.storageReady}
      onPress={() => void s.run(() => s.changeTransport("server"))} />
  </View>;
  if (s.transport === "server") return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 125 }}>
      {transportPicker}<ServerConnection state={s} palette={p} />
    </ScrollView>
  </KeyboardAvoidingView>;
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 125,
          gap: 0,
        }}
      >
        {transportPicker}
        <View
          style={[
            styles.card,
            {
              backgroundColor: p.surface,
              gap: 18,
              padding: 16,
              marginBottom: 34,
            },
          ]}
        >
          <View style={[styles.row, { gap: 14 }]}>
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: 14,
                backgroundColor: s.isDemo ? "#ff8a1914" : `${p.accent}14`,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon
                name={s.isDemo ? "sparkles" : "link"}
                color={s.isDemo ? "#ff8a19" : p.accent}
                size={26}
              />
            </View>
            <View style={{ gap: 4 }}>
              <Text style={{ color: p.text, fontSize: 19, fontWeight: "700" }}>
                {s.isDemo
                  ? "演示模式"
                  : s.status.authenticated
                    ? "Schwab 已连接"
                    : "连接 Schwab"}
              </Text>
              <Text style={{ color: p.secondary, fontSize: 16 }}>
                你的设备，你的账户
              </Text>
            </View>
          </View>
          <View style={styles.spread}>
            <View style={[styles.row, { gap: 12 }]}>
              <Icon name="phone" color={p.accent} size={23} />
              <Text style={{ color: p.text, fontSize: 17 }}>iPhone</Text>
              <Icon name="arrow-right" color={p.secondary} size={18} />
              <Text style={{ color: p.text, fontSize: 17 }}>Schwab</Text>
            </View>
            <Text style={{ color: p.accent, fontSize: 13, fontWeight: "600" }}>
              直连
            </Text>
          </View>
        </View>
        <View
          style={[
            styles.card,
            styles.spread,
            {
              backgroundColor: p.surface,
              marginBottom: 8,
              paddingVertical: 12,
            },
          ]}
        >
          <View style={[styles.row, { gap: 18 }]}>
            <Icon name="sparkles" color={p.accent} size={24} />
            <Text style={{ color: p.text, fontSize: 17 }}>演示模式</Text>
          </View>
          <Switch
            accessibilityLabel="演示模式"
            value={s.isDemo}
            disabled={!native || s.busy}
            onValueChange={s.switchMode}
            trackColor={{ true: p.accent }}
          />
        </View>
        <Text
          style={{
            color: p.secondary,
            fontSize: 13,
            lineHeight: 18,
            paddingHorizontal: 16,
            marginBottom: 24,
          }}
        >
          用虚构账户体验查价、图表、下单与撤改。演示操作不会发送给券商。
        </Text>
        {s.isDemo && (
          <>
            <InfoCard
              palette={p}
              icon="info"
              text="正在查看演示数据，不连接真实账户。"
            />
            <View style={{ height: 22 }} />
            <InfoCard
              palette={p}
              icon="info"
              muted
              text={
                native
                  ? "准备连接真实账户时，关闭上面的演示模式。"
                  : "真实账户请在 iPhone 的 Expo Go 中连接。"
              }
            />
          </>
        )}
        {!s.isDemo && (
          <>
            <View
              style={[styles.card, { backgroundColor: p.surface, gap: 12 }]}
            >
              <Text style={[styles.heading, { color: p.text }]}>
                1　应用配置
              </Text>
              <Text
                style={{ color: s.status.configured ? p.down : p.secondary }}
              >
                {s.status.configured ? "应用已配置，可直接进行下面的账户授权" : "尚未导入配置"}
              </Text>
              <Button
                label="从文件导入个人配置"
                palette={p}
                disabled={s.busy}
                onPress={() =>
                  void s.run(async () => {
                    const config = await importConfiguration();
                    if (config) {
                      await s.broker.configure(
                        config.clientID,
                        config.clientSecret,
                      );
                      await s.refresh();
                      s.setMessage("应用配置已保存到手机，今后无需重复填写。");
                    }
                  })
                }
              />
              <Button
                label={manual ? "隐藏手动输入" : "手动输入配置"}
                palette={p}
                disabled={s.busy}
                onPress={() => setManual(!manual)}
              />
              {manual && (
                <>
                  <Input
                    palette={p}
                    placeholder="Client ID"
                    value={clientID}
                    onChangeText={setClientID}
                    autoCapitalize="none"
                    editable={!s.busy}
                  />
                  <Input
                    palette={p}
                    placeholder="Client Secret"
                    value={secret}
                    onChangeText={setSecret}
                    secureTextEntry
                    autoCapitalize="none"
                    editable={!s.busy}
                  />
                  <Button
                    label="保存配置"
                    palette={p}
                    disabled={s.busy || !clientID.trim() || !secret.trim()}
                    onPress={() =>
                      void s.run(async () => {
                        await s.broker.configure(
                          clientID.trim(),
                          secret.trim(),
                        );
                        setClientID("");
                        setSecret("");
                        setManual(false);
                        await s.refresh();
                      })
                    }
                  />
                </>
              )}
            </View>
            <View
              style={[styles.card, { backgroundColor: p.surface, gap: 12 }]}
            >
              <Text style={[styles.heading, { color: p.text }]}>
                2　授权账户
              </Text>
              <Text
                style={{ color: p.secondary, lineHeight: 20, fontSize: 13 }}
              >
                打开浏览器登录
                Schwab。授权结束后，即使页面显示无法访问，也请复制地址栏中的完整回调网址，返回这里粘贴。
              </Text>
              <Text selectable style={{ color: p.secondary, fontSize: 12 }}>
                开发者门户回调地址：https://127.0.0.1
              </Text>
              <Button
                label="在浏览器登录 Schwab"
                palette={p}
                active
                disabled={!s.status.configured || s.busy}
                onPress={() =>
                  void s.run(async () => {
                    await Linking.openURL(await s.broker.authorizationURL());
                  })
                }
              />
              <Input
                palette={p}
                accessibilityLabel="授权回调网址"
                placeholder="粘贴授权后的完整回调网址"
                value={callback}
                onChangeText={setCallback}
                multiline
                autoCapitalize="none"
                editable={!s.busy}
              />
              <Button
                label="完成授权"
                palette={p}
                disabled={!callback.trim() || s.busy}
                onPress={() =>
                  void s.run(async () => {
                    const value = callback.trim();
                    setCallback("");
                    await s.broker.completeAuthorization(value);
                    await s.refresh();
                    s.setMessage("Schwab 已连接，账户数据已刷新。");
                  })
                }
              />
              <Text
                style={{ color: s.status.authenticated ? p.down : p.secondary }}
              >
                {s.status.authenticated ? "账户已授权" : "尚未授权账户"}
              </Text>
            </View>
            {s.status.unresolvedOperation && (
              <View
                style={[styles.card, { backgroundColor: p.surface, gap: 10 }]}
              >
                <Text style={{ color: p.up }}>
                  上次交易结果尚未确认。先打开 Schwab 检查订单，避免重复下单。
                </Text>
                <Button
                  label={
                    reconcile
                      ? "已在券商核实，解除交易锁定"
                      : "我已检查券商订单"
                  }
                  palette={p}
                  disabled={s.busy}
                  onPress={() => {
                    if (!reconcile) {
                      setReconcile(true);
                      return;
                    }
                    void s.run(async () => {
                      await s.broker.acknowledgeReconciliation();
                      setReconcile(false);
                      await s.refresh();
                    });
                  }}
                />
              </View>
            )}
            <View style={styles.row}>
              <Button
                label="退出账户授权"
                palette={p}
                disabled={s.busy}
                onPress={() =>
                  void s.run(async () => {
                    await s.broker.disconnect(false);
                    await s.refresh();
                  })
                }
              />
              <Button
                label={reset ? "确认删除本机配置" : "重置配置"}
                palette={p}
                disabled={s.busy}
                onPress={() => {
                  if (!reset) {
                    setReset(true);
                    return;
                  }
                  void s.run(async () => {
                    await s.broker.disconnect(true);
                    setReset(false);
                    await s.refresh();
                  });
                }}
              />
            </View>
          </>
        )}
        <Text
          style={{
            color: p.secondary,
            fontSize: 15,
            fontWeight: "600",
            paddingHorizontal: 16,
            marginTop: 18,
            marginBottom: 10,
          }}
        >
          保存在你的设备
        </Text>
        <View
          style={[
            styles.card,
            { backgroundColor: p.surface, marginBottom: 10 },
          ]}
        >
          <View style={[styles.row, { gap: 18, paddingBottom: 14 }]}>
            <Icon name="shield" color={p.accent} size={24} />
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ color: p.text, fontSize: 16 }}>
                凭据与授权存入 iPhone 钥匙串
              </Text>
              <Text
                style={{ color: p.secondary, fontSize: 12, lineHeight: 17 }}
              >
                仅此设备、解锁后使用，不通过 iCloud 同步。
                内置配置的自用 IPA 也含应用凭据，请勿分享安装包。
              </Text>
            </View>
          </View>
          <View
            style={{
              height: 0.5,
              backgroundColor: p.separator,
              marginLeft: 42,
            }}
          />
          <View style={[styles.row, { gap: 18, paddingTop: 14 }]}>
            <Icon name="globe" color={p.accent} size={24} />
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ color: p.text, fontSize: 16 }}>
                直接连接 Schwab
              </Text>
              <Text
                style={{ color: p.secondary, fontSize: 12, lineHeight: 17 }}
              >
                不经过自建中转服务器；网络质量以手机实际连接为准。
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function InfoCard({
  palette: p,
  icon,
  text,
  muted = false,
}: {
  palette: Palette;
  icon: string;
  text: string;
  muted?: boolean;
}) {
  return (
    <View
      style={[
        styles.card,
        styles.row,
        {
          gap: 18,
          backgroundColor: p.surface,
          paddingVertical: 15,
          marginBottom: 10,
        },
      ]}
    >
      <Icon name={icon} color={muted ? p.secondary : p.accent} size={23} />
      <Text
        style={{
          color: muted ? p.secondary : p.text,
          fontSize: 15,
          lineHeight: 21,
          flex: 1,
        }}
      >
        {text}
      </Text>
    </View>
  );
}
