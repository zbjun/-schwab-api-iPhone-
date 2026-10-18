import type { Broker, Order, TradeExecution } from "./types.ts";

const DAY = 86_400_000;
/** Schwab returns at most this many orders per request (see validOrderQuery). */
const PAGE = 200;
const WINDOW = 15 * DAY;
const MIN_WINDOW = 3_600_000;
const MAX_REQUESTS = 48;
export const MAX_EXPORT_DAYS = 60;

export interface OrderHistory {
  from: number;
  to: number;
  orders: Order[];
  /** False when a one-hour window still hit the page cap or the request budget ran out. */
  complete: boolean;
  /** The server predates `orderHistory`; only the regular 30-day order list was available. */
  limited: boolean;
}

const notSupported = (error: unknown) =>
  !!error && typeof error === "object" && (error as { code?: unknown }).code === "methodNotAllowed";

/**
 * Read-only collection of orders for fill export. Windows are fetched newest
 * first and split whenever a page is full, so a busy period is not silently cut.
 */
export async function collectOrderHistory(
  broker: Pick<Broker, "orders" | "orderHistory">,
  accountID: string,
  days: number,
  now = Date.now(),
): Promise<OrderHistory> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPORT_DAYS)
    throw new Error(`导出范围须为 1 至 ${MAX_EXPORT_DAYS} 天。`);
  const to = now,
    from = now - days * DAY;
  const fallback = async (): Promise<OrderHistory> => {
    const orders = await broker.orders(accountID);
    return { from: Math.max(from, now - 30 * DAY), to, orders, complete: orders.length < PAGE, limited: true };
  };
  if (!broker.orderHistory) return fallback();
  const windows: [number, number][] = [];
  for (let end = to; end > from; end -= WINDOW) windows.push([Math.max(from, end - WINDOW), end]);
  const byID = new Map<string, Order>();
  let requests = 0,
    complete = true;
  while (windows.length) {
    if (requests >= MAX_REQUESTS) {
      complete = false;
      break;
    }
    const [start, end] = windows.shift()!;
    requests++;
    let orders: Order[];
    try {
      orders = await broker.orderHistory(accountID, start, end);
    } catch (error) {
      if (requests === 1 && notSupported(error)) return fallback();
      throw error;
    }
    for (const order of orders) byID.set(order.id, order);
    if (orders.length < PAGE) continue;
    if (end - start > MIN_WINDOW) {
      const middle = Math.floor(start + (end - start) / 2);
      windows.unshift([middle, end], [start, middle]);
    } else complete = false;
  }
  return { from, to, orders: [...byID.values()], complete, limited: false };
}

export interface FillRow {
  /** Missing when the broker reports filled shares without per-fill detail. */
  fill?: TradeExecution;
  order: Order;
}

export function fillRows(orders: Order[], from: number, to: number): FillRow[] {
  const seen = new Set<string>();
  const rows: FillRow[] = [];
  for (const order of orders) {
    const fills = order.executions ?? [];
    for (const fill of fills) {
      if (fill.time < from || fill.time > to || seen.has(fill.id)) continue;
      seen.add(fill.id);
      rows.push({ fill, order });
    }
    // Keep filled orders visible for review even when execution legs are absent.
    if (!fills.length && (order.filledQuantity ?? 0) > 0 &&
      order.enteredAt !== undefined && order.enteredAt >= from && order.enteredAt <= to)
      rows.push({ order });
  }
  const time = (row: FillRow) => row.fill?.time ?? row.order.enteredAt ?? 0;
  const id = (row: FillRow) => row.fill?.id ?? row.order.id;
  return rows.sort((a, b) => time(a) - time(b) || id(a).localeCompare(id(b)));
}

const KIND: Record<string, string> = { MARKET: "市价", LIMIT: "限价", STOP: "止损", STOP_LIMIT: "止损限价" };
const DURATION: Record<string, string> = { DAY: "当日有效", GOOD_TILL_CANCEL: "撤单前有效" };
const SESSION: Record<string, string> = { NORMAL: "常规时段", AM: "盘前", PM: "盘后", SEAMLESS: "全时段" };
const STATUS: Record<string, string> = {
  WORKING: "委托中", QUEUED: "排队中", ACCEPTED: "已受理", PENDING_ACTIVATION: "待触发",
  FILLED: "已成交", CANCELED: "已撤销", REJECTED: "已拒绝", EXPIRED: "已过期", REPLACED: "已修改",
};

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
}
function stamp(format: Intl.DateTimeFormat, time: number): string {
  const v: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(time))) v[part.type] = part.value;
  return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}:${v.second}`;
}
/** Plain decimal without grouping; rounding removes binary noise such as 0.1 + 0.2. */
function decimal(value: number | undefined, digits = 6): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return String(Number(value.toFixed(digits)));
}
function cell(value: string): string {
  // Spreadsheet apps execute cells starting with these characters as formulas.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function fillsCSV(
  orders: Order[],
  from: number,
  to: number,
  localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): { csv: string; fills: number; withoutDetail: number } {
  const eastern = formatter("America/New_York"),
    local = formatter(localTimeZone);
  const header = [
    "成交时间(美东)", `成交时间(${localTimeZone})`, "UTC时间", "代码", "方向", "成交价", "成交数量",
    "成交金额", "订单号", "委托时间(美东)", "订单类型", "委托价", "触发价", "委托数量", "有效期",
    "交易时段", "订单状态", "备注",
  ];
  const rows = fillRows(orders, from, to);
  const side = (value?: string) => (value === "BUY" ? "买入" : value === "SELL" ? "卖出" : "");
  const lines = [header.map(cell).join(",")];
  for (const { fill, order } of rows)
    lines.push([
      fill ? stamp(eastern, fill.time) : "",
      fill ? stamp(local, fill.time) : "",
      fill ? new Date(fill.time).toISOString() : "",
      cell(fill?.symbol ?? order.symbol),
      side(fill?.side ?? order.side),
      decimal(fill?.price),
      decimal(fill?.quantity ?? order.filledQuantity),
      fill ? decimal(fill.price * fill.quantity, 4) : "",
      cell(order.id),
      order.enteredAt === undefined ? "" : stamp(eastern, order.enteredAt),
      cell(order.kind ? (KIND[order.kind] ?? order.kind) : ""),
      decimal(order.limitPrice),
      decimal(order.stopPrice),
      decimal(order.quantity),
      cell(order.duration ? (DURATION[order.duration] ?? order.duration) : ""),
      cell(order.session ? (SESSION[order.session] ?? order.session) : ""),
      cell(STATUS[order.status] ?? order.status),
      fill ? "" : "券商未返回逐笔成交明细，数量为订单已成交合计",
    ].join(","));
  const withoutDetail = rows.filter((row) => !row.fill).length;
  // The BOM lets Excel detect UTF-8 so Chinese headers are not garbled.
  return {
    csv: "﻿" + lines.join("\r\n") + "\r\n",
    fills: rows.length - withoutDetail,
    withoutDetail,
  };
}

export function exportFileName(from: number, to: number): string {
  const day = (time: number) => new Date(time).toISOString().slice(0, 10).replace(/-/g, "");
  return `ths-fills-${day(from)}-${day(to)}.csv`;
}
