import assert from 'node:assert/strict';
import test from 'node:test';

import { createLatestSuccessfulSnapshot } from '../serverSnapshotCache';

test('cold callers share one load and fresh callers reuse it', async () => {
  let resolveLoad!: (value: number) => void;
  let calls = 0;
  let now = 1_000;
  const cache = createLatestSuccessfulSnapshot(
    () => {
      calls += 1;
      return new Promise<number>((resolve) => { resolveLoad = resolve; });
    },
    { freshForMs: 60_000, now: () => now },
  );

  const first = cache.get();
  const second = cache.get();
  assert.equal(calls, 1);
  resolveLoad(42);
  assert.deepEqual(await first, { value: 42, status: 'miss', ageMs: 0 });
  assert.deepEqual(await second, { value: 42, status: 'miss', ageMs: 0 });

  now += 10_000;
  assert.deepEqual(await cache.get(), { value: 42, status: 'hit', ageMs: 10_000 });
  assert.equal(calls, 1);
});

test('stale callers return immediately while one refresh replaces the snapshot', async () => {
  let now = 0;
  let value = 1;
  let calls = 0;
  let releaseRefresh!: () => void;
  const cache = createLatestSuccessfulSnapshot(
    async () => {
      calls += 1;
      if (calls > 1) await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      return value;
    },
    { freshForMs: 100, now: () => now },
  );

  await cache.get();
  now = 101;
  value = 2;
  assert.deepEqual(await cache.get(), { value: 1, status: 'stale', ageMs: 101 });
  assert.deepEqual(await cache.get(), { value: 1, status: 'stale', ageMs: 101 });
  assert.equal(calls, 2);

  releaseRefresh();
  await cache.refresh();
  assert.deepEqual(await cache.get(), { value: 2, status: 'hit', ageMs: 0 });
});

test('a failed background refresh preserves the latest successful snapshot', async () => {
  let now = 0;
  let fail = false;
  const errors: unknown[] = [];
  const cache = createLatestSuccessfulSnapshot(
    async () => {
      if (fail) throw new Error('refresh failed');
      return 'good';
    },
    { freshForMs: 10, now: () => now, onBackgroundError: (error) => errors.push(error) },
  );

  await cache.get();
  now = 11;
  fail = true;
  assert.equal((await cache.get()).value, 'good');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal((await cache.get()).value, 'good');
});
