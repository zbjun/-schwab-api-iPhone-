import React, { useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import type { TradingState } from "./useTrading.ts";
import type { Palette } from "./types.ts";
import { Button, Icon, styles } from "./ui.tsx";
import Connection from "./Connection.tsx";

export default function Settings({ state: s, palette: p }: { state: TradingState; palette: Palette }) {
  const [connection, setConnection] = useState(false);
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
