import { isBrowserAtsPlatform } from '../src/lib/browserAtsBoards';
import { isFirstCollectionPlatform } from '../src/lib/atsFirstCollectionAdmission';
import { randomUUID } from 'node:crypto';
import { isPublicAtsPlatform } from '../src/lib/publicAtsBoards';
import { PrismaClient, type AtsDiscoveryAuditRun, type Prisma } from '../src/lib/prismaClient';

import {
  PLATFORMS,
  fetchCommonCrawl,
  getIndices,
  patternsFor,
  validateSlug,
} from '../src/scripts/discoverATS';
import {
  firstDiscoveredAtsBoardCheckDate,
  isPermanentAtsBoardRetirement,
  recordDiscoveredAtsBoard,
} from '../src/lib/atsBoardDiscovery';
import { gustoBoardIdFromSlug } from '../src/lib/gustoBoard';
import {
  AthenaCommonCrawlReader,
  athenaDiscoveryConfig,
  athenaSupportsIndex,
  type AthenaResultPage,
} from '../src/lib/athenaCommonCrawl';

const prisma = new PrismaClient();

const COMMON_CRAWL_DELAY_MS = Number(process.env.ATS_DISCOVERY_CC_DELAY_MS || 5000);
const VALIDATION_CONCURRENCY = 5;
const VALIDATION_BATCH_SIZE = 50;
const MAX_TRANSIENT_ATTEMPTS = 6;
const CANDIDATE_INSERT_CHUNK = 1000;
const ATHENA_POLL_MS = 15_000;
const athenaConfig = athenaDiscoveryConfig();
const athenaReader = athenaConfig ? new AthenaCommonCrawlReader(athenaConfig) : null;

type PlatformKey = keyof typeof PLATFORMS;
type CandidateStatus = 'active' | 'existing' | 'parked' | 'retired' | 'retry' | 'unresolved' | 'discovered_waiting';

type AthenaRead =
  | { kind: 'submitted'; retryAt: Date }
  | { kind: 'waiting'; retryAt: Date }
  | { kind: 'page'; page: AthenaResultPage }
  | { kind: 'failure'; reason: string; restartQuery: boolean };

