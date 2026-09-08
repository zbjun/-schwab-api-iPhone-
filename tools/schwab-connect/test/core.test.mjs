import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { CALLBACK_URL, SchwabSession, createTransport, parseEnv, percentile } from '../core.mjs';
import { createLocalServer } from '../server.mjs';

const tokenReply = (extra = {}) => ({ status: 200, body: JSON.stringify({
  access_token: 'dummy-access-token', refresh_token: 'dummy-refresh-token', expires_in: 1800,
  token_type: 'Bearer', ...extra,
}) });
const sessionWith = (request, extra = {}) => new SchwabSession({ request,
  clientId: 'dummy-client-id', clientSecret: 'dummy-secret', pause: async () => {}, ...extra });
function callbackFor(session, code = 'dummy-code') {
  const authorization = new URL(session.startAuth().authorizationUrl);
  const callback = new URL(CALLBACK_URL);
  callback.search = new URLSearchParams({ code, state: authorization.searchParams.get('state') }).toString();
  return callback;
}

test('configuration accepts only known env fields and does not echo secret values', () => {
  const env = parseEnv('SCHWAB_CLIENT_ID="dummy"\nSCHWAB_CLIENT_SECRET=\'secret\'\nOTHER=ignored');
  assert.deepEqual(env, { SCHWAB_CLIENT_ID: 'dummy', SCHWAB_CLIENT_SECRET: 'secret' });
  const session = new SchwabSession();
  session.configure({ clientId: 'dummy', clientSecret: 'secret' });
  assert.equal(session.status().configured, true);
  assert.equal(JSON.stringify(session.status()).includes('secret'), false);
  assert.throws(() => session.configure({ clientId: 'x', clientSecret: '\r\n' }));
});

test('auth state is fresh, secret stays out of URL, placeholder callback fails closed', () => {
  const session = sessionWith(async () => tokenReply());
  const first = new URL(session.startAuth().authorizationUrl);
  const second = new URL(session.startAuth().authorizationUrl);
  assert.equal(first.origin, 'https://api.schwabapi.com');
  assert.equal(first.searchParams.get('redirect_uri'), CALLBACK_URL);
  assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
  assert.equal(first.href.includes('dummy-secret'), false);
  const invalid = sessionWith(async () => tokenReply(), { callbackUrl: 'https://api.example.com/auth/schwab/callback' });
  assert.throws(() => invalid.startAuth(), /回调/);
});

test('malicious, mismatched and ambiguous callbacks cannot trigger token exchange', async () => {
  let calls = 0;
  const session = sessionWith(async () => { calls++; return tokenReply(); });
  const good = callbackFor(session);
  const variants = [
    good.href.replace('https:', 'http:'),
    good.href.replace('127.0.0.1', 'evil.invalid'),
    good.href.replace('/?', '/another?'),
    `${good.href}&state=another`, `${good.href}&code=another`, `${good.href}#fragment`,
    good.href.replace(/state=[^&]+/, 'state=wrong'),
  ];
  for (const callbackUrl of variants) await assert.rejects(session.completeAuth({ callbackUrl }));
  assert.equal(calls, 0);
});

test('valid callback exchanges a code once, decodes it once, and keeps all tokens private', async () => {
  const sent = [];
  const session = sessionWith(async (request) => { sent.push(request); return tokenReply(); });
  const callback = callbackFor(session, 'test+code%with/slash');
  const completed = await session.completeAuth({ callbackUrl: callback.href });
  assert.deepEqual(completed, { authenticated: true, expiresInSeconds: 1800 });
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].path, '/v1/oauth/token');
  assert.equal(sent[0].form.code, 'test+code%with/slash');
  assert.equal(sent[0].form.redirect_uri, CALLBACK_URL);
  assert.equal(Buffer.from(sent[0].authorization.slice(6), 'base64').toString(), 'dummy-client-id:dummy-secret');
  assert.equal(JSON.stringify(session.status()).includes('dummy-access-token'), false);
  await assert.rejects(session.completeAuth({ callbackUrl: callback.href }));
  assert.equal(sent.length, 1);
});

