import type { Candle, History, HistoryRange } from "./types.ts";
import { newYorkDateKey, sessionWindows } from "./chartData.ts";

/** Observed regular-session volume pace versus the previous five daily sessions. */
export function volumeRatio(
  intraday: History,
  daily: History,
  asOf = Date.now(),
): number | undefined {
  if (intraday.symbol !== daily.symbol || !Number.isFinite(asOf))
    return undefined;
  const bars = [...intraday.candles]
    .sort((a, b) => a.time - b.time)
    .filter((c) => {
      const regular = sessionWindows(c.time).find(
        (w) => w.session === "regular",
      );
      return (
        regular &&
        c.time >= regular.start &&
        c.time < regular.end &&
        c.time + 60000 <= asOf
      );
    });
  const latest = bars.at(-1);
  if (!latest) return undefined;
  const date = newYorkDateKey(latest.time),
    window = sessionWindows(latest.time).find((w) => w.session === "regular")!;
  if (!date) return undefined;
  const today = bars.filter((c) => newYorkDateKey(c.time) === date);
  let observed = 0;
  for (let i = 0; i < today.length; i++) {
    const c = today[i];
    if (
      c.time !== window.start + i * 60000 ||
      c.volume === undefined ||
      !Number.isFinite(c.volume) ||
      c.volume < 0
    )
      return undefined;
    observed += c.volume;
  }
  const previous = [...daily.candles]
    .filter((c) => {
      const day = newYorkDateKey(c.time);
      return day !== undefined && day < date;
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, 5);
  if (
    previous.length !== 5 ||
    new Set(previous.map((c) => newYorkDateKey(c.time))).size !== 5
  )
    return undefined;
  let total = 0,
    minutes = 0;
  for (const c of previous) {
    const regular = sessionWindows(c.time).find((w) => w.session === "regular");
    if (
      !regular ||
      c.volume === undefined ||
      !Number.isFinite(c.volume) ||
      c.volume < 0
    )
      return undefined;
    total += c.volume;
    minutes += (regular.end - regular.start) / 60000;
  }
  const result = observed / today.length / (total / minutes);
  return total > 0 && Number.isFinite(result) ? result : undefined;
}
/** Line charts use their previous-close baseline; candles use the prior bar close. */
export function selectedReferencePrice(
  history: History | undefined,
  selected: Candle | undefined,
  range: HistoryRange,
): number | undefined {
  if (!history || !selected || !Number.isFinite(selected.close))
    return undefined;
  let baseline = history.previousClose;
  if (range !== "intraday" && range !== "fiveDay") {
    const previous = history.candles.reduce<Candle | undefined>(
      (best, candle) =>
        candle.time < selected.time &&
        Number.isFinite(candle.close) &&
        (!best || candle.time > best.time)
          ? candle
          : best,
      undefined,
    );
    baseline = previous?.close;
  }
  if (baseline === undefined || !Number.isFinite(baseline) || baseline <= 0)
    return undefined;
  return baseline;
}

export function selectedChangePercent(
  history: History | undefined,
  selected: Candle | undefined,
  range: HistoryRange,
): number | undefined {
  const baseline = selectedReferencePrice(history, selected, range);
  if (!selected || baseline === undefined) return undefined;
  const percent = (selected.close / baseline - 1) * 100;
  return Number.isFinite(percent) ? percent : undefined;
}

/** Selected-bar estimates; never substitute today's quote volume for missing history. */
export function selectedActivity(selected: Candle | undefined, sharesOutstanding?: number) {
  const volume = selected?.volume !== undefined &&
    Number.isFinite(selected.volume) && selected.volume >= 0 ? selected.volume : undefined;
  const turnover = volume !== undefined && sharesOutstanding !== undefined &&
    Number.isFinite(sharesOutstanding) && sharesOutstanding > 0
    ? volume / sharesOutstanding * 100 : undefined;
  // OHLCV cannot recover actual dollar turnover. Keep this explicitly labelled
  // as an estimate; forming bars with unknown volume remain unknown.
  const average = selected && [selected.open, selected.high, selected.low, selected.close]
    .every(value => Number.isFinite(value) && value > 0)
    ? selected.open / 4 + selected.high / 4 + selected.low / 4 + selected.close / 4
    : undefined;
  const amount = volume !== undefined && average !== undefined ? volume * average : undefined;
  return {
    volume,
    turnoverPercent: turnover !== undefined && Number.isFinite(turnover) ? turnover : undefined,
    amountEstimate: amount !== undefined && Number.isFinite(amount) ? amount : undefined,
  };
}
