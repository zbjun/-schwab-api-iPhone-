export type ChartDragIntent = "undecided" | "horizontal" | "vertical";

/** Once claimed, keep the same axis until all fingers release. */
export function chartDragIntent(
  previous: ChartDragIntent,
  dx: number,
  dy: number,
): ChartDragIntent {
  if (previous !== "undecided") return previous;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return previous;
  const x = Math.abs(dx), y = Math.abs(dy);
  if (x >= 6 && x >= y * 1.15) return "horizontal";
  // Do not permanently yield on a few pixels of initial vertical finger jitter.
  if (y >= 10 && y >= x * 1.5) return "vertical";
  if (Math.max(x, y) >= 16) return x >= y ? "horizontal" : "vertical";
  return "undecided";
}

export function chartInteractionActive(inspecting: boolean, dragging: boolean): boolean {
  return inspecting || dragging;
}
