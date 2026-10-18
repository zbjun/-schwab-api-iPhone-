import { chartSessionWindow, minuteInterval, newYorkDateKey, validCandle } from "../mobile/src/chartData.ts";
import { historyCoverage } from "../mobile/src/historyCoverage.ts";
import type { Candle, History, HistoryRange, Vault } from "../mobile/src/types.ts";

const KEY = "observed-minutes.v1";
const AGE = 10 * 86400_000;
const symbolPattern = /^[A-Z0-9][A-Z0-9.\/-]{0,19}$/;
interface Observation { candle: Candle; receivedAt: number; source: "chart" | "quote" | "rest" }

/** A bounded archive of actual observations, separate from the trading/token vault. */
export class MinuteArchive {
  private symbols = new Map<string, Map<number, Observation>>();
  private version = 0;
  private saved = 0;
  private pending?: Promise<void>;
  private readonly vault: Vault;
  private readonly now: () => number;
  private readonly maxSymbols: number;
  private readonly maxBars: number;
  constructor(vault: Vault, options: { now?: () => number; maxSymbols?: number; maxBars?: number } = {}) {
    this.vault = vault;
    this.now = options.now ?? Date.now;
    this.maxSymbols = options.maxSymbols ?? 16;
    this.maxBars = options.maxBars ?? 15_000;
  }

  async load() {
    const raw = await this.vault.get(KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > this.maxSymbols) throw new Error("Invalid minute archive");
    for (const entry of data) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" ||
          !Array.isArray(entry[1]) || entry[1].length > this.maxBars) throw new Error("Invalid minute archive");
      for (const sample of entry[1]) {
        if (!sample || !["chart", "quote", "rest"].includes(sample.source) || !Number.isFinite(sample.receivedAt))
          throw new Error("Invalid minute observation");
        this.observe(entry[0], sample.candle, sample.source, sample.receivedAt);
      }
    }
    this.saved = this.version;
  }

  observe(symbol: string, sample: Candle, source: Observation["source"] = sample?.provisional ? "quote" : "chart", receivedAt = this.now()) {
    const now = this.now();
    if (!symbolPattern.test(symbol) || !sample || !validCandle(sample) || sample.time % 60_000 !== 0 ||
        (sample.volume !== undefined && (!Number.isFinite(sample.volume) || sample.volume < 0)) ||
        sample.time < now - AGE || sample.time > now + 5000) return;
    const bars = this.symbols.get(symbol) ?? new Map<number, Observation>();
    const old = bars.get(sample.time)?.candle;
    if (old && !old.provisional && sample.provisional) return;
    const candle: Candle = { time: sample.time, open: sample.provisional ? old?.open ?? sample.open : sample.open,
      high: sample.provisional ? Math.max(old?.high ?? sample.high, sample.high) : sample.high,
      low: sample.provisional ? Math.min(old?.low ?? sample.low, sample.low) : sample.low, close: sample.close,
      ...(sample.provisional ? { provisional: true } : sample.volume === undefined ? {} : { volume: sample.volume }) };
    if (old && old.open === candle.open && old.high === candle.high && old.low === candle.low &&
        old.close === candle.close && old.volume === candle.volume && old.provisional === candle.provisional) return;
    bars.set(candle.time, { candle, source, receivedAt });
    if (bars.size > this.maxBars) bars.delete(Math.min(...bars.keys()));
    this.symbols.delete(symbol);
    this.symbols.set(symbol, bars);
    if (this.symbols.size > this.maxSymbols) this.symbols.delete(this.symbols.keys().next().value!);
    this.version++;
  }

  async flush(): Promise<void> {
    if (this.pending) { await this.pending; return this.flush(); }
    if (this.saved === this.version) return;
    const version = this.version, oldest = this.now() - AGE;
    const payload = [...this.symbols].map(([symbol, values]) => [symbol,
      [...values.values()].filter(value => value.candle.time >= oldest).sort((a, b) => a.candle.time - b.candle.time)]);
    this.pending = this.vault.set(KEY, JSON.stringify(payload)).then(() => { this.saved = version; });
    try { await this.pending; } finally { this.pending = undefined; }
  }

  merge(history: History, range: HistoryRange): History {
    const size = minuteInterval(range) ?? (range === "intraday" ? 1 : range === "fiveDay" ? 5 : undefined);
    if (!size) return history;
    const now = this.now();
    // REST is authoritative; archive only actual minute bars, not multi-minute aggregates.
    if (size === 1) for (const candle of history.candles)
      if (!candle.retained && !candle.provisional) this.observe(history.symbol, candle, "rest");
    let minutes = [...(this.symbols.get(history.symbol)?.values() ?? [])]
      .filter(value => value.candle.time >= now - (range === "fiveDay" ? 5 * 86400_000 : AGE) && value.candle.time <= now + 5000)
      .map(value => value.candle).sort((a, b) => a.time - b.time);
    if (range === "intraday") {
      const latest = Math.max(history.candles.at(-1)?.time ?? 0, minutes.at(-1)?.time ?? 0);
      minutes = minutes.filter(candle => newYorkDateKey(candle.time) === newYorkDateKey(latest));
    }
    if (!minutes.length) return history;
    const grouped = new Map<number, Candle[]>();
    const bucket = (time: number) => {
      if (size === 1) return time;
      const session = chartSessionWindow(time);
      return session ? session.start + Math.floor((time - session.start) / (size * 60_000)) * size * 60_000 : undefined;
    };
    for (const candle of minutes) {
      const key = bucket(candle.time);
      if (key === undefined) continue;
      const group = grouped.get(key) ?? []; group.push(candle); grouped.set(key, group);
    }
    const occupied = new Set(history.candles.map(c => bucket(c.time)));
    const additions: Candle[] = [];
    for (const [key, values] of grouped) {
      if (occupied.has(key)) continue;
      const first = values[0], last = values.at(-1)!;
      const session = chartSessionWindow(first.time);
      const expected = size === 1 ? 1 : Math.min(size, ((session?.end ?? key + size * 60_000) - key) / 60_000);
      const complete = values.length === expected && !values.some(c => c.provisional) && now >= key + expected * 60_000;
      additions.push({ time: size === 1 ? first.time : key, open: first.open,
        high: Math.max(...values.map(c => c.high)), low: Math.min(...values.map(c => c.low)), close: last.close,
        ...(complete && values.every(c => c.volume !== undefined) ? { volume: values.reduce((total, c) => total + c.volume!, 0) } : {}),
        ...(!complete ? { provisional: true } : {}), retained: true });
    }
    return { ...history, candles: [...history.candles, ...additions].sort((a, b) => a.time - b.time),
      retainedCoverage: { receivedAt: now, minutes: minutes.length, decoded: historyCoverage(minutes),
        persistence: this.saved === this.version ? "saved" : "memory" } };
  }
}
