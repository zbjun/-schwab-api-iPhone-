import type { MexcApi, MexcStatus } from "../MexcClient.ts";
import type { MexcAccount, MexcContract, MexcDraft, MexcLeveragePrepared, MexcLimits, MexcOrder, MexcPrepared, MexcStopPrepared } from "../mexcRules.ts";
import { orderEntryBlocked, reviewExpired, tradingLocked } from "./mexcView.ts";

export const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : "操作失败，请稍后重试。");
const isUnknown = (error: unknown) => (error as { code?: string } | undefined)?.code === "orderOutcomeUnknown";

export interface MexcSnapshot {
  status?: MexcStatus;
  account?: MexcAccount;
  contracts: MexcContract[];
  limits?: MexcLimits;
  openOrders: MexcOrder[];
  /** The last refresh failed; whatever is shown is the previous data. */
  offline: boolean;
  /** False when this phone has no saved MEXC connection; undefined until that is known. */
  configured?: boolean;
  /** When the account was last read successfully. */
  updatedAt?: number;
  message: string;
  /** This session saw an order whose outcome is unknown. Only a successful acknowledge clears it. */
  sawUnknown: boolean;
  /** A place or cancel is on the wire right now. */
  sending: boolean;
}

/** How long an accepted cancel holds off another one for the same order, in case the list never catches up. */
const CANCEL_SETTLE = 10_000;

const EMPTY: MexcSnapshot = { contracts: [], openOrders: [], offline: false, message: "", sawUnknown: false, sending: false };

/**
 * All state and write handling of the MEXC screens, with no React in it so it can be tested.
 * Writes are sent at most once: one at a time, never retried, and an unknown outcome locks trading
 * until acknowledge() succeeds.
 */
export class MexcController {
  readonly api: MexcApi;
  private snapshot: MexcSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private inflight: Promise<void> | undefined;
  private token = 0;
  private loaded = false;
  private readonly pollSeen = new Map<string, string>();
  private readonly cancelAccepted = new Map<string, number>();

  constructor(api: MexcApi) { this.api = api; }

  getSnapshot = (): MexcSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(patch: Partial<MexcSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Writes are disabled: unconfirmed order, or the server is still processing one. */
  get locked(): boolean { return tradingLocked(this.snapshot.status, this.snapshot.sawUnknown); }

  /** Drops any read still on its way. Safe to call and then use again (a remount does exactly that). */
  dispose() { this.token++; this.inflight = undefined; }

  /** Forgets everything shown, e.g. after the saved connection is removed. A response still in flight is dropped. */
  reset() {
    this.token++; this.inflight = undefined; this.loaded = false; this.pollSeen.clear();
    this.set({ ...EMPTY, status: undefined, account: undefined, limits: undefined, updatedAt: undefined, sending: this.snapshot.sending });
  }

  setMessage = (message: string) => this.set({ message });
  noteError = (error: unknown) => {
    if (isUnknown(error)) this.set({ sawUnknown: true });
    this.set({ message: errorText(error) });
  };
  /** A background poll failed. The same text is not shown again until a poll from that source succeeds. */
  pollError = (source: string, error: unknown) => {
    if (isUnknown(error)) this.set({ sawUnknown: true });
    const text = errorText(error);
    if (this.pollSeen.get(source) === text) return;
    this.pollSeen.set(source, text);
    this.set({ message: text });
  };
  pollOk = (source: string) => { this.pollSeen.delete(source); };
  run = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try { return await work(); } catch (error) { this.noteError(error); return undefined; }
  };

  /** Joins a refresh already under way. */
  refresh = (): Promise<void> => this.inflight ?? this.start();
  /** After a write: always reads again, and drops any older read that is still on its way. */
  refreshAfter = (): Promise<void> => this.start();

