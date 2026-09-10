import { randomBytes } from 'node:crypto';
import { mkdir, readFile, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] ?? directory);
const createdFiles = [];
async function createPrivateFile(name, contents) {
  const path = resolve(target, name), handle = await open(path, 'wx', 0o600);
  createdFiles.push(path);
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
}
try {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const config = JSON.parse(await readFile(new URL('./config.example.json', import.meta.url), 'utf8'));
  config.devices = config.devices.map(device => ({ ...device, token: randomBytes(32).toString('base64url') }));
  // Exclusive creation never overwrites an existing encryption key or configured devices.
  await createPrivateFile('vault.key', randomBytes(32));
  await createPrivateFile('config.json', JSON.stringify(config, null, 2) + '\n');
  console.log('Created local config.json and vault.key. Edit the config on the server and keep both files private.');
} catch {
  // Do not leave a newly generated key beside a pre-existing config after a partial init.
  for (const path of createdFiles.reverse()) await unlink(path).catch(() => {});
  console.error('Initialization did not complete. Existing config or key files were not overwritten.');
  process.exitCode = 1;
}
