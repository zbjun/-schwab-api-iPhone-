import AsyncStorage from "@react-native-async-storage/async-storage";
import { FAVORITES_KEY, parseFavorites } from "./mexcView.ts";

/** Favourite contracts stay on this device. A read failure simply shows none. */
export async function readFavorites(): Promise<string[]> {
  try { return parseFavorites(await AsyncStorage.getItem(FAVORITES_KEY)); } catch { return []; }
}
export async function writeFavorites(favorites: readonly string[]): Promise<void> {
  try { await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); } catch { /* The change still applies for this session. */ }
}
