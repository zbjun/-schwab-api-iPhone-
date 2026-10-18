import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGateway, createDeviceAuthenticator } from './gateway.mjs';
import { TradingError } from '../mobile/src/orderRules.ts';

const devices = [{ id: 'phone-a', token: 'a'.repeat(64) }, { id: 'phone-b', token: 'b'.repeat(64) }];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function brokerFixture() {
  const calls = [];
  let latest, unresolved = false, authenticated = true;
  return {
    calls,
    status: async () => ({ configured: true, authenticated, unresolvedOperation: unresolved }),
    setAuthenticated: value => { authenticated = value; },
    setUnknown: value => { unresolved = value; },
    accounts: async () => [],
    authorizationURL: async () => { calls.push('authorizationURL'); return 'https://api.schwabapi.com/v1/oauth/authorize?state=fictional'; },
    completeAuthorization: async url => {
      calls.push(['completeAuthorization', url]);
      if (new URL(url).searchParams.get('state') !== 'fictional' || authenticated)
        throw new TradingError('invalidCallback', 'Invalid state');
      authenticated = true;
    },
    prepare: async (accountID, draft) => {
      latest = Object.freeze({ id: 'broker-private-review', accountID, draft: Object.freeze({ ...draft }), isDemo: false });
      calls.push(['prepare', latest]); return latest;
    },
    submit: async prepared => {
      assert.equal(prepared, latest, 'gateway must submit original object, never client reconstruction');
      calls.push(['submit', prepared]);
      if (unresolved) throw new TradingError('orderOutcomeUnknown', 'Verify at broker');
      return { orderID: 'fixture-order' };
    },
    cancel: async (...args) => {
      calls.push(['cancel', ...args]);
      if (unresolved) throw new TradingError('orderOutcomeUnknown', 'Verify at broker');
    },
  };
}
async function fixture(t, options = {}) {
  const broker = options.broker ?? brokerFixture();
  const server = createGateway({ broker, devices, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (method, args = [], device = 0, extra = {}) => {
    const response = await fetch(base + '/rpc', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + devices[device].token, ...extra,
    }, body: JSON.stringify({ method, args }) });
    return { status: response.status, body: await response.json() };
  };
  return { broker, base, rpc };
}
const draft = { symbol: 'AAPL', side: 'BUY', quantity: 1, limitPrice: '100', kind: 'LIMIT', duration: 'DAY' };

