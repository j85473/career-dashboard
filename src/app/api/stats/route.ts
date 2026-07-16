import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
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
        orderBy: { createdAt: 'desc' },
        take: 24,
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
        },
      }).catch(() => []),
    ]);

    const byPlatformMap: Record<string, { active: number, parked: number }> = {};
    atsByPlatformRaw.forEach(row => {
      if (!byPlatformMap[row.platform]) byPlatformMap[row.platform] = { active: 0, parked: 0 };
      if (row.status === 'active') byPlatformMap[row.platform].active += row._count;
      else if (row.status === 'parked') byPlatformMap[row.platform].parked += row._count;
    });

    const byPlatform = Object.entries(byPlatformMap).map(([name, counts]) => ({
      name,
      active: counts.active,
      parked: counts.parked
    }));

    return NextResponse.json({
      totalJobs,
      jobsByStatus: jobsByStatus.map(s => ({ name: s.status, count: s._count })),
      atsBoards: {
        total: totalAtsBoards,
        active: activeAtsBoards,
        parked: parkedAtsBoards,
        byPlatform
      },
      jobsBySource: jobsBySourceRaw.map(s => ({ name: s.source || 'Unknown', count: s._count })),
      averages: {
        aimFit: Math.round(scoreStats._avg.aimFitScore || 0),
        experienceFit: Math.round(scoreStats._avg.reqFitScore || 0)
      },
      recentIngestionRuns,
    });
  } catch (error) {
    console.error("Stats API error:", error);
    return NextResponse.json({ error: 'Failed to load database stats' }, { status: 500 });
  }
}
