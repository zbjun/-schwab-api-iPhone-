import test from 'node:test';
import assert from 'node:assert/strict';
import { historyProbePaths, isHistoryProbePath, summarizeHistoryResponse } from '../history-probe.mjs';
import { SchwabSession } from '../core.mjs';

const now = Date.parse('2026-09-08T14:00:00Z');
const candle = (time) => ({ datetime: Date.parse(time), open: 25, high: 26, low: 24, close: 25.5 });
test('history diagnostics allow only fixed symbols/windows and read paths', () => {
  const paths = historyProbePaths(now);
  assert.equal(paths.length, 3);
  for (const { path } of paths) {
    assert.equal(isHistoryProbePath(path), true);
    assert.equal(isHistoryProbePath(path + '&token=private'), false);
    assert.equal(isHistoryProbePath(path.replace('SNDU', 'EVIL')), !path.includes('SNDU'));
    assert.equal(isHistoryProbePath(path.replace('frequency=1', 'frequency=60')), false);
  }
  assert.equal(isHistoryProbePath('/trader/v1/accounts/123/orders'), false);
  assert.equal(isHistoryProbePath('/marketdata/v1/pricehistory?endDate=NaN'), false);
});
test('raw history coverage distinguishes overnight and pre/post with DST', () => {
  const bars = ['2026-09-08T00:30:00Z', '2026-09-08T07:59:00Z', '2026-09-08T08:00:00Z', '2026-09-08T13:30:00Z', '2026-09-07T20:00:00Z'].map(candle);
  const result = summarizeHistoryResponse({ status: 200, body: JSON.stringify({ symbol: 'SNDU', candles: bars, secret: 'DO_NOT_ECHO' }) }, 'SNDU', now);
  assert.equal(result.valid, true);
  assert.deepEqual(result.days.map((d) => [d.date, d.夜盘, d.盘前, d.盘中, d.盘后]),
    [['2026-09-07', 1, 0, 0, 1], ['2026-09-08', 1, 1, 1, 0]]);
  assert.equal(JSON.stringify(result).includes('DO_NOT_ECHO'), false);
  const winter = summarizeHistoryResponse({ status: 200, body: JSON.stringify({ symbol: 'SNDU', candles: [candle('2026-01-06T09:00:00Z')] }) }, 'SNDU', now);
  assert.equal(winter.days[0].盘前, 1);
});
test('bad responses do not masquerade as zero night coverage', () => {
  for (const response of [{ status: 403, body: 'private' }, { status: 200, body: 'private' },
    { status: 200, body: JSON.stringify({ symbol: 'OTHER', candles: [] }) },
    { status: 200, body: JSON.stringify({ symbol: 'SNDU', candles: [{ datetime: now }] }) }])
    assert.equal(summarizeHistoryResponse(response, 'SNDU', now).valid, false);
});
test('diagnostics require auth, use GET only and stop on rate limits', async () => {
  const calls = [];
  const session = new SchwabSession({ now: () => now, request: async (request) => {
    calls.push(request); return { status: 429, body: 'do not echo' };
  } });
  await assert.rejects(session.probeHistory(), /登录/);
  assert.equal(calls.length, 0);
  session.token = { accessToken: 'test-only', expiresAt: now + 3_600_000 };
  const result = await session.probeHistory();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(isHistoryProbePath(calls[0].path), true);
  assert.equal(result.results[0].httpStatus, 429);
  assert.equal(JSON.stringify(result).includes('test-only'), false);
});