test('device configuration validates unique IDs and strong independent keys', () => {
  for (const config of [[], [devices[0], devices[0]], [{ ...devices[0], token: 'short' }], [devices[0], { ...devices[1], token: devices[0].token }]])
    assert.throws(() => createDeviceAuthenticator(config));
  const authenticate = createDeviceAuthenticator(devices);
  assert.equal(authenticate({ headers: { authorization: 'Bearer ' + devices[1].token } }), 'phone-b');
  assert.equal(authenticate({ headers: { authorization: 'Bearer ' + 'x'.repeat(64) } }), null);
});
test('RPC requires valid device key, rejects browsers, and never exposes credential/admin methods', async t => {
  const { base, rpc, broker } = await fixture(t);
  assert.equal((await fetch(base + '/rpc', { method: 'POST' })).status, 401);
  assert.equal((await rpc('status', [], 0, { Authorization: 'Bearer ' + 'x'.repeat(64) })).status, 401);
  assert.equal((await rpc('status', [], 0, { Origin: 'https://untrusted.example' })).status, 403);
  for (const method of ['configure', 'disconnect', 'acknowledgeReconciliation', 'marketCredentials', 'constructor', '__proto__'])
    assert.equal((await rpc(method)).body.error.code, 'methodNotAllowed');
  assert.deepEqual(broker.calls, []);
  assert.deepEqual((await rpc('status')).body.result, { configured: true, authenticated: true, unresolvedOperation: false });
});
test('order history is a read that forwards exactly the account and time window', async t => {
  const broker = brokerFixture();
  broker.orderHistory = async (...args) => { broker.calls.push(['orderHistory', ...args]); return [{ id: '7' }]; };
  const { rpc } = await fixture(t, { broker });
  assert.deepEqual((await rpc('orderHistory', ['acct', 1, 2])).body.result, [{ id: '7' }]);
  assert.deepEqual(broker.calls, [['orderHistory', 'acct', 1, 2]]);
  for (const args of [['acct', 1], ['acct', 1, 2, 3]])
    assert.equal((await rpc('orderHistory', args)).body.error.code, 'invalidRequest');
});
test('timed orders are forwarded to the scheduler, which shares the device write lock', async t => {
  let lock;
  const seen = [];
  const scheduler = {
    useLock: value => { lock = value; },
    add: async (...args) => { seen.push(['add', ...args]); return { id: args[4], status: 'pending' }; },
    list: () => [{ id: 'x', status: 'pending' }],
    cancel: async id => { seen.push(['cancel', id]); return { id, status: 'cancelled' }; },
  };
  const { rpc, broker } = await fixture(t, { scheduler });
  const runAt = Date.now() + 60_000;
  assert.equal((await rpc('schedule', ['acct', draft, runAt, 'scheduled-order-0001'])).body.result.status, 'pending');
  assert.deepEqual(seen[0], ['add', 'phone-a', 'acct', draft, runAt, 'scheduled-order-0001']);
  assert.equal((await rpc('schedule', ['acct', 'not-a-draft', runAt, 'x'])).body.error.code, 'invalidRequest');
  assert.deepEqual((await rpc('scheduled', [], 1)).body.result, [{ id: 'x', status: 'pending' }]);
  assert.equal((await rpc('cancelScheduled', ['scheduled-order-0001'], 1)).body.result.status, 'cancelled');
  // While a timed order holds the lock, device writes wait their turn.
  assert.equal(lock.tryAcquire(), true);
  assert.equal(lock.tryAcquire(), false);
  assert.equal((await rpc('cancel', ['acct', '1'])).body.error.code, 'operationBusy');
  lock.release();
  await rpc('cancel', ['acct', '1']);
  assert.deepEqual(broker.calls.at(-1), ['cancel', 'acct', '1']);
});
test('a gateway without a scheduler reports timed orders as unsupported', async t => {
  const { rpc } = await fixture(t);
  for (const [method, args] of [['scheduled', []], ['cancelScheduled', ['x']], ['schedule', ['a', draft, 1, 'x']]])
    assert.equal((await rpc(method, args)).body.error.code, 'methodNotAllowed');
});
test('malformed, oversized and unrecognized RPC input is rejected', async t => {
  const { base, rpc } = await fixture(t);
  const headers = { Authorization: 'Bearer ' + devices[0].token, 'Content-Type': 'application/json' };
  for (const body of ['not-json', JSON.stringify({ method: 'status', args: [], token: 'ignored?' }), JSON.stringify({ method: 'status', args: [], padding: 'x'.repeat(25000) })]) {
    const response = await fetch(base + '/rpc', { method: 'POST', headers, body });
    assert.equal(response.status, 400);
  }
  assert.equal((await rpc('status', ['unexpected'])).body.error.code, 'invalidRequest');
  assert.equal((await rpc('accounts', {})).body.error.code, 'invalidRequest');
});
test('review is opaque, device-bound, frozen at broker and usable exactly once', async t => {
  const { rpc, broker } = await fixture(t);
  const review = (await rpc('prepare', ['fictional-account', draft])).body.result;
  assert.notEqual(review.id, 'broker-private-review');
  assert.equal((await rpc('submit', [{ id: review.id }], 1)).body.error.code, 'reviewExpired');
  assert.equal((await rpc('submit', [{ id: review.id, draft: { ...draft, quantity: 100 } }])).body.error.code, 'invalidRequest');
  assert.equal((await rpc('submit', [{ id: review.id }])).body.result.orderID, 'fixture-order');
  assert.equal((await rpc('submit', [{ id: review.id }])).body.error.code, 'reviewExpired');
  assert.equal(broker.calls.filter(call => call[0] === 'submit').length, 1);
});
test('latest review invalidates earlier device review and review timeout is enforced', async t => {
  let now = 1000;
  const { rpc } = await fixture(t, { now: () => now });
  const first = (await rpc('prepare', ['fictional-account', draft])).body.result;
  const second = (await rpc('prepare', ['fictional-account', draft], 1)).body.result;
  assert.equal((await rpc('submit', [{ id: first.id }])).body.error.code, 'reviewExpired');
  now += 60_000;
  assert.equal((await rpc('submit', [{ id: second.id }], 1)).body.error.code, 'reviewExpired');
});
test('writes serialize across devices and unknown result is never automatically replayed', async t => {
  const broker = brokerFixture(), entered = deferred(), finish = deferred();
  let submits = 0;
  broker.submit = async () => {
    submits++; entered.resolve(); await finish.promise; broker.setUnknown(true);
    throw new TradingError('orderOutcomeUnknown', 'Verify at broker');
  };
  const { rpc } = await fixture(t, { broker });
  const review = (await rpc('prepare', ['fictional-account', draft])).body.result;
  const pending = rpc('submit', [{ id: review.id }]); await entered.promise;
  assert.equal((await rpc('cancel', ['fictional-account', '123'], 1)).body.error.code, 'operationBusy');
  assert.equal((await rpc('prepare', ['fictional-account', draft], 1)).body.error.code, 'operationBusy');
  finish.resolve();
  assert.equal((await pending).body.error.code, 'orderOutcomeUnknown');
  assert.equal((await rpc('submit', [{ id: review.id }])).body.error.code, 'reviewExpired');
  assert.equal((await rpc('status', [], 1)).body.result.unresolvedOperation, true);
  assert.equal((await rpc('cancel', ['fictional-account', '123'], 1)).body.error.code, 'orderOutcomeUnknown');
  assert.equal(submits, 1);
});
test('OAuth initiation coalesces; configured origin is used and broker validates one-use state', async t => {
  const broker = brokerFixture(); broker.setAuthenticated(false);
  const { rpc, base } = await fixture(t, { broker, callbackURL: 'https://personal.example/oauth/callback' });
  const [a, b] = await Promise.all([rpc('authorizationURL'), rpc('authorizationURL', [], 1)]);
  assert.equal(a.body.result, b.body.result);
  assert.equal(broker.calls.filter(call => call === 'authorizationURL').length, 1);
  const invalid = await fetch(base + '/oauth/callback?code=fixture&state=wrong', { headers: { Host: 'untrusted.example' } });
  assert.equal(invalid.status, 400);
  const valid = await fetch(base + '/oauth/callback?code=fixture&state=fictional', { headers: { Host: 'untrusted.example' } });
  assert.equal(valid.status, 200);
  assert.equal((await valid.text()).includes('code=fixture'), false);
  const completed = broker.calls.findLast(call => call[0] === 'completeAuthorization');
  assert.equal(new URL(completed[1]).origin, 'https://personal.example');
  assert.equal((await rpc('status', [], 1)).body.result.authenticated, true);
  assert.equal((await fetch(base + '/oauth/callback?code=fixture&state=fictional')).status, 400);
});
test('consumed or expired authorization failures evict the cached login link immediately', async t => {
  for (const code of ['authorizationExpired', 'authorizationDeclined', 'httpStatus', 'networkUnavailable']) {
    const broker = brokerFixture(); broker.setAuthenticated(false);
    let sequence = 0;
    broker.authorizationURL = async () => `https://api.schwabapi.com/v1/oauth/authorize?state=fixture-${++sequence}`;
    broker.completeAuthorization = async () => { throw new TradingError(code, 'Fixture failure'); };
    const { rpc, base } = await fixture(t, { broker, callbackURL: 'https://personal.example/oauth/callback' });
    const first = (await rpc('authorizationURL')).body.result;
    assert.equal((await rpc('authorizationURL', [], 1)).body.result, first);
    const failure = await fetch(base + '/oauth/callback?code=fixture&state=fixture-1');
    assert.equal(failure.status, 400);
    const second = (await rpc('authorizationURL', [], 1)).body.result;
    assert.notEqual(second, first, `${code} must not reuse a consumed login link`);
    assert.equal(sequence, 2);
  }
});

