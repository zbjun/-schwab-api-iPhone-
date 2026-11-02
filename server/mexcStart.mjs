import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { MexcBroker } from './mexcBroker.ts';
import { EncryptedVault, acquireProcessLock } from './vault.mjs';
import { createGateway } from './gateway.mjs';

// A separate process, vault and device list from the Schwab gateway. This host holds no Schwab credentials.
const configPath = resolve(process.argv[2] ?? 'server/mexc.config.json');
let release, server;
try {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      typeof config.dataDirectory !== 'string' || typeof config.encryptionKeyFile !== 'string')
    throw new Error('Invalid server configuration');
  const base = dirname(configPath), directory = resolve(base, config.dataDirectory);
  const key = await readFile(resolve(base, config.encryptionKeyFile));
  release = await acquireProcessLock(directory);
  const broker = new MexcBroker(new EncryptedVault(directory, key), { apiKey: config.apiKey, apiSecret: config.apiSecret, limits: config.limits });
  server = createGateway({ broker, devices: config.devices, extraReads: {
    contracts: () => broker.contracts(),
    limits: () => broker.limits,
    closedOrders: (...args) => broker.closedOrders(...args),
  } });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', done); });
  console.log(`MEXC gateway listening on 127.0.0.1:${config.port}; HTTPS reverse proxy required.`);
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    server.close(async () => { await release(); process.exit(0); });
    // Keep the lock on forced termination; the durable operation marker protects uncertain writes.
    setTimeout(() => process.exit(1), 65_000).unref();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch {
  server?.close();
  if (release) await release().catch(() => {});
  console.error('MEXC gateway did not start. Check config, encryption key and vault lock locally; no credentials were logged.');
  process.exitCode = 1;
}
