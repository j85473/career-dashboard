export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { NextResponse } from 'next/server';

import { actionableQueueWhereWithCurrentAimSuppressions, logWhere } from '@/lib/jobListQuery';
import { prisma } from '@/lib/prisma';
import { currentAimSuppressedJobIds } from '@/lib/currentAimFailureSuppression';
import { INDEED12_BUDGET_PROVIDER } from '@/lib/ingestionControl';
import { evaluateAtsCoverageSlo } from '@/lib/atsCoverageSlo';
import { atsRotationCycleCutoff, requiredAtsBoardChecksPerDay } from '@/lib/atsRotation';
import { ATS_SPLIT_INGESTION_ENABLED } from '@/lib/ingestionTaskCatalog';
import { operationalQueueWhere } from '@/lib/operationalQueue';
import { currentScoringInputVersions } from '@/lib/scoringInputVersions';
import {
  enteredInboxCount,
  ingestionOutcomesReconcile,
  known,
  numberFromDatabase,
  preciseRate,
  safeRate,
  stageMetric,
  trackingCoverage,
  unavailable,
} from '@/lib/statsDashboard';
import { currentScoreScope } from '@/lib/statsScoringScope';
import { isEnrichmentSubSource } from '@/lib/ingestionSourceKind';
import { createLatestSuccessfulSnapshot } from '@/lib/serverSnapshotCache';

type DatabaseRow = Record<string, unknown>;

const CHICAGO_TIME_ZONE = 'America/Chicago';
const STATS_SNAPSHOT_FRESH_MS = 60_000;

type SerializedStatsResponse = {
  body: string;
  status: number;
  headers: Record<string, string>;
};

