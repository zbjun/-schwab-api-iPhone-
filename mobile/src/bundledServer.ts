import { serverOrigin } from "./ServerBroker.ts";
import type { Vault } from "./types.ts";

const IMPORTED = "ths.server.bundledConfigurationImported.v1";
export function parseBundledServer(raw: string) {
  const fail = () => new Error("内置服务器配置格式不正确。");
  if (raw.length > 16384) throw fail();
  let value;
  try { value = JSON.parse(raw); } catch { throw fail(); }
  if (value?.version === 1) return undefined;
  if (!value || value.version !== 2 || value.mode !== "server" ||
    Object.keys(value).sort().join(",") !== "deviceKey,mode,origin,version" ||
    typeof value.origin !== "string" || typeof value.deviceKey !== "string" ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(value.deviceKey)) throw fail();
  return { origin: serverOrigin(value.origin), deviceKey: value.deviceKey };
}

export async function seedBundledServer(
  broker: { configuration(): Promise<{ origin: string } | null>; configureServer(origin: string, key: string): Promise<void> },
  vault: Pick<Vault, "get" | "set">,
  readBundle: () => Promise<string | undefined>,
  activate: () => Promise<void> = async () => {},
  options: { restoreMissing?: boolean } = {},
): Promise<boolean> {
  // Only an explicit user recovery may bypass the one-time import marker.
  // Never replace a configured device identity, including on recovery.
  if (options.restoreMissing && await broker.configuration()) return false;
  if (!options.restoreMissing && await vault.get(IMPORTED)) return false;
  const raw = await readBundle();
  if (raw === undefined) return false;
  const config = parseBundledServer(raw);
  if (!config) return false;
  // Preserve a manually configured server and its device identity on upgrade.
  if (!(await broker.configuration())) await broker.configureServer(config.origin, config.deviceKey);
  await activate();
  await vault.set(IMPORTED, "1");
  return true;
}
