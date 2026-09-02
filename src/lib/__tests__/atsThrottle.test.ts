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
import { AtsBoardContentTypeError, isAtsProviderWideError } from '../atsAcquisition';

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

test('a later shorter Retry-After cannot shorten an active platform pause', () => {
  const now = Date.now();
  throttlePlatform('nonshortening-test-platform', '300', now);
  throttlePlatform('nonshortening-test-platform', '60', now + 1_000);
  assert.equal(platformPauseRemainingMs('nonshortening-test-platform', now), 300_000);
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
  const scheduling = {
    waitForSlot,
    withCrossProcessLease: (action: () => Promise<Response>) => action(),
    recordThrottle: async () => {},
  };

  const listRequest = fetchAtsPlatformResponse('workable', undefined, async () => {
    starts.push('list');
    firstStarted.resolve();
    await releaseFirstResponse.promise;
    return new Response('', { status: 429, headers: { 'retry-after': '120' } });
  }, scheduling);

  await firstStarted.promise;
  const detailRequest = fetchAtsPlatformResponse('workable', undefined, async () => {
    starts.push('detail');
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }, scheduling);

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
  const scheduling = {
    waitForSlot,
    withCrossProcessLease: (action: () => Promise<Response>) => action(),
  };

  const workableRequest = fetchAtsPlatformResponse('workable', undefined, async () => {
    starts.push('workable');
    firstStarted.resolve();
    await releaseFirstResponse.promise;
    return new Response('{}', { status: 200 });
  }, scheduling);
  await firstStarted.promise;

  const greenhouseRequest = fetchAtsPlatformResponse('greenhouse', undefined, async () => {
    starts.push('greenhouse');
    return new Response('{}', { status: 200 });
  }, scheduling);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const startsBeforeWorkableFinished = [...starts];
  releaseFirstResponse.resolve();
  await Promise.all([workableRequest, greenhouseRequest]);

  assert.deepEqual(startsBeforeWorkableFinished, ['workable', 'greenhouse']);
});

test('detail response validation does not publish failures to the listing circuit', async () => {
  const detailFailure = new Error('ATS detail endpoint returned HTTP 403');
  await assert.rejects(
    fetchAtsPlatformResponse('workday', undefined, async () => (
      new Response('', { status: 403 })
    ), {
      waitForSlot: async () => {},
      recordPlatformFailures: false,
      onResponse: async () => {
        throw detailFailure;
      },
    }),
    (error: unknown) => error === detailFailure,
  );
});

test('a detail 429 keeps its local pause without publishing a listing-circuit throttle', async () => {
  let recorded = 0;
  const response = await fetchAtsPlatformResponse('detail-throttle-test', undefined, async () => (
    new Response('', { status: 429, headers: { 'retry-after': '60' } })
  ), {
    waitForSlot: async () => {},
    recordPlatformFailures: false,
    recordThrottle: async () => {
      recorded += 1;
    },
  });
  assert.equal(response.status, 429);
  assert.equal(recorded, 0);
  assert.ok(platformPauseRemainingMs('detail-throttle-test') > 50_000);
});

test('an HTML response reports a retired board rather than a JSON syntax error', () => {
  // A dead BambooHR slug answers HTTP 200 with text/html, so res.ok passes and
  // the old code surfaced "Unexpected token '<'".
  const message = 'bamboohr board returned text/html instead of JSON (board retired or access blocked)';
  assert.match(message, /retired or access blocked/);
  assert.doesNotMatch(message, /Unexpected token/);
});

test('one board answering with HTML does not open the whole platform', () => {
  // A retired BambooHR slug answers HTTP 200 with text/html. The message that
  // reported it used to end "...instead of JSON schema", and both
  // isAtsProviderWideError and classifyProviderFailure match the bare word
  // `schema` -- so a single dead board was read as BambooHR changing its API
  // and opened a six-hour provider-wide circuit across 12,233 boards.
  const boardLevel = new AtsBoardContentTypeError('bamboohr', 'text/html');
  assert.equal(isAtsProviderWideError(boardLevel), false);
  assert.doesNotMatch(boardLevel.message, /schema/i);

  // The genuinely provider-wide signals must still open the circuit, or this
  // fix would trade one failure mode for a worse one.
  assert.equal(isAtsProviderWideError(new Error('greenhouse ATS listing schema is invalid: expected an object envelope')), true);
  assert.equal(isAtsProviderWideError(new Error('HTTP 403')), true);
  assert.equal(isAtsProviderWideError(new RateLimitedError('workable')), true);
});

test('a 403 from a per-board host does not close the platform', () => {
  // Workday, BambooHR and the other per-company-host platforms put the company
  // in the URL, so a 401/403 is that company's own deployment refusing us.
  // Workday produced 403s from three boards, six times, while 702 other Workday
  // listings completed the same day -- and each closed all 7,845 for six hours.
  for (const platform of ['workday', 'bamboohr', 'breezy', 'teamtailor', 'pinpoint', 'recruitee', 'personio']) {
    assert.equal(isAtsProviderWideError(new Error('HTTP 403'), platform), false);
    assert.equal(isAtsProviderWideError(new Error('HTTP 401'), platform), false);
  }

  // Shared-API platforms keep the old behaviour: one host serves every board,
  // so a 401/403 plausibly is the platform refusing every caller.
  for (const platform of ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable']) {
    assert.equal(isAtsProviderWideError(new Error('HTTP 403'), platform), true);
  }

  // A rate limit is always the platform's, whichever board we asked about.
  assert.equal(isAtsProviderWideError(new RateLimitedError('workday'), 'workday'), true);
  // And a genuine schema violation still closes the circuit.
  assert.equal(isAtsProviderWideError(new Error('workday ATS listing schema is invalid: x'), 'workday'), true);
});
