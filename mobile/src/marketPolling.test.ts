import assert from "node:assert/strict";
import test from "node:test";
import { startMarketPolling } from "./marketPolling.ts";

type Timer = ReturnType<typeof setTimeout>;

function clock() {
  let time = 0;
  let sequence = 0;
  const tasks = new Map<Timer, { at: number; callback: () => void }>();
  return {
    now: () => time,
    schedule(callback: () => void, delay: number): Timer {
      const id = ++sequence as unknown as Timer;
      tasks.set(id, { at: time + delay, callback });
      return id;
    },
    cancel(id: Timer) {
      tasks.delete(id);
    },
    advance(ms: number) {
      const end = time + ms;
      while (true) {
        const next = [...tasks.entries()]
          .filter(([, task]) => task.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at;
        tasks.delete(next[0]);
        next[1].callback();
      }
      time = end;
    },
    pending: () => tasks.size,
    nextDelay: () => Math.min(...[...tasks.values()].map((task) => task.at - time)),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("starts inactive, polls immediately on activation, and pauses/resumes timers", async () => {
  const time = clock();
  const starts: number[] = [];
  const polling = startMarketPolling({
    ...time,
    interval: () => 1000,
    run: async () => { starts.push(time.now()); },
  });
  assert.equal(time.pending(), 0);
  time.advance(5000);
  assert.deepEqual(starts, []);
  polling.setActive(true);
  polling.setActive(true);
  assert.deepEqual(starts, [5000]);
  await settle();
  assert.equal(time.nextDelay(), 1000);
  polling.setActive(false);
  assert.equal(time.pending(), 0);
  time.advance(5000);
  polling.setActive(true);
  assert.deepEqual(starts, [5000, 10000]);
  await settle();
  polling.stop();
  assert.equal(time.pending(), 0);
  polling.setActive(true);
  time.advance(5000);
  assert.equal(starts.length, 2);
});

test("uses current interval and subtracts successful request duration", async () => {
  const time = clock();
  let interval = 1000;
  let request = deferred();
  let calls = 0;
  const polling = startMarketPolling({
    ...time,
    interval: () => interval,
    run: () => { calls++; return request.promise; },
  });
  polling.setActive(true);
  time.advance(400);
  interval = 1500;
  request.resolve();
  await settle();
  assert.equal(time.nextDelay(), 1100);
  request = deferred();
  time.advance(1100);
  assert.equal(calls, 2);
  time.advance(5000);
  assert.equal(calls, 2);
  assert.equal(time.pending(), 0);
  request.resolve();
  await settle();
  assert.equal(time.nextDelay(), 250);
  polling.stop();
});

test("pause/resume during a read queues one immediate read without overlap", async () => {
  const time = clock();
  const requests = [deferred(), deferred()];
  let calls = 0;
  const polling = startMarketPolling({
    ...time,
    interval: () => 1000,
    run: () => requests[calls++].promise,
  });
  polling.setActive(true);
  polling.setActive(false);
  polling.setActive(true);
  polling.setActive(false);
  polling.setActive(true);
  time.advance(5000);
  assert.equal(calls, 1);
  requests[0].resolve();
  await settle();
  assert.equal(calls, 2);
  assert.equal(time.pending(), 0);
  polling.setActive(false);
  requests[1].resolve();
  await settle();
  assert.equal(time.pending(), 0);
  assert.equal(calls, 2);
  polling.stop();
});

test("stop during an in-flight read permanently prevents follow-up", async () => {
  const time = clock();
  const request = deferred();
  let calls = 0;
  const polling = startMarketPolling({
    ...time,
    interval: () => 1000,
    run: () => { calls++; return request.promise; },
  });
  polling.setActive(true);
  polling.setActive(false);
  polling.setActive(true);
  polling.stop();
  request.resolve();
  await settle();
  polling.setActive(true);
  time.advance(10_000);
  assert.equal(calls, 1);
  assert.equal(time.pending(), 0);
});

test("failures back off to 60 seconds, survive reporting errors, and reset on success", async () => {
  const time = clock();
  const failure = new Error("offline");
  let failing = true;
  let reports = 0;
  const polling = startMarketPolling({
    ...time,
    interval: () => 1000,
    run: async () => { if (failing) throw failure; },
    onError: (error) => {
      assert.equal(error, failure);
      reports++;
      throw new Error("reporter unavailable");
    },
  });
  polling.setActive(true);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    await settle();
    assert.equal(time.nextDelay(), delay);
    time.advance(delay);
  }
  await settle();
  assert.equal(reports, 9);
  failing = false;
  time.advance(60000);
  await settle();
  assert.equal(time.nextDelay(), 1000);
  failing = true;
  time.advance(1000);
  await settle();
  assert.equal(time.nextDelay(), 1000);
  polling.stop();
});

test("slow failures leave a base interval after completion and synchronous throws retry", async () => {
  const time = clock();
  const request = deferred();
  let calls = 0;
  const polling = startMarketPolling({
    ...time,
    interval: () => 1000,
    run: () => {
      if (++calls === 1) return request.promise;
      throw new Error("synchronous failure");
    },
  });
  polling.setActive(true);
  time.advance(5000);
  request.reject(new Error("timeout"));
  await settle();
  assert.equal(time.nextDelay(), 1000);
  time.advance(1000);
  await settle();
  assert.equal(calls, 2);
  assert.equal(time.nextDelay(), 2000);
  polling.stop();
});

test("account completion cadence waits five seconds after a slow response and stops when hidden", async () => {
  const time = clock();
  const request = deferred();
  let calls = 0;
  const polling = startMarketPolling({
    ...time,
    interval: () => 5000,
    cadence: "completion",
    run: () => { calls++; return request.promise; },
  });
  polling.setActive(true);
  time.advance(12_000);
  assert.equal(calls, 1);
  request.resolve();
  await settle();
  assert.equal(time.nextDelay(), 5000);
  time.advance(4999);
  assert.equal(calls, 1);
  polling.setActive(false);
  time.advance(30_000);
  assert.equal(calls, 1);
  polling.setActive(true);
  assert.equal(calls, 2);
  polling.stop();
  await settle();
  assert.equal(time.pending(), 0);
});
