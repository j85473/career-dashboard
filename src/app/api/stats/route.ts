export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { NextResponse } from 'next/server';

import { actionableQueueWhere, logWhere } from '@/lib/jobListQuery';
import { prisma } from '@/lib/prisma';
import {
  enteredInboxCount,
  ingestionOutcomesReconcile,
  numberFromDatabase,
  safeRate,
  trackingCoverage,
} from '@/lib/statsDashboard';

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
    inboxStageThroughputRatio: safeRate(enteredInbox, seen),
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

    const basicQueries = Promise.all([
      prisma.job.count(),
      prisma.job.groupBy({ by: ['status'], _count: true }),
      prisma.job.groupBy({ by: ['source'], _count: true }),
      ingestionControlAvailable ? prisma.$queryRaw<DatabaseRow[]>`
        WITH ranked AS (
          SELECT
            "jobId",
            "aimFitScore",
            "experienceFitScore",
            "staleAt",
            ROW_NUMBER() OVER (
              PARTITION BY "jobId"
              ORDER BY "createdAt" DESC, "id" DESC
            ) AS rank
          FROM "JobScoreEvent"
          WHERE "evaluationType" IN ('standard', 'ae_fit')
        )
        SELECT
          ROUND(AVG("aimFitScore"), 1)::float AS "averageAim",
          ROUND(AVG("experienceFitScore"), 1)::float AS "averageExperience"
        FROM ranked
        JOIN "Job" job ON job.id = ranked."jobId"
        WHERE rank = 1 AND "staleAt" IS NULL;
      ` : Promise.resolve([{ averageAim: 0, averageExperience: 0 }] as DatabaseRow[]),
      prisma.atsCompany.count(),
      prisma.atsCompany.count({ where: { status: 'active' } }),
      prisma.atsCompany.count({ where: { status: 'parked' } }),
      prisma.atsCompany.groupBy({ by: ['platform', 'status'], _count: true }),
      prisma.pipelineState.findUnique({ where: { id: 'global' } }),
      prisma.nativeScoringRequest.findFirst({ orderBy: { createdAt: 'desc' } }),
      Promise.all([
        prisma.job.count({ where: logWhere('local_scoring') }),
        prisma.job.count({ where: logWhere('needs_jd') }),
        prisma.job.count({ where: logWhere('aim_fit') }),
        prisma.job.count({ where: logWhere('context') }),
        prisma.job.count({ where: actionableQueueWhere() }),
        ingestionControlAvailable ? prisma.$queryRaw<DatabaseRow[]>`
          WITH ranked AS (
            SELECT
              "jobId",
              "travelScore",
              "staleAt",
              ROW_NUMBER() OVER (
                PARTITION BY "jobId"
                ORDER BY "createdAt" DESC, "id" DESC
              ) AS rank
            FROM "JobScoreEvent"
            WHERE "evaluationType" IN ('standard', 'ae_fit')
          ),
          latest AS (
            SELECT *
            FROM ranked
            WHERE rank = 1 AND "staleAt" IS NULL
          )
          SELECT
            COUNT(*) FILTER (WHERE latest."travelScore" >= 50)::int AS "atLeast50",
            COUNT(*) FILTER (WHERE latest."travelScore" >= 75)::int AS "atLeast75"
          FROM latest
          JOIN "Job" job ON job.id = latest."jobId"
          WHERE job.status IN ('pending_af', 'inbox', 'dismissed', 'bookmarked', 'cooldown');
        ` : Promise.resolve([{ atLeast50: 0, atLeast75: 0 }] as DatabaseRow[]),
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
              SELECT (CURRENT_TIMESTAMP AT TIME ZONE ${CHICAGO_TIME_ZONE})::date AS today
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
                DATE(source_run."startedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${CHICAGO_TIME_ZONE}) AS date,
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
              WHERE DATE(source_run."startedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${CHICAGO_TIME_ZONE}) >= params.today - 29
                AND control_epoch."startedAt" IS NOT NULL
                AND source_run."startedAt" >= control_epoch."startedAt"
              GROUP BY DATE(source_run."startedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${CHICAGO_TIME_ZONE})
            ),
            events AS (
              SELECT
                DATE("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE ${CHICAGO_TIME_ZONE}) AS date,
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
              WHERE DATE("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE ${CHICAGO_TIME_ZONE}) >= params.today - 29
              GROUP BY DATE("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE ${CHICAGO_TIME_ZONE})
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
            SELECT
              COUNT(*)::int AS total,
              COUNT(*) FILTER (
                WHERE "nextRunAt" <= NOW()
                  AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= NOW())
              )::int AS due,
              COUNT(*) FILTER (WHERE status = 'running')::int AS running,
              COUNT(*) FILTER (
                WHERE "leaseToken" IS NOT NULL AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= NOW())
              )::int AS "staleLeases",
              COUNT(*) FILTER (WHERE status = 'blocked_budget')::int AS "blockedBudget",
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              MIN("nextRunAt") FILTER (
                WHERE "leaseToken" IS NULL OR "leaseExpiresAt" <= NOW()
              ) AS "nextDueAt",
              MAX("watermarkAt") AS "latestWatermarkAt",
              MAX("updatedAt") AS "updatedAt"
            FROM "IngestionTask";
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT
              id,
              source,
              "queryFamily",
              "geoLane",
              "ingestionMode",
              status,
              "nextRunAt",
              "windowStart",
              "windowEnd",
              "watermarkAt",
              "leaseOwner",
              "heartbeatAt",
              "leaseExpiresAt",
              attempt,
              "requestCount",
              "seenCount",
              "insertedCount",
              "duplicateCount",
              "filteredCount",
              "processingErrorCount",
              "providerErrorCount",
              "lastError",
              "lastCompletedAt",
              "updatedAt",
              ("nextRunAt" <= NOW() AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= NOW())) AS "isDue",
              ("leaseToken" IS NOT NULL AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= NOW())) AS "isStaleLease"
            FROM "IngestionTask"
            ORDER BY
              (status = 'running') DESC,
              ("nextRunAt" <= NOW() AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= NOW())) DESC,
              "nextRunAt" ASC,
              source ASC
            LIMIT 40;
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
            WITH ranked AS (
              SELECT
                "jobId",
                "promptVersion",
                passed,
                "aimFitScore",
                "experienceFitScore",
                "travelScore",
                "staleAt",
                "createdAt",
                ROW_NUMBER() OVER (PARTITION BY "jobId" ORDER BY "createdAt" DESC, id DESC) AS rank
              FROM "JobScoreEvent"
              WHERE "evaluationType" IN ('standard', 'ae_fit')
            )
            SELECT
              "promptVersion",
              COUNT(*)::int AS evaluated,
              COUNT(*) FILTER (WHERE passed)::int AS passed,
              ROUND(AVG("aimFitScore"), 1)::float AS "averageAim",
              ROUND(AVG("experienceFitScore"), 1)::float AS "averageExperience",
              ROUND(AVG("travelScore"), 1)::float AS "averageTravel",
              MIN("createdAt") AS "firstEvaluatedAt",
              MAX("createdAt") AS "lastEvaluatedAt"
            FROM ranked
            WHERE rank = 1 AND "staleAt" IS NULL
            GROUP BY "promptVersion"
            ORDER BY MAX("createdAt") DESC
            LIMIT 8;
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            WITH ranked AS (
              SELECT
                "jobId",
                passed,
                "aimFitScore",
                "experienceFitScore",
                "travelScore",
                "staleAt",
                ROW_NUMBER() OVER (PARTITION BY "jobId" ORDER BY "createdAt" DESC, id DESC) AS rank
              FROM "JobScoreEvent"
              WHERE "evaluationType" IN ('standard', 'ae_fit')
            ), bucketed AS (
              SELECT
                CASE
                  WHEN "travelScore" IS NULL THEN 'Unscored'
                  WHEN "travelScore" <= 10 THEN '0–10%'
                  WHEN "travelScore" <= 25 THEN '11–25%'
                  WHEN "travelScore" <= 50 THEN '26–50%'
                  WHEN "travelScore" <= 74 THEN '51–74%'
                  WHEN "travelScore" <= 89 THEN '75–89%'
                  ELSE '90–100%'
                END AS bucket,
                CASE
                  WHEN "travelScore" IS NULL THEN 7
                  WHEN "travelScore" <= 10 THEN 1
                  WHEN "travelScore" <= 25 THEN 2
                  WHEN "travelScore" <= 50 THEN 3
                  WHEN "travelScore" <= 74 THEN 4
                  WHEN "travelScore" <= 89 THEN 5
                  ELSE 6
                END AS bucket_order,
                *
              FROM ranked
              WHERE rank = 1 AND "staleAt" IS NULL
            )
            SELECT
              bucket,
              COUNT(*)::int AS evaluated,
              COUNT(*) FILTER (WHERE passed)::int AS passed,
              COUNT(*) FILTER (
                WHERE NOT passed AND "travelScore" >= 75 AND "experienceFitScore" >= 70
              )::int AS "highTravelAimMisses",
              ROUND(AVG("aimFitScore"), 1)::float AS "averageAim",
              ROUND(AVG("experienceFitScore"), 1)::float AS "averageExperience"
            FROM bucketed
            GROUP BY bucket, bucket_order
            ORDER BY bucket_order;
          `,
          prisma.$queryRaw<DatabaseRow[]>`
            SELECT
              (SELECT MAX("createdAt") FROM "IngestionSourceRun") AS "sourceRunsAt",
              (SELECT MAX("occurredAt") FROM "JobPipelineEvent") AS "pipelineEventsAt",
              (SELECT MAX("createdAt") FROM "JobScoreEvent") AS "scoreEventsAt",
              (SELECT MAX("updatedAt") FROM "IngestionTask") AS "tasksAt",
              (SELECT MAX("updatedAt") FROM "ProviderCircuit") AS "circuitsAt";
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
        ]);

    const [
      [
        totalJobs,
        jobsByStatus,
        jobsBySourceRaw,
        scoreStatsRows,
        totalAtsBoards,
        activeAtsBoards,
        parkedAtsBoards,
        atsByPlatformRaw,
        pipelineState,
        latestScoringRequest,
        [localQueue, jdQueue, aeQueue, contextQueue, actionNeededQueue, travelWatchRows],
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
        travelBucketRows,
        freshnessRows,
      ],
    ] = await Promise.all([basicQueries, legacyRecentRuns, controlQueries]);

    const travelWatch50 = numberFromDatabase(travelWatchRows[0]?.atLeast50);
    const travelWatch75 = numberFromDatabase(travelWatchRows[0]?.atLeast75);
    const averageAimFit = Math.round(numberFromDatabase(scoreStatsRows[0]?.averageAim));
    const averageExperienceFit = Math.round(numberFromDatabase(scoreStatsRows[0]?.averageExperience));

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

    const byPlatformMap: Record<string, { active: number; parked: number }> = {};
    for (const platform of atsByPlatformRaw) {
      byPlatformMap[platform.platform] ||= { active: 0, parked: 0 };
      if (platform.status === 'active') byPlatformMap[platform.platform].active += platform._count;
      if (platform.status === 'parked') byPlatformMap[platform.platform].parked += platform._count;
    }

    const taskSummary = taskSummaryRows[0] || {};
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

    const sourceHealth = sourceHealthRows.map((row) => ({
      source: String(row.source),
      lastSuccessAt: iso(row.lastSuccessAt),
      lastRunAt: iso(row.lastRunAt),
      failedRuns: numberFromDatabase(row.failedRuns),
      idleRuns: numberFromDatabase(row.idleRuns),
      totalRuns: numberFromDatabase(row.totalRuns),
      insertedCount: numberFromDatabase(row.insertedCount),
      requestErrors: numberFromDatabase(row.requestErrors),
      processingErrors: numberFromDatabase(row.processingErrors),
      unreconciledRuns: numberFromDatabase(row.unreconciledRuns),
    }));

    const jobsBySource = jobsBySourceRaw.map((source) => ({
      name: source.source || 'Unknown',
      count: source._count,
    }));
    const jobsByStatusOutput = jobsByStatus.map((status) => ({ name: status.status, count: status._count }));
    const atsBoards = {
      total: totalAtsBoards,
      active: activeAtsBoards,
      parked: parkedAtsBoards,
      byPlatform: Object.entries(byPlatformMap).map(([name, counts]) => ({ name, ...counts })),
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
        scoringRequest: latestScoringRequest ? {
          id: latestScoringRequest.id,
          status: latestScoringRequest.status,
          phase: latestScoringRequest.phase,
          progress: latestScoringRequest.progress,
          heartbeatAt: latestScoringRequest.heartbeatAt?.toISOString() || null,
          updatedAt: latestScoringRequest.updatedAt.toISOString(),
          error: latestScoringRequest.error,
        } : null,
        queues: {
          local: localQueue,
          needsJd: jdQueue,
          ae: aeQueue,
          context: contextQueue,
          actionNeeded: actionNeededQueue,
        },
        tasks: {
          summary: {
            total: numberFromDatabase(taskSummary.total),
            due: numberFromDatabase(taskSummary.due),
            running: numberFromDatabase(taskSummary.running),
            staleLeases: numberFromDatabase(taskSummary.staleLeases),
            blockedBudget: numberFromDatabase(taskSummary.blockedBudget),
            failed: numberFromDatabase(taskSummary.failed),
            nextDueAt: iso(taskSummary.nextDueAt),
            latestWatermarkAt: iso(taskSummary.latestWatermarkAt),
            updatedAt: iso(taskSummary.updatedAt),
          },
          checkpoints: taskRows.map((row) => ({
            id: String(row.id),
            source: String(row.source),
            queryFamily: row.queryFamily ? String(row.queryFamily) : null,
            geoLane: String(row.geoLane),
            ingestionMode: String(row.ingestionMode),
            status: String(row.status),
            nextRunAt: iso(row.nextRunAt),
            windowStart: iso(row.windowStart),
            windowEnd: iso(row.windowEnd),
            watermarkAt: iso(row.watermarkAt),
            leaseOwner: row.leaseOwner ? String(row.leaseOwner) : null,
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
            updatedAt: iso(row.updatedAt),
            isDue: row.isDue === true,
            isStaleLease: row.isStaleLease === true,
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
        recentIngestionRuns,
      },
      outcomes: {
        today: dailyActivity[0] || null,
        trailing7Days: sumDaily(dailyActivity, 7),
        daily: dailyActivity,
      },
      calibration: {
        promptCohorts: promptCohortRows.map((row) => {
          const evaluated = numberFromDatabase(row.evaluated);
          const passed = numberFromDatabase(row.passed);
          return {
            promptVersion: String(row.promptVersion),
            evaluated,
            passed,
            passRate: safeRate(passed, evaluated),
            averageAim: numberFromDatabase(row.averageAim),
            averageExperience: numberFromDatabase(row.averageExperience),
            averageTravel: numberFromDatabase(row.averageTravel),
            firstEvaluatedAt: iso(row.firstEvaluatedAt),
            lastEvaluatedAt: iso(row.lastEvaluatedAt),
          };
        }),
        travelBuckets: travelBucketRows.map((row) => {
          const evaluated = numberFromDatabase(row.evaluated);
          const passed = numberFromDatabase(row.passed);
          return {
            bucket: String(row.bucket),
            evaluated,
            passed,
            passRate: safeRate(passed, evaluated),
            highTravelAimMisses: numberFromDatabase(row.highTravelAimMisses),
            averageAim: numberFromDatabase(row.averageAim),
            averageExperience: numberFromDatabase(row.averageExperience),
          };
        }),
        travelWatch: {
          atLeast50: travelWatch50,
          atLeast75: travelWatch75,
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
