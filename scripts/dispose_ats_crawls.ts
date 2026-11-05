import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, rename, stat, statfs, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { ARCHIVE_ROOTS, loadCrawlArchive } from './archive_ats_crawls';
import { CRAWL_ARCHIVE_DELETE_ORDER, readCrawlArchive, verifyCrawlArchive } from '../src/lib/atsCrawlArchive';

const STATE = '/var/lib/career-dashboard/crawl-archive/disposal-state.json';
const POLICY = 'completed-acquisition-v1';
const GIB = 1024 ** 3;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const locationPattern = /^v1\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}-[a-f0-9]{64}\.json\.gz$/;

async function setFence(client: Client, id: string) {
  await client.query("SELECT set_config('career_dashboard.dispose_batch',$1,true)", [id]);
}

/** Deletes only the four raw acquisition tables. The summary and every job table survive. */
export async function disposeOneCrawl(client: Client, id: string, apply: boolean, roots: readonly string[] = ARCHIVE_ROOTS) {
  if (!uuid.test(id)) throw new Error('A batch UUID is required');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'; SET LOCAL idle_in_transaction_session_timeout='120s'");
    const batch = (await client.query('SELECT * FROM "AtsIngestionBatch" WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!batch) throw new Error('Batch does not exist');
    if (batch.rawDisposedAt) {
      await client.query('ROLLBACK');
      return { batchId: id, deletedRows: 0, alreadyDisposed: true, receipt: batch.rawDisposalReceipt };
    }
    if (!(await client.query('SELECT ats_completed_disposal_eligible($1) AS eligible', [id])).rows[0].eligible) {
      throw new Error('Held: newest board snapshot, recovery window, unfinished work, error, reset, or lease');
    }
    const archive = batch.archiveVerifiedAt
      ? await readCrawlArchive(roots, batch.archiveLocation, batch.archiveContentHash)
      : await loadCrawlArchive(client, id, 1, 'disposal');
    if (archive.batch.id !== id || archive.batch.slug !== batch.slug || archive.batch.platform !== batch.platform
      || archive.batch.activeLedgerGeneration !== batch.activeLedgerGeneration
      || archive.batch.rawObservationCount !== batch.rawObservationCount) throw new Error('Archived source does not match its batch');
    // An unknown lease expiry is not proof that a holder finished.
    for (const row of [archive.batch, ...archive.tables.AtsIngestionItem, ...archive.tables.AtsIngestionSegment]) {
      for (const [token, expiry] of [['leaseToken', 'leaseExpiresAt'], ['itemClaimToken', 'itemLeaseExpiresAt'], ['acquisitionClaimToken', 'acquisitionLeaseExpiresAt']]) {
        if (row[token] && (!row[expiry] || !Number.isFinite(Date.parse(String(row[expiry]))))) throw new Error('Held: lease expiry is unknown');
      }
    }
    // Finished work receipts deliberately retain their historical token while
    // clearing its expiry. Their completion timestamp ends the claim.
    if (archive.tables.AtsAcquisitionWorkReceipt.some(row => !row.finishedAt
      || !Number.isFinite(Date.parse(String(row.finishedAt))))) throw new Error('Held: acquisition work is unfinished');
    const counts = verifyCrawlArchive(archive, Date.now(), 1);
    const receipt = { version: 1, policy: POLICY, batchId: id, recoveryHours: 24,
      completedAt: archive.batch.processedAt, rawCounts: Object.fromEntries(CRAWL_ARCHIVE_DELETE_ORDER.map(table => [table, counts[table]])),
      evidenceHash: createHash('sha256').update(JSON.stringify({ batch: archive.batch,
        pages: archive.tables.AtsIngestionPage.map(row => [row.id, row.rawBodyHash]),
        segments: archive.tables.AtsIngestionSegment.map(row => [row.id, row.manifestHash]), counts })).digest('hex'),
      previousArchiveHash: batch.archiveContentHash ?? null };
    let deletedRows = 0;
    if (apply) {
      await setFence(client, id);
      await client.query('UPDATE "AtsIngestionBatch" SET "rawDisposedAt"=now() AT TIME ZONE \'UTC\',"rawDisposalReceipt"=$2::jsonb WHERE id=$1', [id, JSON.stringify(receipt)]);
    }
    for (const table of CRAWL_ARCHIVE_DELETE_ORDER) {
      const expected = batch.archiveVerifiedAt ? 0 : counts[table];
      const result = apply
        ? await client.query(`DELETE FROM "${table}" WHERE "batchId"=$1`, [id])
        : await client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "batchId"=$1`, [id]);
      const actual = apply ? result.rowCount : result.rows[0].n;
      if (actual !== expected) throw new Error(`Held: ${table} count changed`);
      deletedRows += expected;
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { batchId: id, deletedRows, alreadyDisposed: false, receipt };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}

/** Retryable after an interrupted unlink. The durable disposal receipt comes first. */
export async function deleteDisposedArchiveFiles(client: Client, id: string, roots: readonly string[] = ARCHIVE_ROOTS) {
  const b = (await client.query('SELECT * FROM "AtsIngestionBatch" WHERE id=$1', [id])).rows[0];
  if (!b?.rawDisposedAt || b.rawDisposalReceipt?.policy !== POLICY) throw new Error('A committed disposal receipt is required');
  if (!b.archiveLocation || b.rawArchiveFilesDeletedAt) return 0;
  if (roots.length !== 2 || roots[0] === roots[1] || !locationPattern.test(b.archiveLocation)
    || !b.archiveLocation.endsWith(`/${id}-${b.archiveContentHash}.json.gz`)
    || b.rawDisposalReceipt.previousArchiveHash !== b.archiveContentHash) throw new Error('Archive deletion identity differs');
  let removed = 0;
  // Check both destinations before removing either. Missing files are allowed
  // only after the committed receipt, so a crash between unlinks is retryable.
  const files: string[] = [];
  for (const root of roots) {
    if (!(await lstat(root)).isDirectory()) throw new Error('Archive root must be a real directory');
    const filename = join(root, b.archiveLocation);
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Archive path is not a regular file');
      const bytes = await readFile(filename);
      if (createHash('sha256').update(bytes).digest('hex') !== b.archiveContentHash) throw new Error('Archive checksum differs; file retained');
      files.push(filename);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const filename of files) {
    await unlink(filename); removed++;
    const directory = await open(dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  await client.query('BEGIN');
  try {
    await setFence(client, id);
    await client.query('UPDATE "AtsIngestionBatch" SET "rawArchiveFilesDeletedAt"=now() AT TIME ZONE \'UTC\' WHERE id=$1 AND "rawArchiveFilesDeletedAt" IS NULL', [id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  return removed;
}

async function saveState(state: unknown) {
  const file = await open(`${STATE}.tmp`, 'w', 0o640);
  try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
  await rename(`${STATE}.tmp`, STATE);
  const directory = await open(dirname(STATE), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function databaseReady() {
  if ((await stat('/mnt/nvme')).dev === (await stat('/')).dev) throw new Error('Database mount is missing');
  const disk = await statfs('/mnt/nvme');
  if (disk.bavail * disk.bsize < 20 * GIB) throw new Error('Disposal is waiting for database write headroom');
}
async function archiveMountsReady() {
  const root = await stat('/');
  const disks = await Promise.all(ARCHIVE_ROOTS.map(path => stat(path)));
  if (disks.some(d => d.dev === root.dev) || disks[0].dev === disks[1].dev) throw new Error('Archive disks are unavailable');
}

export async function runCrawlDisposal(argv: string[]) {
  const mode = argv[0] || '--preview';
  const requested = argv[1];
  if (hostname() !== 'm70' || !['--preview', '--apply'].includes(mode) || (requested && !uuid.test(requested))) throw new Error('Use --preview or --apply [batch UUID] on M70');
  const apply = mode === '--apply';
  if (apply) {
    const policy = JSON.parse(await readFile('/etc/career-dashboard/crawl-disposal-enabled', 'utf8'));
    if (policy.policy !== POLICY || policy.recoveryHours !== 24 || policy.keepLatestPerBoard !== true) throw new Error('Deletion policy is not enabled');
    await databaseReady();
  }
  const client = new Client({ host: '/var/run/postgresql', user: 'postgres', database: 'career_db', application_name: 'career-crawl-disposal' });
  await client.connect();
  try {
    if (!(await client.query('SELECT pg_try_advisory_lock(625301105) AS owned')).rows[0].owned) throw new Error('Another retention worker is active');
    let state: { cursor: string; priorityCount: number | null; disposedBatches: number; deletedRows: number; removedFiles: number; held: Array<{batchId: string; reason: string}> } =
      { cursor: '', priorityCount: null, disposedBatches: 0, deletedRows: 0, removedFiles: 0, held: [] };
    if (apply && !requested) {
      try { state = JSON.parse(await readFile(STATE, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const start = Date.now();
    if (apply && !requested) {
      const pending = (await client.query('SELECT id FROM "AtsIngestionBatch" WHERE "rawDisposedAt" IS NOT NULL AND "archiveLocation" IS NOT NULL AND "rawArchiveFilesDeletedAt" IS NULL ORDER BY id LIMIT 10')).rows;
      for (const { id } of pending) {
        if (Date.now() - start > 15000) break;
        try { await archiveMountsReady(); state.removedFiles += await deleteDisposedArchiveFiles(client, id); }
        catch (error) { state.held = [...state.held.slice(-49), { batchId: id, reason: String(error) }]; }
      }
    }
    const candidates = requested ? [{ id: requested, rawObservationCount: 0 }] : (await client.query(`SELECT id,"rawObservationCount" FROM "AtsIngestionBatch"
      WHERE "writerMode"='v2' AND status='processed' AND "rawDisposedAt" IS NULL AND "operatorResetAt" IS NULL
        AND "rawObservationCount">0 AND "processedAt"<(now() AT TIME ZONE 'UTC')-interval '1 day'
        AND ($1::int IS NULL OR "rawObservationCount"<$1 OR ("rawObservationCount"=$1 AND id>$2))
      ORDER BY "rawObservationCount" DESC,id LIMIT $3`, [state.priorityCount, state.cursor, requested ? 1 : 1000])).rows;
    let completed = 0;
    for (const row of candidates) {
      if (Date.now() - start > 45000) break;
      if (apply) await databaseReady();
      state.cursor = row.id; state.priorityCount = row.rawObservationCount;
      if (apply && !requested) await saveState({ ...state, updatedAt: new Date().toISOString(), attemptingBatch: row.id });
      try {
        const result = await disposeOneCrawl(client, row.id, apply);
        completed++;
        if (apply && !result.alreadyDisposed) { state.disposedBatches++; state.deletedRows += result.deletedRows; }
        if (apply) {
          try { await archiveMountsReady(); state.removedFiles += await deleteDisposedArchiveFiles(client, row.id); }
          catch (error) { state.held = [...state.held.slice(-49), { batchId: row.id, reason: String(error) }]; }
        }
        if (!apply || requested) console.log(JSON.stringify(result));
      } catch (error) {
        state.held = [...state.held.slice(-49), { batchId: row.id, reason: String(error) }];
        console.error(JSON.stringify({ held: row.id, reason: String(error) }));
        if (requested) throw error;
      }
    }
    if (!candidates.length) { state.cursor = ''; state.priorityCount = null; }
    if (apply && !requested) await saveState({ ...state, updatedAt: new Date().toISOString(), attemptingBatch: null });
    console.log(JSON.stringify({ mode, completed, disposedBatches: state.disposedBatches, deletedRows: state.deletedRows,
      removedFiles: state.removedFiles, cursor: state.cursor, recentHeld: state.held.length }));
  } finally { await client.end(); }
}
