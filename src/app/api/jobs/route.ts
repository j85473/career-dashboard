export const dynamic = "force-dynamic";
export const revalidate = 0;
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'inbox'; // inbox, applied, bookmarked, archived
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = parseInt(searchParams.get('limit') || '100', 10);
  const skip = (page - 1) * limit;
  
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
            { afBatchId: { not: null } },
            { aimFitScore: null, scoringStatus: 'scored' }
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
  } else if (status === 'lucky_inbox') {
    whereClause = { 
      luckyStatus: 'inbox',
      status: { in: ['pending_af', 'inbox', 'bookmarked', 'dismissed'] }
    };
  } else if (status === 'lucky_dismissed') {
    whereClause = { luckyStatus: 'dismissed' };
  } else if (status === 'tailoring') {
    // tailoring tab shows jobs staged for tailoring
    whereClause = { tailoringStaged: true };
  } else if (status === 'cooldown') {
    whereClause = {
      OR: [
        { status: 'cooldown' },
        { luckyStatus: 'cooldown' }
      ]
    };
  } else {
    if (status === 'inbox') {
      whereClause.tailoringStaged = false;
      whereClause.luckyStatus = { not: 'inbox' };
      whereClause.aimFitScore = { not: null };
    }
  }

  const jobs = await prisma.job.findMany({
    where: whereClause,
    take: limit,
    skip: skip,
    orderBy: {
      aimFitScore: { sort: 'desc', nulls: 'last' }
    },
    select: {
      id: true, title: true, company: true, location: true, url: true,
      source: true, sourceId: true, manualAts: true, canonicalUrl: true, fingerprint: true,
      postedAt: true, status: true, verificationStatus: true,
      contextBatched: true, afBatchId: true, jdBatchId: true, cooldownUntil: true,
      scoringStatus: true, scoreAttempts: true, scoreError: true,
      fitScore: true, aimFitScore: true, fitCategory: true, fitRationale: true,
      tailoringAdvice: true, recommendedResume: true, tailoringStaged: true, passReason: true,
      luckyStatus: true, luckyFitScore: true, luckyAimFitScore: true, luckyFitCategory: true,
      luckyPassReason: true, luckyScoreAttempts: true, luckyScoreError: true,
      reqFitScore: true, reqFitRationale: true, travelScore: true,
      experienceStatus: true, batchJobId: true, createdAt: true, updatedAt: true
    }
  });

  return NextResponse.json({ jobs });
}