test('an unrelated invalid callback preserves a valid shared login attempt', async t => {
  const broker = brokerFixture(); broker.setAuthenticated(false);
  let sequence = 0;
  broker.authorizationURL = async () => `https://api.schwabapi.com/v1/oauth/authorize?state=fixture-${++sequence}`;
  broker.completeAuthorization = async () => { throw new TradingError('invalidCallback', 'Wrong state'); };
  const { rpc, base } = await fixture(t, { broker, callbackURL: 'https://personal.example/oauth/callback' });
  const first = (await rpc('authorizationURL')).body.result;
  assert.equal((await fetch(base + '/oauth/callback?code=unrelated&state=wrong')).status, 400);
  assert.equal((await rpc('authorizationURL', [], 1)).body.result, first);
  assert.equal(sequence, 1);
});

test('shared market endpoints require device authentication and isolate release by device', async t => {
  const calls = [], marketHub = {
    poll: async (...args) => { calls.push(['poll', ...args.slice(0, 4)]); return { cursor: 1, status: { connected: true }, candles: [], formingCandles: [] }; },
    release: id => { calls.push(['release', id]); },
  };
  const { base } = await fixture(t, { marketHub });
  assert.equal((await fetch(base + '/market', { method: 'POST' })).status, 401);
  const headers = { Authorization: 'Bearer ' + devices[1].token, 'Content-Type': 'application/json' };
  const response = await fetch(base + '/market', { method: 'POST', headers, body: JSON.stringify({ symbol: 'SNDU', cursor: 0, waitMs: 0 }) });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], ['poll', 'phone-b', 'SNDU', 0, 0]);
  assert.equal((await fetch(base + '/market', { method: 'POST', headers, body: JSON.stringify({ symbol: 'SNDU', waitMs: 60_000 }) })).status, 400);
  assert.equal((await fetch(base + '/market', { method: 'DELETE', headers })).status, 200);
  assert.deepEqual(calls[1], ['release', 'phone-b']);
});
test('unexpected backend errors do not return raw provider responses or secrets', async t => {
  const broker = brokerFixture(); broker.accounts = async () => { throw new Error('PRIVATE_PROVIDER_BODY'); };
  const { rpc } = await fixture(t, { broker });
  const response = await rpc('accounts');
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(response.body).includes('PRIVATE_PROVIDER_BODY'), false);
});

