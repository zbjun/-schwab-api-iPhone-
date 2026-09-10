import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { SchwabBroker } from '../mobile/src/broker.ts';
import { EncryptedVault, acquireProcessLock } from './vault.mjs';

// Offline-only recovery. This never queries, submits, retries or cancels an order.
// Stop the server and verify the uncertain order in Schwab before using this command.
if (process.argv.length !== 4 || process.argv[3] !== '--confirmed-at-broker') {
  console.error('Usage: node server/reconcile.mjs <config-file> --confirmed-at-broker\nStop the server and verify all uncertain orders in Schwab first.');
  process.exitCode = 1;
} else {
  let release;
  try {
    const configPath = resolve(process.argv[2]);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const base = dirname(configPath);
    const key = await readFile(resolve(base, config.encryptionKeyFile));
    release = await acquireProcessLock(resolve(base, config.dataDirectory));
    const vault = new EncryptedVault(resolve(base, config.dataDirectory), key);
    const broker = new SchwabBroker(vault, { callbackURL: config.callbackURL });
    await broker.acknowledgeReconciliation();
    console.log('Cleared the shared unresolved-operation marker. Restart the server; acknowledge reconciliation on affected devices. No brokerage request was made.');
  } catch {
    console.error('Reconciliation was not completed. Check the stopped server, config, key and lock locally.');
    process.exitCode = 1;
  } finally {
    if (release) await release().catch(() => { process.exitCode = 1; });
  }
}
