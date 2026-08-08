import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const [trackingState] = await prisma.$queryRaw<Array<{ available: boolean }>>`
      SELECT (
        to_regclass('"JobScoringStatusHistory"') IS NOT NULL
        AND to_regclass('"JobStatusHistory"') IS NOT NULL
        AND to_regclass('"StatsTrackingEpoch"') IS NOT NULL
      ) AS available;
    `;
    const activityTrackingAvailable = trackingState?.available === true;
    const localScoringCte = activityTrackingAvailable ? Prisma.sql`
      local_scoring AS (
        SELECT
          DATE(history."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') AS date,
          COUNT(DISTINCT history."jobId")::int AS "localRejected"
        FROM "JobScoringStatusHistory" history
        CROSS JOIN "StatsTrackingEpoch" epoch
        CROSS JOIN params
        WHERE epoch.id = 'daily-activity-v2'
          AND history."createdAt" >= epoch."startedAt"
          AND history."scoringStatus" = 'skipped'
          AND DATE(history."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') >= params.today - 29
        GROUP BY DATE(history."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
      )
    ` : Prisma.sql`
      local_scoring AS (
        SELECT NULL::date AS date, 0::int AS "localRejected" WHERE false
      )
    `;
    const inboxCte = activityTrackingAvailable ? Prisma.sql`
      inbox AS (
        SELECT
          DATE(history."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') AS date,
          COUNT(DISTINCT history."jobId")::int AS inbox
        FROM "JobStatusHistory" history
        CROSS JOIN "StatsTrackingEpoch" epoch
        CROSS JOIN params
        WHERE epoch.id = 'daily-activity-v2'
          AND history."createdAt" >= epoch."startedAt"
          AND history.status = 'inbox'
          AND DATE(history."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') >= params.today - 29
        GROUP BY DATE(history."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
      )
    ` : Prisma.sql`
      inbox AS (
        SELECT NULL::date AS date, 0::int AS inbox WHERE false
      )
    `;
    const epochCte = activityTrackingAvailable ? Prisma.sql`
      epoch AS (
        SELECT
          "startedAt",
          DATE("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') AS start_date
        FROM "StatsTrackingEpoch"
        WHERE id = 'daily-activity-v2'
      )
    ` : Prisma.sql`
      epoch AS (
        SELECT NULL::timestamp AS "startedAt", NULL::date AS start_date
      )
    `;

    const [
      totalJobs,
      jobsByStatus,
      totalAtsBoards,
      activeAtsBoards,
      parkedAtsBoards,
      atsByPlatformRaw,
      jobsBySourceRaw,
      scoreStats,
      recentIngestionRuns,
      sourceHealthRaw,
      dailyActivityRaw,
      trackingEpochRows,
    ] = await Promise.all([
      prisma.job.count(),
      prisma.job.groupBy({ by: ['status'], _count: true }),
      prisma.atsCompany.count(),
      prisma.atsCompany.count({ where: { status: 'active' } }),
      prisma.atsCompany.count({ where: { status: 'parked' } }),
      prisma.atsCompany.groupBy({ by: ['platform', 'status'], _count: true }),
      prisma.job.groupBy({ by: ['source'], _count: true }),
      prisma.job.aggregate({ _avg: { aimFitScore: true, reqFitScore: true } }),
      prisma.ingestionSourceRun.findMany({
        distinct: ['source'],
        orderBy: [{ source: 'asc' }, { createdAt: 'desc' }],
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
      }).catch(() => []),
      // Per-source health over a week. The latest run alone cannot distinguish
      // "failed once just now" from "failed every time for eleven days", which
      // is how the paid APIs stayed broken without anyone noticing.
      prisma.$queryRaw`
        SELECT
          source,
          MAX(CASE WHEN status = 'success' THEN "createdAt" END) AS "lastSuccessAt",
          MAX("createdAt") AS "lastRunAt",
          COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedRuns",
          COUNT(*) FILTER (WHERE status = 'idle')::int AS "idleRuns",
          COUNT(*)::int AS "totalRuns",
          COALESCE(SUM("insertedCount"), 0)::int AS "insertedCount"
        FROM "IngestionSourceRun"
        WHERE "createdAt" > NOW() - INTERVAL '7 days'
        GROUP BY source
        ORDER BY source ASC;
      ` as Promise<Record<string, unknown>[]>,
      // Each stage is grouped by its own immutable event timestamp. A generated
      // Chicago calendar supplies exactly 30 days, including quiet days.
      prisma.$queryRaw`
        WITH params AS (
          SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date AS today
        ),
        days AS (
          SELECT generate_series(
            (SELECT today - 29 FROM params),
            (SELECT today FROM params),
            INTERVAL '1 day'
          )::date AS date
        ),
        ingestion AS (
          SELECT
            DATE("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') AS date,
            COALESCE(SUM("seenCount"), 0) AS seen,
            COALESCE(SUM("insertedCount"), 0) AS ingested,
            COALESCE(SUM("duplicateCount"), 0) AS duplicates,
            COALESCE(SUM("filteredCount"), 0) AS "ingestionFiltered",
            COALESCE(SUM("errorCount"), 0) AS "totalErrors"
          FROM "IngestionSourceRun", params
          WHERE DATE("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') >= params.today - 29
          GROUP BY DATE("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
        ),
        ae_ranked AS (
          SELECT
            DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') AS date,
            "jobId",
            passed,
            ROW_NUMBER() OVER (
              PARTITION BY "jobId", DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
              ORDER BY "createdAt" DESC, id DESC
            ) AS decision_rank
          FROM "JobScoreEvent", params
          WHERE "evaluationType" IN ('standard', 'ae_fit')
            AND DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') >= params.today - 29
        ),
        ae AS (
          SELECT
            date,
            COUNT(*) FILTER (WHERE passed = false)::int AS "rejectedAE",
            COUNT(*) FILTER (WHERE passed = true)::int AS "passedAE"
          FROM ae_ranked
          WHERE decision_rank = 1
          GROUP BY date
        ),
        ${localScoringCte},
        ${inboxCte},
        ${epochCte}
        SELECT
          days.date,
          COALESCE(ingestion.seen, 0) AS seen,
          COALESCE(ingestion.ingested, 0) AS ingested,
          COALESCE(ingestion.duplicates, 0) AS duplicates,
          COALESCE(ingestion."ingestionFiltered", 0) AS "ingestionFiltered",
          GREATEST(
            COALESCE(ingestion.seen, 0)
              - COALESCE(ingestion.ingested, 0)
              - COALESCE(ingestion.duplicates, 0)
              - COALESCE(ingestion."ingestionFiltered", 0),
            0
          ) AS "processingErrors",
          GREATEST(
            COALESCE(ingestion."totalErrors", 0)
              - GREATEST(
                  COALESCE(ingestion.seen, 0)
                    - COALESCE(ingestion.ingested, 0)
                    - COALESCE(ingestion.duplicates, 0)
                    - COALESCE(ingestion."ingestionFiltered", 0),
                  0
                ),
            0
          ) AS "sourceErrors",
          (
            COALESCE(ingestion.seen, 0)
              = COALESCE(ingestion.ingested, 0)
                + COALESCE(ingestion.duplicates, 0)
                + COALESCE(ingestion."ingestionFiltered", 0)
                + GREATEST(
                    COALESCE(ingestion.seen, 0)
                      - COALESCE(ingestion.ingested, 0)
                      - COALESCE(ingestion.duplicates, 0)
                      - COALESCE(ingestion."ingestionFiltered", 0),
                    0
                  )
          ) AS "ingestionReconciles",
          COALESCE(local_scoring."localRejected", 0) AS "localRejected",
          COALESCE(ae."rejectedAE", 0) AS "rejectedAE",
          COALESCE(ae."passedAE", 0) AS "passedAE",
          COALESCE(inbox.inbox, 0) AS inbox,
          CASE
            WHEN epoch.start_date IS NULL THEN 'untracked'
            WHEN days.date < epoch.start_date THEN 'untracked'
            WHEN days.date = epoch.start_date THEN 'partial'
            ELSE 'tracked'
          END AS "transitionTrackingStatus"
        FROM days
        CROSS JOIN epoch
        LEFT JOIN ingestion ON ingestion.date = days.date
        LEFT JOIN local_scoring ON local_scoring.date = days.date
        LEFT JOIN ae ON ae.date = days.date
        LEFT JOIN inbox ON inbox.date = days.date
        ORDER BY days.date DESC;
      ` as Promise<Record<string, unknown>[]>,
      activityTrackingAvailable
        ? prisma.$queryRaw<Array<{ startedAt: Date }>>`
            SELECT "startedAt" FROM "StatsTrackingEpoch" WHERE id = 'daily-activity-v2';
          `
        : Promise.resolve([] as Array<{ startedAt: Date }>),
    ]);

    const byPlatformMap: Record<string, { active: number, parked: number }> = {};
    for (const p of atsByPlatformRaw) {
      if (!byPlatformMap[p.platform]) {
        byPlatformMap[p.platform] = { active: 0, parked: 0 };
      }
      if (p.status === 'active') byPlatformMap[p.platform].active += p._count;
      else if (p.status === 'parked') byPlatformMap[p.platform].parked += p._count;
    }

    const countFields = [
      'seen',
      'ingested',
      'duplicates',
      'ingestionFiltered',
      'processingErrors',
      'sourceErrors',
      'localRejected',
      'rejectedAE',
      'passedAE',
      'inbox',
    ];
    const dailyActivity = (dailyActivityRaw as Record<string, unknown>[]).map((row) => {
      const date = row.date as Date;
      const normalized: Record<string, unknown> = {
        date: date.toISOString().split('T')[0],
        ingestionReconciles: row.ingestionReconciles === true,
        transitionTrackingStatus: String(row.transitionTrackingStatus),
      };
      for (const field of countFields) normalized[field] = Number(row[field]) || 0;
      return normalized;
    });

    return NextResponse.json({
      totalJobs,
      jobsByStatus: jobsByStatus.map((s) => ({ name: s.status, count: s._count })),
      jobsBySource: jobsBySourceRaw.map((s) => ({ name: s.source || 'Unknown', count: s._count })),
      averages: {
        aimFit: Math.round(scoreStats._avg.aimFitScore || 0),
        experienceFit: Math.round(scoreStats._avg.reqFitScore || 0),
      },
      atsBoards: {
        total: totalAtsBoards,
        active: activeAtsBoards,
        parked: parkedAtsBoards,
        byPlatform: Object.entries(byPlatformMap).map(([name, counts]) => ({
          name,
          ...counts
        }))
      },
      recentIngestionRuns: recentIngestionRuns.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      sourceHealth: (sourceHealthRaw as Record<string, unknown>[]).map((row) => ({
        source: String(row.source),
        lastSuccessAt: row.lastSuccessAt ? (row.lastSuccessAt as Date).toISOString() : null,
        lastRunAt: row.lastRunAt ? (row.lastRunAt as Date).toISOString() : null,
        failedRuns: Number(row.failedRuns) || 0,
        idleRuns: Number(row.idleRuns) || 0,
        totalRuns: Number(row.totalRuns) || 0,
        insertedCount: Number(row.insertedCount) || 0,
      })),
      activityTrackingSince: trackingEpochRows[0]?.startedAt.toISOString() || null,
      dailyActivity,
    });
  } catch (error) {
    console.error("Stats API error:", error);
    return NextResponse.json({ error: 'Failed to load database stats' }, { status: 500 });
  }
}
