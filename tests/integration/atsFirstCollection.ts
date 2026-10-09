/** Run only against a disposable database whose name begins ats_first_collection_test_. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { FIRST_COLLECTION_POLICY_ID, reserveFirstCollection, reconcileFirstCollectionCompletion,
  firstCollectionSelectionWhere, reserveJobScoreFeedRequest } from '../../src/lib/atsFirstCollectionAdmission';
import { tickFirstCollections } from '../../src/lib/atsFirstCollectionController';

const databaseUrl = process.env.ATS_FIRST_COLLECTION_TEST_DATABASE_URL || '';
if (!/^\/ats_first_collection_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname)) throw new Error('A dedicated disposable first-collection test database is required');
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
async function main() {
  // The caller creates the old committed schema first. Apply the actual additive migration.
  await db.$executeRaw`INSERT INTO "AtsCompany" (slug,platform,"checkDay") VALUES ('untouched','zohorecruit',1),('started','zohorecruit',1)`;
  await db.atsIngestionBatch.create({ data: { id: 'historical-batch', slug: 'started', platform: 'zohorecruit', status: 'processed' } });
  const migration = readFileSync('prisma/migrations/20261009020000_ats_first_collection_admission/migration.sql', 'utf8');
  // pg accepts the complete SQL migration as one query, including function bodies.
  const { Client } = await import('pg');
  const connection = new Client({ connectionString: databaseUrl });
  await connection.connect();
  try { await connection.query(migration); } finally { await connection.end(); }
  const untouched = await db.atsCompany.findUniqueOrThrow({ where: { slug_platform: { slug: 'untouched', platform: 'zohorecruit' } } });
  assert.equal(untouched.firstCollectionState, 'waiting');
  assert.equal((await db.atsCompany.findUniqueOrThrow({ where: { slug_platform: { slug: 'started', platform: 'zohorecruit' } } })).firstCollectionState, 'established');
  await db.atsAcquisitionRuntimeGate.create({ data: { id: 'global', admissionState: 'open' } });
  const boards = [{ platform: 'gem', slug: 'one' }, { platform: 'manatal', slug: 'two' }];
  for (const board of boards) {
    await db.atsCompany.create({ data: { ...board, checkDay: 1, jobsFound: 10, firstCollectionState: 'established' } });
    assert.equal((await db.atsCompany.findUniqueOrThrow({ where: { slug_platform: board } })).firstCollectionState, 'waiting', 'older/raw writers cannot insert an established new board');
    await assert.rejects(db.atsIngestionBatch.create({ data: { ...board } }), 'batch trigger rejects an unreserved first collection');
    assert.equal(await db.$transaction(tx => reserveFirstCollection(tx, board, randomUUID())), false, 'closed policy denies even a direct batch caller');
    await db.atsCompany.update({ where: { slug_platform: board }, data: { firstCollectionState: 'ready' } });
  }
  const now = new Date();
  await db.atsFirstCollectionPolicy.update({ where: { id: FIRST_COLLECTION_POLICY_ID }, data: {
    mode: 'pilot', pilotBoards: boards.map(b => `${b.platform}::${b.slug}`), healthySince: new Date(now.getTime() - 16 * 60_000), healthObservedAt: now,
  } });
  await assert.rejects(db.$transaction(async tx => {
    assert.equal(await reserveFirstCollection(tx, boards[0], 'rolled-back'), true);
    throw new Error('simulate crash before batch creation');
  }));
  assert.equal((await db.atsCompany.findUniqueOrThrow({ where: { slug_platform: boards[0] } })).firstCollectionState, 'ready');
  const results = await Promise.all(boards.map(board => db.$transaction(async tx => {
    const id = randomUUID();
    if (!await reserveFirstCollection(tx, { ...board, extraPropertyMustNotReachPrisma: true } as typeof board, id)) return null;
    return tx.atsIngestionBatch.create({ data: { id, ...board } });
  }, { timeout: 30_000 })));
  assert.equal(results.filter(Boolean).length, 1, 'two simultaneous hosts share exactly one unfinished allowance');
  const batch = results.find(Boolean)!;
  await assert.rejects(db.atsIngestionBatch.create({ data: { id: 'wrong-reservation', slug: batch.slug, platform: batch.platform } }), 'reservation is bound to the exact batch ID');
  await db.atsIngestionBatch.update({ where: { id: batch.id }, data: { status: 'synchronized', synchronizedAt: now } });
  await reconcileFirstCollectionCompletion(db);
  assert.equal((await db.atsCompany.findUniqueOrThrow({ where: { slug_platform: { slug: batch.slug, platform: batch.platform } } })).firstCollectionState, 'admitted', 'listing completion does not free admission');
  await db.atsIngestionBatch.update({ where: { id: batch.id }, data: { status: 'processed', processedAt: now, processingErrorCount: 1 } });
  await reconcileFirstCollectionCompletion(db);
  assert.equal((await db.atsCompany.findUniqueOrThrow({ where: { slug_platform: { slug: batch.slug, platform: batch.platform } } })).firstCollectionState, 'admitted', 'unresolved persistence errors retain the slot');
  await db.atsIngestionBatch.update({ where: { id: batch.id }, data: { processingErrorCount: 0 } });
  await db.atsFirstCollectionPolicy.update({ where: { id: FIRST_COLLECTION_POLICY_ID }, data: { mode: 'held' } });
  await firstCollectionSelectionWhere(db);
  assert.equal((await db.atsCompany.findUniqueOrThrow({ where: { slug_platform: { slug: batch.slug, platform: batch.platform } } })).firstCollectionState, 'established', 'successful persistence earns rotation even after the rollout is held');
  const other = boards.find(b => b.slug !== batch.slug)!;
  await db.atsFirstCollectionPolicy.update({ where: { id: FIRST_COLLECTION_POLICY_ID }, data: { mode: 'pilot', dailyBoardLimit: 1 } });
  assert.equal(await db.$transaction(tx => reserveFirstCollection(tx, other, 'daily-limit')), false, 'a completed first collection still consumes its rolling daily allowance');
  const requests = await Promise.all([reserveJobScoreFeedRequest(db, 'hourly'), reserveJobScoreFeedRequest(db, 'hourly')]);
  assert.equal(requests.filter(Boolean).length, 1, 'hourly JobScore pacing survives simultaneous processes');
  assert.equal(await reserveJobScoreFeedRequest(db, 'hourly', new Date(Date.now() + 61 * 60_000)), true);
  await db.atsFirstCollectionPolicy.update({ where: { id: FIRST_COLLECTION_POLICY_ID }, data: { dailyBoardLimit: 5, lastStagedItems: 0, lastPersistenceJobs: 0 } });
  await db.atsCompany.create({ data: { platform: 'greenhouse', slug: 'growing-existing-work', checkDay: 1 } });
  const growth = await db.atsIngestionBatch.create({ data: { platform: 'greenhouse', slug: 'growing-existing-work', writerMode: 'v2', rawObservationCount: 1 } });
  assert.equal(await db.$transaction(tx => reserveFirstCollection(tx, other, 'pressure-grew')), false, 'growth between timer observations closes admission at the exact batch transaction');
  await db.atsIngestionBatch.update({ where: { id: growth.id }, data: { status: 'processed' } });
  await db.atsCompany.update({ where: { slug_platform: other }, data: { firstCollectionState: 'waiting' } });
  const candidates = [{ platform: 'gem', slug: 'controller' }, { platform: 'jobscore', slug: 'controller-hourly' }];
  await db.atsFirstCollectionCandidate.createMany({ data: candidates });
  await db.atsFirstCollectionPolicy.update({ where: { id: FIRST_COLLECTION_POLICY_ID }, data: { mode: 'held' } });
  let validations = 0;
  const validate = async () => { validations++; await new Promise(resolve => setTimeout(resolve, 30)); return { success: true, jobsFound: 251 }; };
  await tickFirstCollections(validate, new Date(), db);
  assert.equal(validations, 0, 'closed discovery inventory performs no vendor validation');
  const healthyAt = new Date();
  await db.atsFirstCollectionPolicy.update({ where: { id: FIRST_COLLECTION_POLICY_ID }, data: {
    mode: 'pilot', dailyBoardLimit: 5, pilotBoards: candidates.map(b => `${b.platform}::${b.slug}`),
    healthySince: new Date(healthyAt.getTime() - 16 * 60_000), healthObservedAt: healthyAt, lastStagedItems: 0, lastPersistenceJobs: 0,
  } });
  await Promise.all([tickFirstCollections(validate, new Date(), db), tickFirstCollections(validate, new Date(), db)]);
  assert.equal(validations, 1, 'only one host may validate a tenant catalogue');
  assert.equal((await db.atsFirstCollectionCandidate.findUniqueOrThrow({ where: { slug_platform: candidates[0] } })).state, 'size_review');
  assert.equal(await db.atsCompany.count({ where: candidates[0] }), 0, 'an oversized catalogue never becomes a schedulable board');
  await tickFirstCollections(async () => ({ success: true, jobsFound: 3 }), new Date(), db);
  const paced = await db.atsCompany.findUniqueOrThrow({ where: { slug_platform: candidates[1] } });
  assert.equal(paced.firstCollectionState, 'ready');
  assert.ok(paced.nextCheckDate.getTime() >= Date.now() + 59 * 60_000, 'JobScore waits an hour after validation');
  console.log('First-collection migration, raw-writer fence, transaction rollback, concurrent admission, persistence completion, daily quota and hourly pacing passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
