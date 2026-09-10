import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CASE_DUPLICATE_MIN_EVIDENCE,
  CASE_DUPLICATE_OVERLAP_FLOOR,
  chooseSurvivor,
} from '../../../scripts/consolidate_case_duplicate_ats_boards';

const source = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

function variant(overrides: Partial<Parameters<typeof chooseSurvivor>[0][number]> = {}) {
  return {
    slug: 'acme',
    platform: 'ashby',
    status: 'active',
    jobsFound: 0,
    lastCheckedAt: null,
    lastSynchronizedAt: new Date('2026-09-01T00:00:00.000Z'),
    postingCount: 0,
    ...overrides,
  };
}

test('the row kept is the one that most recently proved it is the live board', () => {
  const survivor = chooseSurvivor([
    variant({ slug: 'Acme', lastSynchronizedAt: new Date('2026-09-01T00:00:00.000Z'), postingCount: 40 }),
    variant({ slug: 'acme', lastSynchronizedAt: new Date('2026-09-08T00:00:00.000Z'), postingCount: 3 }),
  ]);
  // A recent sweep outranks a larger stale catalogue: the question is which
  // capitalisation the provider still answers on, not which one once held more.
  assert.equal(survivor?.slug, 'acme');
});

test('a group with no live row keeps every row rather than guessing', () => {
  assert.equal(chooseSurvivor([
    variant({ slug: 'Acme', status: 'excluded' }),
    variant({ slug: 'acme', status: 'parked' }),
  ]), null);
  assert.equal(chooseSurvivor([
    variant({ slug: 'Acme', lastSynchronizedAt: null }),
    variant({ slug: 'acme', lastSynchronizedAt: null }),
  ]), null);
});

test('the survivor choice is stable across runs over unchanged data', () => {
  const rows = [
    variant({ slug: 'Acme', lastSynchronizedAt: new Date('2026-09-08T00:00:00.000Z'), postingCount: 5 }),
    variant({ slug: 'acme', lastSynchronizedAt: new Date('2026-09-08T00:00:00.000Z'), postingCount: 5 }),
  ];
  assert.equal(chooseSurvivor(rows)?.slug, chooseSurvivor([...rows].reverse())?.slug);
});

/**
 * The rule this script exists to avoid. Collapsing a group because its platform
 * is "case-insensitive" would have retired 813 rows whose postings the survivor
 * has never returned -- 233 of them on Ashby, where a quarter of the groups are
 * two different companies whose names differ only in capitals.
 */
test('redundancy is proved per group by shared postings, never assumed per platform', () => {
  const script = source('scripts/consolidate_case_duplicate_ats_boards.ts');
  assert.ok(CASE_DUPLICATE_OVERLAP_FLOOR > 0.5 && CASE_DUPLICATE_OVERLAP_FLOOR <= 1);
  assert.ok(CASE_DUPLICATE_MIN_EVIDENCE >= 1);
  assert.match(script, /providerSourceId/);
  assert.match(script, /verdict: share >= CASE_DUPLICATE_OVERLAP_FLOOR \? 'retire' : 'distinct'/);
  // No platform ever appears as a condition on the retire decision.
  assert.doesNotMatch(script, /platform === '(workday|ashby|greenhouse|smartrecruiters|lever)'/);
});

test('a row that never returned a posting is reported, never retired', () => {
  const script = source('scripts/consolidate_case_duplicate_ats_boards.ts');
  assert.match(script, /variant\.postingCount < CASE_DUPLICATE_MIN_EVIDENCE/);
  assert.match(script, /verdict: 'barren'/);
});

test('writing requires the operator to echo back the hash they reviewed', () => {
  const script = source('scripts/consolidate_case_duplicate_ats_boards.ts');
  assert.match(script, /if \(!apply\) return;/);
  assert.match(script, /selectionHash !== approved/);
  assert.match(script, /No writes were attempted/);
});

/**
 * The retirement must be the whole of the write. An earlier board cleanup in
 * this repo reached past the board row and cost work that had already been
 * downloaded, so assert that nothing here touches a job, a score or a batch.
 */
test('retirement writes the board row and nothing else', () => {
  const script = source('scripts/consolidate_case_duplicate_ats_boards.ts');
  const writes = script.match(/prisma\.\w+\.(updateMany|update|deleteMany|delete|create)/g) || [];
  assert.deepEqual([...new Set(writes)], ['prisma.atsCompany.updateMany']);
});
