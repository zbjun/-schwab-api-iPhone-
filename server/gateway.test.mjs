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
