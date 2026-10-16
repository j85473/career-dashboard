import assert from 'node:assert/strict';
import test from 'node:test';
import { firstCollectionRetryAt, legacyMissingCareerRetryAt, missingCareerResponse } from '../atsFirstCollectionRetry';
import { tenantAtsBoardSlugFromUrl, tenantAtsBoardUrl } from '../tenantAtsBoards';
import { tickFirstCollections } from '../atsFirstCollectionController';
import { prisma } from '../prisma';

const completed = new Date('2026-10-16T12:00:00Z');
test('unavailable boards retain bounded retry dates without delaying transient failures for a month', () => {
  assert.equal(firstCollectionRetryAt('Feed HTTP 404', null, completed).toISOString(), '2026-10-23T12:00:00.000Z');
  assert.equal(firstCollectionRetryAt('Career page HTTP 410', null, completed).toISOString(), '2026-11-15T12:00:00.000Z');
  assert.equal(firstCollectionRetryAt('Feed HTTP 404', 'Career page HTTP 404', completed).toISOString(), '2026-11-15T12:00:00.000Z');
  for (const reason of ['Feed HTTP 429', 'Career page HTTP 503', 'Public career feed validation failed', undefined]) {
    assert.equal(firstCollectionRetryAt(reason, 'Feed HTTP 410', completed).toISOString(), '2026-10-17T12:00:00.000Z');
  }
  assert.equal(missingCareerResponse('Timeout fetching board-404'), null);
});

test('legacy upgrade preserves completion time and never shortens longer holds or guesses absent attempts', () => {
  const legacy = { lastError: 'Feed HTTP 404', lastValidationStartedAt: new Date('2026-10-16T11:59:59Z'),
    nextValidationAt: new Date('2026-10-17T12:00:00Z') };
  assert.equal(legacyMissingCareerRetryAt(legacy)?.toISOString(), '2026-10-23T12:00:00.000Z');
  assert.equal(legacyMissingCareerRetryAt({ ...legacy, lastError: 'Feed HTTP 410' })?.toISOString(), '2026-11-15T12:00:00.000Z');
  for (const candidate of [{ ...legacy, lastValidationStartedAt: null }, { ...legacy, lastError: 'Feed HTTP 429' },
    { ...legacy, nextValidationAt: new Date('2026-10-23T12:00:00Z') },
    { ...legacy, nextValidationAt: new Date('2026-10-16T12:00:00Z') }]) assert.equal(legacyMissingCareerRetryAt(candidate), null);
});

test('HireHive infrastructure cannot enter discovery or direct board requests; employer tenants remain valid', () => {
  for (const slug of ['accounts', 'blog', 'storage']) {
    assert.equal(tenantAtsBoardSlugFromUrl(`https://${slug}.hirehive.com/`, 'hirehive'), null);
    assert.throws(() => tenantAtsBoardUrl('hirehive', slug));
  }
  assert.equal(tenantAtsBoardSlugFromUrl('https://axonista.hirehive.com/', 'hirehive'), 'axonista');
  assert.equal(tenantAtsBoardSlugFromUrl('https://jobs.gem.com/accounts', 'gem'), 'accounts');
});

test('controller retains unavailable candidates, extends repeated failures and never fetches service hosts', async () => {
  for (const service of [false, true]) {
    const now = new Date();
    let requests = 0;
    const writes: Record<string, unknown>[] = [];
    const policy = { mode: 'capacity', maxCatalogueJobs: 250, maxResponseBytes: 5242880, maxUnfinished: 32,
      validationLeaseToken: null, validationLeaseExpiresAt: null, pilotBoards: [] };
    const candidate = { platform: service ? 'hirehive' : 'jazzhr', slug: service ? 'accounts' : 'old-board', lastError: 'Feed HTTP 404' };
    const tx = {
      $queryRaw: async () => [{ items: BigInt(0), bytes: BigInt(0), persistence: BigInt(0), totalPersistence: BigInt(0), unfinished: BigInt(0), gate: 'open' }],
      $executeRaw: async () => 0,
      atsFirstCollectionPolicy: { findUniqueOrThrow: async () => policy,
        update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(policy, data) },
      atsFirstCollectionCandidate: { findFirst: async () => candidate,
        update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); } },
      atsCompany: { count: async () => 0 },
    };
    const client = { $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx) } as unknown as typeof prisma;
    const result = await tickFirstCollections(async () => { requests++; return { success: false, reason: 'Feed HTTP 404' }; }, now, client);
    assert.equal(result.outcome, 'validation_deferred');
    assert.equal(requests, service ? 0 : 1);
    const write = writes.at(-1)!;
    assert.equal(write.state, 'discovered');
    assert.equal(write.lastError, service ? 'Vendor service address, not an employer career board' : 'Feed HTTP 404');
    assert.ok((write.nextValidationAt as Date).getTime() >= now.getTime() + 30 * 86_400_000);
    assert.ok(!Object.hasOwn(write, 'validatedAt'));
  }
});
