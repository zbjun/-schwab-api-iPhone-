import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EncryptedVault, acquireProcessLock } from './vault.mjs';
import { SchwabBroker } from '../mobile/src/broker.ts';

const execute = promisify(execFile);
const command = fileURLToPath(new URL('./reconcile.mjs', import.meta.url));
const markerKey = 'ths.schwab.operation.v1';
test('server restart and credential configuration retain the encrypted global unknown marker', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ths-marker-restart-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  await new EncryptedVault(directory, key).set(markerKey, JSON.stringify({ pending: true, version: 1 }));
  const broker = new SchwabBroker(new EncryptedVault(directory, key));
  await broker.configure('fictional-client-id', 'fictional-client-secret');
  assert.equal((await broker.status()).unresolvedOperation, true);
  const restarted = new SchwabBroker(new EncryptedVault(directory, key));
  await restarted.configure('fictional-client-id', 'fictional-client-secret');
  assert.equal((await restarted.status()).unresolvedOperation, true);
});
test('offline reconciliation requires operator confirmation and refuses a running owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ths-reconcile-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32), data = join(directory, 'data'), config = join(directory, 'config.json');
  await writeFile(join(directory, 'vault.key'), key);
  await writeFile(config, JSON.stringify({ dataDirectory: './data', encryptionKeyFile: './vault.key', callbackURL: 'https://127.0.0.1' }));
  await new EncryptedVault(data, key).set(markerKey, JSON.stringify({ pending: true, version: 1 }));
  await assert.rejects(execute(process.execPath, [command, config]));
  assert.notEqual(await new EncryptedVault(data, key).get(markerKey), null);
  const release = await acquireProcessLock(data);
  try { await assert.rejects(execute(process.execPath, [command, config, '--confirmed-at-broker'])); }
  finally { await release(); }
  assert.notEqual(await new EncryptedVault(data, key).get(markerKey), null);
  const result = await execute(process.execPath, [command, config, '--confirmed-at-broker']);
  assert.match(result.stdout, /No brokerage request was made/);
  assert.equal(await new EncryptedVault(data, key).get(markerKey), null);
});
