import assert from 'node:assert/strict';
import test from 'node:test';

import { recordDiscoveredAtsBoard } from '../atsBoardDiscovery';
import { extractAuditCandidates } from '../../../scripts/audit_ats_common_crawl';

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
