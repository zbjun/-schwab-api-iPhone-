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
  return <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
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
      <Text style={{ color: p.text, fontSize: 17, fontWeight: "600" }}>本地市价单</Text>
      <Text style={{ color: p.secondary, fontSize: 13, lineHeight: 20 }}>
        买入价 = 买卖中间价 ×（1 + 滑点%）；卖出价 = 买卖中间价 ×（1 − 滑点%）。中间价取买一与卖一的平均值。
      </Text>
      <View style={{ gap: 6 }}>
        <Text style={{ color: p.text, fontSize: 13 }}>滑点 · %</Text>
        <Input palette={p} testID="settings.local.slippage" accessibilityLabel="本地市价滑点百分比"
          placeholder="例如 0.1，表示 0.1%" keyboardType="decimal-pad"
          value={s.localMarketPreferences.slippagePercent}
          editable={!s.busy && s.localMarketPreferencesReady}
          onChangeText={value => s.changeLocalMarketPreference("slippagePercent", value)} />
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
          <Text style={{ color: p.text, fontSize: 13 }}>追价时长 · 秒</Text>
          <Input palette={p} testID="settings.local.duration" accessibilityLabel="本地市价追价时长秒数"
            placeholder="1–3600 秒" keyboardType="number-pad"
            value={s.localMarketPreferences.durationSeconds}
            editable={!s.busy && s.localMarketPreferencesReady}
            onChangeText={value => s.changeLocalMarketPreference("durationSeconds", value)} />
        </View>
      </View>
      <Text style={{ color: p.secondary, fontSize: 12, lineHeight: 19 }}>
        价格边界固定相对启动时的中间价，包含滑点，不会随追价放宽。滑点不能超过边界；边界须小于 100%。
        达到边界或超时后停止追价并撤销剩余委托。滑点不足以覆盖价差时可能等待成交。
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
