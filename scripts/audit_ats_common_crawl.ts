import { PrismaClient, type Prisma } from '@prisma/client';

import {
  PLATFORMS,
  fetchCommonCrawl,
  getIndices,
  patternsFor,
  validateSlug,
} from '../src/scripts/discoverATS';
import {
  isPermanentAtsBoardRetirement,
  recordDiscoveredAtsBoard,
} from '../src/lib/atsBoardDiscovery';

const prisma = new PrismaClient();

const COMMON_CRAWL_DELAY_MS = Number(process.env.ATS_DISCOVERY_CC_DELAY_MS || 5000);
const VALIDATION_CONCURRENCY = 5;
const VALIDATION_BATCH_SIZE = 50;
const MAX_TRANSIENT_ATTEMPTS = 6;
const CANDIDATE_INSERT_CHUNK = 1000;

type PlatformKey = keyof typeof PLATFORMS;
type CandidateStatus = 'active' | 'existing' | 'parked' | 'retired' | 'retry' | 'unresolved';

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function commonCrawlPageRetryDelay(failures: number): number {
  const exponent = Math.max(0, Math.min(Math.floor(failures) - 1, 4));
  return Math.min(15 * 60 * 1000, 60 * 1000 * (2 ** exponent));
}

export type CooperativeAuditQuantumResult =
  | { kind: 'complete' }
  | { kind: 'advanced' }
  | { kind: 'deferred'; attempted: boolean; retryAt: Date };

/**
 * Run one page at a time across every incomplete URL pattern. A page-specific
 * failure therefore yields to its peers, while three consecutive failed pages
 * still open a global backoff before the worker tries a fourth endpoint.
 */
export async function runCooperativeAuditWork<T>(
  workItems: ReadonlyArray<T>,
  runQuantum: (item: T) => Promise<CooperativeAuditQuantumResult>,
  waitUntil: (until: Date) => Promise<void>,
  now: () => Date = () => new Date(),
  onGlobalBackoff: (milliseconds: number) => void = () => {},
): Promise<void> {
  const incomplete = new Set(workItems);
  let consecutiveFailures = 0;
  let globalFailureRounds = 0;

  while (incomplete.size > 0) {
    let requestAttempted = false;
    let progressMade = false;
    let earliestRetryAt: Date | null = null;
    let globalCircuitOpened = false;

    for (const item of workItems) {
      if (!incomplete.has(item)) continue;
      const result = await runQuantum(item);

      if (result.kind === 'complete') {
        incomplete.delete(item);
        progressMade = true;
        consecutiveFailures = 0;
        globalFailureRounds = 0;
        continue;
      }
      if (result.kind === 'advanced') {
        requestAttempted = true;
        progressMade = true;
        consecutiveFailures = 0;
        globalFailureRounds = 0;
        continue;
      }

      if (!earliestRetryAt || result.retryAt < earliestRetryAt) earliestRetryAt = result.retryAt;
      if (!result.attempted) continue;

      requestAttempted = true;
      consecutiveFailures += 1;
      if (consecutiveFailures < 3) continue;

      globalFailureRounds += 1;
      const waitMs = commonCrawlPageRetryDelay(globalFailureRounds);
      onGlobalBackoff(waitMs);
      await waitUntil(new Date(now().getTime() + waitMs));
      consecutiveFailures = 0;
      globalCircuitOpened = true;
      break;
    }

    if (globalCircuitOpened || incomplete.size === 0) continue;
    if (!requestAttempted && !progressMade) {
      if (!earliestRetryAt) throw new Error('Audit scheduler has incomplete work without a retry time.');
      await waitUntil(earliestRetryAt);
    }
  }
}

export async function runProductiveAuditBackoff(
  until: Date,
  processReady: () => Promise<number>,
  wait: (milliseconds: number) => Promise<void>,
  now: () => number = () => Date.now(),
  onIdleWait: (milliseconds: number) => void = () => {},
): Promise<void> {
  while (now() < until.getTime()) {
    const processed = await processReady();
    if (processed > 0) continue;

    const waitMs = Math.max(1, Math.min(60000, until.getTime() - now()));
    onIdleWait(waitMs);
    await wait(waitMs);
  }
}

function normalizedSlug(slug: string): string {
  return slug.trim().toLocaleLowerCase('en-US');
}

export function extractAuditCandidates(
  platformKey: PlatformKey,
  records: ReadonlyArray<{ url?: unknown }>,
): Array<{ slug: string; normalizedSlug: string }> {
  const platform = PLATFORMS[platformKey];
  const exact = new Map<string, { slug: string; normalizedSlug: string }>();
  for (const record of records) {
    if (typeof record.url !== 'string') continue;
    const slug = platform.extract_slug(record.url)?.trim();
    if (!slug) continue;
    // Exact spelling remains significant for case-sensitive vendor tokens.
    exact.set(slug, { slug, normalizedSlug: normalizedSlug(slug) });
  }
  return [...exact.values()];
}

