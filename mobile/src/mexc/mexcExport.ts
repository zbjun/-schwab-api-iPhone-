import { cell, decimal, formatter, stamp } from "../fillExport.ts";
import { mexcActionLabels } from "../mexcRules.ts";
import type { MexcOrder } from "../mexcRules.ts";
import { orderStateLabel } from "./mexcView.ts";

/**
 * Every order with something filled, newest first. MEXC reports these per order, so a row is one order and not
 * one fill. An order seen twice, as a chart and a list can both return it, counts once.
 */
export function mexcOrdersCSV(orders: readonly MexcOrder[], localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): { csv: string; rows: number } {
  const local = formatter(localTimeZone);
  const unique = [...new Map(orders.filter(order => order.dealVol > 0).map(order => [order.id, order])).values()];
  const when = (order: MexcOrder) => order.updatedAt ?? order.createdAt ?? 0;
  unique.sort((a, b) => when(b) - when(a));
  const header = [`时间(${localTimeZone})`, "UTC时间", "合约", "方向", "类型", "委托价", "委托张数", "成交张数", "成交均价", "手续费", "盈亏", "状态", "委托号"];
  const lines = [header.map(cell).join(",")];
  for (const order of unique) {
    const time = when(order);
    lines.push([
      time ? stamp(local, time) : "",
      time ? new Date(time).toISOString() : "",
      cell(order.symbol),
      cell(mexcActionLabels[order.action]),
      order.orderType === 5 ? "市价" : "限价",
      order.orderType === 5 ? "" : decimal(order.price),
      decimal(Number(order.vol)),
      decimal(order.dealVol),
      decimal(order.dealAvgPrice),
      decimal(order.fee, 8),
      decimal(order.profit, 8),
      cell(orderStateLabel(order)),
      cell(order.id),
    ].join(","));
  }
  // The BOM lets Excel detect UTF-8 so Chinese headers are not garbled.
  return { csv: "﻿" + lines.join("\r\n") + "\r\n", rows: unique.length };
}

export function mexcExportFileName(from: number, to: number): string {
  const day = (time: number) => new Date(time).toISOString().slice(0, 10).replace(/-/g, "");
  return `ths-mexc-orders-${day(from)}-${day(to)}.csv`;
}
