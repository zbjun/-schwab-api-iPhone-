/** A level drawn across the chart with a label, such as a position's cost or stop-loss. */
export interface ChartPriceLine {
  id: string;
  price: number;
  label: string;
  color: string;
  /** Estimated profit or loss if the position closes here, drawn after the price. */
  profit?: number;
}

/** Text for a level's estimate, with room for the space before it. */
export function lineProfitText(profit: number | undefined): string {
  if (profit === undefined || !Number.isFinite(profit)) return "";
  const amount = Math.abs(profit).toFixed(2);
  return ` ${Number(amount) === 0 ? "" : profit > 0 ? "+" : "-"}${amount}`;
}

/**
 * Tops for labels of a given height, each as close to where it wants to be as the plot allows and none covering
 * another. Lines close together, and lines off the chart that all pin to one edge, would otherwise stack unreadably.
 */
export function placeLineLabels(wanted: readonly number[], top: number, bottom: number, height: number): number[] {
  const order = wanted.map((_, index) => index).sort((a, b) => wanted[a] - wanted[b]);
  const placed = new Array<number>(wanted.length);
  let next = top;
  for (const index of order) {
    placed[index] = Math.max(wanted[index], next);
    next = placed[index] + height;
  }
  let limit = bottom - height;
  for (const index of [...order].reverse()) {
    placed[index] = Math.min(placed[index], limit);
    limit = placed[index] - height;
  }
  // With more labels than fit, the top ones share the edge rather than leave the plot.
  return placed.map(value => Math.max(top, value));
}

/** Height of the live price tag on the axis with its countdown under the price, the tallest it gets. */
export const LIVE_TAG_HEIGHT = 25;
export const AXIS_TAG_HEIGHT = 14;

/**
 * Top of the crosshair's price on the axis. It sits level with its line, and moves to whichever side of the
 * live price tag is nearer and has room when the two prices are too close for both to be read.
 */
export function crosshairTagTop(y: number, liveY: number | undefined, top: number, bottom: number): number {
  const fit = (value: number, height: number) => Math.min(Math.max(value, top), Math.max(top, bottom - height));
  const level = fit(y - AXIS_TAG_HEIGHT / 2, AXIS_TAG_HEIGHT);
  if (liveY === undefined) return level;
  const liveTop = fit(liveY - LIVE_TAG_HEIGHT / 2, LIVE_TAG_HEIGHT), liveBottom = liveTop + LIVE_TAG_HEIGHT;
  if (level + AXIS_TAG_HEIGHT <= liveTop || level >= liveBottom) return level;
  const above = liveTop - AXIS_TAG_HEIGHT, fitsAbove = above >= top, fitsBelow = liveBottom + AXIS_TAG_HEIGHT <= bottom;
  if (fitsAbove && (y <= liveY || !fitsBelow)) return above;
  return fitsBelow ? liveBottom : level;
}

/** Rough width of a label at font size 11: wide enough for the background, with no text measuring on a chart redraw. */
export const lineLabelWidth = (text: string) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 11 : 6.4), 10);