export type AuditWorkItem = { platformKey: PlatformKey; pattern: string };
type AthenaReader = Pick<AthenaCommonCrawlReader, 'start' | 'state' | 'results'>;

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
  let nextStartIndex = 0;

  while (incomplete.size > 0) {
    let requestAttempted = false;
    let progressMade = false;
    let earliestRetryAt: Date | null = null;
    let globalCircuitOpened = false;
    const roundStartIndex = nextStartIndex;

    for (let offset = 0; offset < workItems.length; offset += 1) {
      const itemIndex = (roundStartIndex + offset) % workItems.length;
      const item = workItems[itemIndex];
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
      // Resume after the item that opened the circuit. Restarting at index 0
      // lets the same three failing pages monopolize every retry round and
      // prevents later provider patterns from receiving a turn.
      nextStartIndex = (itemIndex + 1) % workItems.length;
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

export function verifiedAuditIndexSequence(
  run: Pick<AtsDiscoveryAuditRun, 'indexCount' | 'targetIndexId'>,
  indexIds: ReadonlyArray<string>,
): string[] | null {
  if (indexIds.length !== run.indexCount) return null;
  if (new Set(indexIds).size !== indexIds.length) return null;
  if (indexIds.at(-1) !== run.targetIndexId) return null;
  return [...indexIds];
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
  client: Pick<Prisma.TransactionClient, 'atsDiscoveryAuditCandidate' | 'atsFirstCollectionCandidate'>,
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
    if (isFirstCollectionPlatform(platform)) await client.atsFirstCollectionCandidate.createMany({
      data: chunk.map(candidate => ({ slug: candidate.slug, platform, discoveryRunId: runId })), skipDuplicates: true,
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
  const runCounter = status === 'discovered_waiting' ? null : status === 'active'
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
    if (updated.count === 1 && runCounter) {
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
  const gustoBoardId = platform === 'gusto' ? gustoBoardIdFromSlug(slug) : null;
  const matches = await prisma.atsCompany.findMany({
    where: {
      platform,
      OR: [
        { slug: { equals: slug, mode: 'insensitive' } },
        ...(gustoBoardId ? [{ slug: { endsWith: gustoBoardId, mode: 'insensitive' as const } }] : []),
      ],
    },
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

  if (isFirstCollectionPlatform(platform)) {
    await updateCandidateOutcome(candidate.runId, platform, candidate.slug, 'discovered_waiting', null);
    return;
  }
  const result = await validateSlug(platform, candidate.slug);
  if (result.transient) {
    const attempts = candidate.attempts + 1;
    console.log(`[Audit] ${platform}/${candidate.slug} is temporarily unavailable (${result.reason}); attempt ${attempts}/${MAX_TRANSIENT_ATTEMPTS}.`);
    await markTransient(candidate.runId, platform, candidate.slug, attempts, result.reason);
    return;
  }

  const nextCheckDate = firstDiscoveredAtsBoardCheckDate(result);

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

async function waitProductively(runId: string, until: Date, drainExistingAthena: () => Promise<number> = async () => 0): Promise<void> {
  await runProductiveAuditBackoff(
    until,
    async () => await drainExistingAthena() + await processReadyCandidates(runId, VALIDATION_BATCH_SIZE),
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

async function findUnfinishedRun(): Promise<AtsDiscoveryAuditRun | null> {
  return prisma.atsDiscoveryAuditRun.findFirst({
    where: { status: { in: ['running', 'validating'] } },
    orderBy: { startedAt: 'desc' },
  });
}

async function durableIndexSequence(run: AtsDiscoveryAuditRun): Promise<string[] | null> {
  const completedPattern = await prisma.atsDiscoveryAuditCheckpoint.findFirst({
    where: { runId: run.id, completedThrough: run.targetIndexId },
    orderBy: { updatedAt: 'asc' },
    select: { platform: true, pattern: true },
  });
  if (!completedPattern) return null;

  const receipts = await prisma.atsDiscoveryAuditIndexReceipt.findMany({
    where: {
      runId: run.id,
      platform: completedPattern.platform,
      pattern: completedPattern.pattern,
    },
    orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
    select: { indexId: true },
  });
  return verifiedAuditIndexSequence(run, receipts.map((receipt) => receipt.indexId));
}

async function loadAuditIndices(unfinished: AtsDiscoveryAuditRun | null): Promise<string[]> {
  try {
    return await getIndices();
  } catch (error) {
    if (!unfinished) throw error;
    const durable = await durableIndexSequence(unfinished);
    if (!durable) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Audit] Common Crawl catalog is unavailable (${message}); resuming from ${durable.length} immutable index receipts already proven by this run.`);
    return durable;
  }
}

/** Never transfer historical coverage between two different URL patterns. */
export function auditIndicesMissingCoverage(
  indices: readonly string[],
  workItems: readonly AuditWorkItem[],
  completedReceipts: ReadonlyArray<{ platform: string; pattern: string; indexId: string }>,
): string[] {
  const covered = new Set(completedReceipts.map(({ platform, pattern, indexId }) => (
    JSON.stringify([platform, pattern, indexId])
  )));
  const firstMissing = indices.findIndex((indexId) => workItems.some(({ platformKey, pattern }) => (
    !covered.has(JSON.stringify([platformKey, pattern, indexId]))
  )));
  // Runs retain a contiguous, bounded index sequence. A new/replaced pattern
  // earns historical coverage even if an earlier incremental run included it.
  return firstMissing < 0 ? [] : indices.slice(firstMissing);
}

export async function auditWorkItems(unfinished: AtsDiscoveryAuditRun | null, client: PrismaClient = prisma): Promise<AuditWorkItem[]> {
  const configured = (Object.keys(PLATFORMS) as PlatformKey[]).flatMap((platformKey) => (
    patternsFor(PLATFORMS[platformKey]).map((pattern) => ({ platformKey, pattern }))
  ));
  const saved = unfinished ? await client.atsDiscoveryAuditCheckpoint.findMany({
    where: { runId: unfinished.id }, select: { platform: true, pattern: true },
  }) : [];
  const items = new Map(configured.map((item) => [JSON.stringify([item.platformKey, item.pattern]), item]));
  for (const { platform, pattern } of saved) {
    if (!Object.hasOwn(PLATFORMS, platform)) throw new Error(`Unfinished audit still requires the ${platform} discovery adapter.`);
    const item = { platformKey: platform as PlatformKey, pattern };
    items.set(JSON.stringify([platform, pattern]), item);
  }
  return [...items.values()];
}

export async function createOrResumeRun(
  indices: string[],
  unfinished: AtsDiscoveryAuditRun | null,
  workItems: readonly AuditWorkItem[],
  client: PrismaClient = prisma,
): Promise<AtsDiscoveryAuditRun | null> {
  const patternCount = workItems.length;
  if (unfinished) {
    if (patternCount < unfinished.patternCount) {
      throw new Error(`Configured audit coverage shrank from ${unfinished.patternCount} to ${patternCount} patterns.`);
    }
    if (patternCount > unfinished.patternCount) {
      unfinished = await client.atsDiscoveryAuditRun.update({
        where: { id: unfinished.id },
        data: { patternCount },
      });
      console.log(`[Audit] Expanded the existing run to ${patternCount} patterns without resetting its receipts.`);
    }
    console.log(`[Audit] Resuming ${unfinished.id}, targeted through ${unfinished.targetIndexId}.`);
    return unfinished;
  }

  if (indices.length === 0) throw new Error('Common Crawl returned no target index.');
  const completedReceipts = await client.atsDiscoveryAuditIndexReceipt.findMany({
    where: {
      run: { status: { in: ['complete', 'complete_with_unresolved'] } },
      OR: workItems.map(({ platformKey, pattern }) => ({ platform: platformKey, pattern })),
    },
    distinct: ['platform', 'pattern', 'indexId'],
    select: { platform: true, pattern: true, indexId: true },
  });
  const runIndices = auditIndicesMissingCoverage(indices, workItems, completedReceipts);
  const targetIndexId = runIndices.at(-1);
  if (!targetIndexId) {
    console.log('[Audit] Every configured URL pattern has completed receipts through the current Common Crawl catalog.');
    return null;
  }
  const run = await client.atsDiscoveryAuditRun.create({
    data: {
      targetIndexId, indexCount: runIndices.length, patternCount,
      // Capture all pattern identities with the run, before the first request.
      checkpoints: { create: workItems.map(({ platformKey, pattern }) => ({
        platform: platformKey, pattern, indexId: auditIndexOrder(platformKey, runIndices)[0],
      })) },
    },
  });
  console.log(`[Audit] Started ${run.id}: ${patternCount} URL patterns across ${runIndices.length} Common Crawl indices through ${targetIndexId}.`);
  return run;
}

/** New Eightfold coverage starts with recent postings, then earns every historical receipt. */
export function auditIndexOrder(platform: string, indices: readonly string[]): string[] {
  return (platform === 'eightfold' || isPublicAtsPlatform(platform) || isBrowserAtsPlatform(platform)) ? [...indices].reverse() : [...indices];
}

export function auditRunIndexSequence(run: Pick<AtsDiscoveryAuditRun, 'indexCount' | 'targetIndexId'>, allIndices: readonly string[]): string[] {
  const targetPosition = allIndices.indexOf(run.targetIndexId);
  if (targetPosition < 0) throw new Error(`Audit target ${run.targetIndexId} is not present in the current catalog.`);
  const firstPosition = targetPosition - run.indexCount + 1;
  if (firstPosition < 0) throw new Error(`Audit ${run.targetIndexId} needs ${run.indexCount} indexes, but the catalog has insufficient history.`);
  return allIndices.slice(firstPosition, targetPosition + 1);
}

export function auditCheckpointComplete(
  checkpoint: { indexId: string; completedThrough: string | null },
  targetIndexId: string,
  indices: readonly string[],
): boolean {
  return checkpoint.indexId === indices.at(-1) && checkpoint.completedThrough === targetIndexId;
}

/**
 * Submit one partition-constrained Athena query once, then consume its durable
 * result cursor in small pages. The execution id belongs to the checkpoint, so
 * a worker restart neither resubmits a broad scan nor rewinds candidates that
 * have already been made durable.
 */
export async function readAthenaCheckpoint(
  checkpoint: { runId: string; platform: string; pattern: string; athenaExecutionId: string | null; athenaRequestToken: string | null; athenaNextToken: string | null; athenaResultsComplete: boolean },
  indexId: string,
  reader: AthenaReader | null = athenaReader,
  client: PrismaClient = prisma,
): Promise<AthenaRead> {
  if (!reader) throw new Error('Athena reader requested while Athena discovery is disabled.');
  const where = { runId_platform_pattern: { runId: checkpoint.runId, platform: checkpoint.platform, pattern: checkpoint.pattern } };

  if (checkpoint.athenaResultsComplete) {
    return { kind: 'page', page: { urls: [], nextToken: null } };
  }

  if (!checkpoint.athenaExecutionId) {
    const requestToken = checkpoint.athenaRequestToken || randomUUID();
    if (!checkpoint.athenaRequestToken) {
      // This write must finish before AWS is contacted. A crash after AWS
      // accepts the query can then recover its id with the same token.
      await client.atsDiscoveryAuditCheckpoint.update({ where, data: { athenaRequestToken: requestToken } });
    }
    try {
      const executionId = await reader.start(indexId, checkpoint.pattern, requestToken);
      const retryAt = new Date(Date.now() + ATHENA_POLL_MS);
      await client.atsDiscoveryAuditCheckpoint.update({
        where,
        data: {
          athenaExecutionId: executionId,
          athenaNextToken: null,
          athenaResultsComplete: false,
          nextAttemptAt: retryAt,
          lastError: null,
        },
      });
      console.log(`[Audit] Submitted one Athena URL-index query for ${checkpoint.platform} ${checkpoint.pattern} ${indexId}.`);
      return { kind: 'submitted', retryAt };
    } catch (error) {
      return { kind: 'failure', reason: error instanceof Error ? error.message : String(error), restartQuery: false };
    }
  }

  try {
    const status = await reader.state(checkpoint.athenaExecutionId);
    if (status.state === 'QUEUED' || status.state === 'RUNNING') {
      const retryAt = new Date(Date.now() + ATHENA_POLL_MS);
      await client.atsDiscoveryAuditCheckpoint.update({
        where,
        data: { nextAttemptAt: retryAt, lastError: null },
      });
      return { kind: 'waiting', retryAt };
    }
    if (status.state !== 'SUCCEEDED') {
      return {
        kind: 'failure', reason: status.reason || `Athena query ${status.state.toLowerCase()}`,
        restartQuery: status.state === 'FAILED' || status.state === 'CANCELLED',
      };
    }
    if (status.resultsExpired) return { kind: 'failure', reason: 'Athena managed query results expired after 24 hours.', restartQuery: true };
    return { kind: 'page', page: await reader.results(checkpoint.athenaExecutionId, checkpoint.athenaNextToken) };
  } catch (error) {
    return { kind: 'failure', reason: error instanceof Error ? error.message : String(error), restartQuery: false };
  }
}

export async function crawlPatternQuantum(
  runId: string,
  targetIndexId: string,
  indices: string[],
  platformKey: PlatformKey,
  pattern: string,
  dependencies = {
    client: prisma,
    reader: athenaReader as AthenaReader | null,
    fetchPage: fetchCommonCrawl,
    processReady: processReadyCandidates,
    wait: sleep,
  },
): Promise<CooperativeAuditQuantumResult> {
  const { client, reader: configuredReader, fetchPage, processReady, wait } = dependencies;
  let checkpoint = await client.atsDiscoveryAuditCheckpoint.upsert({
    where: { runId_platform_pattern: { runId, platform: platformKey, pattern } },
    update: {},
    create: { runId, platform: platformKey, pattern, indexId: indices[0], page: 0 },
  });
  if (auditCheckpointComplete(checkpoint, targetIndexId, indices)) return { kind: 'complete' };

  if (checkpoint.nextAttemptAt.getTime() > Date.now()) {
    return { kind: 'deferred', attempted: false, retryAt: checkpoint.nextAttemptAt };
  }

  const indexPosition = indices.indexOf(checkpoint.indexId);
  if (indexPosition < 0) throw new Error(`Checkpoint index ${checkpoint.indexId} is no longer in the Common Crawl catalog.`);
  const targetPosition = indices.indexOf(targetIndexId);
  if (targetPosition < 0) throw new Error(`Audit target ${targetIndexId} is no longer in the Common Crawl catalog.`);
  // The caller supplies exactly the run's bounded index set. Eightfold walks
  // it newest first; other providers retain their existing chronological order.

  const indexId = indices[indexPosition];
  // Legacy catalog collections predate the Parquet URL index. Their existing
  // CDX checkpoints still need actual source exhaustion, never an empty
  // Athena query against a nonexistent partition or an endless mapping error.
  const reader = athenaSupportsIndex(indexId) ? configuredReader : null;
  let records: Array<{ url?: unknown }>;
  let athenaNextToken: string | null = null;
  let sourceFailure: string | null = null;
  let restartQuery = false;
  if (reader) {
    const read = await readAthenaCheckpoint(checkpoint, indexId, reader, client);
    if (read.kind === 'submitted') return { kind: 'advanced' };
    if (read.kind === 'waiting') return { kind: 'deferred', attempted: false, retryAt: read.retryAt };
    if (read.kind === 'failure') {
      sourceFailure = read.reason;
      restartQuery = read.restartQuery;
      records = [];
    } else {
      records = read.page.urls.map((url) => ({ url }));
      athenaNextToken = read.page.nextToken;
    }
  } else {
    const page = await fetchPage(indexId, pattern, checkpoint.page);
    if (!page.ok) {
      sourceFailure = page.reason;
      records = [];
    } else {
      records = page.records;
    }
  }

  if (sourceFailure !== null) {
    const failureCount = checkpoint.failureCount + 1;
    const waitMs = commonCrawlPageRetryDelay(failureCount);
    const retryAt = new Date(Date.now() + waitMs);
    const message = `${platformKey} ${pattern} ${indexId} page ${checkpoint.page}: ${sourceFailure}`;
    checkpoint = await client.$transaction(async (tx) => {
      const next = await tx.atsDiscoveryAuditCheckpoint.update({
        where: { runId_platform_pattern: { runId, platform: platformKey, pattern } },
        data: {
          failureCount,
          nextAttemptAt: retryAt,
          lastError: message,
          // Only verified terminal/expired queries permit another paid scan.
          // Transient reads and uncertain submissions retain all AWS state.
          ...(restartQuery ? { athenaExecutionId: null, athenaRequestToken: null, athenaNextToken: null, athenaResultsComplete: false } : {}),
        },
      });
      await tx.atsDiscoveryAuditRun.update({
        where: { id: runId },
        data: { status: 'running', lastError: message },
      });
      return next;
    });
    console.error(`[Audit] Discovery source remains unavailable; retaining its checkpoint, retrying after ${Math.ceil(waitMs / 60000)} minute(s), and rotating to other work: ${message}`);
    await processReady(runId);
    await wait(COMMON_CRAWL_DELAY_MS);
    return { kind: 'deferred', attempted: true, retryAt: checkpoint.nextAttemptAt };
  }

  if (records.length === 0 && (!reader || athenaNextToken === null)) {
    const isTarget = indexPosition === indices.length - 1;
    const exhaustedRecords = checkpoint.indexRecordsRead;
    checkpoint = await client.$transaction(async (tx) => {
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
              athenaExecutionId: null,
              athenaRequestToken: null,
              athenaNextToken: null,
              athenaResultsComplete: false,
              completedThrough: (platformKey === 'eightfold' || isPublicAtsPlatform(platformKey) || isBrowserAtsPlatform(platformKey)) ? null : indexId,
            },
      });
      const runData = isTarget
        ? { completedPatterns: { increment: 1 }, status: 'running', lastError: null }
        : { status: 'running', lastError: null };
      await tx.atsDiscoveryAuditRun.update({ where: { id: runId }, data: runData });
      return next;
    });
    console.log(`[Audit] Receipt earned: ${platformKey} ${pattern} ${indexId} (${exhaustedRecords} records).`);
    await processReady(runId);
    await wait(COMMON_CRAWL_DELAY_MS);
    return isTarget ? { kind: 'complete' } : { kind: 'advanced' };
  }

  const candidates = extractAuditCandidates(platformKey, records);
  let inserted = 0;
  checkpoint = await client.$transaction(async (tx) => {
    // Candidate durability and the next-page checkpoint are one atomic
    // write. A crash either commits both or repeats the page; it can never
    // remember the page while forgetting a slug found on that page.
    inserted = await insertCandidates(tx, runId, platformKey, candidates);
    const next = await tx.atsDiscoveryAuditCheckpoint.update({
      where: { runId_platform_pattern: { runId, platform: platformKey, pattern } },
      data: {
        indexPagesRead: { increment: 1 },
        indexRecordsRead: { increment: records.length },
        indexCandidatesQueued: { increment: inserted },
        failureCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        // `page` is exclusively the CDX cursor. Reading Athena must never
        // advance it, and CDX reads must never discard an Athena cursor.
        ...(reader
          ? { athenaNextToken, athenaResultsComplete: athenaNextToken === null }
          : { page: { increment: 1 } }),
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
  console.log(`[Audit] ${platformKey} ${pattern} ${indexId} ${reader ? 'Athena result page' : `CDX page ${checkpoint.page - 1}`}: ${records.length} records, ${inserted} new candidates.`);
  await processReady(runId);
  await wait(COMMON_CRAWL_DELAY_MS);
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
  console.log(`[Audit] ${status}: ${receipts}/${expectedReceipts} index receipts; every queued candidate was classified or catalogued for controlled admission; unresolved=${unresolved}.`);
}

export async function runFullAudit(): Promise<void> {
  if (!Number.isFinite(COMMON_CRAWL_DELAY_MS) || COMMON_CRAWL_DELAY_MS < 5000) {
    throw new Error('ATS_DISCOVERY_CC_DELAY_MS must be at least 5000ms to respect Common Crawl rate guidance.');
  }
  while (true) {
    const unfinished = await findUnfinishedRun();
    const allIndices = await loadAuditIndices(unfinished);
    const workItems = await auditWorkItems(unfinished);
    const run = await createOrResumeRun(allIndices, unfinished, workItems);
    if (!run) return;
    const indices = auditRunIndexSequence(run, allIndices);

    await runCooperativeAuditWork(
      workItems,
      ({ platformKey, pattern }) => crawlPatternQuantum(
        run.id,
        run.targetIndexId,
        auditIndexOrder(platformKey, indices),
        platformKey,
        pattern,
      ),
      (until) => waitProductively(run.id, until, async () => {
        // A legacy CDX outage must not strand already-paid Athena results.
        // Only existing query IDs are drained here: this path cannot submit
        // a new scan, broaden a query, or discard a legacy checkpoint.
        const pending = await prisma.atsDiscoveryAuditCheckpoint.findMany({
          where: {runId: run.id, athenaExecutionId: {not: null}, nextAttemptAt: {lte: new Date()},
            NOT: {completedThrough: run.targetIndexId}},
          orderBy: {updatedAt: 'asc'}, take: 10,
          select: {platform: true, pattern: true},
        });
        for (const item of pending) {
          const result = await crawlPatternQuantum(run.id, run.targetIndexId,
            auditIndexOrder(item.platform, indices), item.platform as PlatformKey, item.pattern);
          if (result.kind === 'advanced' || result.kind === 'complete') return 1;
        }
        return 0;
      }),
      () => new Date(),
      (waitMs) => console.error(`[Audit] Three consecutive discovery requests failed; validating queued boards and globally backing off for ${Math.ceil(waitMs / 60000)} minute(s).`),
    );
    await drainCandidates(run.id);
    await verifyAndComplete(run.id);
    // A resumed run can target an older catalog, or a newly added pattern can
    // still lack historical receipts. Finish that work in this invocation.
  }
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
