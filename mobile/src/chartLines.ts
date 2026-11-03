/** A level drawn across the chart with a label, such as a position's cost or stop-loss. */
export interface ChartPriceLine {
  id: string;
  price: number;
  label: string;
  color: string;
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

/** Rough width of a label at font size 11: wide enough for the background, with no text measuring on a chart redraw. */
export const lineLabelWidth = (text: string) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 11 : 6.4), 10);
