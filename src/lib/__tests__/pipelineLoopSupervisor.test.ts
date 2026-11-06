import assert from 'node:assert/strict';
import test from 'node:test';

import { supervisePipelineLoop } from '../pipelineLoopSupervisor';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a worker waits through a storage hold and starts only after recovery', async () => {
  const controller = new AbortController();
  const pauses: boolean[] = [];
  const waits: number[] = [];
  let canRun = false;
  let runs = 0;
  await supervisePipelineLoop(async () => {
    assert.equal(canRun, true);
    runs++;
    controller.abort();
  }, {
    signal: controller.signal,
    shouldStop: async () => false,
    canRun: () => canRun,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      assert.equal(runs, 0);
      if (waits.length === 2) canRun = true;
    },
    onError: (error) => { throw error; },
    onStoragePauseChange: (paused) => pauses.push(paused),
  });
  assert.equal(runs, 1);
  assert.deepEqual(waits, [5_000, 5_000]);
  assert.deepEqual(pauses, [true, false]);
});

test('a worker that yielded during a hold restarts without overlapping its old work', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const finish = deferred();
  const holding = deferred();
  const recover = deferred();
  let canRun = true;
  let runs = 0;
  let active = 0;
  const task = supervisePipelineLoop(async () => {
    runs++;
    active++;
    assert.equal(active, 1);
    if (runs === 1) {
      entered.resolve();
      await finish.promise;
    } else {
      controller.abort();
    }
    active--;
  }, {
    signal: controller.signal,
    shouldStop: async () => false,
    canRun: () => canRun,
    wait: async (milliseconds) => {
      if (milliseconds === 5_000) {
        holding.resolve();
        await recover.promise;
      }
    },
    onError: (error) => { throw error; },
  });
  await entered.promise;
  canRun = false;
  assert.equal(runs, 1);
  finish.resolve();
  await holding.promise;
  assert.equal(runs, 1);
  assert.equal(active, 0);
  canRun = true;
  recover.resolve();
  await task;
  assert.equal(runs, 2);
  assert.equal(active, 0);
});

test('recovery before a yielded worker finishes unwinding cannot retire the lane', async () => {
  const controller = new AbortController();
  let canRun = true;
  let runs = 0;
  await supervisePipelineLoop(async () => {
    runs++;
    if (runs === 1) {
      canRun = false;
      await Promise.resolve();
      canRun = true;
      return;
    }
    controller.abort();
  }, {
    signal: controller.signal,
    shouldStop: async () => false,
    canRun: () => canRun,
    wait: async (milliseconds) => { assert.equal(milliseconds, 1_000); },
    onError: (error) => { throw error; },
  });
  assert.equal(runs, 2);
});

test('local screening and description workers both recover from the same hold', async () => {
  const bothWaiting = deferred();
  const recover = deferred();
  let canRun = false;
  let waiting = 0;
  const runs: string[] = [];
  const tasks = ['Local Scoring', 'JD Extraction'].map((name) => {
    const controller = new AbortController();
    return supervisePipelineLoop(async () => {
      runs.push(name);
      controller.abort();
    }, {
      signal: controller.signal,
      shouldStop: async () => false,
      canRun: () => canRun,
      wait: async () => {
        if (++waiting === 2) bothWaiting.resolve();
        await recover.promise;
      },
      onError: (error) => { throw error; },
    });
  });
  await bothWaiting.promise;
  assert.deepEqual(runs, []);
  canRun = true;
  recover.resolve();
  await Promise.all(tasks);
  assert.deepEqual(runs.sort(), ['JD Extraction', 'Local Scoring']);
});

test('an operator Stop during a storage hold ends the supervisor without resuming work', async () => {
  let stopped = false;
  let runs = 0;
  await supervisePipelineLoop(async () => { runs++; }, {
    signal: new AbortController().signal,
    shouldStop: async () => stopped,
    canRun: () => false,
    wait: async () => { stopped = true; },
    onError: (error) => { throw error; },
  });
  assert.equal(runs, 0);
});

test('abort during a storage wait or stop check prevents another worker start', async () => {
  for (const duringStopCheck of [false, true]) {
    const controller = new AbortController();
    let runs = 0;
    await supervisePipelineLoop(async () => { runs++; }, {
      signal: controller.signal,
      shouldStop: async () => {
        if (duringStopCheck) controller.abort();
        return false;
      },
      canRun: () => duringStopCheck,
      wait: async () => { controller.abort(); },
      onError: (error) => { throw error; },
    });
    assert.equal(runs, 0);
  }
});

test('worker errors retain bounded retry backoff', async () => {
  const waits: number[] = [];
  const failures: number[] = [];
  const failure = new Error('temporary provider failure');
  let stopped = false;
  await supervisePipelineLoop(async () => { throw failure; }, {
    signal: new AbortController().signal,
    shouldStop: async () => stopped,
    canRun: () => true,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      if (waits.length === 8) stopped = true;
    },
    onError: (error, count) => {
      assert.equal(error, failure);
      failures.push(count);
    },
  });
  assert.deepEqual(failures, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
});
