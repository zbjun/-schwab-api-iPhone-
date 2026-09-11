import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { fetch as nativeFetch } from "expo/fetch";
import type { Vault } from "./types.ts";
import { SchwabBroker } from "./broker.ts";
import { ServerBroker } from "./ServerBroker.ts";
import { PERSONAL_CONFIG_RESOURCE, parsePersonalConfiguration, seedPersonalConfiguration } from "./personalConfiguration.ts";
import { seedBundledServer } from "./bundledServer.ts";

const key = (value: string) =>
  `ths.expo.v1.${[...value].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}`;
const nativeOnly = () => {
  if (Platform.OS === "web")
    throw new Error("真实连接请在 iPhone 的 Expo Go 中使用。");
};
const vault: Vault = {
  async get(value) {
    nativeOnly();
    return SecureStore.getItemAsync(key(value));
  },
  async set(value, contents) {
    nativeOnly();
    await SecureStore.setItemAsync(key(value), contents, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async remove(value) {
    nativeOnly();
    await SecureStore.deleteItemAsync(key(value));
  },
};
export function createRealBroker() {
  return new SchwabBroker(vault, {
    fetch: nativeFetch,
    randomState: async () =>
      [...(await Crypto.getRandomBytesAsync(32))]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join(""),
  });
}
export function createServerBroker() {
  nativeOnly();
  return new ServerBroker(vault, { fetch: nativeFetch });
}
export async function restoreBundledConfiguration(broker: SchwabBroker) {
  if (Platform.OS !== "ios") return false;
  return seedPersonalConfiguration(broker, vault, async () => {
    const file = new File(Paths.bundle, PERSONAL_CONFIG_RESOURCE);
    if (!file.exists) return undefined;
    if (file.size > 16384) throw new Error("内置配置文件格式不正确。");
    const raw = await file.text();
    // A shared-server package must never seed direct Schwab credentials.
    if (JSON.parse(raw)?.version === 2) return undefined;
    return raw;
  });
}
export async function restoreBundledServer(broker: ServerBroker, activate: () => Promise<void>) {
  if (Platform.OS !== "ios") return false;
  return seedBundledServer(broker, vault, async () => {
    const file = new File(Paths.bundle, PERSONAL_CONFIG_RESOURCE);
    if (!file.exists) return undefined;
    if (file.size > 16384) throw new Error("内置配置文件格式不正确。");
    return file.text();
  }, activate);
}
export async function importConfiguration(): Promise<
  { clientID: string; clientSecret: string } | undefined
> {
  nativeOnly();
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return undefined;
  const file = new File(result.assets[0].uri);
  try {
    if (file.size > 16384) throw new Error("请选择 THS 个人配置 JSON 文件。");
    return parsePersonalConfiguration(await file.text());
  } finally {
    if (file.uri.startsWith(Paths.cache.uri)) {
      try {
        file.delete();
      } catch {}
    }
  }
}
