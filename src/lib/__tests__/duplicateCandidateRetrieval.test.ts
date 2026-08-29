import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DUPLICATE_CANDIDATE_LIMIT,
  isConservativeSyndicatedDuplicate,
  isSyndicatorCompany,
  mergeDuplicateCandidates,
  SYNDICATOR_COMPANY_NAMES,
} from '../jobIngestion';

type Row = { id: string; createdAt: Date };

const rowAt = (id: string, minutesAgo: number): Row => ({
  id,
  createdAt: new Date(Date.UTC(2026, 7, 29) - minutesAgo * 60_000),
});

/** The single ordered read the split branches replaced. */
function globalTopMatches(rows: readonly Row[], matches: ReadonlyArray<(row: Row) => boolean>) {
  return rows
    .filter((row) => matches.some((predicate) => predicate(row)))
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, DUPLICATE_CANDIDATE_LIMIT);
}

function branchReads(rows: readonly Row[], matches: ReadonlyArray<(row: Row) => boolean>) {
  return matches.map((predicate) => rows
    .filter(predicate)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, DUPLICATE_CANDIDATE_LIMIT));
}

test('split branch reads reproduce the single ordered candidate query exactly', () => {
  // Deterministic pseudo-random membership across five overlapping branches,
  // deliberately oversubscribed so every branch alone exceeds the bound.
  const rows = Array.from({ length: 600 }, (_, index) => rowAt(`job-${index}`, index));
  let seed = 7;
  const nextBit = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % 5 === 0;
  };
  const membership = rows.map(() => Array.from({ length: 5 }, nextBit));
  const matches = Array.from({ length: 5 }, (_, branch) => (row: Row) => {
    const index = rows.findIndex((candidate) => candidate.id === row.id);
    return membership[index][branch];
  });

  const merged = mergeDuplicateCandidates(branchReads(rows, matches));
  assert.deepEqual(merged.map((row) => row.id), globalTopMatches(rows, matches).map((row) => row.id));
  assert.equal(merged.length, DUPLICATE_CANDIDATE_LIMIT);
});

test('merging keeps newest-first order and never repeats a row matched by several branches', () => {
  const older = rowAt('older', 30);
  const newer = rowAt('newer', 10);
  const merged = mergeDuplicateCandidates([[older, newer], [newer], [older], []]);
  assert.deepEqual(merged.map((row) => row.id), ['newer', 'older']);
});

test('an empty branch set yields no candidates rather than throwing', () => {
  assert.deepEqual(mergeDuplicateCandidates([[], [], []]), []);
});

test('the syndicator retrieval filter can only prune rows the predicate rejects', () => {
  // Retrieval uses `contains`; the predicate uses a word boundary. Every name
  // the predicate accepts must therefore still be retrievable by substring.
  for (const name of SYNDICATOR_COMPANY_NAMES) {
    assert.equal(isSyndicatorCompany(`${name} Inc`), true, name);
    assert.equal(`${name} inc`.toLowerCase().includes(name), true, name);
  }
  assert.equal(isSyndicatorCompany('Acme Corp'), false);
  assert.equal(isSyndicatorCompany(null), false);
  // A substring that is not a whole word is retrieved but still rejected.
  assert.equal(isSyndicatorCompany('Lensacraft Optics'), false);
});

test('syndicated collapse still requires a syndicator on one side and an exact description', () => {
  const description = 'x'.repeat(400);
  const employer = { title: 'Sales Director', company: 'Acme', description };
  assert.equal(isConservativeSyndicatedDuplicate(employer, { ...employer, company: 'Beta' }), false);
  assert.equal(
    isConservativeSyndicatedDuplicate({ ...employer, company: 'Lensa' }, employer),
    true,
  );
  assert.equal(
    isConservativeSyndicatedDuplicate(
      { ...employer, company: 'Lensa' },
      { ...employer, description: 'y'.repeat(400) },
    ),
    false,
  );
});

test('the deduper reads each identity through its own index, never one mixed OR', () => {
  const source = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  const deduper = source.slice(
    source.indexOf('export async function findLikelyDuplicateJob'),
    source.indexOf('const ESCAPED_MARKUP_RESIDUE'),
  );
  // A mixed OR over postingIdentity/canonicalUrl/fingerprint/title cannot be
  // served by a bitmap and reverts to scanning the whole retention window.
  assert.equal(/OR:\s*\[\s*\.\.\.\(postingIdentity/.test(deduper), false);
  assert.match(deduper, /Promise\.all\(\[/);
  // ILIKE on canonicalUrl cannot use any index on that column.
  assert.equal(/canonicalUrl:\s*\{\s*equals:[^}]*insensitive/.test(deduper), false);
  assert.match(source, /lower\("canonicalUrl"\)\s*=\s*lower\(/);
});

test('the expression index the canonical-URL lookup depends on is owned by a migration', () => {
  const migration = readFileSync(
    'prisma/migrations/20260829180000_job_dedupe_canonical_url_lower_index/migration.sql',
    'utf8',
  );
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "Job_canonicalUrl_lower_idx"/);
  assert.match(migration, /lower\("canonicalUrl"\)/);
  // An expression index the planner has no statistics for is not merely
  // unused; it loses to a plan worse than the scan this replaces.
  assert.match(migration, /ANALYZE "Job";/);
  // Prisma cannot express the index, so the model must point at the migration.
  assert.match(readFileSync('prisma/schema.prisma', 'utf8'), /Job_canonicalUrl_lower_idx/);
});
