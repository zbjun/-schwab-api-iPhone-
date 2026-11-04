import AsyncStorage from "@react-native-async-storage/async-storage";
import { VENUE_KEY, parseVenue, type Venue } from "./mexcView.ts";

/** Which venue the trade page last used. A read failure starts on Schwab. */
export async function readVenue(): Promise<Venue> {
  try { return parseVenue(await AsyncStorage.getItem(VENUE_KEY)); } catch { return "schwab"; }
}
export async function writeVenue(venue: Venue): Promise<void> {
  try { await AsyncStorage.setItem(VENUE_KEY, venue); } catch { /* The switch still applies for this session. */ }
}
