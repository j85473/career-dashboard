import assert from 'node:assert/strict';
import test from 'node:test';

import { createLatestOnlyAsyncWriter } from '../../src/lib/latestOnlyAsyncWriter';

test('a busy writer retains only the newest pending value', async () => {
  const written: number[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const writer = createLatestOnlyAsyncWriter<number>(async (value) => {
    written.push(value);
    if (value === 1) await firstBlocked;
  });

  writer.push(1);
  writer.push(2);
  writer.push(3);
  writer.push(4);
  assert.deepEqual(written, [1]);

  releaseFirst();
  await writer.waitForIdle();
  assert.deepEqual(written, [1, 4]);
});

test('a failed write does not strand the newest pending value', async () => {
  const written: number[] = [];
  const errors: string[] = [];
  const writer = createLatestOnlyAsyncWriter<number>(async (value) => {
    written.push(value);
    if (value === 1) throw new Error('first write failed');
  }, (error) => errors.push(String(error)));

  writer.push(1);
  writer.push(2);
  await writer.waitForIdle();
  assert.deepEqual(written, [1, 2]);
  assert.deepEqual(errors, ['Error: first write failed']);
});
