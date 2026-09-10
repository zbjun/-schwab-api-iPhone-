import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { SchwabBroker } from '../mobile/src/broker.ts';
import { EncryptedVault, acquireProcessLock } from './vault.mjs';
import { createGateway } from './gateway.mjs';
import { MarketHub } from './market.ts';

// Config/key are local files, never command-line secrets or mobile bundle inputs.
const configPath = resolve(process.argv[2] ?? 'server/config.json');
let release;
try {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      typeof config.dataDirectory !== 'string' || typeof config.encryptionKeyFile !== 'string')
    throw new Error('Invalid server configuration');
  const base = dirname(configPath), directory = resolve(base, config.dataDirectory);
  const key = await readFile(resolve(base, config.encryptionKeyFile));
  release = await acquireProcessLock(directory);
  const vault = new EncryptedVault(directory, key);
  const broker = new SchwabBroker(vault, { callbackURL: config.callbackURL });
  await broker.configure(config.clientID, config.clientSecret);
  const hub = new MarketHub(() => broker.marketCredentials());
  const server = createGateway({ broker, devices: config.devices, callbackURL: config.callbackURL, marketHub: hub });
  server.on('close', () => hub.close());
  await new Promise((done, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', done); });
  console.log(`Personal trading server listening on 127.0.0.1:${config.port}; HTTPS reverse proxy required.`);
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    hub.close();
    server.close(async () => { await release(); process.exit(0); });
    // Keep the lock on forced termination; the durable broker operation marker protects uncertain writes.
    setTimeout(() => process.exit(1), 65_000).unref();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch {
  if (release) await release().catch(() => {});
  console.error('Server did not start. Check config, encryption key and vault lock locally; no credentials were logged.');
  process.exitCode = 1;
}
