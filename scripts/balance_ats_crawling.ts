import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NON_API_ATS_PLATFORMS } from '../src/lib/browserAtsBoards';
import { CRAWL_PENDING_DISCOVERY_SQL, planCrawlingRotation, type CrawlRotationBoard, type CrawlCycleRun } from '../src/lib/atsCrawlingRotation';
import { Prisma, type PrismaClient } from '../src/lib/prismaClient';
import { prisma } from '../src/lib/prisma';

export const CRAWLING_ROTATION_LOCK = 'ats-crawling-first-week-reservations-v1';
const sources = NON_API_ATS_PLATFORMS.map(platform => platform === 'gusto' ? 'Gusto' : `ATS-${platform}`);
const openWork = Prisma.sql`EXISTS (SELECT 1 FROM "AtsIngestionBatch" batch WHERE batch.slug=board.slug AND batch.platform=board.platform
  AND (batch.status IN ('fetching','partial','queued','processing','synchronized','reset_synchronized','reset_draining')
    OR batch."leaseExpiresAt">clock.now_utc OR batch."acquisitionLeaseExpiresAt">clock.now_utc))`;
const liveTask = Prisma.sql`EXISTS (SELECT 1 FROM "IngestionTask" task
  WHERE task.source=CASE WHEN board.platform='gusto' THEN 'Gusto' ELSE 'ATS-'||board.platform END
    AND task."ingestionMode"='public-board' AND task."leaseToken" IS NOT NULL AND task."leaseExpiresAt">clock.now_utc)`;

export function crawlingRotationSnapshotSql(now: Date): Prisma.Sql {
  return Prisma.sql`WITH clock AS (SELECT ${now.toISOString()}::timestamp AS now_utc)
    SELECT board.slug,board.platform,board.status,board."checkDay",board."jobsFound",board."failCount",board."retryCount",
      board."nextCheckDate",board."discoveredAt",board."lastAttemptedAt",board."lastRespondedAt",board."lastCheckedAt",board."lastSynchronizedAt",board."lastProcessedAt",board."rotationMovedAt",
      EXISTS (SELECT 1 FROM "AtsBrowserSweep" sweep WHERE sweep.slug=board.slug AND sweep.platform=board.platform) AS "hasSweep",
      ${openWork} AS "hasOpenWork",${liveTask} AS "taskLeased"
    FROM "AtsCompany" board CROSS JOIN clock
    WHERE board.platform IN (${Prisma.join(NON_API_ATS_PLATFORMS)}) AND board.status IN ('active','parked')
    ORDER BY board.platform,board.slug`;
}

export function crawlingRotationApplySql(assignments: ReturnType<typeof planCrawlingRotation>['assignments'], now: Date): Prisma.Sql {
  return Prisma.sql`WITH clock AS (SELECT ${now.toISOString()}::timestamp AS now_utc),
    selected AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(assignments)}::jsonb) AS entry(
      slug text,platform text,status text,"discoveredAt" timestamp,"fromDay" integer,"toDay" integer,
      "fromNextCheckDate" timestamp,"nextCheckDate" timestamp))
    UPDATE "AtsCompany" board SET "checkDay"=selected."toDay","nextCheckDate"=selected."nextCheckDate","rotationMovedAt"=clock.now_utc
    FROM selected CROSS JOIN clock
    WHERE board.slug=selected.slug AND board.platform=selected.platform AND board.status=selected.status
      AND board.platform IN (${Prisma.join(NON_API_ATS_PLATFORMS)}) AND board.status IN ('active','parked')
      AND board."checkDay"=selected."fromDay" AND board."nextCheckDate"=selected."fromNextCheckDate"
      AND board."discoveredAt"=selected."discoveredAt" AND board."nextCheckDate"<=clock.now_utc
      AND board."lastAttemptedAt" IS NULL AND board."lastRespondedAt" IS NULL AND board."lastSynchronizedAt" IS NULL
      AND board."lastCheckedAt" IS NULL AND board."lastProcessedAt" IS NULL AND board."rotationMovedAt" IS NULL
      AND (board."failCount"=0 OR ${Prisma.raw(CRAWL_PENDING_DISCOVERY_SQL)}) AND board."retryCount"=0
      AND selected."toDay" BETWEEN 0 AND 6 AND selected."nextCheckDate">=clock.now_utc
      AND selected."nextCheckDate"<=clock.now_utc+INTERVAL '7 days'
      AND NOT EXISTS (SELECT 1 FROM "AtsBrowserSweep" sweep WHERE sweep.slug=board.slug AND sweep.platform=board.platform)
      AND NOT ${openWork} AND NOT ${liveTask}
    RETURNING board.slug,board.platform,board."checkDay",board."nextCheckDate"`;
}

