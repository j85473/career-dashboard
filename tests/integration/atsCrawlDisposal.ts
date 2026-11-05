/** Production is a read-only fixture source. Every mutation targets an empty rehearsal database. */
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { mkdtemp, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ARCHIVE_ROOTS, loadCrawlArchive, archiveOneCrawl } from '../../scripts/archive_ats_crawls';
import { disposeOneCrawl, deleteDisposedArchiveFiles } from '../../scripts/dispose_ats_crawls';
import { CRAWL_ARCHIVE_TABLES, CRAWL_ARCHIVE_DELETE_ORDER, readCrawlArchive } from '../../src/lib/atsCrawlArchive';

const database = process.env.ATS_DISPOSAL_TEST_DATABASE || '';
assert.match(database, /^career_disposal_verify_[a-z0-9_]+$/);
const id = process.env.ATS_DISPOSAL_TEST_BATCH || '71e17333-e474-4697-a2f6-5bae827e9463';
const newerId = '11111111-2222-4333-8444-555555555555';
const connection = { host: '/var/run/postgresql', user: 'postgres' };
const source = new Client({ ...connection, database: 'career_db', application_name: 'disposal-read-only-fixture' });
const test = new Client({ ...connection, database, application_name: 'disposal-rehearsal' });
const directory = await mkdtemp(join(tmpdir(), 'career-disposal-'));
const roots = [join(directory, 'first'), join(directory, 'second')];
await source.connect(); await test.connect();
async function insert(table: string, rows: Record<string, unknown>[]) {
  for (let offset = 0; offset < rows.length; offset += 250) await test.query(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(NULL::"${table}",$1::jsonb)`, [JSON.stringify(rows.slice(offset, offset + 250))]);
}
async function rawCounts() {
  const counts: number[] = [];
  for (const table of CRAWL_ARCHIVE_DELETE_ORDER) counts.push((await test.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "batchId"=$1`, [id])).rows[0].n);
  return counts;
}
try {
  assert.equal((await test.query('SELECT count(*)::int AS n FROM "Job"')).rows[0].n, 0);
  assert.equal((await test.query('SELECT count(*)::int AS n FROM "AtsIngestionBatch"')).rows[0].n, 0);
  const receipt = (await source.query('SELECT "archiveLocation","archiveContentHash" FROM "AtsIngestionBatch" WHERE id=$1', [id])).rows[0];
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const archive = receipt.archiveLocation ? await readCrawlArchive(ARCHIVE_ROOTS, receipt.archiveLocation, receipt.archiveContentHash) : await loadCrawlArchive(source, id);
  await source.query('ROLLBACK');
  const job = (await source.query('SELECT to_jsonb(j) AS row FROM "Job" j WHERE "aimFitScore" IS NOT NULL AND EXISTS (SELECT 1 FROM "JobAttachment" a WHERE a."jobId"=j.id) LIMIT 1')).rows[0].row;
  const protectedTables = ['Job', 'JobAttachment', 'JobScoreEvent', 'JobStatusHistory', 'JobScoringStatusHistory', 'JobPipelineEvent'];
  await test.query("SET session_replication_role='replica'");
  await insert('AtsIngestionBatch', [archive.batch]);
  for (const table of CRAWL_ARCHIVE_TABLES) await insert(table, archive.tables[table]);
  await insert('Job', [job]);
  for (const table of protectedTables.slice(1)) await insert(table, (await source.query(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "jobId"=$1`, [job.id])).rows.map(r => r.row));
  await test.query("SET session_replication_role='origin'");
  const protectedSnapshot = async () => {
    const hashes: string[] = [];
    for (const table of protectedTables) hashes.push((await test.query(`SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) AS hash FROM "${table}" t`)).rows[0].hash);
    return hashes;
  };
  const protectedBefore = await protectedSnapshot();
  const before = await rawCounts();
  await assert.rejects(disposeOneCrawl(test, id, true, roots), /newest board snapshot/);
  await test.query("SET session_replication_role='replica'");
  await insert('AtsIngestionBatch', [{ ...archive.batch, id: newerId, leaseToken: null, acquisitionClaimToken: null,
    createdAt: new Date(Date.parse(String(archive.batch.createdAt) + 'Z') + 86400000).toISOString() }]);
  await test.query("SET session_replication_role='origin'");
  const setFixture = async (sql: string, values: unknown[]) => {
    await test.query("SET session_replication_role='replica'");
    try { await test.query(sql, values); } finally { await test.query("SET session_replication_role='origin'"); }
  };
  for (const update of [
    `status='synchronized'`, `"processedAt"=now() AT TIME ZONE 'UTC'`, `"processingErrorCount"=1`,
    `"leaseToken"='test-lease',"leaseExpiresAt"=NULL`,
  ]) {
    await setFixture(`UPDATE "AtsIngestionBatch" SET ${update} WHERE id=$1`, [id]);
    await assert.rejects(disposeOneCrawl(test, id, true, roots), /Held/);
    await setFixture('UPDATE "AtsIngestionBatch" SET status=\'processed\',"processedAt"=$2,"processingErrorCount"=0,"leaseToken"=NULL,"leaseExpiresAt"=NULL WHERE id=$1', [id, archive.batch.processedAt]);
    assert.deepEqual(await rawCounts(), before);
  }
  const work = archive.tables.AtsAcquisitionWorkReceipt[0];
  await setFixture('UPDATE "AtsAcquisitionWorkReceipt" SET "finishedAt"=NULL WHERE id=$1', [work.id]);
  await assert.rejects(disposeOneCrawl(test, id, true, roots), /acquisition work is unfinished/);
  await setFixture('UPDATE "AtsAcquisitionWorkReceipt" SET "finishedAt"=$2 WHERE id=$1', [work.id, work.finishedAt]);
  // A supported full run is eligible after 24h; 30-day archival is not required.
  await setFixture('UPDATE "AtsIngestionBatch" SET "processedAt"=(now() AT TIME ZONE \'UTC\')-interval \'2 days\' WHERE id=$1', [id]);
  const preview = await disposeOneCrawl(test, id, false, roots);
  assert.equal(preview.deletedRows, before.reduce((a,b) => a+b, 0));
  assert.deepEqual(await rawCounts(), before);
  for (const table of CRAWL_ARCHIVE_DELETE_ORDER) await test.query(`GRANT SELECT,DELETE ON "${table}" TO career_admin`);
  await test.query('GRANT SELECT,UPDATE ON "AtsIngestionBatch" TO career_admin');
  await test.query('SET ROLE career_admin');
  await test.query("SELECT set_config('career_dashboard.dispose_batch',$1,false)", [id]);
  await assert.rejects(test.query('DELETE FROM "AtsIngestionItem" WHERE "batchId"=$1', [id]));
  await assert.rejects(test.query('UPDATE "AtsIngestionBatch" SET "rawDisposedAt"=now(),"rawDisposalReceipt"=$2::jsonb WHERE id=$1', [id, JSON.stringify(preview.receipt)]));
  await test.query('RESET ROLE');
  await test.query(`CREATE FUNCTION fail_disposal_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated delete failure'; END; $$;
    CREATE TRIGGER fail_disposal BEFORE DELETE ON "AtsListingObservation" FOR EACH ROW EXECUTE FUNCTION fail_disposal_test()`);
  await assert.rejects(disposeOneCrawl(test, id, true, roots), /simulated delete failure/);
  assert.deepEqual(await rawCounts(), before);
  assert.equal((await test.query('SELECT "rawDisposedAt" FROM "AtsIngestionBatch" WHERE id=$1', [id])).rows[0].rawDisposedAt, null);
  await test.query('DROP TRIGGER fail_disposal ON "AtsListingObservation"');
  const deleted = await disposeOneCrawl(test, id, true, roots);
  assert.deepEqual(await rawCounts(), [0,0,0,0]);
  assert.deepEqual(await protectedSnapshot(), protectedBefore);
  assert.equal((await disposeOneCrawl(test, id, true, roots)).alreadyDisposed, true);
  assert.equal((await test.query('SELECT count(*)::int AS n FROM "AtsIngestionSegment"')).rows[0].n, archive.tables.AtsIngestionSegment.length);
  // Rebuild only the disposable rehearsal fixture to test pre-existing archives.
  await test.query("SET session_replication_role='replica'");
  await test.query('UPDATE "AtsIngestionBatch" SET "rawDisposedAt"=NULL,"rawDisposalReceipt"=NULL,"processedAt"=$2 WHERE id=$1', [id, archive.batch.processedAt]);
  for (const table of [...CRAWL_ARCHIVE_DELETE_ORDER].reverse()) await insert(table, archive.tables[table]);
  await test.query("SET session_replication_role='origin'");
  const archived = await archiveOneCrawl(test, id, true, roots);
  await assert.rejects(deleteDisposedArchiveFiles(test, id, roots), /committed disposal receipt/);
  await disposeOneCrawl(test, id, true, roots);
  const first = join(roots[0], archived.location);
  const intact = await readFile(first);
  await writeFile(first, 'corrupt');
  await assert.rejects(deleteDisposedArchiveFiles(test, id, roots), /checksum/);
  await writeFile(first, intact);
  await unlink(first); // Simulate interruption after the first unlink.
  assert.equal(await deleteDisposedArchiveFiles(test, id, roots), 1);
  assert.equal(await deleteDisposedArchiveFiles(test, id, roots), 0);
  await assert.rejects(readFile(join(roots[1], archived.location)), { code: 'ENOENT' });
  assert.deepEqual(await protectedSnapshot(), protectedBefore);
  console.log(JSON.stringify({ passed: true, deletedRows: deleted.deletedRows, protectedTables,
    checks: ['latest snapshot held','unfinished/recent/error/unknown-lease held','preview makes no changes','application role denied','failed deletion rolled back','repeat is idempotent','old archive files removed with crash retry','jobs scores histories and attachments unchanged'] }));
} finally { await source.end(); await test.end(); await rm(directory, { recursive: true, force: true }); }