class StatsSnapshotLoadError extends Error {
  constructor(readonly response: SerializedStatsResponse) {
    super(`Stats snapshot returned HTTP ${response.status}`);
  }
}
function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function databaseDay(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function sumDaily(rows: Array<Record<string, number | string | boolean>>, days: number) {
  const selected = rows.slice(0, days);
  const sum = (field: string) => selected.reduce((total, row) => total + numberFromDatabase(row[field]), 0);
  const seen = sum('seen');
  const ingested = sum('ingested');
  const localPassed = sum('localPassed');
  const aePassed = sum('passedAE');
  const enteredInbox = sum('inbox');
  return {
    days,
    seen,
    ingested,
    duplicates: sum('duplicates'),
    ingestionFiltered: sum('ingestionFiltered'),
    processingErrors: sum('processingErrors'),
    providerErrors: sum('sourceErrors'),
    localPassed,
    localRejected: sum('localRejected'),
    aePassed,
    aeRejected: sum('rejectedAE'),
    humanPromoted: sum('humanPromoted'),
    humanRejected: sum('humanRejected'),
    enteredInbox,
    localStageThroughputRatio: safeRate(localPassed, ingested),
    aePassRate: safeRate(aePassed, aePassed + sum('rejectedAE')),
    // Inbox admissions are a few dozen against a six-figure denominator.
    // safeRate rounds that to "0%", which reads as "nothing got through".
    inboxStageThroughputRatio: preciseRate(enteredInbox, seen),
    unreconciledRuns: sum('unreconciledRuns'),
  };
}

async function buildStatsResponse() {
  try {
    const [[controlState], resolvedAimSuppressedJobIds] = await Promise.all([
      prisma.$queryRaw<Array<{
        available: boolean;
        atsSplitAvailable: boolean;
        atsLedgerAvailable: boolean;
      }>>`
        SELECT (
          to_regclass('"IngestionTask"') IS NOT NULL
          AND to_regclass('"ProviderCircuit"') IS NOT NULL
          AND to_regclass('"ProviderIncident"') IS NOT NULL
          AND to_regclass('"JobPipelineEvent"') IS NOT NULL
        ) AS available,
        (
          to_regclass('"AtsBoardCheckAttempt"') IS NOT NULL
          AND to_regclass('"AtsIngestionBatch"') IS NOT NULL
        ) AS "atsSplitAvailable",
        (
          to_regclass('"AtsEndpointDailyContactReceipt"') IS NOT NULL
          AND to_regclass('"AtsAcquisitionRuntimeGate"') IS NOT NULL
        ) AS "atsLedgerAvailable";
      `,
      currentAimSuppressedJobIds(prisma),
    ]);
    const ingestionControlAvailable = controlState?.available === true;
    const atsSplitTelemetryAvailable = controlState?.atsSplitAvailable === true;
    const atsLedgerTelemetryAvailable = controlState?.atsLedgerAvailable === true;
    const scoringInputVersions = currentScoringInputVersions();

    // Keep this small compatibility read ahead of the large operational
    // fan-out below. Adding it to the nested ATS Promise.all increased the
    // cold snapshot's simultaneous connection demand beyond the production
    // Prisma pool and could make activation fail with P2024 even though every
    // individual query was valid.
    const atsExactContactRows = atsLedgerTelemetryAvailable
      ? await prisma.$queryRaw<DatabaseRow[]>`
          WITH chicago_day AS (
            SELECT (CURRENT_TIMESTAMP AT TIME ZONE ${CHICAGO_TIME_ZONE})::date AS "localDay"
          )
          SELECT
            COUNT(*) FILTER (
              WHERE contact."contactKind" = 'new_cycle_listing'
            )::int AS "newCycleListingContactedToday",
            COUNT(*) FILTER (
              WHERE contact."contactKind" = 'listing_continuation'
            )::int AS "listingContinuationContactedToday",
            (
              SELECT gate."v2AuthorityActivatedAt"
              FROM "AtsAcquisitionRuntimeGate" gate
              WHERE gate.id = 'global'
            ) AS "contactMetricEffectiveAt",
            (
              SELECT COUNT(*)::int FROM "AtsIngestionBatch" batch
              WHERE batch."writerMode" = 'v2'
                AND batch.status IN ('fetching', 'partial', 'synchronized')
            ) AS "v2ActiveBatches",
            (
              SELECT COALESCE(SUM(GREATEST(
                batch."rawObservationCount"
                  - batch."compactedOccurrenceCount"
                  - batch."publishedItemCount",
                0
              )), 0)::bigint
              FROM "AtsIngestionBatch" batch
              WHERE batch."writerMode" = 'v2'
                AND batch.status IN ('fetching', 'partial', 'synchronized')
            ) AS "v2StagingItems",
            (
              SELECT COALESCE(SUM(batch."acquisitionBytes"), 0)::bigint
              FROM "AtsIngestionBatch" batch
              WHERE batch."writerMode" = 'v2'
                AND batch.status IN ('fetching', 'partial', 'synchronized')
            ) AS "v2StagingBytes",
            (
              SELECT COALESCE(SUM(GREATEST(segment."itemCount" - segment."processingOffset", 0)), 0)::bigint
              FROM "AtsIngestionSegment" segment
              WHERE segment.status IN ('published', 'processing')
            ) AS "v2SegmentBackpressureJobs",
            (
              SELECT COALESCE(SUM(GREATEST(
                batch."terminalItemCount" - batch."sealedItemCount", 0
              )), 0)::bigint
              FROM "AtsIngestionBatch" batch
              WHERE batch."writerMode" = 'v2'
                AND batch.status IN ('fetching', 'partial', 'synchronized')
            ) AS "v2TerminalUnsealedJobs",
            (
              SELECT COALESCE(SUM(segment."itemCount"), 0)::bigint
              FROM "AtsIngestionSegment" segment
              WHERE segment.status = 'sealed'
            ) AS "v2SealedUnpublishedJobs",
            (SELECT COUNT(*)::int FROM "AtsIngestionSegment" WHERE status = 'sealed') AS "v2SealedSegments",
            (SELECT COUNT(*)::int FROM "AtsIngestionSegment" WHERE status = 'published') AS "v2PublishedSegments",
            (SELECT COUNT(*)::int FROM "AtsIngestionSegment" WHERE status = 'processing') AS "v2ProcessingSegments",
            (SELECT COUNT(*)::int FROM "AtsIngestionSegment" WHERE status = 'processed') AS "v2ProcessedSegments",
            (
              SELECT gate."publicationPaused"
              FROM "AtsAcquisitionRuntimeGate" gate
              WHERE gate.id = 'global'
            ) AS "v2PublicationPaused",
            (
              SELECT gate."admissionState"
              FROM "AtsAcquisitionRuntimeGate" gate
              WHERE gate.id = 'global'
            ) AS "admissionState",
            (
              SELECT gate."distributedAuthorityActivatedAt"
              FROM "AtsAcquisitionRuntimeGate" gate
              WHERE gate.id = 'global'
            ) AS "distributedAuthorityActivatedAt",
            (
              SELECT gate."remoteWorkersEnabled"
              FROM "AtsAcquisitionRuntimeGate" gate
              WHERE gate.id = 'global'
            ) AS "remoteWorkersEnabled",
            (
              SELECT gate."globalSlotLimit"
              FROM "AtsAcquisitionRuntimeGate" gate
              WHERE gate.id = 'global'
            ) AS "globalSlotLimit",
            (
              SELECT gate."localSlotReserve"
              FROM "AtsAcquisitionRuntimeGate" gate
              WHERE gate.id = 'global'
            ) AS "localSlotReserve",
            (
              SELECT COUNT(*)::int FROM "AtsAcquisitionWorkerSlot" slot
              WHERE slot."workerKind" = 'pi-acquisition'
                AND slot."leaseExpiresAt" > CURRENT_TIMESTAMP
            ) AS "activePiSlots",
            (
              SELECT COUNT(*)::int FROM "AtsAcquisitionWorkerSlot" slot
              WHERE slot."workerKind" = 'mac-continuation'
                AND slot."leaseExpiresAt" > CURRENT_TIMESTAMP
            ) AS "activeMacSlots",
            (
              SELECT gate."cutoverReadyAt"
              FROM "AtsAcquisitionRuntimeGate" gate
              WHERE gate.id = 'global'
            ) AS "cutoverReadyAt"
          FROM "AtsEndpointDailyContactReceipt" contact, chicago_day
          WHERE contact."localDay" = chicago_day."localDay";
        `
      : [{
          newCycleListingContactedToday: 0,
          listingContinuationContactedToday: 0,
          contactMetricEffectiveAt: null,
          v2ActiveBatches: 0,
          v2StagingItems: 0,
          v2StagingBytes: 0,
          v2SegmentBackpressureJobs: 0,
          v2TerminalUnsealedJobs: 0,
          v2SealedUnpublishedJobs: 0,
          v2PublishedUnpersistedJobs: 0,
          v2SealedSegments: 0,
          v2PublishedSegments: 0,
          v2ProcessingSegments: 0,
          v2ProcessedSegments: 0,
          v2PublicationPaused: false,
          admissionState: 'open',
          distributedAuthorityActivatedAt: null,
          remoteWorkersEnabled: false,
          globalSlotLimit: 4,
          localSlotReserve: 0,
          activePiSlots: 0,
          activeMacSlots: 0,
          cutoverReadyAt: null,
        }] as DatabaseRow[];

    const basicQueries = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return Promise.all([
      tx.job.count(),
      tx.job.groupBy({ by: ['status'], _count: true }),
      tx.job.groupBy({ by: ['source'], _count: true }),
      ingestionControlAvailable ? tx.$queryRaw<DatabaseRow[]>`
        WITH ${currentScoreScope(scoringInputVersions)}
        SELECT
          (SELECT ROUND(AVG("aimFitScore"), 1)::float FROM current_aim) AS "averageAim",
          (SELECT ROUND(AVG("experienceFitScore"), 1)::float FROM current_experience) AS "averageExperience",
          (SELECT COUNT(*) FROM current_aim)::int AS "aimPopulation",
          (SELECT COUNT(*) FROM current_experience)::int AS "experiencePopulation";
      ` : Promise.resolve([{
        averageAim: null, averageExperience: null, aimPopulation: 0, experiencePopulation: 0,
      }] as DatabaseRow[]),
      tx.atsCompany.count(),
      tx.atsCompany.groupBy({ by: ['status'], _count: true }),
      tx.atsCompany.groupBy({ by: ['platform', 'status'], _count: true }),
      // Boards the ingestion pipeline will actually call. jobIngestion.ts polls
      // every status on a backoff, so "how many endpoints do I have" is the
      // whole table, not the 'active' slice the old headline reported.
      tx.atsCompany.count({ where: { nextCheckDate: { lte: new Date() } } }),
      tx.atsCompany.aggregate({ _sum: { jobsFound: true } }),
      // Coverage SLO inputs. `stale` is the slice that has been due longer than
      // the objective allows, which is what makes a growing backlog visible
      // rather than just large.
      Promise.all([
        tx.atsCompany.count({ where: { status: 'active' } }),
        tx.atsCompany.count({
          where: { status: 'active', lastCheckedAt: { gte: atsRotationCycleCutoff(new Date()) } },
        }),
        tx.atsCompany.count({ where: { status: 'active', lastCheckedAt: null } }),
        tx.atsCompany.findFirst({
          where: { status: 'active', lastCheckedAt: { not: null } },
          orderBy: { lastCheckedAt: 'asc' },
          select: { lastCheckedAt: true },
        }),
        tx.atsCompany.groupBy({
          by: ['checkDay'],
          where: { status: 'active' },
          _count: true,
        }),
      ]),
      atsSplitTelemetryAvailable ? Promise.all([
        tx.$queryRaw<DatabaseRow[]>`
          WITH chicago_day AS (
            SELECT (CURRENT_TIMESTAMP AT TIME ZONE ${CHICAGO_TIME_ZONE})::date AS "localDay"
          ),
          params AS (
            SELECT
              (("localDay"::timestamp AT TIME ZONE ${CHICAGO_TIME_ZONE}) AT TIME ZONE 'UTC') AS "dayStartUtc",
              ((("localDay" + 1)::timestamp AT TIME ZONE ${CHICAGO_TIME_ZONE}) AT TIME ZONE 'UTC') AS "dayEndUtc"
            FROM chicago_day
          ),
          daily_events AS (
            SELECT attempt.slug, attempt.platform, 'attempted'::text AS kind
            FROM "AtsBoardCheckAttempt" attempt, params
            WHERE attempt."contactedAt" >= params."dayStartUtc"
              AND attempt."contactedAt" < params."dayEndUtc"
            UNION ALL
            SELECT attempt.slug, attempt.platform, 'responded'::text AS kind
            FROM "AtsBoardCheckAttempt" attempt, params
            WHERE attempt."respondedAt" >= params."dayStartUtc"
              AND attempt."respondedAt" < params."dayEndUtc"
            UNION ALL
            SELECT attempt.slug, attempt.platform, 'synchronized'::text AS kind
            FROM "AtsBoardCheckAttempt" attempt, params
            WHERE attempt."synchronizedAt" >= params."dayStartUtc"
              AND attempt."synchronizedAt" < params."dayEndUtc"
            UNION ALL
            SELECT attempt.slug, attempt.platform, 'processed'::text AS kind
            FROM "AtsBoardCheckAttempt" attempt, params
            WHERE attempt."processedAt" >= params."dayStartUtc"
              AND attempt."processedAt" < params."dayEndUtc"
            UNION ALL
            SELECT attempt.slug, attempt.platform, 'failed'::text AS kind
            FROM "AtsBoardCheckAttempt" attempt, params
            WHERE attempt.outcome IN ('timeout', 'throttled', 'error')
              AND attempt."finishedAt" >= params."dayStartUtc"
              AND attempt."finishedAt" < params."dayEndUtc"
          )
          SELECT
            COUNT(DISTINCT (event.slug, event.platform)) FILTER (WHERE event.kind = 'attempted')::int AS "attemptedToday",
            COUNT(DISTINCT (event.slug, event.platform)) FILTER (WHERE event.kind = 'attempted')::int AS "legacyClaimContactedToday",
            COUNT(DISTINCT (event.slug, event.platform)) FILTER (WHERE event.kind = 'responded')::int AS "respondedToday",
            COUNT(DISTINCT (event.slug, event.platform)) FILTER (WHERE event.kind = 'synchronized')::int AS "synchronizedToday",
            COUNT(DISTINCT (event.slug, event.platform)) FILTER (WHERE event.kind = 'processed')::int AS "processedToday",
            COUNT(DISTINCT (event.slug, event.platform)) FILTER (WHERE event.kind = 'failed')::int AS "failedToday"
          FROM daily_events event;
        `,
        // Only live or actionable queue states belong in the operational
        // snapshot. Processed history remains durable but is not recounted on
        // every 30-second Stats refresh.
        tx.atsIngestionBatch.groupBy({
          by: ['status'],
          where: { status: { in: ['fetching', 'partial', 'queued', 'processing', 'failed'] } },
          _count: true,
        }),
        tx.atsCompany.aggregate({
          _max: {
            lastAttemptedAt: true,
            lastRespondedAt: true,
            lastSynchronizedAt: true,
            lastProcessedAt: true,
          },
        }),
        tx.$queryRaw<DatabaseRow[]>`
          SELECT
            COALESCE(
              SUM(GREATEST(batch."jobCount" - batch."processingOffset", 0))
                FILTER (WHERE batch.status IN ('fetching', 'partial', 'queued', 'processing')),
              0
            )::bigint AS "remainingJobs",
            -- The subset acquisition backpressure actually gates on. A
            -- fetching/partial batch is still listing, so its jobs are not yet
            -- pressure on the persistence stage and must not read as such.
            COALESCE(
              SUM(GREATEST(batch."jobCount" - batch."processingOffset", 0))
                FILTER (WHERE batch.status IN ('queued', 'processing')),
              0
            )::bigint AS "backpressureJobs",
            MIN(batch."synchronizedAt")
              FILTER (WHERE batch.status IN ('queued', 'processing')) AS "oldestSynchronizedAt",
            COALESCE(
              SUM(batch."jobCount")
                FILTER (WHERE batch."processedAt" >= CURRENT_TIMESTAMP - INTERVAL '1 hour'),
              0
            )::bigint AS "processedJobsLastHour",
            COALESCE(
              SUM(
                CASE
                  WHEN batch.metadata #>> '{__careerDashboardAtsPrequeueCompaction,fetchedJobCount}' ~ '^[0-9]+$'
                    THEN (batch.metadata #>> '{__careerDashboardAtsPrequeueCompaction,fetchedJobCount}')::bigint
                  ELSE batch."jobCount"
                END
              ) FILTER (WHERE batch."synchronizedAt" >= CURRENT_TIMESTAMP - INTERVAL '1 hour'),
              0
            )::bigint AS "fetchedJobsLastHour",
            COALESCE(
              SUM(batch."jobCount")
                FILTER (WHERE batch."synchronizedAt" >= CURRENT_TIMESTAMP - INTERVAL '1 hour'),
              0
            )::bigint AS "queuedJobsLastHour",
            COALESCE(
              SUM(
                CASE
                  WHEN batch.metadata #>> '{__careerDashboardAtsPrequeueCompaction,prequeueExactDuplicateCount}' ~ '^[0-9]+$'
                    THEN (batch.metadata #>> '{__careerDashboardAtsPrequeueCompaction,prequeueExactDuplicateCount}')::bigint
                  ELSE 0
                END
              ) FILTER (WHERE batch."synchronizedAt" >= CURRENT_TIMESTAMP - INTERVAL '1 hour'),
              0
            )::bigint AS "prequeueDuplicatesLastHour",
            (
              SELECT COUNT(*)::bigint
              FROM "AtsBoardCheckAttempt" attempt
              WHERE attempt.outcome = 'deferred'
                AND attempt."contactedAt" IS NULL
                AND attempt."finishedAt" >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
            ) AS "deferredWithoutContactLastHour"
          FROM "AtsIngestionBatch" batch;
        `,
      ]) : Promise.resolve([
        [{
          attemptedToday: 0,
          legacyClaimContactedToday: 0,
          respondedToday: 0,
          synchronizedToday: 0,
          processedToday: 0,
          failedToday: 0,
        }] as DatabaseRow[],
        [] as Array<{ status: string; _count: number }>,
        {
          _max: {
            lastAttemptedAt: null,
            lastRespondedAt: null,
            lastSynchronizedAt: null,
            lastProcessedAt: null,
          },
        },
        [{
          remainingJobs: 0,
          backpressureJobs: 0,
          oldestSynchronizedAt: null,
          processedJobsLastHour: 0,
          fetchedJobsLastHour: 0,
          queuedJobsLastHour: 0,
          prequeueDuplicatesLastHour: 0,
          deferredWithoutContactLastHour: 0,
        }] as DatabaseRow[],
      ]),
      tx.pipelineState.findUnique({ where: { id: 'global' } }),
      tx.scoringBatch.findFirst({
        orderBy: { createdAt: 'desc' },
        include: { items: { select: { status: true } } },
      }),
      Promise.all([
        tx.job.count({ where: operationalQueueWhere('local_scoring', resolvedAimSuppressedJobIds) }),
        tx.job.count({ where: operationalQueueWhere('needs_jd', resolvedAimSuppressedJobIds) }),
        tx.job.count({ where: operationalQueueWhere('aim_fit', resolvedAimSuppressedJobIds) }),
        tx.job.count({ where: operationalQueueWhere('experience_fit', resolvedAimSuppressedJobIds) }),
        tx.job.count({ where: logWhere('context') }),
        tx.job.count({
          where: actionableQueueWhereWithCurrentAimSuppressions(resolvedAimSuppressedJobIds),
        }),
      ]),
      ]);
    }, { maxWait: 10_000, timeout: 90_000 });

    const legacyRecentRuns = ingestionControlAvailable
      ? Promise.resolve([] as DatabaseRow[])
      : prisma.ingestionSourceRun.findMany({
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: {
            id: true,
            source: true,
            status: true,
            seenCount: true,
            insertedCount: true,
            duplicateCount: true,
            filteredCount: true,
            errorCount: true,
            error: true,
            finishedAt: true,
            durationMs: true,
            createdAt: true,
          },
        }) as unknown as Promise<DatabaseRow[]>;

    const loadControlQueries = () => ingestionControlAvailable
      ? prisma.$transaction([
          prisma.$queryRaw<DatabaseRow[]>`
            WITH params AS (
              SELECT
                (CURRENT_TIMESTAMP AT TIME ZONE ${CHICAGO_TIME_ZONE})::date AS today,
                ${CHICAGO_TIME_ZONE}::text AS "timeZone"
            ),
            control_epoch AS (
              SELECT MIN("createdAt") AS "startedAt" FROM "IngestionTask"
            ),
            days AS (
              SELECT generate_series(
                (SELECT today - 29 FROM params),
                (SELECT today FROM params),
                INTERVAL '1 day'
              )::date AS date
            ),
            runs AS (
              SELECT
                DATE(source_run."startedAt" AT TIME ZONE 'UTC' AT TIME ZONE params."timeZone") AS date,
                COALESCE(SUM(source_run."seenCount"), 0)::int AS seen,
                COALESCE(SUM(source_run."insertedCount"), 0)::int AS ingested,
                COALESCE(SUM(source_run."duplicateCount"), 0)::int AS duplicates,
                COALESCE(SUM(source_run."filteredCount"), 0)::int AS filtered,
                COALESCE(SUM(source_run."processingErrorCount"), 0)::int AS "processingErrors",
                COALESCE(SUM(source_run."requestErrorCount"), 0)::int AS "providerErrors",
                COUNT(*) FILTER (
                  WHERE source_run."ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                    OR source_run.checkpoint #>> '{queuedJobCount}' = '0'
                )::int AS "runCount",
                COUNT(*) FILTER (
                  WHERE (
                    source_run."ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                    OR source_run.checkpoint #>> '{queuedJobCount}' = '0'
                  ) AND NOT source_run.reconciled
                )::int AS "unreconciledRuns",
                COALESCE(BOOL_AND(source_run.reconciled) FILTER (
                  WHERE source_run."ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                    OR source_run.checkpoint #>> '{queuedJobCount}' = '0'
                ), true) AS "allRunsReconciled"
              FROM "IngestionSourceRun" source_run, params, control_epoch
              WHERE DATE(source_run."startedAt" AT TIME ZONE 'UTC' AT TIME ZONE params."timeZone") >= params.today - 29
                AND control_epoch."startedAt" IS NOT NULL
                AND source_run."startedAt" >= control_epoch."startedAt"
              GROUP BY DATE(source_run."startedAt" AT TIME ZONE 'UTC' AT TIME ZONE params."timeZone")
            ),
            events AS (
              SELECT
                DATE("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE params."timeZone") AS date,
                COUNT(*) FILTER (WHERE "eventType" = 'local_pass')::int AS "localPassed",
                COUNT(*) FILTER (WHERE "eventType" = 'local_reject')::int AS "localRejected",
                COUNT(*) FILTER (WHERE "eventType" = 'ae_pass')::int AS "passedAE",
                COUNT(*) FILTER (WHERE "eventType" = 'ae_reject')::int AS "rejectedAE",
                COUNT(*) FILTER (
                  WHERE "eventType" = 'ae_pass'
                    AND details @> '{"enteredInbox": true}'::jsonb
                )::int AS "aeInboxAdmissions",
                COUNT(*) FILTER (WHERE "eventType" = 'user_promote')::int AS "humanPromoted",
                COUNT(*) FILTER (WHERE "eventType" = 'user_reject')::int AS "humanRejected",
                COUNT(*) FILTER (WHERE "eventType" = 'jd_failed')::int AS "jdFailed"
              FROM "JobPipelineEvent", params
              WHERE DATE("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE params."timeZone") >= params.today - 29
              GROUP BY DATE("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE params."timeZone")
            )
            SELECT
              days.date,
              COALESCE(runs.seen, 0)::int AS seen,
              COALESCE(runs.ingested, 0)::int AS ingested,
              COALESCE(runs.duplicates, 0)::int AS duplicates,
              COALESCE(runs.filtered, 0)::int AS "ingestionFiltered",
              COALESCE(runs."processingErrors", 0)::int AS "processingErrors",
              COALESCE(runs."providerErrors", 0)::int AS "sourceErrors",
              COALESCE(runs."runCount", 0)::int AS "runCount",
              COALESCE(runs."unreconciledRuns", 0)::int AS "unreconciledRuns",
              COALESCE(runs."allRunsReconciled", true) AS "allRunsReconciled",
              COALESCE(events."localPassed", 0)::int AS "localPassed",
              COALESCE(events."localRejected", 0)::int AS "localRejected",
              COALESCE(events."passedAE", 0)::int AS "passedAE",
              COALESCE(events."rejectedAE", 0)::int AS "rejectedAE",
              COALESCE(events."aeInboxAdmissions", 0)::int AS "aeInboxAdmissions",
              COALESCE(events."humanPromoted", 0)::int AS "humanPromoted",
              COALESCE(events."humanRejected", 0)::int AS "humanRejected",
              COALESCE(events."jdFailed", 0)::int AS "jdFailed"
            FROM days
            LEFT JOIN runs ON runs.date = days.date
            LEFT JOIN events ON events.date = days.date
            ORDER BY days.date DESC;
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT
              MIN("occurredAt") AS "eventTrackingSince",
              MIN(DATE("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE ${CHICAGO_TIME_ZONE})) AS "eventTrackingDay",
              (SELECT MIN("createdAt") FROM "IngestionTask") AS "ingestionTrackingSince",
              (SELECT MIN(DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${CHICAGO_TIME_ZONE}))
                FROM "IngestionTask") AS "ingestionTrackingDay"
            FROM "JobPipelineEvent";
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            WITH params AS (
              -- Prisma persists DateTime as a UTC-valued timestamp without a
              -- time zone. Compare it with the UTC wall clock so the database
              -- session time zone cannot shift runnable/lease classification.
              SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"
            ),
            availability AS (
              SELECT task.*,
                GREATEST(
                  task."nextRunAt",
                  CASE WHEN circuit.state = 'open' AND circuit."openUntil" > params."utcNow"
                    THEN circuit."openUntil" ELSE task."nextRunAt" END,
                  CASE WHEN budget_circuit."monthlyLimit" IS NOT NULL
                    AND budget_circuit."budgetMonth" = TO_CHAR(params."utcNow", 'YYYY-MM')
                    AND budget_circuit."monthlyUsed" >= budget_circuit."monthlyLimit"
                    THEN DATE_TRUNC('month', params."utcNow") + INTERVAL '1 month' ELSE task."nextRunAt" END,
                  CASE WHEN budget_circuit."dailyLimit" IS NOT NULL
                    AND budget_circuit."budgetDay" = TO_CHAR(params."utcNow", 'YYYY-MM-DD')
                    AND budget_circuit."dailyUsed" >= budget_circuit."dailyLimit"
                    THEN DATE_TRUNC('day', params."utcNow") + INTERVAL '1 day' ELSE task."nextRunAt" END
                ) AS "availableAt",
                CASE
                  WHEN task."taskKind" = 'orchestration' THEN 'orchestration'
                  WHEN task."lifecycleStatus" = 'retired' THEN 'retired'
                  WHEN task.status = 'running' AND (
                    task."leaseToken" IS NULL OR task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= params."utcNow"
                  ) THEN 'staleLease'
                  WHEN task.status = 'running' THEN 'running'
                  WHEN circuit.state = 'open' AND circuit."openUntil" > params."utcNow" THEN 'circuitCooldown'
                  WHEN budget_circuit."monthlyLimit" IS NOT NULL
                    AND budget_circuit."budgetMonth" = TO_CHAR(params."utcNow", 'YYYY-MM')
                    AND budget_circuit."monthlyUsed" >= budget_circuit."monthlyLimit" THEN 'budgetBlocked'
                  WHEN budget_circuit."dailyLimit" IS NOT NULL
                    AND budget_circuit."budgetDay" = TO_CHAR(params."utcNow", 'YYYY-MM-DD')
                    AND budget_circuit."dailyUsed" >= budget_circuit."dailyLimit" THEN 'budgetBlocked'
                  WHEN task.status = 'failed' AND task."nextRunAt" > params."utcNow" THEN 'failedAwaitingRetry'
                  WHEN task."nextRunAt" <= params."utcNow" AND (
                    task."leaseToken" IS NULL OR task."leaseExpiresAt" <= params."utcNow"
                  ) THEN 'runnableNow'
                  ELSE 'scheduled'
                END AS category
              FROM "IngestionTask" task
              LEFT JOIN "ProviderCircuit" circuit ON circuit.provider = task.source
              LEFT JOIN "ProviderCircuit" budget_circuit ON budget_circuit.provider = CASE
                WHEN task.source = 'Indeed' THEN ${INDEED12_BUDGET_PROVIDER}
                ELSE task.source
              END
              CROSS JOIN params
            )
            SELECT
              COUNT(*) FILTER (WHERE "taskKind" = 'search' AND "lifecycleStatus" = 'active')::int AS "activeSearchTasks",
              COUNT(*) FILTER (WHERE category = 'runnableNow')::int AS "runnableNow",
              COUNT(*) FILTER (WHERE category = 'running')::int AS running,
              COUNT(*) FILTER (WHERE category = 'scheduled')::int AS scheduled,
              COUNT(*) FILTER (WHERE category = 'staleLease')::int AS "staleLeases",
              COUNT(*) FILTER (WHERE category = 'circuitCooldown')::int AS "circuitCooldown",
              COUNT(*) FILTER (WHERE category = 'budgetBlocked')::int AS "budgetBlocked",
              COUNT(*) FILTER (WHERE status = 'failed' AND "taskKind" = 'search' AND "lifecycleStatus" = 'active')::int AS failed,
              COUNT(*) FILTER (WHERE category = 'failedAwaitingRetry')::int AS "failedAwaitingRetry",
              COUNT(*) FILTER (WHERE category = 'retired')::int AS retired,
              COUNT(*) FILTER (WHERE category = 'orchestration')::int AS orchestration,
              MIN("nextRunAt") FILTER (WHERE category = 'runnableNow') AS "oldestRunnableSince",
              MIN("availableAt") FILTER (
                WHERE category IN ('scheduled', 'circuitCooldown', 'budgetBlocked', 'failedAwaitingRetry')
              ) AS "nextRunnableAt",
              MAX("watermarkAt") FILTER (WHERE "taskKind" = 'search' AND "lifecycleStatus" = 'active') AS "latestWatermarkAt",
              MAX("updatedAt") AS "updatedAt"
            FROM availability;
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            WITH params AS (
              SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"
            ),
            availability AS (
              SELECT task.*,
                GREATEST(
                  task."nextRunAt",
                  CASE WHEN circuit.state = 'open' AND circuit."openUntil" > params."utcNow"
                    THEN circuit."openUntil" ELSE task."nextRunAt" END,
                  CASE WHEN budget_circuit."monthlyLimit" IS NOT NULL
                    AND budget_circuit."budgetMonth" = TO_CHAR(params."utcNow", 'YYYY-MM')
                    AND budget_circuit."monthlyUsed" >= budget_circuit."monthlyLimit"
                    THEN DATE_TRUNC('month', params."utcNow") + INTERVAL '1 month' ELSE task."nextRunAt" END,
                  CASE WHEN budget_circuit."dailyLimit" IS NOT NULL
                    AND budget_circuit."budgetDay" = TO_CHAR(params."utcNow", 'YYYY-MM-DD')
                    AND budget_circuit."dailyUsed" >= budget_circuit."dailyLimit"
                    THEN DATE_TRUNC('day', params."utcNow") + INTERVAL '1 day' ELSE task."nextRunAt" END
                ) AS "availableAt",
                CASE
                  WHEN task."taskKind" = 'orchestration' THEN 'orchestration'
                  WHEN task."lifecycleStatus" = 'retired' THEN 'retired'
                  WHEN task.status = 'running' AND (
                    task."leaseToken" IS NULL OR task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= params."utcNow"
                  ) THEN 'staleLease'
                  WHEN task.status = 'running' THEN 'running'
                  WHEN circuit.state = 'open' AND circuit."openUntil" > params."utcNow" THEN 'circuitCooldown'
                  WHEN budget_circuit."monthlyLimit" IS NOT NULL
                    AND budget_circuit."budgetMonth" = TO_CHAR(params."utcNow", 'YYYY-MM')
                    AND budget_circuit."monthlyUsed" >= budget_circuit."monthlyLimit" THEN 'budgetBlocked'
                  WHEN budget_circuit."dailyLimit" IS NOT NULL
                    AND budget_circuit."budgetDay" = TO_CHAR(params."utcNow", 'YYYY-MM-DD')
                    AND budget_circuit."dailyUsed" >= budget_circuit."dailyLimit" THEN 'budgetBlocked'
                  WHEN task.status = 'failed' AND task."nextRunAt" > params."utcNow" THEN 'failedAwaitingRetry'
                  WHEN task."nextRunAt" <= params."utcNow" AND (
                    task."leaseToken" IS NULL OR task."leaseExpiresAt" <= params."utcNow"
                  ) THEN 'runnableNow'
                  ELSE 'scheduled'
                END AS category
              FROM "IngestionTask" task
              LEFT JOIN "ProviderCircuit" circuit ON circuit.provider = task.source
              LEFT JOIN "ProviderCircuit" budget_circuit ON budget_circuit.provider = CASE
                WHEN task.source = 'Indeed' THEN ${INDEED12_BUDGET_PROVIDER}
                ELSE task.source
              END
              CROSS JOIN params
            )
            SELECT * FROM availability
            ORDER BY
              CASE category
                WHEN 'staleLease' THEN 0 WHEN 'running' THEN 1 WHEN 'runnableNow' THEN 2
                WHEN 'failedAwaitingRetry' THEN 3 WHEN 'circuitCooldown' THEN 4
                WHEN 'budgetBlocked' THEN 5 WHEN 'scheduled' THEN 6
                WHEN 'retired' THEN 7 ELSE 8 END,
              "nextRunAt" ASC,
              source ASC
            LIMIT 120;
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT
              provider,
              state,
              "openUntil",
              "consecutiveFailures",
              "dailyLimit",
              "monthlyLimit",
              "dailyUsed",
              "monthlyUsed",
              "budgetDay",
              "budgetMonth",
              "lastError",
              "lastFailureAt",
              "lastSuccessAt",
              "updatedAt"
            FROM "ProviderCircuit"
            ORDER BY (state <> 'closed') DESC, provider ASC;
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT
              provider,
              status,
              ARRAY_AGG(DISTINCT classification ORDER BY classification) AS classifications,
              COUNT(*)::int AS "incidentCount",
              COALESCE(SUM("affectedQueryCount"), 0)::int AS "affectedQueryCount",
              COALESCE(SUM("occurrenceCount"), 0)::int AS "occurrenceCount",
              MIN("firstSeenAt") AS "firstSeenAt",
              MAX("lastSeenAt") AS "lastSeenAt",
              (ARRAY_AGG(message ORDER BY "lastSeenAt" DESC))[1] AS message
            FROM "ProviderIncident"
            WHERE status = 'open' OR "lastSeenAt" >= NOW() - INTERVAL '7 days'
            GROUP BY provider, status
            ORDER BY (status = 'open') DESC, MAX("lastSeenAt") DESC;
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT
              source,
              MAX("createdAt") FILTER (
                WHERE "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                  OR checkpoint #>> '{queuedJobCount}' = '0'
              ) AS "lastRunAt",
              MAX("createdAt") FILTER (
                WHERE status IN ('success', 'succeeded')
                  AND (
                    "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                    OR checkpoint #>> '{queuedJobCount}' = '0'
                  )
              ) AS "lastSuccessAt",
              /**
               * The honest health signal is yield, not the status label.
               * A sweep of a 13,000-board ATS platform cannot finish inside the
               * 600s wall clock, so it ends 'partial' while still inserting
               * 50-150 jobs; meanwhile 'failed' runs inserted 12,715 jobs last
               * week and 'success' runs logged 1,844 errors. Judging on status
               * reported the three highest-yield sources as dead.
               */
              MAX("createdAt") FILTER (WHERE "insertedCount" > 0) AS "lastProductiveAt",
              COUNT(*) FILTER (
                WHERE "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                  OR checkpoint #>> '{queuedJobCount}' = '0'
              )::int AS "totalRuns",
              COUNT(*) FILTER (
                WHERE status = 'failed' AND (
                  "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                  OR checkpoint #>> '{queuedJobCount}' = '0'
                )
              )::int AS "failedRuns",
              COUNT(*) FILTER (
                WHERE status = 'partial' AND (
                  "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                  OR checkpoint #>> '{queuedJobCount}' = '0'
                )
              )::int AS "partialRuns",
              COUNT(*) FILTER (
                WHERE status = 'idle' AND (
                  "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                  OR checkpoint #>> '{queuedJobCount}' = '0'
                )
              )::int AS "idleRuns",
              COUNT(*) FILTER (WHERE "insertedCount" > 0)::int AS "productiveRuns",
              COALESCE(SUM("insertedCount"), 0)::int AS "insertedCount",
              /**
               * Needed to tell "found nothing" apart from "found only things we
               * already have". A source pulling 562 results that are all
               * duplicates is working and saturated; one pulling zero results
               * is broken. Both insert 0.
               */
              COALESCE(SUM("seenCount"), 0)::int AS "seenCount",
              COALESCE(SUM("duplicateCount"), 0)::int AS "duplicateCount",
              COALESCE(SUM("requestErrorCount"), 0)::int AS "requestErrors",
              /**
               * Recent-window counters. A resolved incident sitting three days
               * back inside the seven-day window must not outvote how the
               * source is behaving now: ATS-workday Details carried 46,415
               * errors from a circuit cascade on 08-10 while its last five runs
               * were completely clean.
               */
              COALESCE(SUM("requestErrorCount") FILTER (WHERE "createdAt" > NOW() - INTERVAL '24 hours'), 0)::int AS "recentRequestErrors",
              COUNT(*) FILTER (
                WHERE "createdAt" > NOW() - INTERVAL '24 hours'
                  AND (
                    "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                    OR checkpoint #>> '{queuedJobCount}' = '0'
                  )
              )::int AS "recentRuns",
              COUNT(*) FILTER (
                WHERE status = 'failed'
                  AND "createdAt" > NOW() - INTERVAL '24 hours'
                  AND (
                    "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                    OR checkpoint #>> '{queuedJobCount}' = '0'
                  )
              )::int AS "recentFailedRuns",
              COALESCE(SUM("processingErrorCount"), 0)::int AS "processingErrors",
              COUNT(*) FILTER (WHERE NOT reconciled)::int AS "unreconciledRuns"
            FROM "IngestionSourceRun"
            WHERE "createdAt" >= NOW() - INTERVAL '7 days'
              AND "createdAt" >= (SELECT MIN("createdAt") FROM "IngestionTask")
            GROUP BY source
            ORDER BY source ASC;
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT
              id,
              source,
              status,
              "queryFamily",
              "geoLane",
              "seenCount",
              "insertedCount",
              "duplicateCount",
              "filteredCount",
              "processingErrorCount",
              "requestErrorCount",
              reconciled,
              error,
              "finishedAt",
              "durationMs",
              "createdAt"
            FROM "IngestionSourceRun"
            WHERE "createdAt" >= (SELECT MIN("createdAt") FROM "IngestionTask")
              AND (
                "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                OR checkpoint #>> '{queuedJobCount}' = '0'
              )
            ORDER BY "createdAt" DESC
            LIMIT 30;
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            WITH ${currentScoreScope(scoringInputVersions)}, current_scores AS (
              SELECT
                "evaluationType", "promptVersion", passed,
                "aimFitScore", "experienceFitScore", "createdAt"
              FROM current_aim
              UNION ALL
              SELECT
                "evaluationType", "promptVersion", passed,
                "aimFitScore", "experienceFitScore", "createdAt"
              FROM current_experience
            )
            SELECT
              "evaluationType",
              "promptVersion",
              COUNT(*)::int AS evaluated,
              COUNT(*) FILTER (WHERE passed)::int AS passed,
              ROUND(AVG("aimFitScore"), 1)::float AS "averageAim",
              ROUND(AVG("experienceFitScore"), 1)::float AS "averageExperience",
              MIN("createdAt") AS "firstEvaluatedAt",
              MAX("createdAt") AS "lastEvaluatedAt"
            FROM current_scores
            GROUP BY "evaluationType", "promptVersion"
            ORDER BY MAX("createdAt") DESC
            LIMIT 8;
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT
              (SELECT MAX("createdAt") FROM "IngestionSourceRun") AS "sourceRunsAt",
              (SELECT MAX("occurredAt") FROM "JobPipelineEvent") AS "pipelineEventsAt",
              (SELECT MAX("createdAt") FROM "JobScoreEvent") AS "scoreEventsAt",
              (SELECT MAX("updatedAt") FROM "IngestionTask") AS "tasksAt",
              (SELECT MAX("updatedAt") FROM "ProviderCircuit") AS "circuitsAt";
          `,
          /**
           * Lifetime totals. The rolling windows answer "is it working today";
           * these answer "what has this thing done since I turned it on", which
           * no window can show and which was previously not on the page at all.
           */
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT
              (SELECT COALESCE(SUM("seenCount"), 0) FROM "IngestionSourceRun")::bigint AS "seen",
              (SELECT COALESCE(SUM("insertedCount"), 0) FROM "IngestionSourceRun")::bigint AS "ingested",
              (SELECT COALESCE(SUM("duplicateCount"), 0) FROM "IngestionSourceRun")::bigint AS "duplicates",
              (SELECT COALESCE(SUM("filteredCount"), 0) FROM "IngestionSourceRun")::bigint AS "filtered",
              (SELECT COALESCE(SUM("requestErrorCount"), 0) FROM "IngestionSourceRun")::bigint AS "providerErrors",
              (SELECT COALESCE(SUM("processingErrorCount"), 0) FROM "IngestionSourceRun")::bigint AS "processingErrors",
              (SELECT COUNT(*) FROM "IngestionSourceRun"
                WHERE "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                  OR checkpoint #>> '{queuedJobCount}' = '0')::bigint AS "runs",
              (SELECT MIN("startedAt") FROM "IngestionSourceRun") AS "firstRunAt",
              (SELECT COUNT(*) FROM "JobPipelineEvent"
                WHERE "eventType" = 'ae_pass' AND details @> '{"enteredInbox": true}'::jsonb)::bigint AS "aeInboxAdmissions",
              (SELECT COUNT(*) FROM "JobPipelineEvent" WHERE "eventType" = 'user_promote')::bigint AS "humanPromoted",
              (SELECT COUNT(*) FROM "Job" WHERE status = 'applied')::bigint AS "applied",
              (SELECT COUNT(*) FROM "Job" WHERE status = 'interviewing')::bigint AS "interviewing",
              -- Inbox admissions only exist as far back as pipeline-event
              -- tracking, which started well after ingestion did. Dividing
              -- them by all-time seen mixes two different epochs, so the
              -- comparable denominator is carried alongside.
              (SELECT MIN("occurredAt") FROM "JobPipelineEvent") AS "inboxSince",
              (SELECT COALESCE(SUM("seenCount"), 0) FROM "IngestionSourceRun"
                WHERE "startedAt" >= (SELECT MIN("occurredAt") FROM "JobPipelineEvent"))::bigint AS "seenSinceInboxTracking";
          `,
          /**
           * Whether each funnel stage has *ever* recorded an event. A stage with
           * a lifetime count of zero is not reporting a real zero — nothing is
           * emitting it. Deriving this instead of hardcoding a list means the
           * metric starts working on its own the day an emitter is added.
           */
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT "eventType", COUNT(*)::bigint AS "lifetime"
            FROM "JobPipelineEvent"
            GROUP BY "eventType";
          `,
          /** Lifetime yield per source, so a source can be judged on its whole record. */
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT
              source,
              COUNT(*) FILTER (
                WHERE "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                  OR checkpoint #>> '{queuedJobCount}' = '0'
              )::int AS "totalRuns",
              COUNT(*) FILTER (
                WHERE status = 'failed' AND (
                  "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                  OR checkpoint #>> '{queuedJobCount}' = '0'
                )
              )::int AS "failedRuns",
              COALESCE(SUM("insertedCount"), 0)::bigint AS "insertedCount",
              COALESCE(SUM("seenCount"), 0)::bigint AS "seenCount",
              COALESCE(SUM("requestErrorCount"), 0)::bigint AS "requestErrors",
              MAX("createdAt") FILTER (
                WHERE status IN ('success', 'succeeded') AND (
                  "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                  OR checkpoint #>> '{queuedJobCount}' = '0'
                )
              ) AS "lastSuccessAt",
              MIN("createdAt") FILTER (
                WHERE "ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'
                  OR checkpoint #>> '{queuedJobCount}' = '0'
              ) AS "firstRunAt"
            FROM "IngestionSourceRun"
            GROUP BY source;
          `,
        ])
      : Promise.resolve([
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
          [] as DatabaseRow[],
        ]);

    const [basicResults, legacyRuns] = await Promise.all([basicQueries, legacyRecentRuns]);
    const controlResults = await loadControlQueries();

    const [
      [
        totalJobs,
        jobsByStatus,
        jobsBySourceRaw,
        scoreStatsRows,
        totalAtsBoards,
        atsByStatusRaw,
        atsByPlatformRaw,
        atsDueNow,
        atsJobsFoundAggregate,
        atsCoverageInputs,
        atsPathInputs,
        pipelineState,
        latestScoringBatch,
        [localQueue, jdQueue, aimQueue, experienceQueue, contextQueue, actionNeededQueue],
      ],
      [
        dailyRaw,
        trackingRows,
        taskSummaryRows,
        taskRows,
        circuitRows,
        incidentRows,
        sourceHealthRows,
        recentRunRows,
        promptCohortRows,
        freshnessRows,
        allTimeRows,
        eventCoverageRows,
        sourceLifetimeRows,
      ],
    ] = [basicResults, controlResults] as const;

    /**
     * Lifetime event counts keyed by type. A stage missing from this map has
     * never fired, which is reported as "not instrumented" rather than 0.
     */
    const lifetimeEvents = new Map<string, number>(
      eventCoverageRows.map((row) => [String(row.eventType), numberFromDatabase(row.lifetime)]),
    );
    const lifetimeEventCount = (...types: string[]) => types
      .reduce((total, type) => total + (lifetimeEvents.get(type) || 0), 0);

    const aimPopulation = numberFromDatabase(scoreStatsRows[0]?.aimPopulation);
    const experiencePopulation = numberFromDatabase(scoreStatsRows[0]?.experiencePopulation);
    const averageAimFit = aimPopulation === 0
      ? unavailable('no_matching_evaluations')
      : known(numberFromDatabase(scoreStatsRows[0]?.averageAim));
    const averageExperienceFit = experiencePopulation === 0
      ? unavailable('no_matching_evaluations')
      : known(numberFromDatabase(scoreStatsRows[0]?.averageExperience));

    const allTime = allTimeRows[0] || {};
    const allTimeSeen = numberFromDatabase(allTime.seen);
    const allTimeEnteredInbox = numberFromDatabase(allTime.aeInboxAdmissions)
      + numberFromDatabase(allTime.humanPromoted);
    const seenSinceInboxTracking = numberFromDatabase(allTime.seenSinceInboxTracking);
    const allTimeTotals = {
      since: iso(allTime.firstRunAt),
      seen: allTimeSeen,
      ingested: numberFromDatabase(allTime.ingested),
      duplicates: numberFromDatabase(allTime.duplicates),
      filtered: numberFromDatabase(allTime.filtered),
      providerErrors: numberFromDatabase(allTime.providerErrors),
      processingErrors: numberFromDatabase(allTime.processingErrors),
      runs: numberFromDatabase(allTime.runs),
      enteredInbox: allTimeEnteredInbox,
      /**
       * Inbox admissions start at `inboxSince`, not at `since`. Reporting them
       * as an "all time" rate over all-time seen produced 0.002%, and dividing
       * lifetime `applied` (which predates event tracking) by lifetime inbox
       * admissions produced 1032% — a ratio above 100% is the tell that two
       * epochs were being mixed. Both rates are now scoped to the window where
       * the numerator can actually exist.
       */
      inboxSince: iso(allTime.inboxSince),
      seenSinceInboxTracking,
      inboxRate: preciseRate(allTimeEnteredInbox, seenSinceInboxTracking),
      applied: numberFromDatabase(allTime.applied),
      interviewing: numberFromDatabase(allTime.interviewing),
    };

    const sourceLifetime = new Map(sourceLifetimeRows.map((row) => [String(row.source), row]));

    const tracking = trackingRows[0] || {};
    const eventTrackingSince = iso(tracking.eventTrackingSince);
    const eventTrackingDay = tracking.eventTrackingDay ? databaseDay(tracking.eventTrackingDay) : null;
    const ingestionTrackingSince = iso(tracking.ingestionTrackingSince);
    const ingestionTrackingDay = tracking.ingestionTrackingDay ? databaseDay(tracking.ingestionTrackingDay) : null;

    const dailyActivity = dailyRaw.map((row) => {
      const date = databaseDay(row.date);
      const seen = numberFromDatabase(row.seen);
      const ingested = numberFromDatabase(row.ingested);
      const duplicates = numberFromDatabase(row.duplicates);
      const ingestionFiltered = numberFromDatabase(row.ingestionFiltered);
      const processingErrors = numberFromDatabase(row.processingErrors);
      const sourceErrors = numberFromDatabase(row.sourceErrors);
      const aeInboxAdmissions = numberFromDatabase(row.aeInboxAdmissions);
      const humanPromoted = numberFromDatabase(row.humanPromoted);
      const allRunsReconciled = row.allRunsReconciled === true;
      const arithmeticReconciles = ingestionOutcomesReconcile({
        seen,
        ingested,
        duplicates,
        filtered: ingestionFiltered,
        processingErrors,
        providerErrors: sourceErrors,
      });
      return {
        date,
        seen,
        ingested,
        duplicates,
        ingestionFiltered,
        processingErrors,
        sourceErrors,
        runCount: numberFromDatabase(row.runCount),
        unreconciledRuns: numberFromDatabase(row.unreconciledRuns),
        ingestionReconciles: allRunsReconciled && arithmeticReconciles,
        localPassed: numberFromDatabase(row.localPassed),
        localRejected: numberFromDatabase(row.localRejected),
        rejectedAE: numberFromDatabase(row.rejectedAE),
        passedAE: numberFromDatabase(row.passedAE),
        aeInboxAdmissions,
        humanPromoted,
        humanRejected: numberFromDatabase(row.humanRejected),
        jdFailed: numberFromDatabase(row.jdFailed),
        inbox: enteredInboxCount(aeInboxAdmissions, humanPromoted),
        transitionTrackingStatus: trackingCoverage(
          date,
          eventTrackingDay ? `${eventTrackingDay}T00:00:00.000Z` : null,
        ),
        ingestionTrackingStatus: trackingCoverage(
          date,
          ingestionTrackingDay ? `${ingestionTrackingDay}T00:00:00.000Z` : null,
        ),
      };
    });

    /**
     * Every status, not just active/parked. The old shape dropped 'blacklisted'
     * entirely, so roughly a third of the catalog was invisible and the
     * per-platform rows never summed to the platform's real board count.
     */
    const byPlatformMap: Record<string, { active: number; parked: number; blacklisted: number; total: number }> = {};
    for (const platform of atsByPlatformRaw) {
      byPlatformMap[platform.platform] ||= { active: 0, parked: 0, blacklisted: 0, total: 0 };
      const bucket = byPlatformMap[platform.platform];
      if (platform.status === 'active') bucket.active += platform._count;
      else if (platform.status === 'parked') bucket.parked += platform._count;
      else if (platform.status === 'blacklisted') bucket.blacklisted += platform._count;
      bucket.total += platform._count;
    }

    const atsByStatus: Record<string, number> = {};
    for (const row of atsByStatusRaw) atsByStatus[row.status] = row._count;
    const atsPathRows = atsPathInputs[0] as DatabaseRow[];
    const atsPathStatuses = atsPathInputs[1] as Array<{ status: string; _count: number }>;
    const atsPathMaxima = atsPathInputs[2] as { _max: Record<string, Date | null> };
    const atsPathOperationalRows = atsPathInputs[3] as DatabaseRow[];
    const atsPathRow = atsPathRows[0] || {};
    const atsPathOperational = atsPathOperationalRows[0] || {};
    const atsExactContacts = atsExactContactRows[0] || {};
    const atsBatchByStatus = Object.fromEntries(
      atsPathStatuses.map((row) => [row.status, row._count]),
    );

    const taskSummary = taskSummaryRows[0] || {};
    const activeTaskCategoryTotal = ['running', 'runnableNow', 'scheduled', 'staleLeases', 'circuitCooldown', 'budgetBlocked', 'failedAwaitingRetry']
      .reduce((sum, key) => sum + numberFromDatabase(taskSummary[key]), 0);
    const activeSearchTasks = numberFromDatabase(taskSummary.activeSearchTasks);
    const freshness = freshnessRows[0] || {};
    const recentIngestionRuns = (ingestionControlAvailable ? recentRunRows : legacyRuns).map((row) => ({
      id: String(row.id),
      source: String(row.source),
      status: String(row.status),
      queryFamily: row.queryFamily ? String(row.queryFamily) : null,
      geoLane: row.geoLane ? String(row.geoLane) : null,
      seenCount: numberFromDatabase(row.seenCount),
      insertedCount: numberFromDatabase(row.insertedCount),
      duplicateCount: numberFromDatabase(row.duplicateCount),
      filteredCount: numberFromDatabase(row.filteredCount),
      processingErrorCount: numberFromDatabase(row.processingErrorCount),
      requestErrorCount: ingestionControlAvailable
        ? numberFromDatabase(row.requestErrorCount)
        : numberFromDatabase(row.errorCount),
      reconciled: ingestionControlAvailable ? row.reconciled === true : false,
      error: row.error ? String(row.error) : null,
      finishedAt: iso(row.finishedAt),
      durationMs: row.durationMs == null ? null : numberFromDatabase(row.durationMs),
      createdAt: iso(row.createdAt),
    }));

    const generatedAtMs = Date.now();
    const hoursSince = (value: string | null): number | null => (
      value == null ? null : Math.max(0, (generatedAtMs - new Date(value).getTime()) / 3_600_000)
    );

    /**
     * Sources ranked by how broken they are, judged on **yield** rather than on
     * the run-status label.
     *
     * The first version of this graded on `status`, and it was badly wrong: a
     * sweep of a 13,000-board ATS platform cannot finish inside the 600s wall
     * clock, so it always ends `partial` even while inserting 50-150 jobs per
     * run. That rule reported ATS-greenhouse (7,737 jobs/week), ATS-lever
     * (7,272) and ATS-smartrecruiters (5,304) — the three highest-yield sources
     * in the system — as "failing", while a source with sixteen clean `success`
     * runs that inserted nothing at all was called healthy.
     *
     * A source that is putting jobs in the database is working, whatever it
     * calls itself. A source that is not is broken, whatever it calls itself.
     */
    const sourceHealth = sourceHealthRows.map((row) => {
      const source = String(row.source);
      const lifetime = sourceLifetime.get(source);
      const totalRuns = numberFromDatabase(row.totalRuns);
      const failedRuns = numberFromDatabase(row.failedRuns);
      const partialRuns = numberFromDatabase(row.partialRuns);
      const productiveRuns = numberFromDatabase(row.productiveRuns);
      const requestErrors = numberFromDatabase(row.requestErrors);
      const insertedCount = numberFromDatabase(row.insertedCount);
      const seenCount = numberFromDatabase(row.seenCount);
      const recentRuns = numberFromDatabase(row.recentRuns);
      const recentRequestErrors = numberFromDatabase(row.recentRequestErrors);
      const recentFailedRuns = numberFromDatabase(row.recentFailedRuns);
      const duplicateCount = numberFromDatabase(row.duplicateCount);
      const lifetimeInserted = lifetime ? numberFromDatabase(lifetime.insertedCount) : 0;
      const lastSuccessAt = iso(row.lastSuccessAt);
      const lastProductiveAt = iso(row.lastProductiveAt);
      const productiveAge = hoursSince(lastProductiveAt);
      const failureRate = safeRate(failedRuns, totalRuns);

      let verdict: 'failing' | 'degraded' | 'silent' | 'healthy' = 'healthy';
      let reason = `${insertedCount.toLocaleString()} new jobs across ${totalRuns} runs.`;

      if (totalRuns === 0) {
        verdict = 'silent';
        reason = 'No runs recorded in the window.';
      } else if (isEnrichmentSubSource(source)) {
        /**
         * A per-posting detail fetcher enriches jobs the parent board already
         * found; the row is credited to that parent, so this source can never
         * report one. Grading it on yield reported ATS-workday Details as the
         * worst source in the system while its calls were returning full job
         * descriptions on request. Judge it on whether the requests work.
         */
        if (recentRuns > 0 && recentRequestErrors === 0 && recentFailedRuns === 0) {
          // Behaving now. Any older errors in the window are history.
          reason = requestErrors > 0
            ? `Detail fetcher for its parent source · clean across ${recentRuns} runs in the last 24h (${requestErrors.toLocaleString()} earlier errors have since resolved).`
            : `Detail fetcher for its parent source · ${totalRuns} runs, no request errors.`;
        } else if (recentRequestErrors > 0 || recentFailedRuns > 0) {
          verdict = recentFailedRuns >= recentRuns ? 'failing' : 'degraded';
          reason = `Detail fetcher for its parent source · ${recentRequestErrors.toLocaleString()} request errors in the last 24h.`;
        } else if (requestErrors > 0) {
          verdict = 'degraded';
          reason = `Detail fetcher for its parent source · ${requestErrors.toLocaleString()} request errors in the window, none recent.`;
        } else {
          reason = `Detail fetcher for its parent source · ${totalRuns} runs, no request errors.`;
        }
      } else if (insertedCount === 0) {
        /**
         * Zero new jobs has three quite different causes and they must not
         * share a label. A feed returning 562 postings that are all duplicates
         * is doing its job — the catalog is simply saturated, and some feeds
         * (the Apify pull, for one) only refresh once a day. A feed returning
         * nothing at all is broken. And a feed that has run thousands of times
         * without ever contributing a single job is working but worthless.
         */
        if (failedRuns > 0 || requestErrors > 0) {
          verdict = 'failing';
          reason = `${totalRuns} runs, zero new jobs, ${failedRuns} failed · ${requestErrors.toLocaleString()} request errors.`;
        } else if (seenCount === 0) {
          verdict = 'silent';
          reason = `${totalRuns} runs returned no results at all.`;
        } else if (lifetimeInserted === 0) {
          verdict = 'silent';
          /**
           * "Never" is a claim this data cannot support. `lifetime` sums
           * IngestionSourceRun, and that table only begins when run telemetry
           * was switched on — so a source older than the table reads as having
           * produced nothing, ever. TheMuse displayed "has never contributed a
           * job" while owning 31 rows in Job that predate the first recorded
           * run. Scope the sentence to the evidence behind it.
           */
          const trackedSince = lifetime ? iso(lifetime.firstRunAt) : null;
          reason = trackedSince
            ? `${seenCount.toLocaleString()} results seen, none new — no job since run tracking began ${trackedSince.slice(0, 10)}.`
            : `${seenCount.toLocaleString()} results seen, none new — no job on record.`;
        } else {
          reason = `${seenCount.toLocaleString()} results, all already in the database (${duplicateCount.toLocaleString()} duplicates).`;
        }
      } else if (productiveAge != null && productiveAge >= 24) {
        verdict = 'failing';
        reason = `Last produced a job ${Math.floor(productiveAge)}h ago.`;
      } else if (failureRate != null && failureRate >= 50) {
        verdict = 'failing';
        reason = `${failureRate}% of runs failed, though ${insertedCount.toLocaleString()} jobs still landed.`;
      } else if (requestErrors > insertedCount / 2) {
        // Errors are only meaningful next to yield. A platform sweeping
        // thousands of boards will always log some 404s; that matters when the
        // errors rival the jobs produced, not when they are 5% of them.
        verdict = 'degraded';
        reason = `${insertedCount.toLocaleString()} new jobs against ${requestErrors.toLocaleString()} request errors.`;
      } else if (failureRate != null && failureRate >= 10) {
        verdict = 'degraded';
        reason = `${insertedCount.toLocaleString()} new jobs · ${failureRate}% of runs failed.`;
      } else if (partialRuns > 0) {
        // Worth stating, never a fault: the sweep is simply larger than one turn.
        reason = `${insertedCount.toLocaleString()} new jobs · ${partialRuns} sweeps hit the turn deadline mid-catalog.`;
      }

      return {
        source,
        verdict,
        reason,
        lastSuccessAt,
        lastProductiveAt,
        lastRunAt: iso(row.lastRunAt),
        productiveAgeHours: productiveAge == null ? null : Math.round(productiveAge * 10) / 10,
        failedRuns,
        partialRuns,
        productiveRuns,
        seenCount,
        duplicateCount,
        recentRuns,
        recentRequestErrors,
        recentFailedRuns,
        idleRuns: numberFromDatabase(row.idleRuns),
        totalRuns,
        failureRate,
        insertedCount,
        requestErrors,
        processingErrors: numberFromDatabase(row.processingErrors),
        unreconciledRuns: numberFromDatabase(row.unreconciledRuns),
        lifetime: lifetime
          ? {
              totalRuns: numberFromDatabase(lifetime.totalRuns),
              failedRuns: numberFromDatabase(lifetime.failedRuns),
              insertedCount: numberFromDatabase(lifetime.insertedCount),
              seenCount: numberFromDatabase(lifetime.seenCount),
              requestErrors: numberFromDatabase(lifetime.requestErrors),
              firstRunAt: iso(lifetime.firstRunAt),
            }
          : null,
      };
    }).sort((a, b) => {
      const rank = { failing: 0, silent: 1, degraded: 2, healthy: 3 };
      if (rank[a.verdict] !== rank[b.verdict]) return rank[a.verdict] - rank[b.verdict];
      // Within a tier, the source costing you the most jobs comes first: a dead
      // source that used to produce thousands outranks one that never did.
      const lost = (source: typeof a) => source.lifetime?.insertedCount ?? source.insertedCount;
      if (a.verdict === 'healthy') return b.insertedCount - a.insertedCount;
      return lost(b) - lost(a);
    });

    const failingSources = sourceHealth.filter((source) => source.verdict !== 'healthy');

    const jobsBySource = jobsBySourceRaw.map((source) => ({
      name: source.source || 'Unknown',
      count: source._count,
    }));
    const jobsByStatusOutput = jobsByStatus.map((status) => ({ name: status.status, count: status._count }));
    /**
     * "How many ATS endpoints do I have" is the whole table. Every status is
     * polled by `jobIngestion.ts` on a backoff — 'blacklisted' means a 30-day
     * recheck after three consecutive errors, not removal — so reporting only
     * the 'active' count understated the catalog by more than half.
     */
    const atsBoards = {
      total: totalAtsBoards,
      active: atsByStatus.active || 0,
      parked: atsByStatus.parked || 0,
      blacklisted: atsByStatus.blacklisted || 0,
      byStatus: Object.entries(atsByStatus)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      dueForCheck: atsDueNow,
      coverageSlo: evaluateAtsCoverageSlo({
        activeBoards: atsCoverageInputs[0],
        boardsCheckedWithinCycle: atsCoverageInputs[1],
        boardsNeverChecked: atsCoverageInputs[2],
        oldestCheckedAt: atsCoverageInputs[3]?.lastCheckedAt || null,
        boardsByRotationDay: Object.fromEntries(
          atsCoverageInputs[4].map((row) => [row.checkDay, row._count]),
        ),
      }),
      path: {
        available: atsSplitTelemetryAvailable,
        enabled: ATS_SPLIT_INGESTION_ENABLED,
        dailyTarget: requiredAtsBoardChecksPerDay(atsCoverageInputs[0]),
        attemptedToday: numberFromDatabase(atsPathRow.attemptedToday),
        legacyClaimContactedToday: numberFromDatabase(atsPathRow.legacyClaimContactedToday),
        newCycleListingContactedToday: numberFromDatabase(
          atsExactContacts.newCycleListingContactedToday,
        ),
        listingContinuationContactedToday: numberFromDatabase(
          atsExactContacts.listingContinuationContactedToday,
        ),
        contactMetricEffectiveAt: iso(atsExactContacts.contactMetricEffectiveAt),
        v2ActiveBatches: numberFromDatabase(atsExactContacts.v2ActiveBatches),
        v2StagingItems: numberFromDatabase(atsExactContacts.v2StagingItems),
        v2StagingBytes: numberFromDatabase(atsExactContacts.v2StagingBytes),
        v2SegmentBackpressureJobs: numberFromDatabase(atsExactContacts.v2SegmentBackpressureJobs),
        v2TerminalUnsealedJobs: numberFromDatabase(atsExactContacts.v2TerminalUnsealedJobs),
        v2SealedUnpublishedJobs: numberFromDatabase(atsExactContacts.v2SealedUnpublishedJobs),
        v2PublishedUnpersistedJobs: numberFromDatabase(atsExactContacts.v2SegmentBackpressureJobs),
        v2SealedSegments: numberFromDatabase(atsExactContacts.v2SealedSegments),
        v2PublishedSegments: numberFromDatabase(atsExactContacts.v2PublishedSegments),
        v2ProcessingSegments: numberFromDatabase(atsExactContacts.v2ProcessingSegments),
        v2ProcessedSegments: numberFromDatabase(atsExactContacts.v2ProcessedSegments),
        v2PublicationPaused: atsExactContacts.v2PublicationPaused === true,
        admissionState: String(atsExactContacts.admissionState || 'open'),
        distributedAuthorityActivatedAt: iso(atsExactContacts.distributedAuthorityActivatedAt),
        remoteWorkersEnabled: atsExactContacts.remoteWorkersEnabled === true,
        globalSlotLimit: numberFromDatabase(atsExactContacts.globalSlotLimit),
        localSlotReserve: numberFromDatabase(atsExactContacts.localSlotReserve),
        activePiSlots: numberFromDatabase(atsExactContacts.activePiSlots),
        activeMacSlots: numberFromDatabase(atsExactContacts.activeMacSlots),
        cutoverReadyAt: iso(atsExactContacts.cutoverReadyAt),
        respondedToday: numberFromDatabase(atsPathRow.respondedToday),
        synchronizedToday: numberFromDatabase(atsPathRow.synchronizedToday),
        processedToday: numberFromDatabase(atsPathRow.processedToday),
        failedToday: numberFromDatabase(atsPathRow.failedToday),
        remainingJobs: numberFromDatabase(atsPathOperational.remainingJobs),
        backpressureJobs: numberFromDatabase(atsPathOperational.backpressureJobs),
        oldestSynchronizedAt: iso(atsPathOperational.oldestSynchronizedAt),
        processedJobsLastHour: numberFromDatabase(atsPathOperational.processedJobsLastHour),
        fetchedJobsLastHour: numberFromDatabase(atsPathOperational.fetchedJobsLastHour),
        queuedJobsLastHour: numberFromDatabase(atsPathOperational.queuedJobsLastHour),
        prequeueDuplicatesLastHour: numberFromDatabase(
          atsPathOperational.prequeueDuplicatesLastHour,
        ),
        deferredWithoutContactLastHour: numberFromDatabase(
          atsPathOperational.deferredWithoutContactLastHour,
        ),
        lastAttemptedAt: iso(atsPathMaxima._max.lastAttemptedAt),
        lastRespondedAt: iso(atsPathMaxima._max.lastRespondedAt),
        lastSynchronizedAt: iso(atsPathMaxima._max.lastSynchronizedAt),
        lastProcessedAt: iso(atsPathMaxima._max.lastProcessedAt),
        queue: {
          fetching: atsBatchByStatus.fetching || 0,
          partial: atsBatchByStatus.partial || 0,
          queued: atsBatchByStatus.queued || 0,
          processing: atsBatchByStatus.processing || 0,
          failed: atsBatchByStatus.failed || 0,
        },
      },
      jobsFoundAtLastCheck: numberFromDatabase(atsJobsFoundAggregate._sum.jobsFound),
      byPlatform: Object.entries(byPlatformMap)
        .map(([name, counts]) => ({ name, ...counts }))
        .sort((a, b) => b.total - a.total),
    };

    return NextResponse.json({
      asOf: {
        generatedAt: new Date().toISOString(),
        timeZone: CHICAGO_TIME_ZONE,
        ingestionControlAvailable,
        eventTrackingSince,
        ingestionTrackingSince,
        freshness: {
          sourceRunsAt: iso(freshness.sourceRunsAt),
          pipelineEventsAt: iso(freshness.pipelineEventsAt),
          scoreEventsAt: iso(freshness.scoreEventsAt),
          tasksAt: iso(freshness.tasksAt),
          circuitsAt: iso(freshness.circuitsAt),
        },
      },
      operations: {
        pipeline: pipelineState ? {
          isRunning: pipelineState.isRunning,
          currentStep: pipelineState.currentStep,
          stepProgress: pipelineState.stepProgress,
          lastUpdated: pipelineState.lastUpdated.toISOString(),
          lockOwner: pipelineState.lockOwner,
          lockHeartbeatAt: pipelineState.lockHeartbeatAt?.toISOString() || null,
        } : null,
        scoringBatch: latestScoringBatch ? {
          id: latestScoringBatch.id,
          stage: latestScoringBatch.stage,
          status: latestScoringBatch.status,
          imported: latestScoringBatch.items.filter((item) => item.status === 'imported').length,
          total: latestScoringBatch.items.length,
          createdAt: latestScoringBatch.createdAt.toISOString(),
          expiresAt: latestScoringBatch.expiresAt.toISOString(),
        } : null,
        queues: {
          local: localQueue,
          needsJd: jdQueue,
          aim: aimQueue,
          experience: experienceQueue,
          context: contextQueue,
          actionNeeded: actionNeededQueue,
        },
        tasks: {
          summary: {
            activeSearchTasks,
            categoryReconciles: activeTaskCategoryTotal === activeSearchTasks,
            runnableNow: numberFromDatabase(taskSummary.runnableNow),
            running: numberFromDatabase(taskSummary.running),
            scheduled: numberFromDatabase(taskSummary.scheduled),
            staleLeases: numberFromDatabase(taskSummary.staleLeases),
            circuitCooldown: numberFromDatabase(taskSummary.circuitCooldown),
            blockedBudget: numberFromDatabase(taskSummary.budgetBlocked),
            failed: numberFromDatabase(taskSummary.failed),
            failedAwaitingRetry: numberFromDatabase(taskSummary.failedAwaitingRetry),
            retired: numberFromDatabase(taskSummary.retired),
            orchestration: numberFromDatabase(taskSummary.orchestration),
            oldestRunnableSince: iso(taskSummary.oldestRunnableSince),
            nextRunnableAt: iso(taskSummary.nextRunnableAt),
            latestWatermarkAt: iso(taskSummary.latestWatermarkAt),
            updatedAt: iso(taskSummary.updatedAt),
            // One-release compatibility aliases; callers should use the
            // availability names above.
            total: numberFromDatabase(taskSummary.activeSearchTasks),
            due: numberFromDatabase(taskSummary.runnableNow),
            nextDueAt: iso(taskSummary.nextRunnableAt),
          },
          checkpoints: taskRows.map((row) => ({
            id: String(row.id),
            source: String(row.source),
            queryFamily: row.queryFamily ? String(row.queryFamily) : null,
            geoLane: String(row.geoLane),
            ingestionMode: String(row.ingestionMode),
            taskKind: String(row.taskKind),
            lifecycleStatus: String(row.lifecycleStatus),
            retiredAt: iso(row.retiredAt),
            status: String(row.status),
            category: String(row.category),
            nextRunAt: iso(row.nextRunAt),
            availableAt: iso(row.availableAt),
            windowStart: iso(row.windowStart),
            windowEnd: iso(row.windowEnd),
            watermarkAt: iso(row.watermarkAt),
            leaseOwner: row.leaseOwner ? String(row.leaseOwner) : null,
            leaseStartedAt: iso(row.leaseStartedAt),
            heartbeatAt: iso(row.heartbeatAt),
            leaseExpiresAt: iso(row.leaseExpiresAt),
            attempt: numberFromDatabase(row.attempt),
            requestCount: numberFromDatabase(row.requestCount),
            seenCount: numberFromDatabase(row.seenCount),
            insertedCount: numberFromDatabase(row.insertedCount),
            duplicateCount: numberFromDatabase(row.duplicateCount),
            filteredCount: numberFromDatabase(row.filteredCount),
            processingErrorCount: numberFromDatabase(row.processingErrorCount),
            providerErrorCount: numberFromDatabase(row.providerErrorCount),
            lastError: row.lastError ? String(row.lastError) : null,
            lastCompletedAt: iso(row.lastCompletedAt),
            lastStartedAt: iso(row.lastStartedAt),
            cursor: row.cursor || null,
            updatedAt: iso(row.updatedAt),
            isDue: row.category === 'runnableNow',
            isStaleLease: row.category === 'staleLease',
          })),
        },
        circuits: circuitRows.map((row) => ({
          provider: String(row.provider),
          state: String(row.state),
          openUntil: iso(row.openUntil),
          consecutiveFailures: numberFromDatabase(row.consecutiveFailures),
          dailyLimit: row.dailyLimit == null ? null : numberFromDatabase(row.dailyLimit),
          monthlyLimit: row.monthlyLimit == null ? null : numberFromDatabase(row.monthlyLimit),
          dailyUsed: numberFromDatabase(row.dailyUsed),
          monthlyUsed: numberFromDatabase(row.monthlyUsed),
          budgetDay: row.budgetDay ? String(row.budgetDay) : null,
          budgetMonth: row.budgetMonth ? String(row.budgetMonth) : null,
          lastError: row.lastError ? String(row.lastError) : null,
          lastFailureAt: iso(row.lastFailureAt),
          lastSuccessAt: iso(row.lastSuccessAt),
          updatedAt: iso(row.updatedAt),
        })),
        incidents: incidentRows.map((row) => ({
          provider: String(row.provider),
          status: String(row.status),
          classifications: Array.isArray(row.classifications) ? row.classifications.map(String) : [],
          incidentCount: numberFromDatabase(row.incidentCount),
          affectedQueryCount: numberFromDatabase(row.affectedQueryCount),
          occurrenceCount: numberFromDatabase(row.occurrenceCount),
          firstSeenAt: iso(row.firstSeenAt),
          lastSeenAt: iso(row.lastSeenAt),
          message: row.message ? String(row.message) : null,
        })),
        sourceHealth,
        failingSources,
        recentIngestionRuns,
      },
      outcomes: {
        today: dailyActivity[0] || null,
        trailing7Days: sumDaily(dailyActivity, 7),
        trailing30Days: sumDaily(dailyActivity, 30),
        allTime: allTimeTotals,
        daily: dailyActivity,
        /**
         * Which funnel stages have any emitter at all. The UI renders an
         * unwired stage as "not instrumented" instead of a zero that looks
         * like a real measurement.
         */
        stageCoverage: {
          local: stageMetric(0, lifetimeEventCount('local_pass', 'local_reject')).unavailable,
          ae: stageMetric(0, lifetimeEventCount('ae_pass', 'ae_reject')).unavailable,
          human: stageMetric(0, lifetimeEventCount('user_promote', 'user_reject')).unavailable,
          jdFailed: stageMetric(0, lifetimeEventCount('jd_failed')).unavailable,
        },
      },
      calibration: {
        promptCohorts: promptCohortRows.map((row) => {
          const evaluated = numberFromDatabase(row.evaluated);
          const passed = numberFromDatabase(row.passed);
          return {
            // Rows are grouped by stage AND prompt, so the prompt string alone
            // is not a unique identity for a cohort.
            evaluationType: String(row.evaluationType),
            promptVersion: String(row.promptVersion),
            evaluated,
            passed,
            passRate: safeRate(passed, evaluated),
            averageAim: numberFromDatabase(row.averageAim),
            averageExperience: numberFromDatabase(row.averageExperience),
            firstEvaluatedAt: iso(row.firstEvaluatedAt),
            lastEvaluatedAt: iso(row.lastEvaluatedAt),
          };
        }),
        population: {
          aim: aimPopulation,
          experience: experiencePopulation,
        },
      },
      inventory: {
        totalJobs,
        jobsByStatus: jobsByStatusOutput,
        jobsBySource,
        averages: {
          aimFit: averageAimFit,
          experienceFit: averageExperienceFit,
        },
        atsBoards,
      },

      // Compatibility fields for callers that have not moved to the grouped
      // contract yet. They point at the same authoritative objects above.
      totalJobs,
      jobsByStatus: jobsByStatusOutput,
      jobsBySource,
      averages: {
        aimFit: averageAimFit,
        experienceFit: averageExperienceFit,
      },
      atsBoards,
      recentIngestionRuns,
      sourceHealth,
      activityTrackingSince: eventTrackingSince,
      dailyActivity,
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error('Stats API error:', error);
    return NextResponse.json({ error: 'Failed to load dashboard metrics' }, { status: 500 });
  }
}

async function loadStatsSnapshot(): Promise<SerializedStatsResponse> {
  const response = await buildStatsResponse();
  const serialized = {
    body: await response.text(),
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
  };
  if (!response.ok) throw new StatsSnapshotLoadError(serialized);
  return serialized;
}

const statsSnapshot = createLatestSuccessfulSnapshot(loadStatsSnapshot, {
  freshForMs: STATS_SNAPSHOT_FRESH_MS,
  onBackgroundError: (error) => console.error('Stats snapshot refresh failed:', error),
});

function statsResponse(
  response: SerializedStatsResponse,
  cacheStatus: 'miss' | 'hit' | 'stale' | 'error',
  ageMs: number,
) {
  return new NextResponse(response.body, {
    status: response.status,
    headers: {
      ...response.headers,
      'X-Career-Stats-Cache': cacheStatus,
      'X-Career-Stats-Age': String(Math.floor(ageMs / 1_000)),
    },
  });
}

export async function GET() {
  try {
    const snapshot = await statsSnapshot.get();
    return statsResponse(snapshot.value, snapshot.status, snapshot.ageMs);
  } catch (error) {
    if (error instanceof StatsSnapshotLoadError) {
      return statsResponse(error.response, 'error', 0);
    }
    console.error('Stats snapshot cache error:', error);
    return NextResponse.json({ error: 'Failed to load dashboard metrics' }, { status: 500 });
  }
}