test('expired pending login cannot exchange a code', async () => {
  let now = 0;
  let calls = 0;
  const session = sessionWith(async () => { calls++; return tokenReply(); }, { now: () => now });
  const callback = callbackFor(session);
  now = 601000;
  await assert.rejects(session.completeAuth({ callbackUrl: callback.href }), /过期/);
  assert.equal(calls, 0);
});

test('token failures are redacted and never expose provider content', async () => {
  const session = sessionWith(async () => ({ status: 400, body: 'provider included dummy-secret and financial data' }));
  const callback = callbackFor(session);
  await assert.rejects(session.completeAuth({ callbackUrl: callback.href }), (error) => {
    assert.equal(error.message.includes('dummy-secret'), false);
    assert.match(error.message, /HTTP 400/);
    return true;
  });
  assert.equal(session.status().authenticated, false);
});

test('expired access refreshes before a read and a rotated refresh token is retained', async () => {
  let now = 0;
  const grants = [];
  const session = sessionWith(async (request) => {
    grants.push(request.form.grant_type);
    return tokenReply({ refresh_token: grants.length > 1 ? 'dummy-rotated' : 'dummy-refresh-token' });
  }, { now: () => now });
  await session.completeAuth({ callbackUrl: callbackFor(session).href });
  now = 1790000;
  await session.ensureToken();
  assert.deepEqual(grants, ['authorization_code', 'refresh_token']);
  assert.equal(session.token.refreshToken, 'dummy-rotated');
});

test('authenticated benchmark returns timing metadata, never account contents', async () => {
  const calls = [];
  let reads = 0;
  const session = sessionWith(async (request) => {
    calls.push(request);
    if (request.method === 'POST') return tokenReply();
    reads++;
    return { status: 200, body: JSON.stringify([{ securitiesAccount: { accountNumber: 'PRIVATE-ACCOUNT',
      positions: [{ instrument: { symbol: 'PRIVATE-HOLDING' } }] } }]),
    timing: { status: 200, totalMs: [310, 250, 270][reads - 1], firstByteMs: 240,
      reusedConnection: reads > 1, bytes: 1234 } };
  });
  await session.completeAuth({ callbackUrl: callbackFor(session).href });
  const result = await session.benchmark({ samples: 3 });
  assert.equal(result.results[0].medianMs, 270);
  assert.equal(result.results[0].successfulCount, 3);
  assert.equal(result.results[0].reusedCount, 2);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(calls.filter((request) => request.method === 'GET').every((request) => request.path === '/trader/v1/accounts?fields=positions'), true);
});

test('HTTP 401/429 and invalid 200 payloads do not become successful latency samples', async () => {
  for (const status of [401, 429, 200]) {
    let reads = 0;
    const session = sessionWith(async (request) => {
      if (request.method === 'POST') return tokenReply();
      reads++;
      return { status, body: '<html>not account data</html>', timing: { status, totalMs: 10, reusedConnection: true } };
    });
    await session.completeAuth({ callbackUrl: callbackFor(session).href });
    const result = await session.benchmark({ samples: 5 });
    assert.equal(reads, 1);
    assert.equal(result.results[0].successfulCount, 0);
    assert.equal(result.results[0].medianMs, null);
  }
});

test('transport rejects order writes before making a network connection', async () => {
  const transport = createTransport();
  try {
    await assert.rejects(transport.request({ method: 'POST', path: '/trader/v1/accounts/test/orders' }), /只读/);
    await assert.rejects(transport.request({ method: 'GET', path: 'https://evil.invalid' }), /只读/);
  } finally { transport.close(); }
});

