import test from "node:test";
import assert from "node:assert/strict";
import { createActivitySync } from "./activitySync.ts";

test("bursts coalesce, events during a read trigger one later fresh read, and stop cancels queued work", async () => {
  const tasks = new Map<number, () => void>(); let id = 0, reads = 0;
  let resolve!: () => void;
  const sync = createActivitySync({
    read: async () => { reads++; if (reads === 1) await new Promise<void>(yes => { resolve = yes; }); },
    schedule: ((fn: () => void) => { tasks.set(++id, fn); return id; }) as unknown as typeof setTimeout,
    cancel: ((key: number) => tasks.delete(key)) as unknown as typeof clearTimeout,
  });
  const fire = () => { const [key, fn] = tasks.entries().next().value!; tasks.delete(key); fn(); };
  sync.notify(); sync.notify(); sync.notify();
  assert.equal(tasks.size, 1);
  fire(); await Promise.resolve(); assert.equal(reads, 1);
  sync.notify(); sync.notify();
  assert.equal(tasks.size, 0);
  resolve(); await new Promise<void>(yes => setImmediate(yes));
  assert.equal(tasks.size, 1);
  fire(); await new Promise<void>(yes => setImmediate(yes));
  assert.equal(reads, 2);
  sync.notify(); sync.stop(); assert.equal(tasks.size, 0);
  sync.notify(); assert.equal(tasks.size, 0);
});

test("fallback waits for the actual read and propagates failure without marking it dirty", async () => {
  let calls = 0, reject!: (error: Error) => void;
  const sync = createActivitySync({ read: () => { calls++; return new Promise<void>((_, no) => { reject = no; }); } });
  const first = sync.poll(), second = sync.poll();
  const checked = Promise.all([assert.rejects(first, /offline/), assert.rejects(second, /offline/)]);
  await Promise.resolve(); assert.equal(calls, 1);
  reject(new Error("offline")); await checked;
  await new Promise(yes => setTimeout(yes, 250)); assert.equal(calls, 1);
  sync.stop();
});

test("failed reconciliation does not wedge future account events", async () => {
  let fire!: () => void, calls = 0;
  const sync = createActivitySync({ read: async () => { calls++; throw new Error("offline"); },
    schedule: ((fn: () => void) => { fire = fn; return 1; }) as unknown as typeof setTimeout,
    cancel: (() => {}) as typeof clearTimeout });
  sync.notify(); fire(); await new Promise<void>(yes => setImmediate(yes));
  sync.notify(); fire(); await new Promise<void>(yes => setImmediate(yes));
  assert.equal(calls, 2); sync.stop();
});
