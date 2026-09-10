import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EncryptedVault, acquireProcessLock } from './vault.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ths-vault-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, key: randomBytes(32) };
}
test('vault persists authenticated ciphertext without plaintext secrets', async t => {
  const { directory, key } = await fixture(t), vault = new EncryptedVault(directory, key);
  await vault.set('token', 'fictional-secret-only');
  const first = await readFile(join(directory, 'vault.enc'));
  assert.equal(first.includes(Buffer.from('fictional-secret-only')), false);
  assert.equal(await new EncryptedVault(directory, key).get('token'), 'fictional-secret-only');
  await vault.set('token', 'fictional-secret-only');
  assert.notDeepEqual(await readFile(join(directory, 'vault.enc')), first);
  await vault.remove('token');
  assert.equal(await new EncryptedVault(directory, key).get('token'), null);
});
test('wrong key, corrupted ciphertext and truncated vault fail closed', async t => {
  const { directory, key } = await fixture(t);
  await new EncryptedVault(directory, key).set('token', 'fictional');
  await assert.rejects(new EncryptedVault(directory, randomBytes(32)).get('token'), /authentication failed/);
  const original = await readFile(join(directory, 'vault.enc'));
  const tampered = Buffer.from(original); tampered[tampered.length - 1] ^= 1;
  await writeFile(join(directory, 'vault.enc'), tampered);
  await assert.rejects(new EncryptedVault(directory, key).set('token', 'overwrite'), /authentication failed/);
  assert.deepEqual(await readFile(join(directory, 'vault.enc')), tampered);
  await writeFile(join(directory, 'vault.enc'), original.subarray(0, 20));
  await assert.rejects(new EncryptedVault(directory, key).get('token'), /authentication failed/);
});
test('concurrent mutations serialize, remain durable and leave no temporary files', async t => {
  const { directory, key } = await fixture(t), vault = new EncryptedVault(directory, key);
  await Promise.all(Array.from({ length: 30 }, (_, i) => vault.set('key-' + i, String(i))));
  await Promise.all([vault.set('ordered', 'first'), vault.remove('ordered'), vault.set('ordered', 'last')]);
  const restored = new EncryptedVault(directory, key);
  for (let i = 0; i < 30; i++) assert.equal(await restored.get('key-' + i), String(i));
  assert.equal(await restored.get('ordered'), 'last');
  assert.deepEqual(await readdir(directory), ['vault.enc']);
});
test('process lock refuses concurrent or stale owners and releases exactly once', async t => {
  const { directory } = await fixture(t);
  const release = await acquireProcessLock(directory);
  await assert.rejects(acquireProcessLock(directory), /locked/);
  await release(); await release();
  const releaseAgain = await acquireProcessLock(directory); await releaseAgain();
  await writeFile(join(directory, 'process.lock'), '999999999');
  await assert.rejects(acquireProcessLock(directory), /locked/);
});
test('failed persistence stops the live vault instead of serving a potentially stale marker', async t => {
  const { directory, key } = await fixture(t), vault = new EncryptedVault(directory, key);
  await vault.set('marker', 'pending');
  const path = join(directory, 'vault.enc'), original = await readFile(path);
  await unlink(path); await mkdir(path);
  await assert.rejects(vault.set('next', 'value'));
  await rm(path, { recursive: true }); await writeFile(path, original);
  await assert.rejects(vault.get('marker'), /persistence failed/);
  await assert.rejects(vault.remove('marker'), /persistence failed/);
  assert.equal(await new EncryptedVault(directory, key).get('marker'), 'pending');
  assert.deepEqual(await readdir(directory), ['vault.enc']);
});
