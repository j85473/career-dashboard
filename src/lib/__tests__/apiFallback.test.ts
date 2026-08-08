import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchWithKeyRotation,
  KEY_COOLDOWN_QUOTA_MS,
  KEY_COOLDOWN_THROTTLE_MS,
  resetKeyCooldowns,
} from '../apiFallback';

const KEYS = ['key-a', 'key-b', 'key-c'];

function reply(status: number, body = '', headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

/** Records which keys were tried so rotation itself can be asserted. */
function recorder(handler: (key: string) => Response) {
  const tried: string[] = [];
  return {
    tried,
    fetchFn: async (key: string) => {
      tried.push(key);
      return handler(key);
    },
  };
}

test.beforeEach(() => resetKeyCooldowns());

test('a throttled key is rested briefly, not retired for the process lifetime', async () => {
  const now = 1_000_000;
  const { fetchFn } = recorder((key) => (key === 'key-a' ? reply(429, 'Too many requests') : reply(200, 'ok')));

  const first = await fetchWithKeyRotation(KEYS, fetchFn, 'svc', { now: () => now });
  assert.equal(first?.status, 200);

  // Still inside the cooldown: key-a must be skipped.
  const during = recorder(() => reply(200, 'ok'));
  await fetchWithKeyRotation(KEYS, during.fetchFn, 'svc', { now: () => now + KEY_COOLDOWN_THROTTLE_MS - 1 });
  assert.equal(during.tried.includes('key-a'), false);

  // Once it expires the key returns to the pool. The old code never got here.
  const after = recorder((key) => (key === 'key-a' ? reply(200, 'recovered') : reply(200, 'ok')));
  await fetchWithKeyRotation(['key-a'], after.fetchFn, 'svc', { now: () => now + KEY_COOLDOWN_THROTTLE_MS + 1 });
  assert.deepEqual(after.tried, ['key-a']);
});

test('a monthly quota rests the key for far longer than a throttle', async () => {
  const now = 2_000_000;
  const quota = 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.';
  await fetchWithKeyRotation(['key-a', 'key-b'], async (key) => (key === 'key-a' ? reply(429, quota) : reply(200, 'ok')), 'svc', { now: () => now });

  const soon = recorder(() => reply(200, 'ok'));
  await fetchWithKeyRotation(['key-a', 'key-b'], soon.fetchFn, 'svc', { now: () => now + KEY_COOLDOWN_THROTTLE_MS + 1 });
  assert.equal(soon.tried.includes('key-a'), false, 'a spent monthly quota must outlast a throttle cooldown');

  const later = recorder(() => reply(200, 'ok'));
  await fetchWithKeyRotation(['key-a'], later.fetchFn, 'svc', { now: () => now + KEY_COOLDOWN_QUOTA_MS + 1 });
  assert.deepEqual(later.tried, ['key-a']);
});

test('an explicit reset header sets the cooldown instead of the default', async () => {
  const now = 3_000_000;
  await fetchWithKeyRotation(['key-a', 'key-b'], async (key) => (
    key === 'key-a' ? reply(429, 'slow down', { 'x-ratelimit-requests-reset': '600' }) : reply(200, 'ok')
  ), 'svc', { now: () => now });

  const early = recorder(() => reply(200, 'ok'));
  await fetchWithKeyRotation(['key-a', 'key-b'], early.fetchFn, 'svc', { now: () => now + 599_000 });
  assert.equal(early.tried.includes('key-a'), false);

  const onTime = recorder(() => reply(200, 'ok'));
  await fetchWithKeyRotation(['key-a'], onTime.fetchFn, 'svc', { now: () => now + 601_000 });
  assert.deepEqual(onTime.tried, ['key-a']);
});

test('cooldowns are scoped per service, so one API cannot disable a key everywhere', async () => {
  const now = 4_000_000;
  await fetchWithKeyRotation(['key-a', 'key-b'], async (key) => (key === 'key-a' ? reply(429) : reply(200, 'ok')), 'jsearch', { now: () => now });

  const other = recorder(() => reply(200, 'ok'));
  await fetchWithKeyRotation(['key-a'], other.fetchFn, 'indeed', { now: () => now });
  assert.deepEqual(other.tried, ['key-a']);
});

test('every key cooling reports when one recovers rather than "exhausted or missing"', async () => {
  const now = 5_000_000;
  await fetchWithKeyRotation(['key-a'], async () => reply(429, 'slow down', { 'x-ratelimit-requests-reset': '120' }), 'svc', { now: () => now })
    .catch(() => {});

  await assert.rejects(
    () => fetchWithKeyRotation(['key-a'], async () => reply(200, 'ok'), 'svc', { now: () => now + 1_000 }),
    // The old message named neither the service nor a recovery time.
    /All 1 API keys for svc are cooling down; next retry in \d+[smh]\./,
  );
});

test('an empty key list is reported as configuration, not exhaustion', async () => {
  await assert.rejects(
    () => fetchWithKeyRotation([], async () => reply(200, 'ok'), 'svc'),
    /No API keys are configured\./,
  );
});

test('a transport failure moves to the next key without resting the failed one', async () => {
  const now = 6_000_000;
  const tried: string[] = [];
  const res = await fetchWithKeyRotation(['key-a', 'key-b'], async (key) => {
    tried.push(key);
    if (key === 'key-a') throw new Error('socket hang up');
    return reply(200, 'ok');
  }, 'svc', { now: () => now });

  assert.equal(res?.status, 200);
  assert.deepEqual(tried, ['key-a', 'key-b']);

  // A network blip is not the key's fault, so it stays eligible.
  const next = recorder(() => reply(200, 'ok'));
  await fetchWithKeyRotation(['key-a'], next.fetchFn, 'svc', { now: () => now + 1 });
  assert.deepEqual(next.tried, ['key-a']);
});
