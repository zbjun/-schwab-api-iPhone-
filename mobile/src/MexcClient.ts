import { ServerBroker } from "./ServerBroker.ts";
import { TradingError } from "./orderRules.ts";
import { MEXC_ACCOUNT, MEXC_MESSAGES, freezeMexcDraft, isOpening, validateMexcDraft, validMexcOrderID } from "./mexcRules.ts";
import type { MexcAccount, MexcContract, MexcDraft, MexcLimits, MexcOrder, MexcPrepared, MexcTicker } from "./mexcRules.ts";
import type { FetchTransport } from "./broker.ts";
import type { History, HistoryRange, SessionStatus, Vault } from "./types.ts";

export type MexcStatus = SessionStatus & {
  tradingBlocked?: string;
  /** A write is being processed on the server right now; this is not yet a problem. */
  writeInProgress?: boolean;
};
/** Everything the MEXC screens need. The real client and the demo both implement it. */
export interface MexcApi {
  readonly isDemo: boolean;
  status(): Promise<MexcStatus>;
  account(): Promise<MexcAccount>;
  contracts(): Promise<MexcContract[]>;
  limits(): Promise<MexcLimits>;
  tickers(symbols: string[]): Promise<MexcTicker[]>;
  chart(symbol: string, range: HistoryRange): Promise<History>;
  openOrders(): Promise<MexcOrder[]>;
  closedOrders(symbol: string, from: number, to: number): Promise<MexcOrder[]>;
  review(draft: MexcDraft): Promise<MexcPrepared>;
  place(prepared: MexcPrepared): Promise<{ orderID: string }>;
  cancelOrder(orderID: string): Promise<void>;
  acknowledgeReconciliation(): Promise<void>;
}

const CONNECTION_TEXT: Record<string, string> = {
  serverDeviceUnauthorized: "设备访问密钥已失效或无权限，请检查 MEXC 网关的设备配置。",
  serverTimeout: "MEXC 网关连接超时，请检查网络。",
  serverUnavailable: "无法连接 MEXC 网关或响应无效，请检查网络和服务器。",
};
/** Device keys and markers stay apart from the Schwab gateway's, so neither locks the other. */
function prefixedVault(vault: Vault): Vault {
  return {
    get: key => vault.get("mexc." + key),
    set: (key, value) => vault.set("mexc." + key, value),
    remove: key => vault.remove("mexc." + key),
  };
}

/** A second gateway connection speaking the same one-use review and never-retried write protocol. */
export class MexcClient extends ServerBroker implements MexcApi {
  readonly isDemo = false;
  constructor(vault: Vault, options: { fetch?: FetchTransport; timeoutMilliseconds?: number } = {}) {
    super(prefixedVault(vault), options);
  }
  protected override messages(): Record<string, string> { return { ...MEXC_MESSAGES, ...CONNECTION_TEXT }; }
  override async status(): Promise<MexcStatus> {
    try { return await super.status() as MexcStatus; }
    catch (error) {
      // The gateway being unreachable must not hide a write this device could not confirm.
      if (await this.hasUnconfirmedWrite()) return { configured: true, authenticated: false, unresolvedOperation: true };
      throw error;
    }
  }
  async account(): Promise<MexcAccount> {
    const accounts = await this.rpc<MexcAccount[]>("accounts");
    const account = Array.isArray(accounts) ? accounts[0] : undefined;
    if (!account?.asset || !Array.isArray(account.positions))
      throw new TradingError("serverUnavailable", CONNECTION_TEXT.serverUnavailable);
    return account;
  }
  contracts() { return this.rpc<MexcContract[]>("contracts"); }
  limits() { return this.rpc<MexcLimits>("limits"); }
  tickers(symbols: string[]) { return this.rpc<MexcTicker[]>("quotes", [symbols]); }
  chart(symbol: string, range: HistoryRange) { return this.rpc<History>("history", [symbol, range]); }
  openOrders() { return this.rpc<MexcOrder[]>("orders", [MEXC_ACCOUNT]); }
  closedOrders(symbol: string, from: number, to: number) { return this.rpc<MexcOrder[]>("closedOrders", [symbol, from, to]); }
  async review(draft: MexcDraft): Promise<MexcPrepared> {
    validateMexcDraft(draft); // Precise local messages before anything is sent.
    const sent = freezeMexcDraft(draft);
    // Measured on this device, as for Schwab: the server enforces its own one-use deadline.
    const startedAt = Date.now();
    const prepared = await this.rpc<MexcPrepared>("prepare", [MEXC_ACCOUNT, sent]);
    const back = prepared?.draft;
    // The screen must show what the server will send, not what was asked for.
    if (!prepared || typeof prepared.id !== "string" || !prepared.id || prepared.isDemo !== false || !back ||
        back.symbol !== sent.symbol || back.action !== sent.action || back.kind !== sent.kind || back.vol !== sent.vol ||
        back.price !== sent.price || back.leverage !== sent.leverage ||
        typeof prepared.orderPrice !== "string" || !Number.isFinite(prepared.notional) ||
        (sent.kind === "LIMIT" && prepared.orderPrice !== sent.price) || prepared.leverage !== sent.leverage ||
        (isOpening(sent.action) && prepared.openType !== 1))
      throw new TradingError("serverUnavailable", "服务器返回的核对信息无效，本次未提交。");
    return { ...prepared, preparedAt: startedAt };
  }
  /**
   * A timeout or a lost reply keeps the device's marker because the order may exist. Say so plainly:
   * "could not connect" would invite a second attempt. Only a request that never started stays as it is.
   */
  private async honest<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof TradingError && error.code === "operationBusy") throw error;
      if (await this.hasUnconfirmedWrite().catch(() => true))
        throw new TradingError("orderOutcomeUnknown", MEXC_MESSAGES.orderOutcomeUnknown);
      throw error;
    }
  }
  place(prepared: MexcPrepared) {
    return this.honest(() => this.write<{ orderID: string }>("submit", [{ id: prepared.id }], result => {
      // An accepted write without a usable id cannot be matched to an order.
      if (!validMexcOrderID(result?.orderID))
        throw new TradingError("orderOutcomeUnknown", MEXC_MESSAGES.orderOutcomeUnknown);
      return result;
    }));
  }
  cancelOrder(orderID: string) { return this.honest(() => this.write<void>("cancel", [MEXC_ACCOUNT, orderID])); }
}
