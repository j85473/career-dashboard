import assert from 'node:assert/strict';
import test from 'node:test';

import { startClientPolling } from '../clientPolling';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('forced refresh ignores a late older response and schedules only one next poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: Array<ReturnType<typeof deferred<string>> & { signal: AbortSignal }> = [];
  const displayed: string[] = [];
  const polling = startClientPolling({
    request: (signal) => {
      const request = { ...deferred<string>(), signal };
      requests.push(request);
      return request.promise;
    },
    onData: (value) => { displayed.push(value); },
    intervalMs: () => 100,
  });
  t.after(polling.stop);
  t.mock.timers.tick(0);
  polling.refresh();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve('newer');
  await flush();
  requests[0].resolve('older');
  await flush();
  assert.deepEqual(displayed, ['newer']);

  t.mock.timers.tick(100);
  assert.equal(requests.length, 3, 'only one future request may be scheduled');
  t.mock.timers.tick(1_000);
  assert.equal(requests.length, 3, 'automatic polling waits for the active request');
  polling.stop();
  requests[2].resolve('after unmount');
  await flush();
  t.mock.timers.tick(1_000);
  polling.refresh();
  assert.equal(requests.length, 3);
  assert.deepEqual(displayed, ['newer']);
});

test('refresh clears an existing timer and stopping clears its replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const polling = startClientPolling({
    request: async () => ++calls,
    onData: () => {},
    intervalMs: () => 100,
  });
  t.after(polling.stop);
  t.mock.timers.tick(0);
  await flush();
  t.mock.timers.tick(50);
  polling.refresh();
  await flush();
  t.mock.timers.tick(50);
  assert.equal(calls, 2, 'the original timer must have been cleared');
  polling.stop();
  t.mock.timers.tick(1_000);
  assert.equal(calls, 2);
});

test('current failures retry, while cancelled failures cannot change the error or cadence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: Array<ReturnType<typeof deferred<string>>> = [];
  const errors: unknown[] = [];
  const polling = startClientPolling({
    request: () => {
      const request = deferred<string>();
      requests.push(request);
      return request.promise;
    },
    onData: () => {},
    onError: (error) => { errors.push(error); },
    intervalMs: () => 100,
  });
  t.after(polling.stop);
  t.mock.timers.tick(0);
  polling.refresh();
  requests[0].reject(new Error('cancelled old request'));
  await flush();
  assert.deepEqual(errors, []);
  const failure = new Error('temporary failure');
  requests[1].reject(failure);
  await flush();
  assert.deepEqual(errors, [failure]);
  t.mock.timers.tick(100);
  assert.equal(requests.length, 3);
  polling.stop();
  requests[2].reject(new Error('after stop'));
  await flush();
  assert.deepEqual(errors, [failure]);
});
