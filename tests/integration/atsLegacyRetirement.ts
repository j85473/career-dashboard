/** Run only on an empty schema-only copy in the disposable PostgreSQL server.
 * DATABASE_URL=postgresql://ats_fixture@127.0.0.1:55479/career_ats_simplify_20261104
 * node --import tsx tests/integration/atsLegacyRetirement.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { prisma } from '../../src/lib/prisma';
import { readLegacyAtsRetirement, retireLegacyAtsWorker } from '../../src/lib/atsLegacyRetirement';

const databaseUrl = new URL(process.env.DATABASE_URL!);
assert.equal(databaseUrl.hostname, '127.0.0.1');
assert.equal(databaseUrl.port, '55479');
assert.equal(databaseUrl.username, 'ats_fixture');
assert.equal(databaseUrl.pathname, '/career_ats_simplify_20261104');
assert.ok(!process.env.DATABASE_RUNTIME_HOST);
const sql = new Client({ connectionString: databaseUrl.href });
const competitor = new Client({ connectionString: databaseUrl.href });
const releaseId = 'a'.repeat(40);
const nextDay = new Date(Date.now() + 86_400_000);

async function main() {
  await sql.connect(); await competitor.connect();
  assert.equal(await prisma.atsCompany.count(), 0, 'Use an empty schema-only copy');
  assert.equal(await prisma.job.count(), 0, 'Never run against user data');
  const saved = await prisma.job.create({ data: { title: 'Preserved job', company: 'Saved employer', source: 'fixture',
    postedAt: new Date(), status: 'applied', aimFitScore: 82, reqFitScore: 76, description: 'Original description' } });
  await sql.query(`INSERT INTO "AtsAcquisitionRuntimeGate" (id,"minimumWriterVersion","compatibilityWriterVersion",
    "v2AuthorityActivatedAt","activatedLedgerVersion","updatedAt") VALUES ('global',3,3,CURRENT_TIMESTAMP,2,CURRENT_TIMESTAMP)`);
  for (const [slug, platform] of [['saved-api', 'greenhouse'], ['saved-public', 'adp'], ['in-flight', 'lever']]) {
    await prisma.atsCompany.create({ data: { slug, platform, checkDay: 3, nextCheckDate: nextDay } });
  }
  const old = await prisma.atsIngestionBatch.create({ data: { slug: 'saved-api', platform: 'greenhouse', status: 'partial',
    payload: [{ title: 'Saved posting', description: 'Immutable download' }], jobCount: 1, nextAcquireAt: nextDay } });
  // Separate public-board work must not block or be rerouted by API retirement.
  const publicBatch = await prisma.atsIngestionBatch.create({ data: { slug: 'saved-public', platform: 'adp', status: 'partial',
    payload: [{ title: 'Public posting' }], jobCount: 1, nextAcquireAt: nextDay } });
  const before = (await sql.query(`SELECT to_jsonb(g) AS gate FROM "AtsAcquisitionRuntimeGate" g`)).rows[0].gate;
  for (const migration of ['20261104190000_ats_retry_classification', '20261104210000_ats_legacy_worker_retirement']) {
    await sql.query(readFileSync(new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8'));
  }
  const after = (await sql.query(`SELECT to_jsonb(g)-'legacyAcquisitionRetiredAt'-'legacyAcquisitionRetirementReleaseId' AS gate FROM "AtsAcquisitionRuntimeGate" g`)).rows[0].gate;
  assert.deepEqual(after, before, 'installing the migration does not activate retirement');
  assert.deepEqual(await prisma.atsIngestionBatch.findUnique({ where: { id: old.id } }), old);
  await prisma.atsAcquisitionWorkerSlot.create({ data: { slotNumber: 1, leaseToken: 'healthy-v2', workerKind: 'mac-continuation',
    releaseId, leaseOwner: 'fixture', acquiredAt: new Date(), leaseExpiresAt: nextDay, heartbeatAt: new Date() } });
  const blocked = await readLegacyAtsRetirement(prisma, releaseId);
  assert.equal(blocked.unfinished.unfinishedBatches, 1);
  await assert.rejects(retireLegacyAtsWorker(prisma, releaseId, blocked.selectionHash), /finish or explicitly convert/);
  await assert.rejects(sql.query(`UPDATE "AtsAcquisitionRuntimeGate" SET "legacyAcquisitionRetiredAt"=CURRENT_TIMESTAMP,
    "legacyAcquisitionRetirementReleaseId"=$1 WHERE id='global'`, [releaseId]), /drain before retirement/);
  assert.deepEqual(await prisma.atsIngestionBatch.findUnique({ where: { id: old.id } }), old);

  // Ordinary processing finishes the fixture's old work; retirement never does.
  await prisma.atsIngestionBatch.update({ where: { id: old.id }, data: { status: 'processed', processingOffset: 1, processedAt: new Date() } });
  const completed = await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: old.id } });
  const ready = await readLegacyAtsRetirement(prisma, releaseId);
  assert.equal(ready.ready, true);
  await assert.rejects(retireLegacyAtsWorker(prisma, releaseId, '0'.repeat(64)), /selection changed/);

  // A transaction already admitting legacy work must finish before retirement
  // obtains the gate lock. Its newly committed attempt then blocks retirement.
  await competitor.query('BEGIN');
  await competitor.query(`INSERT INTO "AtsBoardCheckAttempt" (id,slug,platform) VALUES ('racing-attempt','in-flight','lever')`);
  const raced = retireLegacyAtsWorker(prisma, releaseId, ready.selectionHash).then(
    result => ({ result, error: null }), error => ({ result: null, error }));
  let waiting = false;
  for (let i = 0; i < 100 && !waiting; i++) {
    waiting = (await sql.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%AtsAcquisitionRuntimeGate%' AND query LIKE '%FOR UPDATE%') AS waiting`)).rows[0].waiting;
    if (!waiting) await delay(20);
  }
  assert.ok(waiting, 'retirement waits for an in-flight legacy admission to commit');
  await competitor.query('COMMIT');
  const raceResult = await raced;
  assert.ok(raceResult.error, 'retirement must see committed legacy admission');
  assert.equal((await readLegacyAtsRetirement(prisma, releaseId)).retired, false);
  await sql.query(`UPDATE "AtsBoardCheckAttempt" SET outcome='succeeded' WHERE id='racing-attempt'`);

  await prisma.atsAcquisitionWorkerSlot.update({ where: { slotNumber: 1 }, data: { releaseId: 'b'.repeat(40) } });
  const mixed = await readLegacyAtsRetirement(prisma, releaseId);
  assert.equal(mixed.ready, false);
  await assert.rejects(sql.query(`UPDATE "AtsAcquisitionRuntimeGate" SET "legacyAcquisitionRetiredAt"=CURRENT_TIMESTAMP,
    "legacyAcquisitionRetirementReleaseId"=$1 WHERE id='global'`, [releaseId]), /healthy v2 worker/);
  await prisma.atsAcquisitionWorkerSlot.update({ where: { slotNumber: 1 }, data: { releaseId } });

  // SQL time comparisons stay correct in non-UTC sessions, too.
  await sql.query(`SET TIME ZONE 'America/Chicago'`);
  await sql.query(`UPDATE "AtsIngestionBatch" SET "leaseExpiresAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '1 minute' WHERE id=$1`, [old.id]);
  assert.equal((await sql.query('SELECT ats_legacy_worker_retirement_blockers() AS counts')).rows[0].counts.unfinishedBatches, 1);
  assert.equal((await readLegacyAtsRetirement(prisma, releaseId)).unfinished.unfinishedBatches, 1);
  await sql.query(`UPDATE "AtsIngestionBatch" SET "leaseExpiresAt"=NULL WHERE id=$1`, [old.id]);
  const preview = await readLegacyAtsRetirement(prisma, releaseId);
  const retired = await retireLegacyAtsWorker(prisma, releaseId, preview.selectionHash);
  assert.equal(retired.changed, true); assert.equal(retired.retired, true);
  assert.equal((await retireLegacyAtsWorker(prisma, releaseId, preview.selectionHash)).changed, false);
  await assert.rejects(sql.query(`UPDATE "AtsAcquisitionRuntimeGate" SET "legacyAcquisitionRetiredAt"=NULL,
    "legacyAcquisitionRetirementReleaseId"=NULL WHERE id='global'`), /cannot be undone/);
  await assert.rejects(sql.query(`INSERT INTO "AtsBoardCheckAttempt" (id,slug,platform) VALUES ('old-binary','in-flight','lever')`), /retired/);
  await assert.rejects(sql.query(`INSERT INTO "AtsIngestionBatch" (id,slug,platform,"updatedAt")
    VALUES ('old-batch','in-flight','lever',CURRENT_TIMESTAMP)`), /retired/);
  await assert.rejects(sql.query(`UPDATE "AtsBoardCheckAttempt" SET outcome='running' WHERE id='racing-attempt'`), /retired/);
  await assert.rejects(prisma.atsIngestionBatch.update({ where: { id: old.id }, data: { status: 'fetching' } }), /retired/);
  await assert.rejects(prisma.atsIngestionBatch.update({ where: { id: old.id }, data: { leaseToken: 'resurrected' } }), /retired/);
  const board = await prisma.atsCompany.create({ data: { slug: 'new-api', platform: 'greenhouse', checkDay: 2, nextCheckDate: nextDay } });
  assert.equal(board.acquisitionEngine, 'v2'); assert.equal(board.nextCheckDate?.getTime(), nextDay.getTime());
  await assert.rejects(prisma.atsCompany.update({ where: { slug_platform: { slug: board.slug, platform: board.platform } },
    data: { acquisitionEngine: 'legacy' } }), /retired/);
  for (const platform of ['adp', 'gusto', 'icims']) {
    const separate = await prisma.atsCompany.create({ data: { slug: `new-${platform}`, platform, checkDay: 2 } });
    assert.equal(separate.acquisitionEngine, 'legacy');
    await prisma.atsIngestionBatch.create({ data: { slug: separate.slug, platform } });
  }
  const v2 = await prisma.atsIngestionBatch.create({ data: { slug: board.slug, platform: board.platform, writerMode: 'v2', ledgerVersion: 2 } });
  assert.equal(v2.writerMode, 'v2');
  assert.deepEqual(await prisma.atsIngestionBatch.findUnique({ where: { id: old.id } }), completed);
  assert.deepEqual(await prisma.atsIngestionBatch.findUnique({ where: { id: publicBatch.id } }), publicBatch);
  assert.deepEqual(await prisma.job.findUnique({ where: { id: saved.id } }), saved);
  console.log('PASS: dormant migration, held-work refusal, concurrent admission, release checks, idempotent retirement, old-binary fencing, direct v2 routing, separate collector continuity and score/evidence preservation');
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await sql.end(); await competitor.end(); });
