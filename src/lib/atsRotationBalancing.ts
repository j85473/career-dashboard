import { Prisma, type PrismaClient } from '@prisma/client';
import { assignedRotationDay, ATS_ROTATION_DAY_NAMES, isAtsBoardEnabledForIngestion } from './atsRotation';
import {
  ATS_ROTATION_BALANCE_POLICY,
  estimateNewAtsBoardWorkload,
  estimateAtsBoardWorkload,
  lightestAtsWorkloadDay,
  planAtsRotationWorkload,
  summarizeAtsWorkload,
  type AtsWorkloadBoard,
  type AtsWorkloadDay,
  type AtsWorkloadProfiles,
} from './atsRotationWorkload';

export const ATS_ROTATION_BALANCE_LOCK = 'ats-weekday-workload-reservations-v1';
const STATE_ID = 'weekly-api';

/** This query is also safe before the expand-only balancing migration. */
export const ATS_WORKLOAD_SNAPSHOT_SQL = `
WITH completed AS (
  SELECT DISTINCT ON (b.slug,b.platform) b.id,b.slug,b.platform,b."processedAt",
    b."canonicalOccurrenceCount",b."jobCount",b."writerMode"
  FROM "AtsIngestionBatch" b
  WHERE b.status='processed' AND b."operatorResetAt" IS NULL AND b."processedAt" IS NOT NULL
    AND b."createdAt">$1::timestamp-INTERVAL '30 days'
  ORDER BY b.slug,b.platform,b."createdAt" DESC
), measured AS (
  SELECT b.slug,b.platform,b."processedAt",
    CASE WHEN b."writerMode"='v2' THEN b."canonicalOccurrenceCount" ELSE b."jobCount" END AS "sampleJobs",
    sum(extract(epoch from(w."finishedAt"-w."startedAt"))*1000)
      FILTER(WHERE w."finishedAt">w."startedAt"
        AND w."finishedAt"-w."startedAt"<=INTERVAL '3 minutes')::double precision AS "workerMs"
  FROM completed b LEFT JOIN "AtsAcquisitionWorkReceipt" w ON w."batchId"=b.id
  GROUP BY b.slug,b.platform,b."processedAt",b."writerMode",b."canonicalOccurrenceCount",b."jobCount"
)
SELECT c.slug,c.platform,c."checkDay",c."jobsFound",c."failCount",c."retryCount",
  c."nextCheckDate",c."lastProcessedAt",m."sampleJobs",m."workerMs",m."processedAt" AS "sampleAt",
  (to_jsonb(c)->>'rotationMovedAt')::timestamp AS "rotationMovedAt",
  EXISTS(SELECT 1 FROM "AtsIngestionBatch" b WHERE b.slug=c.slug AND b.platform=c.platform
    AND (b.status IN ('fetching','partial','queued','processing','synchronized','reset_synchronized','reset_draining')
      OR b."leaseExpiresAt">$1::timestamp OR b."acquisitionLeaseExpiresAt">$1::timestamp)) AS "hasOpenWork"
FROM "AtsCompany" c LEFT JOIN measured m USING(slug,platform)
WHERE c.status='active' AND c.platform<>'gusto' ORDER BY c.platform,c.slug`;

export async function readAtsWorkloadSnapshot(client: PrismaClient, now = new Date()): Promise<AtsWorkloadBoard[]> {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
    await transaction.$executeRaw`SET LOCAL statement_timeout = '45s'`;
    // Constant, repository-owned SQL; the date is a bound parameter.
    // Date parameters bind as timestamptz, but these columns hold UTC timestamp
    // values. ISO text plus an explicit cast avoids the session timezone offset.
    return transaction.$queryRawUnsafe<AtsWorkloadBoard[]>(ATS_WORKLOAD_SNAPSHOT_SQL, now.toISOString());
  }, { timeout: 50_000 });
}