  private start(): Promise<void> {
    const mine = ++this.token;
    const work = (async () => {
      try {
        // With no connection saved there is no account to read and no outage to show. The status is still read: it
        // answers from the phone and carries any unknown outcome, which only a person may clear. An unreadable
        // connection goes on to the same status read, so it cannot hide that either.
        const saved = await Promise.resolve(this.api.configuration?.()).catch(() => undefined);
        if (mine !== this.token) return;
        if (saved === null) {
          const status = await this.api.status();
          if (mine !== this.token) return;
          this.set({ status, configured: false, offline: false });
          this.pollOk("refresh");
          return;
        }
        if (this.snapshot.configured !== true) this.set({ configured: true });
        const status = await this.api.status();
        if (mine !== this.token) return;
        // The lock and any closure show as soon as the status is known, whatever the other reads do.
        this.set({ status });
        const [account, openOrders, limits, contracts] = await Promise.all([
          this.api.account(), this.api.openOrders(), this.api.limits(), this.loaded ? undefined : this.api.contracts(),
        ]);
        if (mine !== this.token) return;
        const patch: Partial<MexcSnapshot> = { account, openOrders, limits, offline: false, updatedAt: Date.now() };
        for (const id of [...this.cancelAccepted.keys()]) if (!openOrders.some(order => order.id === id)) this.cancelAccepted.delete(id);
        if (contracts && contracts.length) { patch.contracts = contracts; this.loaded = true; }
        this.set(patch);
        this.pollOk("refresh");
      } catch (error) {
        if (mine !== this.token) return;
        this.set({ offline: true });
        this.pollError("refresh", error);
      } finally {
        if (mine === this.token) this.inflight = undefined;
      }
    })();
    this.inflight = work;
    return work;
  }

  async acknowledge(): Promise<void> {
    try {
      await this.api.acknowledgeReconciliation();
    } catch (error) {
      this.noteError(error); // Still locked.
      return;
    }
    const status = this.snapshot.status;
    // Shown as cleared at once, even if the read after it fails.
    // The note about the unconfirmed order goes too: it no longer applies.
    this.set({ sawUnknown: false, message: "", ...(status ? { status: { ...status, unresolvedOperation: false } } : {}) });
    await this.refreshAfter();
  }

  /** Sends one reviewed order. Spent whatever happens; never retried. */
  async place(prepared: MexcPrepared): Promise<{ orderID?: string; error?: string; unknown?: boolean }> {
    if (this.snapshot.sending) return { error: "上一笔操作还在发送中。" };
    if (this.locked) return { error: "交易已锁定，不能下单。" };
    if (orderEntryBlocked(this.snapshot.status?.tradingBlocked, prepared.draft.action)) return { error: "服务器已关闭下单。" };
    this.set({ sending: true });
    return this.send(prepared);
  }

  /**
   * Quick mode: one press reviews and sends. Only the person's look at the review is skipped. The server still makes
   * and checks the same one-use review, the send is the same as `place`, and nothing here retries. Marked as sending
   * from the start, so leaving the screen cannot strand an order on its way.
   */
  async quickPlace(draft: MexcDraft, isCurrent: () => boolean): Promise<{ orderID?: string; error?: string; unknown?: boolean }> {
    if (this.snapshot.sending) return { error: "上一笔操作还在发送中。" };
    if (this.locked) return { error: "交易已锁定，不能下单。" };
    if (orderEntryBlocked(this.snapshot.status?.tradingBlocked, draft.action)) return { error: "服务器已关闭下单。" };
    this.set({ sending: true });
    let prepared: MexcPrepared;
    try {
      prepared = await this.api.review(draft);
    } catch (error) {
      this.noteError(error);
      this.set({ sending: false });
      return { error: errorText(error), ...(isUnknown(error) ? { unknown: true } : {}) };
    }
    // Any of these can have changed while the review was on its way. Nothing is sent, and the review expires unused.
    const stopped = !isCurrent() ? "委托内容已变化，这笔没有发送，请重新下单。"
      : this.locked ? "交易已锁定，这笔没有发送。"
        : orderEntryBlocked(this.snapshot.status?.tradingBlocked, draft.action) ? "服务器已关闭下单，这笔没有发送。"
          : reviewExpired(prepared.preparedAt, Date.now()) ? "核对已过期，这笔没有发送，请重新下单。" : "";
    if (stopped) {
      this.set({ message: stopped, sending: false });
      return { error: stopped };
    }
    return this.send(prepared);
  }