export async function readCrawlingRotationSnapshot(client: PrismaClient, now = new Date()) {
  return client.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout='45s'`;
    const boards = await tx.$queryRaw<CrawlRotationBoard[]>(crawlingRotationSnapshotSql(now));
    const runs = await tx.ingestionSourceRun.findMany({
      where: { source: { in: sources }, ingestionMode: 'public-board', createdAt: { gte: new Date(now.valueOf() - 30 * 86_400_000) }, finishedAt: { lte: now } },
      select: { source: true, startedAt: true, finishedAt: true, durationMs: true, seenCount: true, reconciled: true, checkpoint: true },
      orderBy: [{ source: 'asc' }, { startedAt: 'asc' }],
    });
    return { observedAt: now, boards, runs };
  }, { timeout: 50_000 });
}

export async function applyCrawlingRotation(client: PrismaClient, plan: ReturnType<typeof planCrawlingRotation>, now = new Date()) {
  if (now.valueOf() < plan.observedAt.valueOf() || now.valueOf() - plan.observedAt.valueOf() > 5 * 60_000) throw Error('Crawling rotation selection is stale; make a fresh preview.');
  if (!plan.assignments.length) return [];
  return client.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL lock_timeout='3s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout='25s'`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CRAWLING_ROTATION_LOCK},0))`;
    // Task claims update these same rows. Take locks before checking live leases
    // so a concurrently starting provider cannot silently pass the lease guard.
    await tx.$queryRaw`SELECT id FROM "IngestionTask" WHERE source IN (${Prisma.join(sources)})
      AND "ingestionMode"='public-board' ORDER BY id FOR UPDATE`;
    return tx.$queryRaw<Array<{ slug: string; platform: string; checkDay: number; nextCheckDate: Date }>>(
      crawlingRotationApplySql(plan.assignments, plan.observedAt),
    );
  }, { timeout: 30_000 });
}

function date(value: unknown, nullable: boolean): Date | null {
  if (value === null || value === undefined || value === '') {
    if (nullable) return null;
    throw Error('Missing required date in crawling snapshot');
  }
  // PostgreSQL timestamp columns store UTC but json_agg emits no zone suffix.
  // Parse those instants as UTC even when the local reviewer is in Chicago.
  const raw = String(value);
  const timestamp = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw) ? raw.replace(' ', 'T') + 'Z' : raw;
  const result = value instanceof Date ? new Date(value.valueOf()) : new Date(timestamp);
  if (!Number.isFinite(result.valueOf())) throw Error('Invalid date in crawling snapshot');
  return result;
}
const bool = (value: unknown) => value === true || value === 't';
export function decodeCrawlingRotationSnapshot(value: unknown): { boards: CrawlRotationBoard[]; runs: CrawlCycleRun[] } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { boards?: unknown }).boards) || !Array.isArray((value as { runs?: unknown }).runs)) throw Error('Snapshot requires boards and runs arrays');
  const snapshot = value as { boards: Array<Record<string, unknown>>; runs: Array<Record<string, unknown>> };
  const boards = snapshot.boards.map(row => ({ ...row, slug: String(row.slug), platform: String(row.platform), status: String(row.status), checkDay: Number(row.checkDay), jobsFound: Number(row.jobsFound), failCount: Number(row.failCount), retryCount: Number(row.retryCount),
    nextCheckDate: date(row.nextCheckDate, false)!, discoveredAt: date(row.discoveredAt, false)!, lastAttemptedAt: date(row.lastAttemptedAt, true), lastRespondedAt: date(row.lastRespondedAt, true), lastCheckedAt: date(row.lastCheckedAt, true), lastSynchronizedAt: date(row.lastSynchronizedAt, true), lastProcessedAt: date(row.lastProcessedAt, true), rotationMovedAt: date(row.rotationMovedAt, true),
    hasSweep: bool(row.hasSweep), hasOpenWork: bool(row.hasOpenWork), taskLeased: bool(row.taskLeased) }));
  const runs = snapshot.runs.map(row => ({ source: String(row.source), startedAt: date(row.startedAt, false)!, finishedAt: date(row.finishedAt, true), durationMs: row.durationMs === null ? null : Number(row.durationMs), seenCount: Number(row.seenCount), reconciled: bool(row.reconciled), checkpoint: row.checkpoint }));
  return { boards, runs };
}

export async function main(argv = process.argv.slice(2)) {
  let apply = false, snapshotPath: string | undefined, nowText: string | undefined, outputDirectory: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === '--apply') apply = true;
    else if (['--snapshot', '--now', '--output'].includes(option)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${option}`);
      if (option === '--snapshot') snapshotPath = value;
      else if (option === '--now') nowText = value;
      else outputDirectory = value;
    } else throw Error('Usage: balance_ats_crawling.ts [--apply] [--snapshot file.json] [--now ISO-date] [--output directory]');
  }
  if (apply && (snapshotPath || nowText)) throw Error('Apply requires a fresh database snapshot and the actual current time.');
  const now = nowText ? date(nowText, false)! : new Date();
  const snapshot = snapshotPath ? { observedAt: now, ...decodeCrawlingRotationSnapshot(JSON.parse(await readFile(snapshotPath, 'utf8'))) }
    : await readCrawlingRotationSnapshot(prisma, now);
  const plan = planCrawlingRotation(snapshot.boards, snapshot.runs, now);
  const directory = path.resolve(outputDirectory || path.join('.tasks', 'ats-crawling-rotation', randomUUID()));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  const receiptPath = path.join(directory, 'receipt.json');
  const receipt: Record<string, unknown> = { mode: apply ? 'apply' : 'preview', selectionHash: plan.selectionHash,
    observedAt: now, state: apply ? 'prepared' : 'complete', writesPerformed: 0, applied: [], guardedOut: 0 };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  try {
    if (apply) {
      const applied = await applyCrawlingRotation(prisma, plan);
      Object.assign(receipt, { state: 'complete', writesPerformed: applied.length, applied, guardedOut: plan.assignments.length - applied.length, finishedAt: new Date() });
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    }
  } catch (error) {
    Object.assign(receipt, { state: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date() });
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    throw error;
  }
  const { assignments: _assignments, ...summary } = plan;
  console.log(JSON.stringify({ ...summary, ...receipt, applied: undefined, artifacts: { directory, snapshot: path.join(directory, 'snapshot.json'), plan: path.join(directory, 'plan.json'), receipt: receiptPath } }, null, 2));
  return { plan, receipt, directory };
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '')) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
