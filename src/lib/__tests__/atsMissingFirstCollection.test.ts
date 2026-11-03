import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { catalogueMissingFirstCollectionCandidates, FIRST_COLLECTION_PLATFORMS } from '../atsFirstCollectionAdmission';
import type { Prisma } from '../prismaClient';

test('the missing-validation repair only catalogues untouched overdue boards without resetting attempts or holds', async () => {
  let captured: Prisma.Sql | undefined;
  await catalogueMissingFirstCollectionCandidates({ $executeRaw: (async (query: Prisma.Sql) => {
    captured = query; return 1;
  }) as never });
  const sql = captured!.text;
  assert.match(sql, /INSERT INTO "AtsFirstCollectionCandidate"/);
  assert.match(sql, /board\.status='active'.*board\."firstCollectionState"='waiting'/);
  for (const field of ['lastAttemptedAt', 'lastRespondedAt', 'lastCheckedAt', 'lastSynchronizedAt', 'lastProcessedAt', 'firstCollectionHoldReason', 'firstCollectionBatchId'])
    assert(sql.includes(`board."${field}" IS NULL`), field);
  for (const table of ['AtsFirstCollectionCandidate', 'AtsIngestionBatch', 'AtsBoardCheckAttempt', 'AtsEndpointSweepReceipt'])
    assert.match(sql, new RegExp(`NOT EXISTS \\(SELECT 1 FROM "${table}"`));
  assert.match(sql, /LIMIT 100\s+ON CONFLICT \(slug, platform\) DO NOTHING/);
  assert.doesNotMatch(sql, /UPDATE|DELETE|"Job"|"JobScoreEvent"/);
  assert.deepEqual(captured!.values, [...FIRST_COLLECTION_PLATFORMS]);
});

test('the handoff repair runs only after the controller proves policy and capacity permit validation', () => {
  const source = readFileSync('src/lib/atsFirstCollectionController.ts', 'utf8');
  const call = source.indexOf('await catalogueMissingFirstCollectionCandidates(tx)');
  assert(call > source.indexOf('if (!health.healthy || !firstCollectionAllowance('));
  assert(call > source.indexOf('if (policy.validationLeaseExpiresAt'));
  assert(call < source.indexOf('const next = await tx.atsFirstCollectionCandidate.findFirst'));
});
