import { validateLocalMarketSettings, type LocalMarketSettings } from "./localMarket.ts";

export const localMarketSettingsKey = "ths.expo.localMarket.settings.v1";
export interface LocalMarketPreferences {
  startSpreadPercent: string;
  repriceIntervalSeconds: string;
  minRepriceTicks: string;
  jumpPercent: string;
  maxSpreadPercent: string;
  boundaryPercent: string;
  durationSeconds: string;
}
export const emptyLocalMarketPreferences: LocalMarketPreferences = {
  startSpreadPercent: "25", repriceIntervalSeconds: "5", minRepriceTicks: "2",
  jumpPercent: "0.5", maxSpreadPercent: "1", boundaryPercent: "", durationSeconds: "",
};

/** Preserve existing limits; the old price-based slippage is never interpreted as a spread fraction. */
export function decodeLocalMarketPreferences(raw: string | null): LocalMarketPreferences {
  if (!raw) return { ...emptyLocalMarketPreferences };
  const saved: unknown = JSON.parse(raw);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid local market preferences");
  const value = saved as Record<string, unknown>;
  return Object.fromEntries(Object.entries(emptyLocalMarketPreferences).map(([key, fallback]) =>
    [key, value[key] === undefined ? fallback : typeof value[key] === "string" ? value[key] : ""]
  )) as unknown as LocalMarketPreferences;
}

export function readLocalMarketSettings(preferences: LocalMarketPreferences): LocalMarketSettings {
  if (Object.values(preferences).some(value => !value.trim()))
    throw new Error("请先到设置 → 本地市价单填写完整的价格优先参数、价格边界和执行时长。");
  const settings = {
    startSpreadPercent: Number(preferences.startSpreadPercent),
    repriceIntervalSeconds: Number(preferences.repriceIntervalSeconds),
    minRepriceTicks: Number(preferences.minRepriceTicks),
    jumpPercent: Number(preferences.jumpPercent),
    maxSpreadPercent: Number(preferences.maxSpreadPercent),
    boundaryPercent: Number(preferences.boundaryPercent),
    durationSeconds: Number(preferences.durationSeconds),
  };
  validateLocalMarketSettings(settings);
  return settings;
}

/** Serialize edits so a slow earlier save cannot overwrite a newer preference. */
export function createLocalMarketPreferenceWriter(write: (raw: string) => Promise<void>) {
  let pending = Promise.resolve();
  return (preferences: LocalMarketPreferences) => {
    const raw = JSON.stringify(preferences);
    const result = pending.then(() => write(raw));
    pending = result.catch(() => {});
    return result;
  };
}