test('comparison alternates routes, excludes warmups and reports tail latency without data', async () => {
  const order = [];
  const counts = { direct: 0, proxy: 0 };
  const replies = { direct: [9000, 100, 200, 1200], proxy: [8000, 300, 400, 500] };
  const makeRequest = (route) => async (request) => {
    if (request.method === 'POST') return tokenReply();
    order.push(route);
    const time = replies[route][counts[route]++];
    return { status: 200, body: '[{"securitiesAccount":{"accountNumber":"PRIVATE"}}]',
      timing: { status: 200, totalMs: time, reusedConnection: counts[route] > 1 } };
  };
  const session = sessionWith(makeRequest('direct'), { proxyRequest: makeRequest('proxy'), proxyLabel: '127.0.0.1:7897' });
  await session.completeAuth({ callbackUrl: callbackFor(session).href });
  const result = await session.benchmark({ samples: 3, route: 'compare' });
  assert.deepEqual(order, ['direct', 'proxy', 'direct', 'proxy', 'proxy', 'direct', 'direct', 'proxy']);
  assert.equal(result.authenticatedRequestCount, 8);
  assert.equal(result.results[0].medianMs, 200);
  assert.equal(result.results[0].p95Ms, 1100);
  assert.equal(result.results[0].maxMs, 1200);
  assert.equal(result.results[0].over1000msCount, 1);
  assert.equal(result.results[0].reusedCount, 3);
  assert.equal(result.results[1].medianMs, 400);
  assert.equal(result.results[0].warmup.totalMs, 9000);
  assert.equal(session.status().benchmarkProgress, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('proxy failures are separate from successful latency and leave direct comparison usable', async () => {
  const direct = async (request) => request.method === 'POST' ? tokenReply() : {
    status: 200, body: '[{"securitiesAccount":{}}]', timing: { status: 200, totalMs: 300 } };
  const session = sessionWith(direct, { proxyRequest: async () => { throw new Error('PRIVATE'); } });
  await session.completeAuth({ callbackUrl: callbackFor(session).href });
  const result = await session.benchmark({ samples: 3, route: 'compare' });
  assert.equal(result.results[0].successfulCount, 3);
  assert.equal(result.results[1].warmupFailed, true);
  assert.equal(result.results[1].warmup.transportError, true);
  assert.equal(result.results[1].successfulCount, 0);
  assert.equal(result.results[1].medianMs, null);
  assert.equal(result.authenticatedRequestCount, 5);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('proxy configuration rejects external hosts and credentials', async () => {
  for (const proxyUrl of ['http://example.com:7897', 'https://127.0.0.1:7897',
    'http://user:password@127.0.0.1:7897', 'http://127.0.0.1:7897/path']) {
    assert.throws(() => createTransport({ proxyUrl }), /代理/);
  }
  const session = sessionWith(async () => tokenReply());
  await assert.rejects(session.benchmark({ route: 'compare', samples: 3 }), /代理/);
});

test('percentiles handle empty, odd and even samples without mutating inputs', () => {
  const values = [500, 100, 300, 200];
  assert.equal(percentile(values, 0.5), 250);
  assert.equal(percentile(values, 0.95), 470);
  assert.equal(percentile([], 0.5), null);
  assert.deepEqual(values, [500, 100, 300, 200]);
});

test('local HTTP endpoints enforce host, origin and CSRF boundaries', async () => {
  const server = createLocalServer({ session: new SchwabSession() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await fetch(`${origin}/api/status`);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    const status = await initial.json();
    const payload = JSON.stringify({ clientId: 'dummy-client-id', clientSecret: 'dummy-secret' });
    const denied = await fetch(`${origin}/api/config`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.invalid', 'x-csrf-token': status.csrfToken }, body: payload });
    assert.equal(denied.status, 403);
    const noCsrf = await fetch(`${origin}/api/config`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin }, body: payload });
    assert.equal(noCsrf.status, 403);
    const accepted = await fetch(`${origin}/api/config`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-csrf-token': status.csrfToken }, body: payload });
    assert.deepEqual(await accepted.json(), { configured: true });
    const redacted = await (await fetch(`${origin}/api/status`)).text();
    assert.equal(redacted.includes('dummy-secret'), false);
    const badHostStatus = await new Promise((resolve, reject) => {
      http.get(`${origin}/api/status`, { headers: { Host: 'evil.invalid' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    const filesystemProbe = await fetch(`${origin}/.env`);
    assert.equal(filesystemProbe.status, 404);
    const tradingProbe = await fetch(`${origin}/api/orders`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-csrf-token': status.csrfToken }, body: '{}' });
    assert.equal(tradingProbe.status, 404);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  }
});
