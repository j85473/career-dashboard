import { Client } from 'pg';
import { mkdir, open, readFile, rename, stat, statfs, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { CRAWL_ARCHIVE_DELETE_ORDER, CRAWL_ARCHIVE_TABLES, CRAWL_ARCHIVE_MAX_BYTES,
  encodeCrawlArchive, verifyCrawlArchive, readCrawlArchive,
  type ArchiveRow, type CrawlArchive } from '../src/lib/atsCrawlArchive';

export const ARCHIVE_ROOTS = ['/media/nas/career-dashboard-crawl-archive', '/mnt/backup/career-dashboard-crawl-archive'] as const;
const GIB = 1024 ** 3;
const STATE = '/var/lib/career-dashboard/crawl-archive/state.json';
const CONFIG = '/etc/career-dashboard/crawl-archive-enabled';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function saveState(state: unknown): Promise<void> {
  const file = await open(`${STATE}.tmp`, 'w', 0o640);
  try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
  finally { await file.close(); }
  await rename(`${STATE}.tmp`, STATE);
  const directory = await open(dirname(STATE), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function rootsReady(): Promise<void> {
  const [nas, backup, root] = await Promise.all(['/media/nas', '/mnt/backup', '/'].map(path => stat(path)));
  if (nas.dev === root.dev || backup.dev === root.dev || nas.dev === backup.dev) throw new Error('Two separate mounted archive disks are required');
  for (const [index, directory] of ARCHIVE_ROOTS.entries()) {
    const info = await stat(directory);
    if (info.dev !== [nas, backup][index].dev || (info.mode & 0o007)) throw new Error('Archive directory has unsafe placement or permissions');
    const disk = await statfs(directory);
    if (disk.bavail * disk.bsize < 20 * GIB + CRAWL_ARCHIVE_MAX_BYTES) throw new Error('Archive disk must retain at least 20 GiB of free space');
  }
  const database = await statfs('/mnt/nvme');
  if (database.bavail * database.bsize < 20 * GIB) throw new Error('Archival is waiting for 20 GiB of database write headroom');
}

async function jsonExpression(client: Client, table: string): Promise<string> {
  const columns = await client.query<{ attname: string }>(`SELECT attname FROM pg_attribute
    WHERE attrelid=$1::regclass AND atttypid='int8'::regtype AND attnum>0 AND NOT attisdropped`, [`"${table}"`]);
  // PostgreSQL bigint values must survive JSON/JavaScript without precision loss.
  return 'to_jsonb(t)' + columns.rows.map(({ attname }) => ` || jsonb_build_object('${attname}',t.${quote(attname)}::text)`).join('');
}

async function assertDatabaseRoundTrip(client: Client, table: string, rows: ArchiveRow[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 250) {
    const part = rows.slice(offset, offset + 250);
    // Compare native composite values, not to_jsonb(t): that conversion erases
    // the distinction between SQL NULL and a JSONB literal null. This also
    // catches JSON numbers that JavaScript cannot represent without rounding.
    const result = await client.query(`SELECT count(t.id)::int AS matched,
      count(*) FILTER (WHERE t IS DISTINCT FROM original)::int AS changed
      FROM jsonb_populate_recordset(NULL::${quote(table)},$1::jsonb) original
      LEFT JOIN ${quote(table)} t ON t.id=original.id`, [JSON.stringify(part)]);
    if (result.rows[0].matched !== part.length || result.rows[0].changed !== 0) {
      throw new Error(`Crawl archive held: ${table} cannot round-trip every native database value; source retained`);
    }
  }
}

export async function loadCrawlArchive(client: Client, batchId: string, retentionDays = 30): Promise<CrawlArchive> {
  if (!uuid.test(batchId)) throw new Error('A batch UUID is required');
  const expression = await jsonExpression(client, 'AtsIngestionBatch');
  const batch = await client.query<{ row: ArchiveRow }>(`SELECT ${expression} AS row FROM "AtsIngestionBatch" t WHERE id=$1 FOR UPDATE`, [batchId]);
  if (batch.rowCount !== 1) throw new Error('Batch does not exist');
  const archive: CrawlArchive = { version: 1, batch: batch.rows[0].row, tables: {} as CrawlArchive['tables'] };
  let bytes = Buffer.byteLength(JSON.stringify(archive.batch));
  await client.query("SET LOCAL cursor_tuple_fraction=1.0");
  for (const table of CRAWL_ARCHIVE_TABLES) {
    const expression = await jsonExpression(client, table);
    const rows: ArchiveRow[] = [];
    // A server cursor scans the batch once. Repeated UUID keyset LIMITs can
    // choose the global primary-key index and repeatedly scan unrelated crawls.
    // Sorting the JSON in PostgreSQL materializes the entire cold batch before
    // the first FETCH and can spill large payloads onto the nearly full NVMe.
    // Stream the batch index, then sort the bounded in-memory rows by identity.
    await client.query(`DECLARE crawl_archive_rows NO SCROLL CURSOR FOR
      SELECT ${expression} AS row FROM ${quote(table)} t WHERE "batchId"=$1`, [batchId]);
    try {
      while (true) {
        const result = await client.query<{ row: ArchiveRow }>('FETCH FORWARD 100 FROM crawl_archive_rows');
        for (const { row } of result.rows) {
          bytes += Buffer.byteLength(JSON.stringify(row));
          if (bytes > CRAWL_ARCHIVE_MAX_BYTES - 1024 * 1024) throw new Error('Batch exceeds the bounded archive budget; retained for streaming review');
          rows.push(row);
        }
        if (result.rows.length < 100) break;
      }
    } finally {
      // A timed-out FETCH aborts the transaction; CLOSE would otherwise mask
      // the actual held reason with "current transaction is aborted".
      await client.query('CLOSE crawl_archive_rows').catch(() => undefined);
    }
    archive.tables[table] = rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  verifyCrawlArchive(archive, Date.now(), retentionDays);
  await assertDatabaseRoundTrip(client, 'AtsIngestionBatch', [archive.batch]);
  for (const table of CRAWL_ARCHIVE_TABLES) await assertDatabaseRoundTrip(client, table, archive.tables[table]);
  return archive;
}

export async function writeArchiveCopy(root: string, location: string, bytes: Buffer, hash: string): Promise<void> {
  const filename = join(root, location);
  await mkdir(dirname(filename), { recursive: true, mode: 0o750 });
  try {
    const existing = await readFile(filename);
    assertArchiveCopy(existing, bytes, hash);
    const handle = await open(filename, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await syncArchiveParents(root, filename);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o640);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    const restored = await readFile(temporary);
    assertArchiveCopy(restored, bytes, hash);
    await rename(temporary, filename);
    await syncArchiveParents(root, filename);
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

async function syncArchiveParents(root: string, filename: string): Promise<void> {
  // Include a pre-existing copy: an earlier process may have exited between
  // rename and directory fsync, before it could publish a database receipt.
  for (const path of [dirname(filename), dirname(dirname(filename)), root]) {
    const directory = await open(path, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

function assertArchiveCopy(copy: Buffer, verifiedBytes: Buffer, hash: string): void {
  // encodeCrawlArchive validated the entire source and produced these exact
  // compressed bytes. Equality plus checksum proves the disk copy contains
  // that same complete archive without repeatedly decoding/hashing every row.
  if (createHash('sha256').update(copy).digest('hex') !== hash || !copy.equals(verifiedBytes)) {
    throw new Error('Archive copy differs from the complete verified source');
  }
}

export async function archiveOneCrawl(client: Client, batchId: string, apply: boolean,
  roots: readonly string[] = ARCHIVE_ROOTS): Promise<{ batchId: string; rows: number; archiveBytes: number; hash: string; location: string }> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='120s'");
    const archive = await loadCrawlArchive(client, batchId);
    const counts = Object.fromEntries(CRAWL_ARCHIVE_TABLES.map(table => [table, archive.tables[table].length]));
    const { bytes, hash } = encodeCrawlArchive(archive);
    const location = `v1/${String(archive.batch.createdAt).slice(0, 10)}/${batchId}-${hash}.json.gz`;
    const result = { batchId, rows: CRAWL_ARCHIVE_DELETE_ORDER.reduce((n, table) => n + counts[table], 0), archiveBytes: bytes.length, hash, location };
    if (apply) {
      if (roots.length !== 2 || roots[0] === roots[1]) throw new Error('Two independent archive destinations are required');
      for (const root of roots) await writeArchiveCopy(root, location, bytes, hash);
      // Verify both published copies again before granting this transaction its
      // narrow delete capability. Interrupted copies never change the database.
      for (const root of roots) assertArchiveCopy(await readFile(join(root, location)), bytes, hash);
      await client.query("SELECT set_config('career_dashboard.ats_v2_writer','2',true), set_config('career_dashboard.archive_batch',$1,true)", [batchId]);
      const updated = await client.query(`UPDATE "AtsIngestionBatch" SET "archiveEligibleAt"=now() AT TIME ZONE 'UTC',
        "archivePartitionDay"="processedAt"::date,"archiveLocation"=$2,"archiveContentHash"=$3,"archiveBytes"=$4,
        "archiveVerifiedAt"=now() AT TIME ZONE 'UTC' WHERE id=$1 AND "archiveVerifiedAt" IS NULL`, [batchId, location, hash, bytes.length]);
      if (updated.rowCount !== 1) throw new Error('Archive receipt was not published exactly once');
      for (const table of CRAWL_ARCHIVE_DELETE_ORDER) {
        const deleted = await client.query(`DELETE FROM ${quote(table)} WHERE "batchId"=$1`, [batchId]);
        if (deleted.rowCount !== counts[table]) throw new Error(`Archive deletion count differs for ${table}`);
      }
      await client.query('COMMIT');
    } else await client.query('ROLLBACK');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}

export async function runCrawlArchive(argv: string[]): Promise<void> {
  const mode = argv[0] || '--preview';
  if (!['--preview', '--apply', '--read'].includes(mode) || hostname() !== 'm70') throw new Error('Use --preview, --apply or --read on M70');
  const requestedId = argv[1];
  if (requestedId && !uuid.test(requestedId)) throw new Error('The optional second argument must be a batch UUID');
  const client = new Client({ host: '/var/run/postgresql', database: 'career_db', user: 'postgres', application_name: 'career-crawl-archive' });
  await client.connect();
  try {
    if (mode === '--read') {
      if (!requestedId) throw new Error('--read requires a batch UUID');
      const { rows } = await client.query('SELECT "archiveLocation","archiveContentHash","rawDisposedAt" FROM "AtsIngestionBatch" WHERE id=$1', [requestedId]);
      if (rows[0]?.rawDisposedAt) throw new Error('Raw acquisition data was permanently deleted under the completed-run retention policy; jobs and scores were preserved.');
      const archive = await readCrawlArchive(ARCHIVE_ROOTS, rows[0]?.archiveLocation, rows[0]?.archiveContentHash);
      process.stdout.write(`${JSON.stringify(archive)}\n`);
      return;
    }
    if (mode === '--apply') {
      const configuration = JSON.parse(await readFile(CONFIG, 'utf8'));
      if (configuration.retentionDays !== 30 || configuration.version !== 1) throw new Error('Archival policy is not enabled');
      await rootsReady();
      const referenceIndex = await client.query(`SELECT i.indisvalid FROM pg_index i
        WHERE i.indexrelid=to_regclass('"AtsIngestionItem_representativeObservationId_idx"')`);
      if (referenceIndex.rows[0]?.indisvalid !== true) throw new Error('The archive reference index must be ready before retiring rows');
    }
    if (!(await client.query('SELECT pg_try_advisory_lock(625301105) AS owned')).rows[0].owned) throw new Error('An archive worker is already running');
    let state: { cursor: string; priorityCount?: number | null; archivedBatches: number; archivedRows: number; archiveBytes: number; held: Array<{ batchId: string; reason: string }> } =
      { cursor: '', priorityCount: null, archivedBatches: 0, archivedRows: 0, archiveBytes: 0, held: [] };
    if (mode === '--apply' && !requestedId) {
      try { state = JSON.parse(await readFile(STATE, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    // Retire the largest eligible completed crawls first. A stable two-part
    // cursor advances past held batches too, so one bad archive cannot starve
    // all smaller crawls. A completed pass returns to newly eligible work.
    const candidates = requestedId ? [{ id: requestedId, rawObservationCount: 0 }] : (await client.query<{ id: string; rawObservationCount: number }>(`SELECT id,"rawObservationCount" FROM "AtsIngestionBatch"
      WHERE "writerMode"='v2' AND status='processed' AND "archiveVerifiedAt" IS NULL AND "operatorResetAt" IS NULL
        AND "processedAt" < (now() AT TIME ZONE 'UTC')-interval '30 days'
        AND "rawObservationCount">0 AND ($1::int IS NULL OR "rawObservationCount"<$1 OR ("rawObservationCount"=$1 AND id>$2))
      ORDER BY "rawObservationCount" DESC,id LIMIT $3`, [state.priorityCount ?? null, state.cursor, mode === '--apply' ? 1000 : 10])).rows;
    const start = Date.now();
    let completed = 0;
    for (const { id, rawObservationCount } of candidates) {
      if (Date.now() - start > 45_000) break;
      // A missing mount or exhausted shared disk stops the pass. It is not a
      // defect in an individual batch and must not advance past that batch.
      if (mode === '--apply') await rootsReady();
      state.cursor = id;
      state.priorityCount = rawObservationCount;
      if (mode === '--apply' && !requestedId) {
        // Persist the next cursor before potentially expensive work. A process
        // interruption leaves its transaction intact or rolled back, then the
        // next pass can proceed instead of retrying one oversized batch forever.
        await saveState({ ...state, updatedAt: new Date().toISOString(), attemptingBatch: id });
      }
      try {
        const result = await archiveOneCrawl(client, id, mode === '--apply');
        completed++;
        if (mode === '--apply') {
          state.archivedBatches++; state.archivedRows += result.rows; state.archiveBytes += result.archiveBytes;
        }
        if (mode !== '--apply' || requestedId) console.log(JSON.stringify(result));
      } catch (error) {
        state.held = [...state.held.slice(-49), { batchId: id, reason: String(error) }];
        console.error(JSON.stringify({ held: id, reason: String(error) }));
        if (requestedId) throw error;
      }
    }
    if (candidates.length === 0) { state.cursor = ''; state.priorityCount = null; }
    if (mode === '--apply' && !requestedId) {
      await saveState({ ...state, updatedAt: new Date().toISOString(), attemptingBatch: null });
    }
    console.log(JSON.stringify({ mode, completed, cumulativeBatches: state.archivedBatches, cumulativeRows: state.archivedRows, held: state.held.length }));
  } finally { await client.end(); }
}
