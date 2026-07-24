import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    function getStartOfDayChicago() {
      const now = new Date();
      const year = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format(now));
      const month = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric' }).format(now));
      const day = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', day: 'numeric' }).format(now));
      
      const d = new Date(Date.UTC(year, month - 1, day, 5, 0, 0)); 
      const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hour12: true });
      
      if (formatter.format(d).includes('12:00') && formatter.format(d).includes('AM')) {
        return d;
      }
      return new Date(Date.UTC(year, month - 1, day, 6, 0, 0));
    }
    
    getStartOfDayChicago();

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
      ingestRunsToday,
      jobsByStatusToday,
      scoreEventsToday,
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
      // Daily Activity Stats - Historical
      prisma.$queryRaw`
        SELECT 
          DATE("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') as date,
          SUM("insertedCount") as ingested,
          SUM("filteredCount") as "killedLocal"
        FROM "IngestionSourceRun"
        GROUP BY DATE("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
        ORDER BY date DESC
        LIMIT 30;
      ` as Promise<Record<string, unknown>[]>,
      prisma.$queryRaw`
        SELECT 
          DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') as date,
          SUM(CASE WHEN status = 'inbox' AND "aimFitScore" IS NOT NULL THEN 1 ELSE 0 END) as inbox,
          SUM(CASE WHEN "luckyStatus" = 'inbox' AND "luckyAimFitScore" IS NOT NULL THEN 1 ELSE 0 END) as lucky
        FROM "Job"
        GROUP BY DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
        ORDER BY date DESC
        LIMIT 30;
      ` as Promise<Record<string, unknown>[]>,
      prisma.$queryRaw`
        SELECT 
          DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') as date,
          SUM(CASE WHEN passed = false THEN 1 ELSE 0 END) as "killedAE",
          SUM(CASE WHEN passed = true THEN 1 ELSE 0 END) as "passedAE"
        FROM "JobScoreEvent"
        GROUP BY DATE("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')
        ORDER BY date DESC
        LIMIT 30;
      ` as Promise<Record<string, unknown>[]>
    ]);

    const byPlatformMap: Record<string, { active: number, parked: number }> = {};
    for (const p of atsByPlatformRaw) {
      if (!byPlatformMap[p.platform]) {
        byPlatformMap[p.platform] = { active: 0, parked: 0 };
      }
      if (p.status === 'active') byPlatformMap[p.platform].active += p._count;
      else if (p.status === 'parked') byPlatformMap[p.platform].parked += p._count;
    }

    const map = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const add = (arr: any[]) => {
      arr.forEach(row => {
        if (!row.date) return;
        const dateStr = row.date.toISOString().split('T')[0];
        const existing = map.get(dateStr) || { date: dateStr, ingested: 0, killedLocal: 0, killedAE: 0, passedAE: 0, inbox: 0, lucky: 0 };
        for (const [k, v] of Object.entries(row)) {
          if (k !== 'date') existing[k] = Number(v) || 0;
        }
        map.set(dateStr, existing);
      });
    };
    add(ingestRunsToday); add(jobsByStatusToday); add(scoreEventsToday);
    const dailyActivity = Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));

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
      dailyActivity
    });
  } catch (error) {
    console.error("Stats API error:", error);
    return NextResponse.json({ error: 'Failed to load database stats' }, { status: 500 });
  }
}
