/** Run against an empty schema-only rehearsal database, never production. */
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveOneCrawl, loadCrawlArchive } from '../../scripts/archive_ats_crawls';
import { CRAWL_ARCHIVE_TABLES, CRAWL_ARCHIVE_DELETE_ORDER, readCrawlArchive } from '../../src/lib/atsCrawlArchive';

const database = process.env.ATS_ARCHIVE_TEST_DATABASE || '';
assert.match(database, /^career_archive_verify_[a-z0-9_]+$/);
const batchId = process.env.ATS_ARCHIVE_TEST_BATCH || '71e17333-e474-4697-a2f6-5bae827e9463';
const connection = { host: '/var/run/postgresql', user: 'postgres' };
const source = new Client({ ...connection, database: 'career_db', application_name: 'archive-read-only-rehearsal-source' });
const test = new Client({ ...connection, database, application_name: 'archive-rehearsal' });
await source.connect(); await test.connect();
const directory = await mkdtemp(join(tmpdir(), 'career-archive-integration-'));
const roots = [join(directory, 'first'), join(directory, 'second')];
async function insertRows(table: string, rows: Record<string, unknown>[]) {
  for (let offset = 0; offset < rows.length; offset += 250) {
    await test.query(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(NULL::"${table}",$1::jsonb)`,
      [JSON.stringify(rows.slice(offset, offset + 250))]);
  }
}
try {
  assert.equal((await test.query('SELECT count(*)::int AS n FROM "AtsIngestionBatch"')).rows[0].n, 0);
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const archive = await loadCrawlArchive(source, batchId);
  await source.query('ROLLBACK');
  const sourceJob = (await source.query('SELECT to_jsonb(t) AS row FROM "Job" t WHERE "aimFitScore" IS NOT NULL LIMIT 1')).rows[0].row;
  await test.query("SET session_replication_role='replica'");
  await test.query('INSERT INTO "AtsIngestionBatch" SELECT * FROM jsonb_populate_record(NULL::"AtsIngestionBatch",$1::jsonb)', [JSON.stringify(archive.batch)]);
  for (const table of CRAWL_ARCHIVE_TABLES) await insertRows(table, archive.tables[table]);
  await test.query('INSERT INTO "Job" SELECT * FROM jsonb_populate_record(NULL::"Job",$1::jsonb)', [JSON.stringify(sourceJob)]);
  await test.query("SET session_replication_role='origin'");
  const scoreBefore = (await test.query('SELECT md5(to_jsonb(t)::text) AS hash FROM "Job" t')).rows;
  const rawCounts = async () => {
    const counts = [];
    for (const table of CRAWL_ARCHIVE_DELETE_ORDER) counts.push(
      (await test.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "batchId"=$1`, [batchId])).rows[0].n);
    return counts;
  };
  const before = await rawCounts();
  // Values that a JSON/JavaScript round-trip would change must remain online.
  for (const metadata of ['null', '{"exact":9007199254740993}']) {
    await test.query("SET session_replication_role='replica'");
    await test.query('UPDATE "AtsIngestionBatch" SET metadata=$1::jsonb', [metadata]);
    await test.query("SET session_replication_role='origin'");
    await assert.rejects(archiveOneCrawl(test, batchId, true, roots), /cannot round-trip/);
    assert.deepEqual(await rawCounts(), before);
  }
  await test.query("SET session_replication_role='replica'");
  await test.query('UPDATE "AtsIngestionBatch" SET metadata=(jsonb_populate_record(NULL::"AtsIngestionBatch",$1::jsonb)).metadata', [JSON.stringify(archive.batch)]);
  await test.query("SET session_replication_role='origin'");
  for (const table of CRAWL_ARCHIVE_DELETE_ORDER) await test.query(`GRANT SELECT,DELETE ON "${table}" TO career_admin`);
  await test.query('GRANT SELECT ON "AtsIngestionBatch" TO career_admin');
  await test.query('SET ROLE career_admin');
  await test.query("SELECT set_config('career_dashboard.archive_batch',$1,false)", [batchId]);
  await assert.rejects(test.query('DELETE FROM "AtsIngestionItem" WHERE "batchId"=$1', [batchId]), { code: '55000' });
  await test.query('RESET ROLE');
  const failedRoot = join(directory, 'not-a-directory');
  await writeFile(failedRoot, 'Simulated unavailable second archive destination');
  await assert.rejects(archiveOneCrawl(test, batchId, true, [roots[0], failedRoot]));
  assert.deepEqual(await rawCounts(), before, 'failed second archive copy changed source rows');
  assert.equal((await test.query('SELECT "archiveVerifiedAt" FROM "AtsIngestionBatch"')).rows[0].archiveVerifiedAt, null);
  const result = await archiveOneCrawl(test, batchId, true, roots);
  assert.deepEqual(await rawCounts(), [0, 0, 0, 0]);
  assert.deepEqual((await test.query('SELECT md5(to_jsonb(t)::text) AS hash FROM "Job" t')).rows, scoreBefore);
  assert.equal((await test.query('SELECT count(*)::int AS n FROM "AtsIngestionSegment"')).rows[0].n, archive.tables.AtsIngestionSegment.length);
  for (const root of roots) assert.deepEqual(await readCrawlArchive([root], result.location, result.hash), archive);
  await assert.rejects(archiveOneCrawl(test, batchId, true, roots), /archived/);
  // Reconstruct every retired row in the isolated database and compare all
  // native PostgreSQL values, including dates, JSON and bigint fields.
  for (const table of [...CRAWL_ARCHIVE_DELETE_ORDER].reverse()) {
    await insertRows(table, archive.tables[table]);
    for (let offset = 0; offset < archive.tables[table].length; offset += 250) {
      const original = archive.tables[table].slice(offset, offset + 250);
      const comparison = await test.query(`SELECT count(*)::int AS n, bool_and(t IS NOT DISTINCT FROM original) AS same
        FROM jsonb_populate_recordset(NULL::"${table}",$1::jsonb) original JOIN "${table}" t USING(id)`, [JSON.stringify(original)]);
      assert.equal(comparison.rows[0].n, original.length);
      assert.equal(comparison.rows[0].same, true, `Restored ${table} rows differ`);
    }
  }
  assert.deepEqual(await rawCounts(), before);
  console.log(JSON.stringify({ passed: true, batchId, archivedRows: result.rows,
    checks: ['lossy JSON null/large numbers held', 'application deletion refused', 'failed copy rolled back', 'two complete copies verified', 'scores preserved', 'every archived column restored'] }));
} finally {
  await source.end(); await test.end(); await rm(directory, { recursive: true, force: true });
}
