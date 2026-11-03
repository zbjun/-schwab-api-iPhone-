import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { MexcBroker } from './mexcBroker.ts';
import { EncryptedVault, acquireProcessLock } from './vault.mjs';

// Offline recovery with the gateway stopped. It only reads from MEXC: it never submits,
// retries or cancels an order. Clearing the lock takes a separate, explicit flag.
const [, , file, flag] = process.argv;
if (process.argv.length < 3 || process.argv.length > 4 || (flag !== undefined && flag !== '--confirmed-at-exchange')) {
  console.error('Usage: node server/mexcReconcile.mjs <config-file> [--confirmed-at-exchange]\nWithout the flag this shows the locked operation. Stop the gateway first.');
  process.exitCode = 1;
} else {
  let release;
  try {
    const configPath = resolve(file);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const base = dirname(configPath), directory = resolve(base, config.dataDirectory);
    const key = await readFile(resolve(base, config.encryptionKeyFile));
    release = await acquireProcessLock(directory);
    const broker = new MexcBroker(new EncryptedVault(directory, key), { apiKey: config.apiKey, apiSecret: config.apiSecret, limits: config.limits });
    if (flag) {
      await broker.acknowledgeReconciliation();
      console.log('Cleared the unresolved-operation marker. Restart the gateway; acknowledge on affected devices. No MEXC request was made.');
    } else {
      const pending = await broker.pendingOperation();
      if (!pending) console.log('Nothing is locked.');
      else {
        const { marker, order, position, stopOrders, lookup } = pending;
        console.log(`Locked ${marker.operation} on ${marker.symbol ?? 'unknown contract'} at ${new Date(marker.createdAt).toISOString()}, id ${marker.externalOid ?? marker.orderID ?? marker.positionId}.`);
        if (marker.operation === 'stop') {
          console.log(`The request was ${marker.stopKind}${marker.stopOrderId ? ` of ${marker.stopOrderId}` : ''} with take-profit ${marker.takeProfitPrice ?? 'none'} and stop-loss ${marker.stopLossPrice ?? 'none'}.`);
          if (lookup === 'failed') console.log('The lookup failed, so this tells you nothing about the position. Check MEXC directly.');
          else for (const row of stopOrders ?? []) console.log(`MEXC shows take-profit and stop-loss ${row.id} waiting: take-profit ${row.takeProfitPrice ?? 'none'}, stop-loss ${row.stopLossPrice ?? 'none'}, ${row.vol} contracts.`);
          if (lookup === 'notFound') console.log('MEXC shows none waiting on this position.');
          console.log('What MEXC shows now does not prove the request never landed. Check the position at MEXC before clearing.');
        } else if (marker.operation === 'leverage') {
          if (lookup === 'found') console.log(`MEXC reports position ${position.id} at ${position.leverage}x. The change was from ${marker.previousLeverage}x to ${marker.leverage}x.`);
          else if (lookup === 'notFound') console.log('MEXC lists no such open position. Check the MEXC position history before clearing.');
          else console.log('The lookup failed, so this tells you nothing about the position. Check MEXC directly.');
          console.log('A position still at the old leverage does not prove the change never landed. Check the position at MEXC before clearing.');
        } else if (lookup === 'found') console.log(`MEXC reports order ${order.id}: state ${order.state} (1 pending, 2 unfilled, 3 filled, 4 canceled, 5 invalid), filled ${order.dealVol} of ${order.vol}.`);
        // Not finding it does not prove it never landed: an order can appear after the lookup.
        else if (lookup === 'notFound') console.log('MEXC says this order does not exist. That does not prove it was never placed; wait and check the MEXC order history before clearing.');
        else console.log('The lookup failed, so this tells you nothing about the order. Check the MEXC order history directly.');
      }
    }
  } catch {
    console.error('Reconciliation was not completed. Check the stopped gateway, config, key and lock locally.');
    process.exitCode = 1;
  } finally {
    if (release) await release().catch(() => { process.exitCode = 1; });
  }
}
