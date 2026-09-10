import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile), command = fileURLToPath(new URL('./init.mjs', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ths-init-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('initialization generates independent keys, prints no secrets and never overwrites', async t => {
  const directory = await fixture(t);
  const result = await execute(process.execPath, [command, directory]);
  const key = await readFile(join(directory, 'vault.key'));
  const raw = await readFile(join(directory, 'config.json'), 'utf8'), config = JSON.parse(raw);
  assert.equal(key.length, 32);
  assert.notEqual(config.devices[0].token, config.devices[1].token);
  for (const { token } of config.devices) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(result.stdout.includes(token), false);
  }
  await assert.rejects(execute(process.execPath, [command, directory]));
  assert.deepEqual(await readFile(join(directory, 'vault.key')), key);
  assert.equal(await readFile(join(directory, 'config.json'), 'utf8'), raw);
});
test('existing config without key is preserved and newly generated key rolls back', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'config.json'), 'existing-config');
  await assert.rejects(execute(process.execPath, [command, directory]));
  assert.equal(await readFile(join(directory, 'config.json'), 'utf8'), 'existing-config');
  assert.deepEqual(await readdir(directory), ['config.json']);
});
