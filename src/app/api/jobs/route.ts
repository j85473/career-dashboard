export const dynamic = "force-dynamic";
export const revalidate = 0;
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'inbox'; // inbox, applied, bookmarked, archived
  
  let whereClause: any = { status };
  
  // If we are looking for dismissed jobs, we WANT the ones with fitCategory = rejected
  if (status === 'log') {
    whereClause = {
      OR: [
        {
          status: { notIn: ['dismissed', 'passed', 'archived', 'expired', 'applied'] },
          OR: [
            { scoringStatus: { in: ['queued', 'scoring', 'failed', 'skipped', 'needs_jd'] } },
            { fitCategory: 'review' },
            { experienceStatus: { in: ['queued', 'processing'] } },
            { status: 'pending_af' },
            { afBatchId: { not: null } }
          ]
        },
        {
          status: { in: ['passed', 'applied'] },
          contextBatched: false
        }
      ]
    };
  } else if (status === 'dismissed') {
    // dismissed tab shows AI auto-rejected jobs and manually dismissed jobs
    whereClause = { status: 'dismissed' };
  } else if (status === 'tailoring') {
    // tailoring tab shows jobs staged for tailoring
    whereClause = { tailoringStaged: true };
  } else {
    // other tabs exclude unscored and rejected jobs
    if (status !== 'passed') {
      whereClause.fitCategory = { notIn: ['rejected', 'unscored'] };
    }
    if (status === 'inbox') {
      whereClause.tailoringStaged = false;
    }
  }

  const jobs = await prisma.job.findMany({
    where: whereClause,
    orderBy: {
      fitScore: 'desc'
    }
  });

  return NextResponse.json({ jobs });
}
