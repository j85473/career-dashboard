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

test('a snapshot past its serve ceiling makes the caller wait instead of answering with it', async () => {
  let now = 0;
  let value = 'morning';
  let calls = 0;
  const cache = createLatestSuccessfulSnapshot(
    async () => { calls += 1; return value; },
    { freshForMs: 100, maxServeAgeMs: 1_000, now: () => now },
  );

  await cache.get();
  // Inside the ceiling the old value still answers immediately and the rebuild
  // runs behind it. That is the whole point of the retained snapshot.
  now = 500;
  value = 'afternoon';
  assert.equal((await cache.get()).status, 'stale');

  // Past the ceiling the caller must not be handed the old reading. This is the
  // overnight case: nothing polls, the snapshot ages for hours, and the first
  // request of the morning used to receive yesterday's numbers and merely
  // trigger the refresh that corrected them.
  await cache.refresh();
  now = 10_000;
  value = 'next morning';
  const served = await cache.get();
  assert.equal(served.value, 'next morning');
  assert.equal(served.status, 'hit');
  assert.equal(served.ageMs, 0);
});

test('a snapshot past its ceiling that cannot be rebuilt is served labelled, never as current', async () => {
  let now = 0;
  let fail = false;
  const errors: unknown[] = [];
  const cache = createLatestSuccessfulSnapshot(
    async () => {
      if (fail) throw new Error('database unreachable');
      return 'good';
    },
    { freshForMs: 100, maxServeAgeMs: 1_000, now: () => now, onBackgroundError: (e) => errors.push(e) },
  );

  await cache.get();
  now = 10_000;
  fail = true;
  const served = await cache.get();
  // The retained value is still the best thing there is, so a failed load must
  // not discard it -- but it cannot come back wearing a fresh label either.
  assert.equal(served.value, 'good');
  assert.equal(served.status, 'expired');
  assert.equal(served.ageMs, 10_000);
  assert.equal(errors.length, 1);
});

test('a serve ceiling below the freshness window is rejected outright', () => {
  assert.throws(
    () => createLatestSuccessfulSnapshot(async () => 1, { freshForMs: 1_000, maxServeAgeMs: 1_000 }),
    /maxServeAgeMs/,
  );
  // Omitting the ceiling keeps the old unbounded behaviour for callers that
  // genuinely want it, rather than silently changing them.
  assert.doesNotThrow(() => createLatestSuccessfulSnapshot(async () => 1, { freshForMs: 1_000 }));
});