  private async send(prepared: MexcPrepared): Promise<{ orderID?: string; error?: string; unknown?: boolean }> {
    try {
      const result = await this.api.place(prepared);
      // MEXC's answer says nothing about what the order carries, so the position is the proof.
      const carried = prepared.draft.takeProfitPrice !== undefined || prepared.draft.stopLossPrice !== undefined;
      this.set({ message: `${this.api.isDemo ? "演示" : ""}委托已提交，编号 ${result.orderID}。${carried ? "成交后请确认持仓上显示了止盈止损。" : ""}` });
      void this.refreshAfter();
      return { orderID: result.orderID };
    } catch (error) {
      this.noteError(error); // No retry; an unknown outcome also locks trading.
      void this.refreshAfter();
      return { error: errorText(error), ...(isUnknown(error) ? { unknown: true } : {}) };
    } finally {
      this.set({ sending: false });
    }
  }

  /** Changes one position's leverage after its own review, under the same rules as an order. */
  async changeLeverage(prepared: MexcLeveragePrepared): Promise<{ leverage?: number; error?: string; unknown?: boolean }> {
    if (this.snapshot.sending) return { error: "上一笔操作还在发送中。" };
    if (this.locked) return { error: "交易已锁定，不能修改杠杆。" };
    // More leverage is more exposure, so any closure of order entry stops it, as it stops an opening order.
    if (orderEntryBlocked(this.snapshot.status?.tradingBlocked, "OPEN_LONG")) return { error: "服务器已关闭下单。" };
    this.set({ sending: true });
    try {
      const result = await this.api.changeLeverage(prepared);
      // MEXC's answer only says it accepted; the position shown after this refresh is the proof.
      this.set({ message: `${this.api.isDemo ? "演示持仓" : "MEXC 已接受，"}杠杆改为 ${result.leverage}x，请以持仓显示为准。` });
      void this.refreshAfter();
      return { leverage: result.leverage };
    } catch (error) {
      this.noteError(error);
      void this.refreshAfter();
      return { error: errorText(error), ...(isUnknown(error) ? { unknown: true } : {}) };
    } finally {
      this.set({ sending: false });
    }
  }

  /** Sets, changes or cancels one take-profit and stop-loss after its own review, under the same rules as an order. */
  async changeStop(prepared: MexcStopPrepared): Promise<{ done?: boolean; error?: string; unknown?: boolean }> {
    if (this.snapshot.sending) return { error: "上一笔操作还在发送中。" };
    if (this.locked) return { error: "交易已锁定，不能修改止盈止损。" };
    // A failed key lookup lets this through as it does a close. Cancelling is never closed.
    if (prepared.draft.kind !== "STOP_CANCEL" && orderEntryBlocked(this.snapshot.status?.tradingBlocked, "CLOSE_LONG")) return { error: "服务器已关闭下单。" };
    this.set({ sending: true });
    try {
      await this.api.changeStop(prepared);
      const verb = prepared.draft.kind === "STOP_CANCEL" ? "已取消" : prepared.draft.kind === "STOP_CHANGE" ? "已修改" : "已设置";
      // MEXC's answer only says it accepted; the list shown after this refresh is the proof.
      this.set({ message: `${this.api.isDemo ? "演示" : "MEXC 已接受，"}止盈止损${verb}，请以持仓显示为准。` });
      void this.refreshAfter();
      return { done: true };
    } catch (error) {
      this.noteError(error);
      void this.refreshAfter();
      return { error: errorText(error), ...(isUnknown(error) ? { unknown: true } : {}) };
    } finally {
      this.set({ sending: false });
    }
  }

  /** A cancel for this order was accepted a moment ago and the list has not caught up. Another press is not another write. */
  cancelSent = (orderID: string): boolean => {
    const at = this.cancelAccepted.get(orderID);
    return at !== undefined && Date.now() - at < CANCEL_SETTLE;
  };

  /** Cancels one order once. A failure is shown, never retried. */
  async cancel(orderID: string): Promise<boolean> {
    if (this.snapshot.sending || this.locked || this.cancelSent(orderID)) return false;
    this.set({ sending: true });
    try {
      await this.api.cancelOrder(orderID);
      this.cancelAccepted.set(orderID, Date.now());
      this.set({ message: `${this.api.isDemo ? "演示" : ""}委托已撤销。` });
      return true;
    } catch (error) {
      this.noteError(error);
      return false;
    } finally {
      this.set({ sending: false });
      void this.refreshAfter();
    }
  }
}
