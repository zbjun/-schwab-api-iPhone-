import { openMultiMarketStream } from "../mobile/src/marketStream.ts";
import type { MarketStreamCallbacks, StreamCredentials } from "../mobile/src/marketStream.ts";
import type { Candle, History, HistoryRange } from "../mobile/src/types.ts";
import type { MinuteArchive } from "./minuteArchive.ts";

type Quote = Parameters<MarketStreamCallbacks["onQuote"]>[0];
type Status = Parameters<MarketStreamCallbacks["onStatus"]>[0];
type Timer = ReturnType<typeof setTimeout>;
type Event = { revision: number; kind: "candle" | "forming"; candle: Candle };
interface SymbolState {
  revision: number;
  status: Status;
  quote?: Quote;
  events: Event[];
  forming: Map<number, Candle>;
  candles: Map<number, Candle>;
}
interface Device {
  symbol: string;
  expiry?: Timer;
  wake?: () => void;
}
export interface MarketSnapshot {
  cursor: number;
  status: Status;
  quote?: Quote;
  formingCandles: Candle[];
  candles: Candle[];
}
export interface MarketHubOptions {
  openStream?: typeof openMultiMarketStream;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  archive?: MinuteArchive;
  collectSymbols?: string[];
}

/** Server-local relay. Device identities must be authenticated by the HTTP handler. */
export class MarketHub {
  private devices = new Map<string, Device>();
  private symbols = new Map<string, SymbolState>();
  private revision = 0;
  private generation = 0;
  private stop?: (() => void) & { setSymbols?: (symbols: string[]) => void };
  private activityDevices = new Map<string, Device>();
  private activityRevision = 0;
  private activityStatus: Status = "connecting";
  private readonly collectSymbols: string[];
  private readonly archive?: MinuteArchive;
  private closed = false;
  private readonly openStream: typeof openMultiMarketStream;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  private readonly credentials: () => Promise<StreamCredentials>;

  constructor(credentials: () => Promise<StreamCredentials>, options: MarketHubOptions = {}) {
    this.credentials = credentials;
    this.openStream = options.openStream ?? openMultiMarketStream;
    this.schedule = options.setTimeout ?? setTimeout;
    this.cancel = options.clearTimeout ?? clearTimeout;
    const collect = options.collectSymbols ?? [];
    if (!Array.isArray(collect) || collect.length > 8 || collect.some(s => typeof s !== "string" || !/^[A-Z0-9][A-Z0-9.\/-]{0,19}$/.test(s)))
      throw new Error("Invalid collection symbols (maximum 8)");
    this.collectSymbols = [...new Set(collect)].sort();
    this.archive = options.archive;
    if (collect.length) this.rebuild();
  }

  private renew(id: string, device: Device) {
    if (device.expiry !== undefined) this.cancel(device.expiry);
    device.expiry = this.schedule(() => this.release(id), 45_000);
    device.expiry.unref?.();
  }

  private publish(symbol: string) {
    const state = this.symbols.get(symbol);
    if (!state) return;
    state.revision = ++this.revision;
    for (const device of this.devices.values()) {
      if (device.symbol === symbol) device.wake?.();
    }
  }

  private candle(symbol: string, candle: Candle, kind: Event["kind"]) {
    const state = this.symbols.get(symbol);
    if (!state) return;
    this.archive?.observe(symbol, { ...candle, ...(kind === "forming" ? { provisional: true } : {}) });
    if (kind === "forming") {
      const old = state.forming.get(candle.time);
      candle = { ...candle, open: old?.open ?? candle.open,
        high: Math.max(old?.high ?? candle.high, candle.high),
        low: Math.min(old?.low ?? candle.low, candle.low) };
      state.forming.set(candle.time, candle);
      if (state.forming.size > 128) state.forming.delete(Math.min(...state.forming.keys()));
    } else {
      state.candles.set(candle.time, { ...candle });
      if (state.candles.size > 128) state.candles.delete(Math.min(...state.candles.keys()));
    }
    state.events.push({ revision: this.revision + 1, kind, candle: { ...candle } });
    if (state.events.length > 512) state.events.splice(0, state.events.length - 512);
    this.publish(symbol);
  }

  private rebuild() {
    if (this.closed) return;
    const wanted = [...new Set([...this.collectSymbols, ...[...this.devices.values()].map((device) => device.symbol)])].sort();
    if (this.stop && (wanted.length || this.activityDevices.size) && wanted.join(",") === [...this.symbols.keys()].sort().join(",")) return;
    for (const symbol of this.symbols.keys()) if (!wanted.includes(symbol)) this.symbols.delete(symbol);
    for (const symbol of wanted) {
      if (!this.symbols.has(symbol)) this.symbols.set(symbol, {
        revision: ++this.revision, status: "connecting", events: [], forming: new Map(), candles: new Map(),
      });
    }
    if (this.stop?.setSymbols && (wanted.length || this.activityDevices.size)) {
      this.stop.setSymbols(wanted);
      return;
    }
    const epoch = ++this.generation;
    this.stop?.();
    this.stop = undefined;
    if (!wanted.length && !this.activityDevices.size) return;
    const active = () => !this.closed && epoch === this.generation;
    this.stop = this.openStream(wanted, this.credentials, {
      onStatus: (status) => {
        if (!active()) return;
        for (const symbol of this.symbols.keys()) {
          const state = this.symbols.get(symbol)!;
          state.status = status;
          this.publish(symbol);
        }
      },
      onQuote: (quote) => {
        if (!active()) return;
        const state = this.symbols.get(quote.symbol);
        if (!state) return;
        state.quote = { ...state.quote, ...quote };
        this.publish(quote.symbol);
      },
      onFormingCandle: (symbol, candle) => { if (active()) this.candle(symbol, candle, "forming"); },
      onCandle: (symbol, candle) => { if (active()) this.candle(symbol, candle, "candle"); },
      onAccountActivity: () => { if (active()) this.activityChanged(); },
      onAccountActivityStatus: (status) => {
        if (!active() || this.activityStatus === status) return;
        this.activityStatus = status;
        this.activityChanged();
      },
    });
  }

