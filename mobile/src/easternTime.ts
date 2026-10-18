const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function parts(time: number) {
  const v: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(time)))
    if (part.type !== "literal") v[part.type] = Number(part.value);
  return v;
}

/** US-Eastern wall clock for an instant: "YYYY-MM-DD" and "HH:MM:SS". */
export function easternClock(time: number): { date: string; time: string } {
  const v = parts(time);
  const two = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${v.year}-${two(v.month)}-${two(v.day)}`,
    time: `${two(v.hour)}:${two(v.minute)}:${two(v.second)}`,
  };
}

/** The Eastern calendar date `days` after the Eastern date of `time`. */
export function easternDate(time: number, days = 0): string {
  const v = parts(time);
  const noon = new Date(Date.UTC(v.year, v.month - 1, v.day + days, 12));
  return noon.toISOString().slice(0, 10);
}

/**
 * Instant for an Eastern wall-clock time, or undefined when the text is invalid
 * or names a time skipped by the spring daylight-saving change. A time repeated
 * when clocks fall back resolves to its later (standard-time) instant.
 */
export function easternEpoch(date: string, time: string): number | undefined {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!d || !t) return undefined;
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hour, minute, second] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
  // Start from UTC-5 and correct by the observed offset; two passes settle DST.
  let guess = wanted + 5 * 3_600_000;
  for (let i = 0; i < 3; i++) {
    const v = parts(guess);
    const shown = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
    if (shown === wanted) return guess;
    guess += wanted - shown;
  }
  return undefined;
}
