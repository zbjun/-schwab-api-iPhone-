import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EncryptedVault, acquireProcessLock } from './vault.mjs';

// Nothing here reaches MEXC: the only paths exercised stop before any network request.
const execute = promisify(execFile);
const script = name => fileURLToPath(new URL(`./${name}`, import.meta.url));
const markerKey = 'ths.mexc.operation.v1';
const limits = { maxLeverage: 5, maxOrderNotional: 1000, marketProtection: 0.01 };
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ths-mexc-scripts-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32), data = join(directory, 'data'), config = join(directory, 'mexc.config.json');
  await writeFile(join(directory, 'vault.key'), key);
  await writeFile(config, JSON.stringify({ dataDirectory: './data', encryptionKeyFile: './vault.key', apiKey: 'fictional', apiSecret: 'fictional', limits }));
  return { directory, key, data, config };
}

test('recovery refuses bad arguments and leaves the lock alone', async t => {
  const { key, data, config } = await workspace(t);
  await new EncryptedVault(data, key).set(markerKey, JSON.stringify({ pending: true, version: 1, createdAt: 1 }));
  await assert.rejects(execute(process.execPath, [script('mexcReconcile.mjs')]));
  await assert.rejects(execute(process.execPath, [script('mexcReconcile.mjs'), config, '--confirmed-at-broker']));
  await assert.rejects(execute(process.execPath, [script('mexcReconcile.mjs'), config, '--confirmed-at-exchange', 'extra']));
  assert.notEqual(await new EncryptedVault(data, key).get(markerKey), null);
});

test('recovery refuses to run beside a live gateway', async t => {
  const { key, data, config } = await workspace(t);
  await new EncryptedVault(data, key).set(markerKey, JSON.stringify({ pending: true, version: 1, createdAt: 1 }));
  const release = await acquireProcessLock(data);
  try {
    await assert.rejects(execute(process.execPath, [script('mexcReconcile.mjs'), config, '--confirmed-at-exchange']));
    await assert.rejects(execute(process.execPath, [script('mexcReconcile.mjs'), config]));
  } finally { await release(); }
  assert.notEqual(await new EncryptedVault(data, key).get(markerKey), null);
});

test('recovery only clears with the explicit flag and prints no credentials', async t => {
  const { key, data, config } = await workspace(t);
  const clean = await execute(process.execPath, [script('mexcReconcile.mjs'), config]);
  assert.match(clean.stdout, /Nothing is locked/);
  await new EncryptedVault(data, key).set(markerKey, JSON.stringify({ pending: true, version: 1, createdAt: 1 }));
  const cleared = await execute(process.execPath, [script('mexcReconcile.mjs'), config, '--confirmed-at-exchange']);
  assert.match(cleared.stdout, /No MEXC request was made/);
  assert.doesNotMatch(cleared.stdout + cleared.stderr, /fictional/);
  assert.equal(await new EncryptedVault(data, key).get(markerKey), null);
});

test('a marker that names no order is reported as a failed lookup without any request', async t => {
  const { key, data, config } = await workspace(t);
  await new EncryptedVault(data, key).set(markerKey, JSON.stringify({ pending: true, version: 1, createdAt: 1 }));
  const result = await execute(process.execPath, [script('mexcReconcile.mjs'), config]);
  assert.match(result.stdout, /lookup failed/);
  assert.notEqual(await new EncryptedVault(data, key).get(markerKey), null);
});

test('a locked leverage change is described without claiming it failed, and stays locked', async t => {
  const { key, data, config } = await workspace(t);
  // An id that cannot be looked up stops before any request, so this stays offline.
  await new EncryptedVault(data, key).set(markerKey, JSON.stringify({ pending: true, version: 1, createdAt: 1, operation: 'leverage', symbol: 'QQQSTOCK_USDT', positionId: 'not-digits', leverage: 3, previousLeverage: 5 }));
  const result = await execute(process.execPath, [script('mexcReconcile.mjs'), config]);
  assert.match(result.stdout, /Locked leverage on QQQSTOCK_USDT/);
  assert.match(result.stdout, /tells you nothing about the position/);
  assert.match(result.stdout, /does not prove the change never landed/);
  assert.notEqual(await new EncryptedVault(data, key).get(markerKey), null);
});

test('a locked stop request is described without claiming it failed, and stays locked', async t => {
  const { key, data, config } = await workspace(t);
  // A symbol that cannot be looked up stops before any request, so this stays offline.
  await new EncryptedVault(data, key).set(markerKey, JSON.stringify({ pending: true, version: 1, createdAt: 1, operation: 'stop', symbol: 'a/b', positionId: '1', stopKind: 'STOP_CHANGE', stopOrderId: '7', stopLossPrice: '680' }));
  const result = await execute(process.execPath, [script('mexcReconcile.mjs'), config]);
  assert.match(result.stdout, /Locked stop on a\/b/);
  assert.match(result.stdout, /STOP_CHANGE of 7 with take-profit none and stop-loss 680/);
  assert.match(result.stdout, /tells you nothing about the position/);
  assert.match(result.stdout, /does not prove the request never landed/);
  assert.notEqual(await new EncryptedVault(data, key).get(markerKey), null);
});

test('init creates private files, unique device tokens and never overwrites', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ths-mexc-init-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execute(process.execPath, [script('mexcInit.mjs'), directory]);
  const first = await readFile(join(directory, 'mexc.config.json'), 'utf8');
  const config = JSON.parse(first);
  assert.equal(config.apiKey, 'REPLACE_ON_SERVER');
  assert.equal(config.limits.maxLeverage, 5);
  assert.equal(new Set(config.devices.map(device => device.token)).size, config.devices.length);
  assert.ok(config.devices.every(device => /^[A-Za-z0-9_-]{43}$/.test(device.token)));
  assert.equal((await stat(join(directory, 'mexc-vault.key'))).size, 32);
  await assert.rejects(execute(process.execPath, [script('mexcInit.mjs'), directory]));
  assert.equal(await readFile(join(directory, 'mexc.config.json'), 'utf8'), first);
});

test('the gateway will not start with a mistyped key check setting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ths-mexc-keycheck-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execute(process.execPath, [script('mexcInit.mjs'), directory]);
  const path = join(directory, 'mexc.config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(config.keyCheck, true);
  await writeFile(path, JSON.stringify({ ...config, apiKey: 'fictional', apiSecret: 'fictional', keyCheck: 'false', dataDirectory: './d', port: 18789 }));
  // The timeout turns a gateway that wrongly starts into a failure instead of a hung test.
  await assert.rejects(execute(process.execPath, [script('mexcStart.mjs'), path], { timeout: 15_000 }), error => {
    assert.match(error.stderr, /did not start/);
    return true;
  });
});

test('the gateway will not start with the placeholder key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ths-mexc-start-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execute(process.execPath, [script('mexcInit.mjs'), directory]);
  await assert.rejects(execute(process.execPath, [script('mexcStart.mjs'), join(directory, 'mexc.config.json')]), error => {
    assert.match(error.stderr, /did not start/);
    assert.doesNotMatch(error.stdout + error.stderr, /REPLACE_ON_SERVER/);
    return true;
  });
});
