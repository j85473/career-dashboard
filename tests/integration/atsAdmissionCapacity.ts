/** Emit read-only PostgreSQL fixtures. All table names are shadowed by CTEs:
 * node --import tsx tests/integration/atsAdmissionCapacity.ts | psql -X -v ON_ERROR_STOP=1
 * Run with both UTC and the production America/Chicago session timezone.
 */
import assert from 'node:assert/strict';
import { Prisma } from '../../src/lib/prismaClient';
import { atsV2StagingSnapshot, atsV2RunnablePersistenceBacklog } from '../../src/lib/atsAcquisitionLedger';
import { firstCollectionHealth } from '../../src/lib/atsFirstCollectionAdmission';
import { atsListingAdmissionReservationSql } from '../../src/lib/atsAdmissionCapacity';

const now = new Date('2026-10-11T17:00:00Z');
const fixtures = `
"AtsIngestionBatch" AS (
  SELECT 'fixture'::text AS slug, 'workday'::text AS platform, 'v2'::text AS "writerMode",
    'fetching'::text AS status, 'listing'::text AS "acquisitionPhase", 24 AS "rawObservationCount",
    0 AS "compactedOccurrenceCount", 0 AS "publishedItemCount", 100::bigint AS "acquisitionBytes",
    'HTTP 500'::text AS "lastError", TIMESTAMP '2026-10-11 16:00' AS "nextAcquireAt",
    NULL::text AS "acquisitionClaimToken", NULL::timestamp AS "acquisitionLeaseExpiresAt",
    0 AS "jobCount", 0 AS "processingOffset", NULL::timestamp AS "nextProcessAt"
  FROM generate_series(1,40)
  UNION ALL
  SELECT 'fixture','workday','v2','fetching',phase,raw,0,0,100,err,retry,claim,lease,0,0,NULL
  FROM (VALUES
    ('listing',20,NULL::text,TIMESTAMP '2026-10-11 16:00',NULL::text,NULL::timestamp),
    ('listing',20,NULL,NULL,NULL,NULL),
    ('listing',20,NULL,TIMESTAMP '2026-10-11 18:00',NULL,NULL),
    ('listing',20,'HTTP 500',TIMESTAMP '2026-10-11 18:00','live',TIMESTAMP '2026-10-11 17:03'),
    ('listing',20,'HTTP 500',TIMESTAMP '2026-10-11 16:00','expired',TIMESTAMP '2026-10-11 16:59'),
    ('listing',0,'HTTP 500',NULL,'live-empty',TIMESTAMP '2026-10-11 17:03'),
    ('enrichment',20,NULL,NULL,NULL,NULL)
  ) AS cases(phase,raw,err,retry,claim,lease)
  UNION ALL
  SELECT 'fixture','workday','legacy',state,'listing',0,0,0,0,NULL,NULL,NULL,NULL,jobs,0,retry
  FROM (VALUES ('queued',80,TIMESTAMP '2026-10-11 16:00'),
    ('queued',2000,TIMESTAMP '2026-10-11 18:00'),
    ('processing',30,TIMESTAMP '2026-10-11 18:00'),
    ('processed',999,NULL::timestamp)) AS cases(state,jobs,retry)
),
"AtsCompany" AS (SELECT 'fixture'::text AS slug,'workday'::text AS platform,'active'::text AS status,0 AS "checkDay"),
"AtsIngestionSegment" AS (
  SELECT state AS status,items AS "itemCount",offset_ AS "processingOffset",retry AS "nextProcessAt"
  FROM (VALUES ('published',100,0,TIMESTAMP '2026-10-11 16:00'),
    ('published',50,0,NULL::timestamp),('published',2000,0,TIMESTAMP '2026-10-11 18:00'),
    ('processing',25,0,TIMESTAMP '2026-10-11 18:00'),
    ('processed',500,0,NULL::timestamp),('published',20,0,TIMESTAMP '2026-10-11 17:00'),
    ('published',10,10,NULL::timestamp)) AS cases(state,items,offset_,retry)
),
"AtsAcquisitionRuntimeGate" AS (SELECT 'global'::text AS id,'open'::text AS "admissionState")`;

function render(query: Prisma.Sql) {
  return query.text.replace(/\$(\d+)/g, (_, index) => {
    const value = query.values[Number(index) - 1];
    if (value instanceof Date) return `'${value.toISOString()}'`;
    assert.equal(typeof value, 'number');
    return String(value);
  });
}

async function capture(run: (client: never) => Promise<unknown>) {
  let captured: Prisma.Sql | undefined;
  await run({ $queryRaw: async (query: Prisma.Sql) => { captured = query; return []; } } as never);
  assert.ok(captured);
  return render(captured);
}

async function main() {
  const pressure = await capture(client => atsV2StagingSnapshot(client, now));
  const persistence = await capture(client => atsV2RunnablePersistenceBacklog(client, now));
  const health = await capture(client => firstCollectionHealth(client, 250, 5242880, now));
  const dueHealth = await capture(client => firstCollectionHealth(client, 250, 5242880, new Date('2026-10-11T18:00:00Z')));
  const telemetryPressure = render(Prisma.sql`SELECT COUNT(*) FILTER (
    WHERE ${atsListingAdmissionReservationSql(Prisma.sql`TIMESTAMP '2026-10-11 17:00:00'`)}) AS reservations
    FROM "AtsIngestionBatch" batch WHERE batch."writerMode"='v2'`);
  console.log("BEGIN READ ONLY; SET LOCAL statement_timeout='10s';");
  for (const zone of ['UTC','America/Chicago']) {
    console.log(`SET LOCAL TIME ZONE '${zone}';`);
    for (const [label, query, expected] of [
      ['failed downloads retained; only productive due listings and live claims reserve capacity',pressure,'items=1080 AND "unfinishedListings"=4 AND "cohortUnfinishedListings"=4'],
      ['publication counts due segments and every processing segment',persistence,'remaining=195'],
      ['pilot capacity excludes future holds, including legacy, while reporting all retained work',health,'items=1080 AND persistence=305 AND "totalPersistence"=4305'],
      ['held work consumes pilot capacity exactly when its retry becomes due',dueHealth,'persistence=4305 AND "totalPersistence"=4305'],
      ['operator telemetry applies the same rule using its statement UTC clock',telemetryPressure,'reservations=4'],
    ]) console.log(`WITH ${fixtures}, result AS (${query}) SELECT '${zone}: ${label}' AS fixture, 1/((${expected})::int) AS passed FROM result;`);
  }
  console.log('ROLLBACK;');
}
main().catch(error => { console.error(error); process.exitCode=1; });
