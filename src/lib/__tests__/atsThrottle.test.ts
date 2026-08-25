import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchAtsPlatformResponse,
  isPermanentSourceFailure,
  IngestionInterruptedError,
  PLATFORM_THROTTLE_MS,
  platformPauseRemainingMs,
  RateLimitedError,
  throttlePlatform,
  waitForPlatformSlot,
} from '../jobIngestion';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('a 429 pauses the whole platform, not just the board that hit it', () => {
  // Pinned clock: reading the wall clock either side of the call made the
  // remaining time exceed the bound by a millisecond and flake.
  const now = Date.now();
  throttlePlatform('workable', null, now);
  const remaining = platformPauseRemainingMs('workable', now);
  assert.ok(remaining > 0 && remaining <= PLATFORM_THROTTLE_MS);
  // One platform being throttled must not slow an unrelated one.
  assert.equal(platformPauseRemainingMs('greenhouse', now), 0);
});

test('Retry-After is honoured over the default pause', () => {
  const now = Date.now();
  throttlePlatform('bamboohr', '300', now);
  const remaining = platformPauseRemainingMs('bamboohr', now);
  assert.ok(remaining > 290_000, `expected roughly 300s, got ${remaining}ms`);
});

test('an absurd Retry-After is capped rather than stalling the crawl for hours', () => {
  const now = Date.now();
  throttlePlatform('lever', '86400', now);
  assert.ok(platformPauseRemainingMs('lever', now) <= 15 * 60 * 1000);
});

test('a nonsense Retry-After falls back to the default pause', () => {
  const now = Date.now();
  throttlePlatform('ashby', 'Wed, 21 Oct 2026 07:28:00 GMT', now);
  const remaining = platformPauseRemainingMs('ashby', now);
  assert.ok(remaining > 0 && remaining <= PLATFORM_THROTTLE_MS);
});

test('being throttled is not treated as a permanent source failure', () => {
  // Workable produced 45,233 of these in a week; counting them as permanent
  // would blacklist boards that are perfectly alive.
  assert.equal(isPermanentSourceFailure(new RateLimitedError('workable')), false);
  assert.equal(isPermanentSourceFailure(new Error('HTTP 404')), true);
});

test('a platform throttle wait is interruptible by the owning pipeline', async () => {
  const controller = new AbortController();
  throttlePlatform('interruptible-test-platform', '300');
  const waiting = waitForPlatformSlot('interruptible-test-platform', controller.signal);
  controller.abort(new IngestionInterruptedError('pipeline stop'));
  await assert.rejects(waiting, /pipeline stop/);
});

test('Workable list and detail requests serialize so a 429 pauses an already-queued request', async () => {
  const firstStarted = deferred();
  const releaseFirstResponse = deferred();
  const queuedWaitStarted = deferred();
  const releaseQueuedWait = deferred();
  const starts: string[] = [];
  let workableWaits = 0;

  const waitForSlot: typeof waitForPlatformSlot = async (platform) => {
    if (platform !== 'workable') return;
    workableWaits += 1;
    if (workableWaits === 2) {
      queuedWaitStarted.resolve();
      await releaseQueuedWait.promise;
    }
  };

  const listRequest = fetchAtsPlatformResponse('workable', undefined, async () => {
    starts.push('list');
    firstStarted.resolve();
    await releaseFirstResponse.promise;
    return new Response('', { status: 429, headers: { 'retry-after': '120' } });
  }, { waitForSlot });

  await firstStarted.promise;
  const detailRequest = fetchAtsPlatformResponse('workable', undefined, async () => {
    starts.push('detail');
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }, { waitForSlot });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['list'], 'the detail request must remain queued behind the list response');

  releaseFirstResponse.resolve();
  const listResponse = await listRequest;
  assert.equal(listResponse.status, 429);
  assert.ok(platformPauseRemainingMs('workable') > 110_000, 'the 429 pause must be published before queue release');

  await queuedWaitStarted.promise;
  assert.deepEqual(starts, ['list'], 'the queued detail must wait for the newly-published pause');
  releaseQueuedWait.resolve();
  const detailResponse = await detailRequest;

  assert.equal(detailResponse.status, 200);
  assert.deepEqual(starts, ['list', 'detail']);
});

test('a paused Workable queue does not serialize an unrelated ATS platform', async () => {
  const firstStarted = deferred();
  const releaseFirstResponse = deferred();
  const starts: string[] = [];
  const waitForSlot: typeof waitForPlatformSlot = async () => {};

  const workableRequest = fetchAtsPlatformResponse('workable', undefined, async () => {
    starts.push('workable');
    firstStarted.resolve();
    await releaseFirstResponse.promise;
    return new Response('{}', { status: 200 });
  }, { waitForSlot });
  await firstStarted.promise;

  const greenhouseRequest = fetchAtsPlatformResponse('greenhouse', undefined, async () => {
    starts.push('greenhouse');
    return new Response('{}', { status: 200 });
  }, { waitForSlot });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const startsBeforeWorkableFinished = [...starts];
  releaseFirstResponse.resolve();
  await Promise.all([workableRequest, greenhouseRequest]);

  assert.deepEqual(startsBeforeWorkableFinished, ['workable', 'greenhouse']);
});

test('an HTML response reports a retired board rather than a JSON syntax error', () => {
  // A dead BambooHR slug answers HTTP 200 with text/html, so res.ok passes and
  // the old code surfaced "Unexpected token '<'".
  const message = 'bamboohr board returned text/html instead of JSON (board retired or access blocked)';
  assert.match(message, /retired or access blocked/);
  assert.doesNotMatch(message, /Unexpected token/);
});