async function insertCandidates(
  client: Pick<Prisma.TransactionClient, 'atsDiscoveryAuditCandidate'>,
  runId: string,
  platform: PlatformKey,
  candidates: Array<{ slug: string; normalizedSlug: string }>,
): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < candidates.length; offset += CANDIDATE_INSERT_CHUNK) {
    const chunk = candidates.slice(offset, offset + CANDIDATE_INSERT_CHUNK);
    const result = await client.atsDiscoveryAuditCandidate.createMany({
      data: chunk.map((candidate) => ({ runId, platform, ...candidate })),
      skipDuplicates: true,
    });
    inserted += result.count;
  }
  return inserted;
}

async function updateCandidateOutcome(
  runId: string,
  platform: string,
  slug: string,
  status: Exclude<CandidateStatus, 'retry'>,
  lastError: string | null,
): Promise<void> {
  const runCounter = status === 'active'
    ? 'boardsCreated'
    : status === 'existing'
      ? 'existingBoards'
      : status === 'retired'
        ? 'retiredBoards'
        : status === 'parked'
          ? 'parkedBoards'
          : 'unresolvedBoards';

  await prisma.$transaction(async (tx) => {
    const updated = await tx.atsDiscoveryAuditCandidate.updateMany({
      where: {
        runId,
        platform,
        slug,
        status: { in: ['pending', 'retry'] },
      },
      data: { status, lastError },
    });
    if (updated.count === 1) {
      await tx.atsDiscoveryAuditRun.update({
        where: { id: runId },
        data: { [runCounter]: { increment: 1 } },
      });
    }
  });
}

async function existingCandidateOutcome(
  platform: string,
  slug: string,
): Promise<'existing' | 'retired' | null> {
  const matches = await prisma.atsCompany.findMany({
    where: { platform, slug: { equals: slug, mode: 'insensitive' } },
    select: { status: true, excludedReason: true },
  });
  if (matches.length === 0) return null;
  if (matches.some(isPermanentAtsBoardRetirement)) return 'retired';
  return matches.some((match) => match.status !== 'excluded') ? 'existing' : 'retired';
}

function retryDelay(attempts: number): number {
  const minutes = [1, 5, 15, 60, 180, 360][Math.max(0, attempts - 1)] || 360;
  return minutes * 60 * 1000;
}

async function markTransient(
  runId: string,
  platform: string,
  slug: string,
  attempts: number,
  reason: string,
): Promise<void> {
  if (attempts >= MAX_TRANSIENT_ATTEMPTS) {
    await updateCandidateOutcome(runId, platform, slug, 'unresolved', reason);
    return;
  }
  await prisma.atsDiscoveryAuditCandidate.updateMany({
    where: { runId, platform, slug, status: { in: ['pending', 'retry'] } },
    data: {
      status: 'retry',
      attempts,
      lastError: reason,
      nextAttemptAt: new Date(Date.now() + retryDelay(attempts)),
    },
  });
}

async function processCandidate(candidate: {
  runId: string;
  platform: string;
  slug: string;
  attempts: number;
}): Promise<void> {
  const platform = candidate.platform as PlatformKey;
  const existing = await existingCandidateOutcome(platform, candidate.slug);
  if (existing) {
    await updateCandidateOutcome(candidate.runId, platform, candidate.slug, existing, null);
    return;
  }

  const result = await validateSlug(platform, candidate.slug);
  if (result.transient) {
    const attempts = candidate.attempts + 1;
    console.log(`[Audit] ${platform}/${candidate.slug} is temporarily unavailable (${result.reason}); attempt ${attempts}/${MAX_TRANSIENT_ATTEMPTS}.`);
    await markTransient(candidate.runId, platform, candidate.slug, attempts, result.reason);
    return;
  }

  const nextCheckDate = new Date();
  nextCheckDate.setDate(nextCheckDate.getDate() + (result.success ? 1 : 30));

  const boardOutcome = await prisma.$transaction((tx) => recordDiscoveredAtsBoard(
    tx,
    { platform, slug: candidate.slug },
    nextCheckDate,
    {
      status: result.success ? 'active' : 'parked',
      jobsFound: result.success ? result.jobsFound : 0,
      reactivateExisting: false,
    },
  ));

  const status: Exclude<CandidateStatus, 'retry'> = boardOutcome === 'created'
    ? (result.success ? 'active' : 'parked')
    : boardOutcome === 'retired'
      ? 'retired'
      : 'existing';
  await updateCandidateOutcome(
    candidate.runId,
    platform,
    candidate.slug,
    status,
    result.success ? null : result.reason,
  );
}

