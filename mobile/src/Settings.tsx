import React, { useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import type { TradingState } from "./useTrading.ts";
import type { Palette } from "./types.ts";
import { Button, Icon, Input, styles } from "./ui.tsx";
import Connection from "./Connection.tsx";
import { readLocalMarketSettings } from "./localMarketPreferences.ts";

export default function Settings({ state: s, palette: p }: { state: TradingState; palette: Palette }) {
  const [connection, setConnection] = useState(false);
  let localSettingsIssue = "";
  try { readLocalMarketSettings(s.localMarketPreferences); }
  catch (error) { localSettingsIssue = error instanceof Error ? error.message : "请检查本地市价参数。"; }
  if (connection) return <View style={{ flex: 1 }}>
    <View style={{ alignItems: "flex-start", paddingHorizontal: 12 }}>
      <Button label="返回设置" palette={p} disabled={s.busy} onPress={() => setConnection(false)} />
    </View>
    <Connection state={s} palette={p} />
  </View>;
  return <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
    contentContainerStyle={styles.pageContent}>
    <View style={[styles.card, { backgroundColor: p.surface, gap: 12 }]}>
      <View style={styles.spread}>
        <View style={styles.row}>
          <Icon name="trade" color={p.accent} size={22} />
          <Text style={{ color: p.text, fontSize: 17, fontWeight: "600" }}>快速模式</Text>
        </View>
        <Switch accessibilityLabel="快速模式" value={s.quickMode} disabled={s.busy || !s.storageReady}
          trackColor={{ false: p.separator, true: p.accent }} ios_backgroundColor={p.separator}
          onValueChange={(value) => void s.run(() => s.changeQuickMode(value))} />
      </View>
      <Text style={{ color: p.secondary, fontSize: 13, lineHeight: 20 }}>
        开启后，点买入、卖出或单笔撤单即提交，不再显示二次确认。账户、数量与订单状态仍会自动校验。
      </Text>
      <Text style={{ color: s.quickMode ? p.accent : p.secondary, fontSize: 12 }}>
        {s.quickMode ? "已开启 · 真实模式下按钮会直接发送真实委托" : "默认关闭 · 交易前显示订单核对页"}
      </Text>
    </View>
    <View style={[styles.card, { backgroundColor: p.surface, gap: 12 }]}>
      <Text style={{ color: p.text, fontSize: 17, fontWeight: "600" }}>本地市价单 · 价格优先</Text>
      <Text style={{ color: p.secondary, fontSize: 13, lineHeight: 20 }}>
        买入从买一向中间价靠近，卖出从卖一向中间价靠近。首次等待后最多让价到中间价，争取更好的价格，可能无法成交。
      </Text>
      <View style={{ gap: 6 }}>
        <Text style={{ color: p.text, fontSize: 13 }}>起挂位置 · 占买卖价差 %</Text>
        <Input palette={p} testID="settings.local.startSpread" accessibilityLabel="起挂位置占买卖价差百分比"
          placeholder="0–50，25 为价差内四分之一" keyboardType="decimal-pad"
          value={s.localMarketPreferences.startSpreadPercent}
          editable={!s.busy && s.localMarketPreferencesReady}
          onChangeText={value => s.changeLocalMarketPreference("startSpreadPercent", value)} />
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={{ color: p.text, fontSize: 13 }}>价格边界 · %</Text>
          <Input palette={p} testID="settings.local.boundary" accessibilityLabel="本地市价价格边界百分比"
            placeholder="例如 0.5" keyboardType="decimal-pad"
            value={s.localMarketPreferences.boundaryPercent}
            editable={!s.busy && s.localMarketPreferencesReady}
            onChangeText={value => s.changeLocalMarketPreference("boundaryPercent", value)} />
        </View>
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={{ color: p.text, fontSize: 13 }}>最长执行 · 秒</Text>
          <Input palette={p} testID="settings.local.duration" accessibilityLabel="本地市价追价时长秒数"
            placeholder="1–3600 秒" keyboardType="number-pad"
            value={s.localMarketPreferences.durationSeconds}
            editable={!s.busy && s.localMarketPreferencesReady}
            onChangeText={value => s.changeLocalMarketPreference("durationSeconds", value)} />
        </View>
      </View>
      {([
        [{ key: "repriceIntervalSeconds", label: "最短改单间隔 · 秒", hint: "2–60", id: "interval" },
          { key: "minRepriceTicks", label: "最小改价 · 价位数", hint: "1–100", id: "ticks" }],
        [{ key: "jumpPercent", label: "3 秒突变阈值 · %", hint: "例如 0.5", id: "jump" },
          { key: "maxSpreadPercent", label: "最大价差 · %", hint: "例如 1", id: "spread" }],
      ] as const).map((row, index) => <View key={index} style={{ flexDirection: "row", gap: 10 }}>
        {row.map(field => <View key={field.key} style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <Text style={{ color: p.text, fontSize: 13 }}>{field.label}</Text>
          <Input palette={p} testID={`settings.local.${field.id}`} accessibilityLabel={field.label}
            placeholder={field.hint} keyboardType={index === 0 ? "number-pad" : "decimal-pad"}
            value={s.localMarketPreferences[field.key]} editable={!s.busy && s.localMarketPreferencesReady}
            onChangeText={value => s.changeLocalMarketPreference(field.key, value)} />
        </View>)}
      </View>)}
      <Text style={{ color: p.secondary, fontSize: 12, lineHeight: 19 }}>
        价差阈值按买卖价差 ÷ 中间价计算。价格边界固定相对启动中间价，不随改单放宽。首次挂单等待达到改单间隔后，允许让到中间价。
        中间价突变、价差超限、突破价格边界或超时会停止并撤销剩余委托，不会自动重启。参数是可调整的初始值，未经回测证明最优。
      </Text>
      {!!localSettingsIssue && s.localMarketPreferencesReady && <Text accessibilityRole="alert"
        testID="settings.local.validation" style={{ color: p.down, fontSize: 12, lineHeight: 19 }}>
        {localSettingsIssue}
      </Text>}
      <Text style={{ color: s.localMarketPreferencesError ? p.down : p.secondary, fontSize: 12 }}>
        {s.localMarketPreferencesError || (!s.localMarketPreferencesReady ? "正在恢复参数…"
          : s.localMarketPreferencesSaving ? "正在保存…" : "参数自动保存在此设备，交易执行期间不可修改。")}
      </Text>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Schwab 连接" disabled={s.busy}
      onPress={() => setConnection(true)} style={[styles.card, styles.spread, { backgroundColor: p.surface }]}>
      <View style={styles.row}>
        <Icon name="link" color={p.accent} size={22} />
        <View style={{ gap: 5 }}>
          <Text style={{ color: p.text, fontSize: 17 }}>Schwab 连接</Text>
          <Text style={{ color: p.secondary, fontSize: 12 }}>{s.isDemo ? "演示模式" : s.status.authenticated ? "已授权" : "登录授权与个人配置"}</Text>
        </View>
      </View>
      <Text style={{ color: p.secondary, fontSize: 22 }}>›</Text>
    </Pressable>
  </ScrollView>;
}
