/** Run only in a disposable database prepared with the current Prisma schema. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { FIRST_COLLECTION_POLICY_ID, firstCollectionCounts, reserveFirstCollection,
  reserveJobScoreFeedRequest } from '../../src/lib/atsFirstCollectionAdmission';
import { tickFirstCollections } from '../../src/lib/atsFirstCollectionController';

const databaseUrl = process.env.ATS_FIRST_COLLECTION_TEST_DATABASE_URL || '';
if (!/^\/ats_first_collection_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname)) throw new Error('A dedicated disposable database is required');
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
async function main() {
  const sql = new Client({ connectionString: databaseUrl });
  await sql.connect();
  try {
    const original = readFileSync('prisma/migrations/20261009020000_ats_first_collection_admission/migration.sql', 'utf8');
    // Apply the production checks and raw-writer fences to the disposable current schema.
    await sql.query(`ALTER TABLE "AtsFirstCollectionPolicy"
      ADD CONSTRAINT "AtsFirstCollectionPolicy_mode_check" CHECK (mode IN ('held','pilot','ramp')),
      ADD CONSTRAINT "AtsFirstCollectionPolicy_dailyBoardLimit_check" CHECK ("dailyBoardLimit" BETWEEN 1 AND 100),
      ADD CONSTRAINT "AtsFirstCollectionPolicy_maxUnfinished_check" CHECK ("maxUnfinished" BETWEEN 1 AND 8)`);
    await sql.query(original.slice(original.indexOf('CREATE FUNCTION ats_first_collection_board_guard()')));
    await db.atsFirstCollectionPolicy.create({ data: { id: FIRST_COLLECTION_POLICY_ID, mode: 'held' } });
    await sql.query(readFileSync('prisma/migrations/20261011220000_ats_first_collection_capacity/migration.sql', 'utf8'));
    assert.equal((await db.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: FIRST_COLLECTION_POLICY_ID } })).mode, 'held', 'migration does not change the operator mode');
    await assert.rejects(sql.query(`UPDATE "AtsFirstCollectionPolicy" SET mode='pilot',"dailyBoardLimit"=0`));
  } finally { await sql.end(); }
  await db.atsAcquisitionRuntimeGate.create({ data: { id: 'global', admissionState: 'open' } });
  await db.atsFirstCollectionPolicy.update({ where: { id: FIRST_COLLECTION_POLICY_ID }, data: {
    mode: 'capacity', dailyBoardLimit: 0, maxUnfinished: 32, healthySince: null,
    healthObservedAt: null, lastStagedItems: 0, lastPersistenceJobs: 0,
  } });
  const candidates = Array.from({ length: 8 }, (_, i) => ({ platform: 'gem', slug: `capacity-${i}` }));
  await db.atsFirstCollectionCandidate.createMany({ data: candidates });
  let calls = 0;
  for (let i = 0; i < 8; i++) await tickFirstCollections(async () => { calls++; return { success: true, jobsFound: 10 }; }, new Date(), db);
  assert.equal(calls, 8, 'more than five validations run and multiple boards wait ready');
  assert.equal(await db.atsCompany.count({ where: { firstCollectionState: 'ready' } }), 8);
  const starts = await Promise.all(candidates.map((board, i) => db.$transaction(async tx => {
    const id = `capacity-batch-${i}`;
    if (!await reserveFirstCollection(tx, board, id)) return false;
    await tx.atsIngestionBatch.create({ data: { id, ...board, writerMode: 'v2', rawObservationCount: 10 } });
    return true;
  }, { timeout: 30_000 })));
  assert.equal(starts.filter(Boolean).length, 8, 'all eight workers can admit first collections despite growing staging');
  assert.equal((await firstCollectionCounts(db, new Date(), true)).unfinished, 8);
  await db.atsIngestionBatch.updateMany({ data: { nextAcquireAt: new Date(Date.now() + 3600000), lastError: 'temporary provider hold' } });
  assert.equal((await firstCollectionCounts(db, new Date(), true)).unfinished, 0, 'future-held work does not consume productive refill slots');
  assert.equal(await db.atsCompany.count({ where: { firstCollectionState: 'admitted' } }), 8, 'retry-held work remains admitted and durable');
  await db.atsIngestionBatch.updateMany({ data: { nextAcquireAt: new Date(Date.now() - 1) } });
  assert.equal((await firstCollectionCounts(db, new Date(), true)).unfinished, 8, 'due retries consume capacity again');
  const extra = { platform: 'gem', slug: 'blocked-by-pressure' };
  await db.atsCompany.create({ data: { ...extra, checkDay: 1 } });
  await db.atsCompany.update({ where: { slug_platform: extra }, data: { firstCollectionState: 'ready' } });
  await db.atsIngestionBatch.update({ where: { id: 'capacity-batch-0' }, data: { rawObservationCount: 50000 } });
  assert.equal(await db.$transaction(tx => reserveFirstCollection(tx, extra, 'pressure')), false, 'staging pressure still blocks an exact concurrent admission');
  const before = calls;
  await tickFirstCollections(async () => { calls++; return { success: true, jobsFound: 1 }; }, new Date(), db);
  assert.equal(calls, before, 'validation pauses while staging is full');
  await db.atsIngestionBatch.updateMany({ data: { rawObservationCount: 0 } });
  await db.atsAcquisitionRuntimeGate.update({ where: { id: 'global' }, data: { admissionState: 'draining' } });
  assert.equal(await db.$transaction(tx => reserveFirstCollection(tx, extra, 'paused')), false, 'operator admission pause still controls starts');
  await db.atsAcquisitionRuntimeGate.update({ where: { id: 'global' }, data: { admissionState: 'open' } });
  assert.equal(await db.$transaction(tx => reserveFirstCollection(tx, extra, 'refilled')), true, 'room becoming available immediately permits refill');
  await assert.rejects(db.atsIngestionBatch.create({ data: { id: 'wrong-id', ...extra } }), 'raw writer cannot bypass the exact batch reservation');
  const hourly = await Promise.all([reserveJobScoreFeedRequest(db, 'paced'), reserveJobScoreFeedRequest(db, 'paced')]);
  assert.equal(hourly.filter(Boolean).length, 1, 'provider-specific hourly pacing remains durable');
  console.log('Capacity migration, eight simultaneous starts, growth tolerance, held retry preservation, pressure stop/refill, operator pause and provider pacing passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
