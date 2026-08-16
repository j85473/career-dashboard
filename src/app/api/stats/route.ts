export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { NextResponse } from 'next/server';

import { actionableQueueWhere, logWhere } from '@/lib/jobListQuery';
import { prisma } from '@/lib/prisma';
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

type DatabaseRow = Record<string, unknown>;

const CHICAGO_TIME_ZONE = 'America/Chicago';
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

export async function GET() {
  try {
    const [controlState] = await prisma.$queryRaw<Array<{ available: boolean }>>`
      SELECT (
        to_regclass('"IngestionTask"') IS NOT NULL
        AND to_regclass('"ProviderCircuit"') IS NOT NULL
        AND to_regclass('"ProviderIncident"') IS NOT NULL
        AND to_regclass('"JobPipelineEvent"') IS NOT NULL
      ) AS available;
    `;
    const ingestionControlAvailable = controlState?.available === true;
    const scoringInputVersions = currentScoringInputVersions();

    const basicQueries = Promise.all([
      prisma.job.count(),
      prisma.job.groupBy({ by: ['status'], _count: true }),
      prisma.job.groupBy({ by: ['source'], _count: true }),
      ingestionControlAvailable ? prisma.$queryRaw<DatabaseRow[]>`
        WITH ${currentScoreScope(scoringInputVersions)}
        SELECT
          (SELECT ROUND(AVG("aimFitScore"), 1)::float FROM current_aim) AS "averageAim",
          (SELECT ROUND(AVG("experienceFitScore"), 1)::float FROM current_experience) AS "averageExperience",
          (SELECT COUNT(*) FROM current_aim)::int AS "aimPopulation",
          (SELECT COUNT(*) FROM current_experience)::int AS "experiencePopulation";
      ` : Promise.resolve([{
        averageAim: null, averageExperience: null, aimPopulation: 0, experiencePopulation: 0,
      }] as DatabaseRow[]),
      prisma.atsCompany.count(),
      prisma.atsCompany.groupBy({ by: ['status'], _count: true }),
      prisma.atsCompany.groupBy({ by: ['platform', 'status'], _count: true }),
      // Boards the ingestion pipeline will actually call. jobIngestion.ts polls
      // every status on a backoff, so "how many endpoints do I have" is the
      // whole table, not the 'active' slice the old headline reported.
      prisma.atsCompany.count({ where: { nextCheckDate: { lte: new Date() } } }),
      prisma.atsCompany.aggregate({ _sum: { jobsFound: true } }),
      prisma.pipelineState.findUnique({ where: { id: 'global' } }),
      prisma.scoringBatch.findFirst({
        orderBy: { createdAt: 'desc' },
        include: { items: { select: { status: true } } },
      }),
      Promise.all([
        prisma.job.count({ where: logWhere('local_scoring') }),
        prisma.job.count({ where: logWhere('needs_jd') }),
        prisma.job.count({ where: logWhere('aim_fit') }),
        prisma.job.count({ where: logWhere('experience_fit') }),
        prisma.job.count({ where: logWhere('context') }),
        prisma.job.count({ where: actionableQueueWhere() }),
      ]),
    ]);

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

    const controlQueries = ingestionControlAvailable
      ? Promise.all([
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
                COUNT(*)::int AS "runCount",
                COUNT(*) FILTER (WHERE NOT source_run.reconciled)::int AS "unreconciledRuns",
                COALESCE(BOOL_AND(source_run.reconciled), false) AS "allRunsReconciled"
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
            WITH availability AS (
              SELECT task.*,
                GREATEST(
                  task."nextRunAt",
                  CASE WHEN circuit.state = 'open' AND circuit."openUntil" > NOW()
                    THEN circuit."openUntil" ELSE task."nextRunAt" END,
                  CASE WHEN circuit."monthlyLimit" IS NOT NULL
                    AND circuit."budgetMonth" = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM')
                    AND circuit."monthlyUsed" >= circuit."monthlyLimit"
                    THEN DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 month' ELSE task."nextRunAt" END,
                  CASE WHEN circuit."dailyLimit" IS NOT NULL
                    AND circuit."budgetDay" = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                    AND circuit."dailyUsed" >= circuit."dailyLimit"
                    THEN DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day' ELSE task."nextRunAt" END
                ) AS "availableAt",
                CASE
                  WHEN task."taskKind" = 'orchestration' THEN 'orchestration'
                  WHEN task."lifecycleStatus" = 'retired' THEN 'retired'
                  WHEN task.status = 'running' AND (
                    task."leaseToken" IS NULL OR task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= NOW()
                  ) THEN 'staleLease'
                  WHEN task.status = 'running' THEN 'running'
                  WHEN circuit.state = 'open' AND circuit."openUntil" > NOW() THEN 'circuitCooldown'
                  WHEN circuit."monthlyLimit" IS NOT NULL
                    AND circuit."budgetMonth" = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM')
                    AND circuit."monthlyUsed" >= circuit."monthlyLimit" THEN 'budgetBlocked'
                  WHEN circuit."dailyLimit" IS NOT NULL
                    AND circuit."budgetDay" = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                    AND circuit."dailyUsed" >= circuit."dailyLimit" THEN 'budgetBlocked'
                  WHEN task.status = 'failed' AND task."nextRunAt" > NOW() THEN 'failedAwaitingRetry'
                  WHEN task."nextRunAt" <= NOW() AND (
                    task."leaseToken" IS NULL OR task."leaseExpiresAt" <= NOW()
                  ) THEN 'runnableNow'
                  ELSE 'scheduled'
                END AS category
              FROM "IngestionTask" task
              LEFT JOIN "ProviderCircuit" circuit ON circuit.provider = task.source
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
            WITH availability AS (
              SELECT task.*,
                GREATEST(
                  task."nextRunAt",
                  CASE WHEN circuit.state = 'open' AND circuit."openUntil" > NOW()
                    THEN circuit."openUntil" ELSE task."nextRunAt" END,
                  CASE WHEN circuit."monthlyLimit" IS NOT NULL
                    AND circuit."budgetMonth" = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM')
                    AND circuit."monthlyUsed" >= circuit."monthlyLimit"
                    THEN DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 month' ELSE task."nextRunAt" END,
                  CASE WHEN circuit."dailyLimit" IS NOT NULL
                    AND circuit."budgetDay" = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                    AND circuit."dailyUsed" >= circuit."dailyLimit"
                    THEN DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day' ELSE task."nextRunAt" END
                ) AS "availableAt",
                CASE
                  WHEN task."taskKind" = 'orchestration' THEN 'orchestration'
                  WHEN task."lifecycleStatus" = 'retired' THEN 'retired'
                  WHEN task.status = 'running' AND (
                    task."leaseToken" IS NULL OR task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= NOW()
                  ) THEN 'staleLease'
                  WHEN task.status = 'running' THEN 'running'
                  WHEN circuit.state = 'open' AND circuit."openUntil" > NOW() THEN 'circuitCooldown'
                  WHEN circuit."monthlyLimit" IS NOT NULL
                    AND circuit."budgetMonth" = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM')
                    AND circuit."monthlyUsed" >= circuit."monthlyLimit" THEN 'budgetBlocked'
                  WHEN circuit."dailyLimit" IS NOT NULL
                    AND circuit."budgetDay" = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                    AND circuit."dailyUsed" >= circuit."dailyLimit" THEN 'budgetBlocked'
                  WHEN task.status = 'failed' AND task."nextRunAt" > NOW() THEN 'failedAwaitingRetry'
                  WHEN task."nextRunAt" <= NOW() AND (
                    task."leaseToken" IS NULL OR task."leaseExpiresAt" <= NOW()
                  ) THEN 'runnableNow'
                  ELSE 'scheduled'
                END AS category
              FROM "IngestionTask" task
              LEFT JOIN "ProviderCircuit" circuit ON circuit.provider = task.source
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
              MAX("createdAt") AS "lastRunAt",
              MAX("createdAt") FILTER (WHERE status IN ('success', 'succeeded')) AS "lastSuccessAt",
              COUNT(*)::int AS "totalRuns",
              COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedRuns",
              COUNT(*) FILTER (WHERE status = 'idle')::int AS "idleRuns",
              COALESCE(SUM("insertedCount"), 0)::int AS "insertedCount",
              COALESCE(SUM("requestErrorCount"), 0)::int AS "requestErrors",
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
              (SELECT COUNT(*) FROM "IngestionSourceRun")::bigint AS "runs",
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
              COUNT(*)::int AS "totalRuns",
              COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedRuns",
              COALESCE(SUM("insertedCount"), 0)::bigint AS "insertedCount",
              COALESCE(SUM("seenCount"), 0)::bigint AS "seenCount",
              COALESCE(SUM("requestErrorCount"), 0)::bigint AS "requestErrors",
              MAX("createdAt") FILTER (WHERE status IN ('success', 'succeeded')) AS "lastSuccessAt",
              MIN("createdAt") AS "firstRunAt"
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
        pipelineState,
        latestScoringBatch,
        [localQueue, jdQueue, aimQueue, experienceQueue, contextQueue, actionNeededQueue],
      ],
      legacyRuns,
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
    ] = await Promise.all([basicQueries, legacyRecentRuns, controlQueries]);

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
     * Sources ranked by how broken they are, rather than listed alphabetically
     * and left for the reader to diff. `verdict` is the single word the UI
     * shows; `reason` is why. A source that runs cleanly but never inserts
     * anything is called out separately from one that errors — both are
     * failures, but they are not the same failure.
     */
    const sourceHealth = sourceHealthRows.map((row) => {
      const source = String(row.source);
      const lifetime = sourceLifetime.get(source);
      const totalRuns = numberFromDatabase(row.totalRuns);
      const failedRuns = numberFromDatabase(row.failedRuns);
      const requestErrors = numberFromDatabase(row.requestErrors);
      const insertedCount = numberFromDatabase(row.insertedCount);
      const lastSuccessAt = iso(row.lastSuccessAt);
      const successAge = hoursSince(lastSuccessAt);
      const failureRate = safeRate(failedRuns, totalRuns);

      let verdict: 'failing' | 'degraded' | 'silent' | 'healthy' = 'healthy';
      let reason = 'Running and inserting normally.';
      if (lastSuccessAt == null && totalRuns > 0) {
        verdict = 'failing';
        reason = `${totalRuns} runs, not one successful.`;
      } else if (failureRate != null && failureRate >= 50) {
        verdict = 'failing';
        reason = `${failureRate}% of runs failed.`;
      } else if (successAge != null && successAge >= 24) {
        verdict = 'failing';
        reason = `No successful run in ${Math.floor(successAge)}h.`;
      } else if (insertedCount === 0 && totalRuns > 0) {
        verdict = 'silent';
        reason = `${totalRuns} runs, zero new jobs.`;
      } else if (failedRuns > 0 || requestErrors > 0) {
        verdict = 'degraded';
        reason = `${failedRuns} failed runs · ${requestErrors} request errors.`;
      }

      return {
        source,
        verdict,
        reason,
        lastSuccessAt,
        lastRunAt: iso(row.lastRunAt),
        successAgeHours: successAge == null ? null : Math.round(successAge * 10) / 10,
        failedRuns,
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
      return b.requestErrors - a.requestErrors;
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
