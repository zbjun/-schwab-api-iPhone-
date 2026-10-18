import test from 'node:test';
import assert from 'node:assert/strict';
import { startMaintenance } from './maintenance.mjs';

test('maintenance serializes refreshes, survives sanitized failures, and flushes on stop', async () => {
  const timers = new Map(); let counter = 0, refreshes = 0, flushes = 0, resolve;
  const warnings = [];
  const job = startMaintenance({
    broker: { maintainAuthorization: async () => { refreshes++; if (refreshes === 1) await new Promise(yes => { resolve = yes; }); else throw new Error('secret response'); } },
    archive: { flush: async () => { flushes++; } }, warn: kind => warnings.push(kind),
    schedule: fn => { timers.set(++counter, fn); return counter; }, cancel: key => timers.delete(key),
  });
  assert.equal(refreshes, 1); assert.equal(timers.size, 0);
  resolve(); await new Promise(yes => setImmediate(yes));
  for (let i = 0; i < 2; i++) {
    const [id, callback] = timers.entries().next().value; timers.delete(id); callback();
    await new Promise(yes => setImmediate(yes));
  }
  assert.equal(refreshes, 3); assert.equal(flushes, 1);
  assert.deepEqual(warnings, ['authorization']);
  await job.stop(); assert.equal(timers.size, 0); assert.equal(flushes, 2);
});
