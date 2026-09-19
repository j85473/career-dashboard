import assert from 'node:assert/strict';
import test from 'node:test';

import { recordDiscoveredAtsBoard } from '../atsBoardDiscovery';
import {
  commonCrawlPageRetryDelay,
  extractAuditCandidates,
  runCooperativeAuditWork,
  runProductiveAuditBackoff,
  verifiedAuditIndexSequence,
} from '../../../scripts/audit_ats_common_crawl';

function clientWith(matches: Array<{
  slug: string;
  platform: string;
  status: string;
  excludedReason: string | null;
}>) {
  const updates: unknown[] = [];
  const creates: unknown[] = [];
  return {
    client: {
      $executeRaw: async () => 1,
      atsCompany: {
        findMany: async () => matches,
        update: async (args: unknown) => { updates.push(args); },
        create: async (args: unknown) => { creates.push(args); },
      },
    } as unknown as Parameters<typeof recordDiscoveredAtsBoard>[0],
    updates,
    creates,
  };
}

test('a permanently excluded board cannot be revived by an exact or case-only discovery', async () => {
  for (const slug of ['Acme', 'acme']) {
    const harness = clientWith([{
      slug: 'Acme',
      platform: 'greenhouse',
      status: 'excluded',
      excludedReason: 'never_relevant_geography',
    }]);
    const outcome = await recordDiscoveredAtsBoard(
      harness.client,
      { slug, platform: 'greenhouse' },
    );
    assert.equal(outcome, 'retired');
    assert.equal(harness.updates.length, 0);
    assert.equal(harness.creates.length, 0);
  }
});

test('a capitalization tombstone points at its surviving board without recreating the duplicate', async () => {
  const harness = clientWith([
    {
      slug: 'Acme',
      platform: 'ashby',
      status: 'excluded',
      excludedReason: 'Same board as acme with different capitals',
    },
    { slug: 'acme', platform: 'ashby', status: 'active', excludedReason: null },
  ]);
  const outcome = await recordDiscoveredAtsBoard(
    harness.client,
    { slug: 'ACME', platform: 'ashby' },
    new Date(),
    { reactivateExisting: false },
  );
  assert.equal(outcome, 'existing');
  assert.equal(harness.updates.length, 0);
  assert.equal(harness.creates.length, 0);
});

test('manual discovery can reactivate a parked board but not an excluded one', async () => {
  const harness = clientWith([
    { slug: 'acme', platform: 'lever', status: 'parked', excludedReason: null },
  ]);
  const outcome = await recordDiscoveredAtsBoard(
    harness.client,
    { slug: 'ACME', platform: 'lever' },
  );
  assert.equal(outcome, 'reactivated');
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.creates.length, 0);
});

test('the full audit has no 4,000-candidate ceiling', () => {
  const records = Array.from({ length: 5001 }, (_, index) => ({
    url: `https://jobs.ashbyhq.com/company-${index}/posting-${index}`,
  }));
  const candidates = extractAuditCandidates('ashby', records);
  assert.equal(candidates.length, 5001);
  assert.equal(candidates.at(-1)?.slug, 'company-5000');
});

test('Common Crawl page retries back off without acquiring a completion ceiling', () => {
  assert.equal(commonCrawlPageRetryDelay(1), 60_000);
  assert.equal(commonCrawlPageRetryDelay(2), 120_000);
  assert.equal(commonCrawlPageRetryDelay(5), 900_000);
  assert.equal(commonCrawlPageRetryDelay(50_000), 900_000);
});

test('a cooling page yields to another URL pattern before it is retried', async () => {
  let now = 0;
  let blockedAttempts = 0;
  let healthyAttempts = 0;
  let productiveWaits = 0;
  const order: string[] = [];

  await runCooperativeAuditWork(
    ['blocked', 'healthy'],
    async (item) => {
      order.push(`${item}@${now}`);
      if (item === 'blocked') {
        if (now < 60_000) {
          if (blockedAttempts === 0) {
            blockedAttempts += 1;
            return { kind: 'deferred', attempted: true, retryAt: new Date(60_000) };
          }
          return { kind: 'deferred', attempted: false, retryAt: new Date(60_000) };
        }
        blockedAttempts += 1;
        return { kind: 'complete' };
      }
      healthyAttempts += 1;
      return healthyAttempts === 1 ? { kind: 'advanced' } : { kind: 'complete' };
    },
    async (until) => {
      productiveWaits += 1;
      now = until.getTime();
    },
    () => new Date(now),
  );

  assert.ok(order.indexOf('healthy@0') < order.indexOf('blocked@60000'));
  assert.equal(blockedAttempts, 2);
  assert.equal(healthyAttempts, 2);
  assert.equal(productiveWaits, 1);
});

test('a Common Crawl backoff drains ready board validations before sleeping', async () => {
  let now = 0;
  let validationPasses = 0;
  const sleeps: number[] = [];

  await runProductiveAuditBackoff(
    new Date(60_000),
    async () => {
      validationPasses += 1;
      return validationPasses === 1 ? 50 : 0;
    },
    async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    () => now,
  );

  assert.equal(validationPasses, 2);
  assert.deepEqual(sleeps, [60_000]);
});

test('three different failed pages open a global backoff before a fourth request', async () => {
  let now = 0;
  const attempts = new Map<string, number>();
  const order: string[] = [];
  const waits: number[] = [];

  await runCooperativeAuditWork(
    ['one', 'two', 'three', 'four'],
    async (item) => {
      order.push(`${item}@${now}`);
      const count = attempts.get(item) || 0;
      attempts.set(item, count + 1);
      return count === 0
        ? { kind: 'deferred', attempted: true, retryAt: new Date(now + 60_000) }
        : { kind: 'complete' };
    },
    async (until) => {
      waits.push(until.getTime() - now);
      now = until.getTime();
    },
    () => new Date(now),
  );

  assert.equal(waits[0], 60_000);
  assert.ok(order.includes('three@0'));
  assert.equal(order.includes('four@0'), false);
  assert.ok(order.includes('four@60000'));
});

test('an existing audit can rebuild its exact catalog from immutable receipts', () => {
  const run = { indexCount: 3, targetIndexId: 'CC-MAIN-2026-34-index' };
  const receipts = [
    'CC-MAIN-2026-26-index',
    'CC-MAIN-2026-30-index',
    'CC-MAIN-2026-34-index',
  ];

  assert.deepEqual(verifiedAuditIndexSequence(run, receipts), receipts);
  assert.equal(verifiedAuditIndexSequence(run, receipts.slice(1)), null);
  assert.equal(verifiedAuditIndexSequence(run, [receipts[0], receipts[0], receipts[2]]), null);
  assert.equal(verifiedAuditIndexSequence(run, [...receipts.slice(0, 2), 'CC-MAIN-2026-38-index']), null);
});
