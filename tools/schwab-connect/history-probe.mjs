// Bounded read-only diagnostics; never return broker bodies or credentials.
const DAY = 86_400_000;
const prefix = '/marketdata/v1/pricehistory?';

export function historyProbePaths(now) {
  if (!Number.isSafeInteger(now) || now < 10 * DAY) throw new Error('Invalid diagnostic time');
  return [
    { symbol: 'SNDU', mode: 'App 相同参数', period: '10' },
    { symbol: 'SNDU', mode: '明确最近 10 天', startDate: String(now - 10 * DAY) },
    { symbol: 'QQQ', mode: '对照股票', period: '10' },
  ].map(({ symbol, mode, ...window }) => ({ symbol, mode, path: prefix + new URLSearchParams({
    symbol, periodType: 'day', frequencyType: 'minute', frequency: '1',
    endDate: String(now), needExtendedHoursData: 'true', needPreviousClose: 'true', ...window,
  }) }));
}

export function isHistoryProbePath(path) {
  if (typeof path !== 'string' || !path.startsWith(prefix)) return false;
  const query = new URLSearchParams(path.slice(prefix.length));
  const end = Number(query.get('endDate'));
  try { return historyProbePaths(end).some((item) => item.path === path); }
  catch { return false; }
}

const ny = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function parts(time) {
  const p = Object.fromEntries(ny.formatToParts(time).map((item) => [item.type, item.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const session = minutes < 240 || minutes >= 1200 ? '夜盘' : minutes < 570 ? '盘前' : minutes < 960 ? '盘中' : '盘后';
  return { date: `${p.year}-${p.month}-${p.day}`, clock: `${p.hour}:${p.minute}`, session };
}
export function summarizeHistoryResponse(response, symbol, now) {
  if (response.status !== 200) return { httpStatus: response.status, valid: false };
  let data;
  try { data = JSON.parse(response.body); } catch { return { httpStatus: 200, valid: false }; }
  if (data?.symbol !== symbol || !Array.isArray(data.candles) || data.candles.length > 30_000)
    return { httpStatus: 200, valid: false };
  const byDay = new Map();
  let invalid = 0;
  const seen = new Set();
  let duplicates = 0;
  for (const c of data.candles) {
    if (!c || !Number.isSafeInteger(c.datetime) || c.datetime <= 0 || c.datetime > now + 5000 ||
        ![c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v >= 0) ||
        c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)) { invalid++; continue; }
    if (seen.has(c.datetime)) { duplicates++; continue; }
    seen.add(c.datetime);
    const { date, clock, session } = parts(c.datetime);
    const row = byDay.get(date) ?? { date, '夜盘': 0, '盘前': 0, '盘中': 0, '盘后': 0, first: clock, last: clock };
    row[session]++;
    if (clock < row.first) row.first = clock;
    if (clock > row.last) row.last = clock;
    byDay.set(date, row);
  }
  return { httpStatus: 200, valid: invalid === 0, total: data.candles.length, invalid, duplicates,
    timezone: 'America/New_York', days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
