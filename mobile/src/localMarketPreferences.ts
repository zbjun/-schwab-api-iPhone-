import { validateLocalMarketSettings, type LocalMarketSettings } from "./localMarket.ts";

export const localMarketSettingsKey = "ths.expo.localMarket.settings.v1";
export interface LocalMarketPreferences {
  slippagePercent: string;
  boundaryPercent: string;
  durationSeconds: string;
}
export const emptyLocalMarketPreferences: LocalMarketPreferences = {
  slippagePercent: "", boundaryPercent: "", durationSeconds: "",
};

/** Older installations saved only boundary and duration: slippage still needs an explicit choice. */
export function decodeLocalMarketPreferences(raw: string | null): LocalMarketPreferences {
  if (!raw) return { ...emptyLocalMarketPreferences };
  const saved: unknown = JSON.parse(raw);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid local market preferences");
  const value = saved as Record<string, unknown>;
  return {
    slippagePercent: typeof value.slippagePercent === "string" ? value.slippagePercent : "",
    boundaryPercent: typeof value.boundaryPercent === "string" ? value.boundaryPercent : "",
    durationSeconds: typeof value.durationSeconds === "string" ? value.durationSeconds : "",
  };
}

export function readLocalMarketSettings(preferences: LocalMarketPreferences): LocalMarketSettings {
  if (Object.values(preferences).some(value => !value.trim()))
    throw new Error("请先到设置 → 本地市价单填写滑点、价格边界和追价时长。");
  const settings = {
    slippagePercent: Number(preferences.slippagePercent),
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
