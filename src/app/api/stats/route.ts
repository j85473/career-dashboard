import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const totalJobs = await prisma.job.count();
    const jobsByStatus = await prisma.job.groupBy({
      by: ['status'],
      _count: true
    });

    const totalAtsBoards = await prisma.atsCompany.count();
    const activeAtsBoards = await prisma.atsCompany.count({ where: { status: 'active' } });
    const parkedAtsBoards = await prisma.atsCompany.count({ where: { status: 'parked' } });
    
    const atsByPlatformRaw = await prisma.atsCompany.groupBy({
      by: ['platform', 'status'],
      _count: true
    });

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

    const jobsBySourceRaw = await prisma.job.groupBy({
      by: ['source'],
      _count: true
    });

    const scoreStats = await prisma.job.aggregate({
      _avg: {
        aimFitScore: true,
        reqFitScore: true,
      }
    });

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
      }
    });
  } catch (error: any) {
    console.error("Stats API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