  mergeHistory(history: History, range: HistoryRange): History {
    return this.archive?.merge(history, range) ?? history;
  }

  private activityChanged() {
    this.activityRevision++;
    for (const device of this.activityDevices.values()) device.wake?.();
  }

  private renewActivity(id: string, device: Device) {
    if (device.expiry !== undefined) this.cancel(device.expiry);
    device.expiry = this.schedule(() => this.releaseActivity(id), 45_000);
    device.expiry.unref?.();
  }

  async pollActivity(id: string, cursor?: number, waitMs = 20_000, signal?: AbortSignal) {
    if (this.closed || !id || (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) ||
        !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 20_000) throw new Error("Invalid activity request");
    let device = this.activityDevices.get(id);
    if (device?.wake) throw new Error("Activity request already pending");
    if (!device && this.activityDevices.size >= 16) throw new Error("Activity device limit reached");
    if (!device) { cursor = undefined; device = { symbol: "" }; this.activityDevices.set(id, device); }
    this.renewActivity(id, device);
    this.rebuild();
    if (!signal?.aborted && cursor === this.activityRevision && waitMs) {
      await new Promise<void>(resolve => {
        let timer: Timer | undefined;
        const done = () => {
          if (device!.wake !== done) return;
          device!.wake = undefined;
          if (timer !== undefined) this.cancel(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        device!.wake = done;
        timer = this.schedule(done, waitMs);
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) done();
      });
    }
    if (this.activityDevices.get(id) === device) this.renewActivity(id, device);
    return { cursor: this.activityRevision, status: this.activityStatus };
  }

  releaseActivity(id: string) {
    const device = this.activityDevices.get(id);
    if (!device) return;
    if (device.expiry !== undefined) this.cancel(device.expiry);
    this.activityDevices.delete(id);
    device.wake?.();
    this.rebuild();
  }

  private snapshot(symbol: string, cursor?: number): MarketSnapshot {
    const state = this.symbols.get(symbol);
    if (!state) return { cursor: this.revision, status: "fallback", formingCandles: [], candles: [] };
    // A lagging client may have missed more events than the ring retains. Keep
    // authoritative minute snapshots separately so active forming bars cannot
    // erase older completed minutes before a second device gets them.
    const after = cursor !== undefined && cursor <= state.revision &&
      cursor >= (state.events[0]?.revision ?? 0) - 1 ? cursor : -1;
    const candles = new Map<number, Candle>(after < 0 ? state.candles : []);
    const forming = new Map<number, Candle>(after < 0 ? state.forming : []);
    for (const event of state.events) if (event.revision > after) {
      (event.kind === "candle" ? candles : forming).set(event.candle.time, { ...event.candle });
    }
    const ordered = (values: Map<number, Candle>) => [...values.values()].sort((a, b) => a.time - b.time).slice(-128);
    return { cursor: state.revision, status: state.status,
      ...(state.quote && state.revision > after ? { quote: { ...state.quote } } : {}),
      formingCandles: ordered(forming), candles: ordered(candles) };
  }

  async poll(id: string, symbol: string, cursor?: number, waitMs = 20_000, signal?: AbortSignal): Promise<MarketSnapshot> {
    if (this.closed || !id || !/^[A-Z0-9][A-Z0-9.\/-]{0,19}$/.test(symbol) ||
        (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) ||
        !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 20_000) throw new Error("Invalid market request");
    let device = this.devices.get(id);
    if (device?.wake) throw new Error("Market request already pending");
    if (!device && this.devices.size >= 16) throw new Error("Market device limit reached");
    // Cursors belong to the device's current symbol subscription. After TTL,
    // symbol changes or a process restart, replay a full bounded snapshot.
    if (!device || device.symbol !== symbol) cursor = undefined;
    if (!device) { device = { symbol }; this.devices.set(id, device); }
    device.symbol = symbol;
    this.renew(id, device);
    this.rebuild();
    const state = this.symbols.get(symbol)!;
    if (signal?.aborted || cursor === undefined || cursor !== state.revision || waitMs === 0)
      return this.snapshot(symbol, cursor);
    await new Promise<void>((resolve) => {
      let timer: Timer | undefined;
      const done = () => {
        if (device!.wake !== done) return;
        device!.wake = undefined;
        if (timer !== undefined) this.cancel(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      device!.wake = done;
      timer = this.schedule(done, waitMs);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
    if (this.devices.get(id) === device) this.renew(id, device);
    return this.snapshot(symbol, cursor);
  }

  release(id: string) {
    const device = this.devices.get(id);
    if (!device) return;
    if (device.expiry !== undefined) this.cancel(device.expiry);
    this.devices.delete(id);
    device.wake?.();
    this.rebuild();
  }

  close() {
    this.closed = true;
    this.generation++;
    this.stop?.();
    this.stop = undefined;
    for (const id of [...this.devices.keys()]) this.release(id);
    for (const id of [...this.activityDevices.keys()]) this.releaseActivity(id);
    this.symbols.clear();
  }
}
