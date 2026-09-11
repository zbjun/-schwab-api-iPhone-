import type { Candle, History, HistoryRange } from "./types.ts";
import { validCandle } from "./chartData.ts";

interface DayCoverage {
  date: string;
  night: number;
  pre: number;
  regular: number;
  post: number;
}
export interface Coverage { total: number; first?: string; last?: string; days: DayCoverage[] }
const ny = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** Counts observations by civil NY day, not claims about venue opening hours. */
export function historyCoverage(candles: readonly Candle[], sessionCounts = true): Coverage {
  const days = new Map<string, DayCoverage>();
  let total = 0, first: string | undefined, last: string | undefined;
  for (const c of candles) {
    if (!validCandle(c)) continue;
    const p = Object.fromEntries(ny.formatToParts(c.time).map(v => [v.type, v.value]));
    const date = `${p.year}-${p.month}-${p.day}`, stamp = `${date} ${p.hour}:${p.minute}`;
    const minute = Number(p.hour) * 60 + Number(p.minute);
    const key = minute < 240 || minute >= 1200 ? "night" : minute < 570 ? "pre" : minute < 960 ? "regular" : "post";
    const day = days.get(date) ?? { date, night: 0, pre: 0, regular: 0, post: 0 };
    if (sessionCounts) { day[key]++; days.set(date, day); }
    total++;
    if (!first || stamp < first) first = stamp;
    if (!last || stamp > last) last = stamp;
  }
  return { total, first, last, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export function historyCoverageReport(history: History, range: HistoryRange): string {
  const intraday = !["daily", "weekly", "monthly"].includes(range);
  const plotted = historyCoverage(history.candles, intraday);
  const source = history.sourceCoverage;
  const rows = (coverage: Coverage) => !intraday ? "" : coverage.days.slice(-14).map(d =>
    `${d.date}：夜${d.night} / 前${d.pre} / 中${d.regular} / 后${d.post}`).join("\n");
  return [
    `${history.symbol} · ${range} · 行情诊断`,
    intraday ? "美东自然日统计，夜盘按20:00–24:00和00:00–04:00计数；跨午夜需查看相邻两天。"
      : "日/周/月K的时间戳不代表成交时段，不作夜盘覆盖判断；请切换分钟K查看。",
    source ? `接口读取：${new Date(source.receivedAt).toISOString()}\n原始${source.rawBars}根 → 解码${source.decoded.total}根（重复时间戳合并）\n${source.decoded.first ?? "—"} 至 ${source.decoded.last ?? "—"}\n${rows(source.decoded)}`
      : "当前数据没有接口诊断信息；刷新后重试。",
    `图表全量：${plotted.total}根（含聚合/实时合并），缓存${history.candles.filter(c => c.retained).length}根，形成中${history.candles.filter(c => c.provisional).length}根\n${rows(plotted)}`,
    "零根表示本次数据未包含对应时段，不表示零成交或没有交易资格。未列出的日期不在返回数据中。",
  ].join("\n\n");
}
