import type { Broker, Vault } from "./types.ts";

export const PERSONAL_CONFIG_RESOURCE = "THSPersonalConfiguration.json";
const IMPORTED_KEY = "ths.schwab.bundledConfigurationImported.v1";

export function parsePersonalConfiguration(raw: string) {
  const failure = () => new Error("个人配置文件格式不正确，请重新导入。");
  if (raw.length > 16384) throw failure();
  let value;
  try { value = JSON.parse(raw); } catch { throw failure(); }
  if (!value || value.version !== 1 || typeof value.clientID !== "string" || typeof value.clientSecret !== "string")
    throw failure();
  const clientID = value.clientID.trim(), clientSecret = value.clientSecret.trim();
  const valid = (text: string) => text.length > 0 && new TextEncoder().encode(text).length <= 512 && !/[\s\p{Cc}\p{Cf}]/u.test(text);
  if (!valid(clientID) || clientID.includes(":") || !valid(clientSecret)) throw failure();
  return { clientID, clientSecret };
}

/** Seed the Keychain once; never overwrite authorization or undo an explicit reset. */
export async function seedPersonalConfiguration(
  broker: Pick<Broker, "status" | "configure">,
  vault: Pick<Vault, "get" | "set">,
  readBundle: () => Promise<string | undefined>,
): Promise<boolean> {
  if ((await broker.status()).configured) {
    if (!(await vault.get(IMPORTED_KEY))) await vault.set(IMPORTED_KEY, "1");
    return true;
  }
  if (await vault.get(IMPORTED_KEY)) return false;
  const raw = await readBundle();
  if (raw === undefined) return false;
  const config = parsePersonalConfiguration(raw);
  await broker.configure(config.clientID, config.clientSecret);
  await vault.set(IMPORTED_KEY, "1");
  return true;
}