async function processReadyCandidates(runId: string, limit = VALIDATION_BATCH_SIZE): Promise<number> {
  const candidates = await prisma.atsDiscoveryAuditCandidate.findMany({
    where: {
      runId,
      status: { in: ['pending', 'retry'] },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: [{ attempts: 'asc' }, { createdAt: 'asc' }],
    take: limit,
    select: { runId: true, platform: true, slug: true, attempts: true },
  });

  for (let offset = 0; offset < candidates.length; offset += VALIDATION_CONCURRENCY) {
    await Promise.all(candidates.slice(offset, offset + VALIDATION_CONCURRENCY).map(processCandidate));
  }
  return candidates.length;
}

async function waitProductively(runId: string, until: Date): Promise<void> {
  await runProductiveAuditBackoff(
    until,
    () => processReadyCandidates(runId, VALIDATION_BATCH_SIZE),
    sleep,
    () => Date.now(),
    (waitMs) => console.log(`[Audit] No board validation is ready; waiting ${Math.ceil(waitMs / 1000)}s before the next Common Crawl opportunity.`),
  );
}

async function drainCandidates(runId: string): Promise<void> {
  await prisma.atsDiscoveryAuditRun.update({ where: { id: runId }, data: { status: 'validating' } });
  while (true) {
    const processed = await processReadyCandidates(runId, VALIDATION_BATCH_SIZE);
    if (processed > 0) continue;

    const next = await prisma.atsDiscoveryAuditCandidate.findFirst({
      where: { runId, status: { in: ['pending', 'retry'] } },
      orderBy: { nextAttemptAt: 'asc' },
      select: { nextAttemptAt: true },
    });
    if (!next) return;

    const waitMs = Math.max(1000, Math.min(60000, next.nextAttemptAt.getTime() - Date.now()));
    console.log(`[Audit] Waiting ${Math.ceil(waitMs / 1000)}s for the next transient-board retry.`);
    await sleep(waitMs);
  }
}

async function createOrResumeRun(indices: string[]) {
  const unfinished = await prisma.atsDiscoveryAuditRun.findFirst({
    where: { status: { in: ['running', 'validating'] } },
    orderBy: { startedAt: 'desc' },
  });
  if (unfinished) {
    console.log(`[Audit] Resuming ${unfinished.id}, targeted through ${unfinished.targetIndexId}.`);
    return unfinished;
  }

  const targetIndexId = indices.at(-1);
  if (!targetIndexId) throw new Error('Common Crawl returned no target index.');
  const patternCount = Object.values(PLATFORMS).reduce(
    (sum, platform) => sum + patternsFor(platform).length,
    0,
  );
  const run = await prisma.atsDiscoveryAuditRun.create({
    data: { targetIndexId, indexCount: indices.length, patternCount },
  });
  console.log(`[Audit] Started ${run.id}: ${patternCount} URL patterns across ${indices.length} Common Crawl indices through ${targetIndexId}.`);
  return run;
}

async function crawlPatternQuantum(
  runId: string,
  targetIndexId: string,
  indices: string[],
  platformKey: PlatformKey,
  pattern: string,
): Promise<CooperativeAuditQuantumResult> {
  let checkpoint = await prisma.atsDiscoveryAuditCheckpoint.upsert({
    where: { runId_platform_pattern: { runId, platform: platformKey, pattern } },
    update: {},
    create: { runId, platform: platformKey, pattern, indexId: indices[0], page: 0 },
  });
  if (checkpoint.completedThrough === targetIndexId) return { kind: 'complete' };

  if (checkpoint.nextAttemptAt.getTime() > Date.now()) {
    return { kind: 'deferred', attempted: false, retryAt: checkpoint.nextAttemptAt };
  }

  const indexPosition = indices.indexOf(checkpoint.indexId);
  if (indexPosition < 0) throw new Error(`Checkpoint index ${checkpoint.indexId} is no longer in the Common Crawl catalog.`);
  const targetPosition = indices.indexOf(targetIndexId);
  if (targetPosition < 0) throw new Error(`Audit target ${targetIndexId} is no longer in the Common Crawl catalog.`);
  if (indexPosition > targetPosition) throw new Error(`Checkpoint index ${checkpoint.indexId} is beyond audit target ${targetIndexId}.`);

  const indexId = indices[indexPosition];
  const page = await fetchCommonCrawl(indexId, pattern, checkpoint.page);
  if (!page.ok) {
    const failureCount = checkpoint.failureCount + 1;
    const waitMs = commonCrawlPageRetryDelay(failureCount);
    const retryAt = new Date(Date.now() + waitMs);
    const message = `${platformKey} ${pattern} ${indexId} page ${checkpoint.page}: ${page.reason}`;
    checkpoint = await prisma.$transaction(async (tx) => {
      const next = await tx.atsDiscoveryAuditCheckpoint.update({
        where: { runId_platform_pattern: { runId, platform: platformKey, pattern } },
        data: { failureCount, nextAttemptAt: retryAt, lastError: message },
      });
      await tx.atsDiscoveryAuditRun.update({
        where: { id: runId },
        data: { status: 'running', lastError: message },
      });
      return next;
    });
    console.error(`[Audit] Common Crawl page remains unavailable; retaining its checkpoint, retrying after ${Math.ceil(waitMs / 60000)} minute(s), and rotating to other work: ${message}`);
    await processReadyCandidates(runId);
    await sleep(COMMON_CRAWL_DELAY_MS);
    return { kind: 'deferred', attempted: true, retryAt: checkpoint.nextAttemptAt };
  }

  const records = page.records;
  if (records.length === 0) {
    const isTarget = indexId === targetIndexId;
    const exhaustedRecords = checkpoint.indexRecordsRead;
    checkpoint = await prisma.$transaction(async (tx) => {
      await tx.atsDiscoveryAuditIndexReceipt.upsert({
        where: { runId_platform_pattern_indexId: { runId, platform: platformKey, pattern, indexId } },
        update: {},
        create: {
          runId,
          platform: platformKey,
          pattern,
          indexId,
          pagesRead: checkpoint.indexPagesRead,
          recordsRead: checkpoint.indexRecordsRead,
          candidatesQueued: checkpoint.indexCandidatesQueued,
        },
      });
      const next = await tx.atsDiscoveryAuditCheckpoint.update({
        where: { runId_platform_pattern: { runId, platform: platformKey, pattern } },
        data: isTarget
          ? {
              completedThrough: targetIndexId,
              failureCount: 0,
              nextAttemptAt: new Date(),
              lastError: null,
            }
          : {
              indexId: indices[indexPosition + 1],
              page: 0,
              indexPagesRead: 0,
              indexRecordsRead: 0,
              indexCandidatesQueued: 0,
              failureCount: 0,
              nextAttemptAt: new Date(),
              lastError: null,
              completedThrough: indexId,
            },
      });
      const runData = isTarget
        ? { completedPatterns: { increment: 1 }, status: 'running', lastError: null }
        : { status: 'running', lastError: null };
      await tx.atsDiscoveryAuditRun.update({ where: { id: runId }, data: runData });
      return next;
    });
    console.log(`[Audit] Receipt earned: ${platformKey} ${pattern} ${indexId} (${exhaustedRecords} records).`);
    await processReadyCandidates(runId);
    await sleep(COMMON_CRAWL_DELAY_MS);
    return isTarget ? { kind: 'complete' } : { kind: 'advanced' };
  }

  const candidates = extractAuditCandidates(platformKey, records);
  let inserted = 0;
  checkpoint = await prisma.$transaction(async (tx) => {
    // Candidate durability and the next-page checkpoint are one atomic
    // write. A crash either commits both or repeats the page; it can never
    // remember the page while forgetting a slug found on that page.
    inserted = await insertCandidates(tx, runId, platformKey, candidates);
    const next = await tx.atsDiscoveryAuditCheckpoint.update({
      where: { runId_platform_pattern: { runId, platform: platformKey, pattern } },
      data: {
        page: { increment: 1 },
        indexPagesRead: { increment: 1 },
        indexRecordsRead: { increment: records.length },
        indexCandidatesQueued: { increment: inserted },
        failureCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
      },
    });
    await tx.atsDiscoveryAuditRun.update({
      where: { id: runId },
      data: {
        pagesRead: { increment: 1 },
        recordsRead: { increment: records.length },
        candidatesQueued: { increment: inserted },
        status: 'running',
        lastError: null,
      },
    });
    return next;
  });
  console.log(`[Audit] ${platformKey} ${pattern} ${indexId} page ${checkpoint.page - 1}: ${records.length} records, ${inserted} new candidates.`);
  await processReadyCandidates(runId);
  await sleep(COMMON_CRAWL_DELAY_MS);
  return { kind: 'advanced' };
}

async function verifyAndComplete(runId: string): Promise<void> {
  const run = await prisma.atsDiscoveryAuditRun.findUniqueOrThrow({ where: { id: runId } });
  const expectedReceipts = run.patternCount * run.indexCount;
  const [receipts, incompletePatterns, unresolved, pending] = await Promise.all([
    prisma.atsDiscoveryAuditIndexReceipt.count({ where: { runId } }),
    prisma.atsDiscoveryAuditCheckpoint.count({ where: { runId, NOT: { completedThrough: run.targetIndexId } } }),
    prisma.atsDiscoveryAuditCandidate.count({ where: { runId, status: 'unresolved' } }),
    prisma.atsDiscoveryAuditCandidate.count({ where: { runId, status: { in: ['pending', 'retry'] } } }),
  ]);

  if (receipts !== expectedReceipts || incompletePatterns !== 0 || pending !== 0) {
    throw new Error(`Audit proof is incomplete: ${receipts}/${expectedReceipts} receipts, ${incompletePatterns} incomplete patterns, ${pending} pending candidates.`);
  }

  const status = unresolved === 0 ? 'complete' : 'complete_with_unresolved';
  await prisma.atsDiscoveryAuditRun.update({
    where: { id: runId },
    data: { status, unresolvedBoards: unresolved, completedAt: new Date(), lastError: null },
  });
  console.log(`[Audit] ${status}: ${receipts}/${expectedReceipts} index receipts and every queued candidate reached a terminal outcome; unresolved=${unresolved}.`);
}

export async function runFullAudit(): Promise<void> {
  if (!Number.isFinite(COMMON_CRAWL_DELAY_MS) || COMMON_CRAWL_DELAY_MS < 5000) {
    throw new Error('ATS_DISCOVERY_CC_DELAY_MS must be at least 5000ms to respect Common Crawl rate guidance.');
  }
  const allIndices = await getIndices();
  const run = await createOrResumeRun(allIndices);
  const targetPosition = allIndices.indexOf(run.targetIndexId);
  if (targetPosition < 0) throw new Error(`Audit target ${run.targetIndexId} is not present in the current catalog.`);
  const indices = allIndices.slice(0, targetPosition + 1);

  const workItems = (Object.keys(PLATFORMS) as PlatformKey[]).flatMap((platformKey) => (
    patternsFor(PLATFORMS[platformKey]).map((pattern) => ({ platformKey, pattern }))
  ));
  await runCooperativeAuditWork(
    workItems,
    ({ platformKey, pattern }) => crawlPatternQuantum(
      run.id,
      run.targetIndexId,
      indices,
      platformKey,
      pattern,
    ),
    (until) => waitProductively(run.id, until),
    () => new Date(),
    (waitMs) => console.error(`[Audit] Three consecutive Common Crawl pages failed; validating queued boards and globally backing off for ${Math.ceil(waitMs / 60000)} minute(s).`),
  );
  await drainCandidates(run.id);
  await verifyAndComplete(run.id);
}

export async function reportAuditStatus(): Promise<void> {
  const run = await prisma.atsDiscoveryAuditRun.findFirst({ orderBy: { startedAt: 'desc' } });
  if (!run) {
    console.log(JSON.stringify({ status: 'not_started' }, null, 2));
    return;
  }
  const [receipts, candidates, retryingPages] = await Promise.all([
    prisma.atsDiscoveryAuditIndexReceipt.count({ where: { runId: run.id } }),
    prisma.atsDiscoveryAuditCandidate.groupBy({
      by: ['status'],
      where: { runId: run.id },
      _count: { _all: true },
    }),
    prisma.atsDiscoveryAuditCheckpoint.aggregate({
      where: { runId: run.id, failureCount: { gt: 0 } },
      _count: { _all: true },
      _min: { nextAttemptAt: true },
    }),
  ]);
  console.log(JSON.stringify({
    ...run,
    expectedReceipts: run.patternCount * run.indexCount,
    receipts,
    candidates: Object.fromEntries(candidates.map((row) => [row.status, row._count._all])),
    retryingPages: retryingPages._count._all,
    nextPageRetryAt: retryingPages._min.nextAttemptAt,
  }, null, 2));
}

if (process.argv[1]?.includes('audit_ats_common_crawl')) {
  const command = process.argv.includes('--status') ? reportAuditStatus() : runFullAudit();
  command
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Audit] Failed safely: ${message}`);
      const active = await prisma.atsDiscoveryAuditRun.findFirst({
        where: { status: { in: ['running', 'validating'] } },
        orderBy: { startedAt: 'desc' },
      });
      if (active) {
        await prisma.atsDiscoveryAuditRun.update({
          where: { id: active.id },
          data: { status: 'running', lastError: message },
        });
      }
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
