import React from "react";
import { RefreshControl, type RefreshControlProps } from "react-native";
import type { Palette } from "./types.ts";
import type { TradingState } from "./useTrading.ts";

/** The four data tabs share the same refresh lock, feedback and native gesture. */
export function PageRefreshControl({ state: s, palette: p, refresh, ...props }: {
  state: TradingState;
  palette: Palette;
  refresh?: () => Promise<void>;
} & Omit<RefreshControlProps, "refreshing" | "onRefresh">) {
  // ScrollView injects layout props (and its children on web); forward all of them.
  return <RefreshControl {...props} refreshing={s.pullRefreshing}
    onRefresh={() => void s.pullRefresh(refresh)} enabled={!s.busy}
    tintColor={p.accent} colors={[p.accent]} />;
}