/** Discovery reserves its share under the same short lock used by the review. */
export async function reserveNewAtsRotationDay(
  client: Pick<Prisma.TransactionClient, '$executeRaw' | 'atsRotationBalanceState'>,
  board: { slug: string; platform: string }, jobsFound: number | undefined, now: Date,
): Promise<number> {
  const fallback = assignedRotationDay(board.slug, board.platform);
  if (!isAtsBoardEnabledForIngestion(board)) return fallback;
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ATS_ROTATION_BALANCE_LOCK}, 0))`;
  const state = await client.atsRotationBalanceState.findUnique({ where: { id: STATE_ID } });
  // Until the first report initializes the cache, discovery retains its
  // previous behavior. A stale estimate never prevents first collection.
  if (!state || now.valueOf() - state.refreshedAt.valueOf() > 36 * 60 * 60_000) return fallback;
  const days = state.days as unknown as AtsWorkloadDay[];
  const profiles = state.profiles as unknown as AtsWorkloadProfiles;
  const day = lightestAtsWorkloadDay(board.slug, board.platform, days);
  const cost = estimateNewAtsBoardWorkload(board.platform, jobsFound, profiles);
  const reserved = days.map((entry) => entry.day === day
    ? { ...entry, boards: entry.boards + 1, workerMs: entry.workerMs + cost } : entry);
  await client.atsRotationBalanceState.update({
    where: { id: STATE_ID }, data: { days: reserved as unknown as Prisma.InputJsonValue },
  });
  return day;
}

/** A failed guarded review is evidence to retry, not a completed weekly review. */
export function atsRotationReviewWasIncomplete(report: unknown, reviewedAt: Date): boolean {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  const saved = report as Record<string, unknown>;
  return saved.mode === 'apply' && saved.reviewDue === true
    && saved.observedAt === reviewedAt.toISOString()
    && Array.isArray(saved.moves) && saved.moves.length > 0
    && Array.isArray(saved.appliedMoves) && saved.appliedMoves.length === 0
    && saved.appliedVarianceImprovement === 0 && saved.writesPerformed === 2
    && (saved.reviewOutcome === undefined || saved.reviewOutcome === 'deferred');
}

/** Daily refresh; a successful or valid zero-plan review consumes the weekly interval. */
export async function reviewAtsRotationWorkload(client: PrismaClient, apply: boolean, now = new Date()) {
  const snapshot = await readAtsWorkloadSnapshot(client, now);
  const plan = planAtsRotationWorkload(snapshot, now);
  if (!apply) return { mode: 'preview', ...plan, appliedMoves: [], writesPerformed: 0 };

  return client.$transaction(async (transaction) => {
    // Snapshot work happens outside this short lock. A concurrent completed
    // review supersedes this snapshot, rather than overwriting its moves.
    await transaction.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ATS_ROTATION_BALANCE_LOCK}, 0))`;
    const prior = await transaction.atsRotationBalanceState.findUnique({ where: { id: STATE_ID } });
    const latestRun = await transaction.atsRotationBalanceRun.findFirst({ orderBy: { createdAt: 'desc' } });
    if (latestRun && latestRun.createdAt > now) {
      return { mode: 'superseded', ...plan, appliedMoves: [], writesPerformed: 0 };
    }
    // Daily refreshes may be newer than the review that set the weekly clock.
    // Inspect its exact receipt so an unsuccessful review remains retryable.
    const priorReview = prior?.lastRebalancedAt
      ? await transaction.atsRotationBalanceRun.findFirst({
        where: { report: { path: ['observedAt'], equals: prior.lastRebalancedAt.toISOString() } },
        orderBy: { createdAt: 'desc' },
      }) : null;
    const priorReviewIncomplete = Boolean(prior?.lastRebalancedAt
      && atsRotationReviewWasIncomplete(priorReview?.report, prior.lastRebalancedAt));
    // Read only the small board metadata under the reservation lock. Include
    // new discoveries and current weekdays/statuses without repeating the
    // expensive worker-receipt scan or losing their reserved workload.
    const currentBoards = await transaction.atsCompany.findMany({
      where: { status: 'active', platform: { not: 'gusto' } },
      select: { slug: true, platform: true, checkDay: true, jobsFound: true },
    });
    const observations = new Map(snapshot.map((board) => [JSON.stringify([board.slug, board.platform]), board]));
    const currentBefore: AtsWorkloadDay[] = ATS_ROTATION_DAY_NAMES.map((dayName, day) => ({ day, dayName, boards: 0, workerMs: 0 }));
    let currentMeasuredBoards = 0;
    for (const board of currentBoards) {
      if (!isAtsBoardEnabledForIngestion(board) || !currentBefore[board.checkDay]) continue;
      const observation = observations.get(JSON.stringify([board.slug, board.platform]));
      currentBefore[board.checkDay].boards += 1;
      const estimate = observation ? estimateAtsBoardWorkload(observation, plan.profiles, now)
        : { workerMs: estimateNewAtsBoardWorkload(board.platform, board.jobsFound, plan.profiles), measured: false };
      currentBefore[board.checkDay].workerMs += estimate.workerMs;
      currentMeasuredBoards += Number(estimate.measured);
    }
    const reviewDue = prior?.lastRebalancedAt == null || priorReviewIncomplete
      || now.valueOf() - prior.lastRebalancedAt.valueOf() >= ATS_ROTATION_BALANCE_POLICY.reviewIntervalMs;
    const appliedMoves = [];
    let attemptedMoves = 0;
    let guardedOutMoves = 0;
    let rolledBackMoves = 0;
    const days = currentBefore.map((day) => ({ ...day }));
    const currentMoveLimit = Math.min(ATS_ROTATION_BALANCE_POLICY.maximumMoves,
      Math.floor(currentBefore.reduce((sum, day) => sum + day.boards, 0) * ATS_ROTATION_BALANCE_POLICY.maximumBoardFraction));
    await transaction.$executeRawUnsafe('SAVEPOINT rotation_moves');
    if (reviewDue && summarizeAtsWorkload(currentBefore).maxDeviation > ATS_ROTATION_BALANCE_POLICY.triggerDeviation) for (const move of plan.moves) {
      if (appliedMoves.length >= currentMoveLimit) break;
      if (days[move.fromDay].workerMs - days[move.toDay].workerMs <= move.workerMs) continue;
      // Conditional row update fences against acquisition admitting a board,
      // finishing a cycle, applying backoff, or an operator changing it after
      // the preview. Only weekday/date metadata may change.
      attemptedMoves++;
      const rows = await transaction.$queryRaw<Array<{ slug: string }>>(Prisma.sql`
        UPDATE "AtsCompany" c SET "checkDay"=${move.toDay}, "nextCheckDate"=${move.nextCheckDate.toISOString()}::timestamp,
          "rotationMovedAt"=${now.toISOString()}::timestamp
        WHERE c.slug=${move.slug} AND c.platform=${move.platform} AND c.status='active'
          AND c."checkDay"=${move.fromDay} AND c."nextCheckDate"=${move.fromNextCheckDate.toISOString()}::timestamp
          AND c."lastProcessedAt"=${move.lastProcessedAt.toISOString()}::timestamp AND c."failCount"=0 AND c."retryCount"=0
          AND (c."rotationMovedAt" IS NULL OR c."rotationMovedAt"<=${new Date(now.valueOf() - ATS_ROTATION_BALANCE_POLICY.boardMoveCooldownMs).toISOString()}::timestamp)
          AND NOT EXISTS(SELECT 1 FROM "AtsIngestionBatch" b WHERE b.slug=c.slug AND b.platform=c.platform
            AND (b.status IN ('fetching','partial','queued','processing','synchronized','reset_synchronized','reset_draining')
              OR b."leaseExpiresAt">${now.toISOString()}::timestamp OR b."acquisitionLeaseExpiresAt">${now.toISOString()}::timestamp))
        RETURNING c.slug`);
      if (!rows.length) { guardedOutMoves++; continue; }
      appliedMoves.push(move);
      days[move.fromDay].boards -= 1;
      days[move.fromDay].workerMs -= move.workerMs;
      days[move.toDay].boards += 1;
      days[move.toDay].workerMs += move.workerMs;
    }
    const variance = (rows: AtsWorkloadDay[]) => {
      const mean = rows.reduce((sum, day) => sum + day.workerMs, 0) / 7;
      return rows.reduce((sum, day) => sum + (day.workerMs - mean) ** 2, 0);
    };
    const initialVariance = variance(currentBefore);
    let appliedVarianceImprovement = initialVariance > 0
      ? (initialVariance - variance(days)) / initialVariance : 0;
    if (appliedMoves.length > 0 && appliedVarianceImprovement < ATS_ROTATION_BALANCE_POLICY.minimumVarianceImprovement) {
      await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rotation_moves');
      rolledBackMoves = appliedMoves.length;
      appliedMoves.length = 0;
      days.splice(0, days.length, ...currentBefore.map((day) => ({ ...day })));
      appliedVarianceImprovement = 0;
    }
    const reviewDeferred = reviewDue && plan.moves.length > 0 && appliedMoves.length === 0;
    const reviewOutcome = !reviewDue ? 'not_due' : reviewDeferred ? 'deferred' : 'complete';
    const report = { mode: 'apply', ...plan, before: currentBefore, after: days, reviewDue, appliedMoves,
      reviewOutcome, attemptedMoves, guardedOutMoves, rolledBackMoves, priorReviewIncomplete,
      measuredBoards: currentMeasuredBoards,
      estimatedBoards: currentBefore.reduce((sum, day) => sum + day.boards, 0) - currentMeasuredBoards,
      appliedVarianceImprovement, writesPerformed: appliedMoves.length + 2,
      method: 'Recorded complete-cycle worker time; provider medians for unmeasured boards.' };
    await transaction.atsRotationBalanceState.upsert({
      where: { id: STATE_ID },
      create: { id: STATE_ID, days: days as unknown as Prisma.InputJsonValue,
        profiles: plan.profiles, refreshedAt: now, lastRebalancedAt: reviewDeferred ? null : now },
      update: { days: days as unknown as Prisma.InputJsonValue, profiles: plan.profiles,
        refreshedAt: now, ...(reviewDue && !reviewDeferred ? { lastRebalancedAt: now }
          : priorReviewIncomplete ? { lastRebalancedAt: null } : {}) },
    });
    await transaction.atsRotationBalanceRun.create({ data: {
      report: JSON.parse(JSON.stringify(report)) as Prisma.InputJsonValue,
    } });
    return report;
  }, { timeout: 30_000 });
}
