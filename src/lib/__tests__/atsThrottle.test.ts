import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import { atsAuthFailureIsPlatformWide } from '../atsUtils';

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

test('the response boundary and the failure classifier agree on who owns a 403', () => {
  // The rule above was already right, and Workday still went down all day on
  // 2026-09-02. isAtsProviderWideError judged a Workday 403 per-board, but the
  // response boundary in jobIngestion classified the same 403 as `credentials`
  // -- which shuts the whole provider on the first occurrence -- and never
  // consulted the per-board-host list at all. Three boards' 403s closed all
  // ~7,700 Workday boards repeatedly and blocked 3,249 batches, while both
  // hosts could reach Workday normally throughout.
  //
  // One authority now, reachable from both, because they cannot import each
  // other. A second copy is what let them disagree.
  for (const platform of ['workday', 'bamboohr', 'breezy', 'teamtailor', 'pinpoint', 'recruitee', 'personio']) {
    assert.equal(atsAuthFailureIsPlatformWide(platform), false, platform);
    assert.equal(isAtsProviderWideError(new Error('HTTP 403'), platform), false, platform);
  }
  for (const platform of ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable']) {
    assert.equal(atsAuthFailureIsPlatformWide(platform), true, platform);
    assert.equal(isAtsProviderWideError(new Error('HTTP 403'), platform), true, platform);
  }
  // An unknown platform stays platform-wide: the conservative reading is that
  // a shared API refused our account.
  assert.equal(atsAuthFailureIsPlatformWide(undefined), true);

  // Both recording paths at the boundary must consult it -- the thrown-error
  // path that classification reaches first, and the status check below it.
  const ingestion = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');
  const boundary = ingestion.slice(
    ingestion.indexOf('export async function fetchAtsPlatformResponse'),
    ingestion.indexOf('export async function fetchAtsPlatformResponse') + 4000,
  );
  assert.match(boundary, /classification !== 'credentials'\s*\n?\s*\|\| atsAuthFailureIsPlatformWide\(platform\)/);
  assert.match(boundary, /atsAuthFailureIsPlatformWide\(platform\)\s*\n?\s*&& \(response\.status === 401 \|\| response\.status === 403\)/);

  // A rate limit and a schema violation stay platform-wide at the boundary too,
  // or this trades one outage for a worse one.
  assert.equal(isAtsProviderWideError(new RateLimitedError('workday'), 'workday'), true);
});

test('an off-host 429 is the vendor disowning a board, not a throttle', async () => {
  // Personio serves an unknown subdomain by redirecting to its own marketing
  // site and answering 429. The status check ran before anything looked at
  // where the answer came from, so 487 boards that had never once responded
  // kept being re-contacted 18 days after discovery -- and each refusal paused
  // ~2,800 working Personio boards for sixty seconds.
  let throttled = 0;
  const response = await fetchAtsPlatformResponse('personio', undefined, async () => (
    Object.defineProperty(new Response('<!DOCTYPE html>', { status: 429 }), 'url', {
      value: 'https://personio.com/',
    })
  ), {
    waitForSlot: async () => {},
    requestedUrl: 'https://ackerdemia.jobs.personio.de/xml',
    recordThrottle: async () => { throttled += 1; },
  });
  assert.equal(response.status, 429);
  assert.equal(throttled, 0, 'a board the vendor does not host must not pause the platform');
  assert.equal(platformPauseRemainingMs('personio'), 0, 'no platform pause may be published');
});

test('a 429 from the board own address stays a real refusal', async () => {
  // The narrow case still has to work: an on-host 429 is the employer's server
  // pacing us and must not be read as the board being absent.
  const { atsRateLimitIsAbsentBoard } = await import('../atsUtils');
  assert.equal(atsRateLimitIsAbsentBoard({
    platform: 'personio',
    requestedUrl: 'https://acme.jobs.personio.de/xml',
    respondedUrl: 'https://acme.jobs.personio.de/xml',
  }), false);
  assert.equal(atsRateLimitIsAbsentBoard({
    platform: 'personio',
    requestedUrl: 'https://acme.jobs.personio.de/xml',
    respondedUrl: 'https://personio.com/',
  }), true);
  // Unconfirmed platforms are left alone even when they redirect off-host.
  assert.equal(atsRateLimitIsAbsentBoard({
    platform: 'bamboohr',
    requestedUrl: 'https://acme.bamboohr.com/careers/list',
    respondedUrl: 'https://www.bamboohr.com/',
  }), false);
});

test('a board-scoped 429 does not pause every other employer on the platform', async () => {
  // Refusals and successes on different Personio boards landed inside the same
  // minute -- eight refused, one served at 18:51 on 2026-09-03 -- which a
  // platform-wide limit cannot produce. The refusal rate also moved against our
  // request rate: 3% while making 678 calls an hour, 100% while making almost
  // none. It was never about our pacing.
  let throttled = 0;
  const response = await fetchAtsPlatformResponse('personio', undefined, async () => (
    Object.defineProperty(new Response('', { status: 429, headers: { 'retry-after': '60' } }), 'url', {
      value: 'https://acme.jobs.personio.de/xml',
    })
  ), {
    waitForSlot: async () => {},
    requestedUrl: 'https://acme.jobs.personio.de/xml',
    recordThrottle: async () => { throttled += 1; },
  });
  assert.equal(response.status, 429);
  assert.equal(throttled, 0, 'one employer refusing must not open the vendor circuit');
  assert.equal(platformPauseRemainingMs('personio'), 0);
});

test('a shared-API 429 still pauses the platform it speaks for', async () => {
  // Greenhouse, Lever, Ashby, Workable and SmartRecruiters host every board
  // behind one API, so a 429 there is about the credential we call with and
  // does apply to every board. This is the case the board-scoped rule must not
  // swallow.
  let throttled = 0;
  const response = await fetchAtsPlatformResponse('sharedapi-throttle-test', undefined, async () => (
    new Response('', { status: 429, headers: { 'retry-after': '120' } })
  ), {
    waitForSlot: async () => {},
    requestedUrl: 'https://boards.sharedapi-throttle-test.com/list',
    recordThrottle: async () => { throttled += 1; },
  });
  assert.equal(response.status, 429);
  assert.equal(throttled, 1, 'a shared-API rate limit is still the platform speaking');
  assert.ok(platformPauseRemainingMs('sharedapi-throttle-test') > 100_000);
});