test('atomic quick order uses one broker operation and device-bound replay receipts', async t => {
  const broker = brokerFixture();
  let calls = 0;
  broker.submitQuick = async (accountID, value) => {
    calls++;
    return { snapshot: { accountID, draft: value, isDemo: false }, result: { orderID: 'quick-order' } };
  };
  const { rpc } = await fixture(t, { broker });
  const requestID = 'fixture-request-0001';
  const first = await rpc('submitQuick', ['account', draft, requestID]);
  assert.equal(first.body.result.result.orderID, 'quick-order');
  assert.deepEqual((await rpc('submitQuick', ['account', draft, requestID])).body, first.body);
  assert.equal((await rpc('submitQuick', ['account', draft, requestID], 1)).body.error.code, 'invalidRequest');
  assert.equal((await rpc('submitQuick', ['account', { ...draft, quantity: 2 }, requestID])).body.error.code, 'invalidRequest');
  assert.equal((await rpc('submitQuick', ['account', draft, 'short'])).body.error.code, 'invalidRequest');
  assert.equal(calls, 1);
  assert.deepEqual(broker.calls, [], 'no duplicate prepare/submit validation rounds');
});

test('atomic quick order serializes both devices, invalidates old review, and caches unknown outcome', async t => {
  const broker = brokerFixture(), entered = deferred(), finish = deferred();
  let calls = 0;
  broker.submitQuick = async () => { calls++; entered.resolve(); await finish.promise; throw new TradingError('orderOutcomeUnknown', 'Verify'); };
  const { rpc } = await fixture(t, { broker });
  const review = (await rpc('prepare', ['account', draft])).body.result;
  const args = ['account', draft, 'fixture-request-0002'];
  const pending = rpc('submitQuick', args);
  await entered.promise;
  for (const [method, values] of [['submitQuick', ['account', draft, 'fixture-request-0003']], ['prepare', ['account', draft]], ['cancel', ['account', 'order']]])
    assert.equal((await rpc(method, values, 1)).body.error.code, 'operationBusy');
  finish.resolve();
  assert.equal((await pending).body.error.code, 'orderOutcomeUnknown');
  assert.equal((await rpc('submitQuick', args)).body.error.code, 'orderOutcomeUnknown');
  assert.equal((await rpc('submit', [{ id: review.id }])).body.error.code, 'reviewExpired');
  assert.equal(calls, 1);
});

test('account activity routes are authenticated and validate device-scoped cursor and wait', async t => {
  const calls = [], marketHub = {
    pollActivity: async (...args) => { calls.push(['poll', ...args.slice(0, 3)]); assert.ok(args[3] instanceof AbortSignal); return { cursor: 4, status: 'live' }; },
    releaseActivity: id => { calls.push(['release', id]); },
  };
  const { base } = await fixture(t, { marketHub });
  assert.equal((await fetch(base + '/activity', { method: 'POST' })).status, 401);
  const headers = { Authorization: 'Bearer ' + devices[1].token, 'Content-Type': 'application/json' };
  const valid = await fetch(base + '/activity', { method: 'POST', headers, body: JSON.stringify({ cursor: 3, waitMs: 20_000 }) });
  assert.deepEqual((await valid.json()).result, { cursor: 4, status: 'live' });
  for (const body of [{ cursor: -1 }, { waitMs: 20_001 }, { unknown: true }])
    assert.equal((await fetch(base + '/activity', { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  await fetch(base + '/activity', { method: 'DELETE', headers });
  assert.deepEqual(calls, [['poll', 'phone-b', 3, 20_000], ['release', 'phone-b']]);
});

test('retained history augments provider result without hiding it on storage failure', async t => {
  const broker = brokerFixture(), history = { symbol: 'AAPL', candles: [] };
  broker.history = async () => history;
  let broken = false;
  const marketHub = { mergeHistory: async (value, range) => { assert.equal(value, history); assert.equal(range, 'minute1'); if (broken) throw new Error(); return { ...value, retained: true }; } };
  const { rpc } = await fixture(t, { broker, marketHub });
  assert.equal((await rpc('history', ['AAPL', 'minute1'])).body.result.retained, true);
  broken = true;
  assert.deepEqual((await rpc('history', ['AAPL', 'minute1'])).body.result, history);
});
