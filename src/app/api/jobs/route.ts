export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  DEFAULT_JOB_PAGE_SIZE,
  MAX_JOB_PAGE_SIZE,
  jobOrder,
  jobWhere,
  positiveInteger,
} from '@/lib/jobListQuery';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { projectJobScoreAuthority } from '@/lib/scoreAuthority';

const listSelect = {
  id: true,
  title: true,
  company: true,
  location: true,
  url: true,
  source: true,
  sourceId: true,
  manualAts: true,
  postedAt: true,
  status: true,
  contextBatched: true,
  afBatchId: true,
  jdBatchId: true,
  scoringStatus: true,
  scoreAttempts: true,
  scoreError: true,
  fitScore: true,
  aimFitScore: true,
  fitCategory: true,
  tailoringStaged: true,
  reqFitScore: true,
  travelScore: true,
  passReason: true,
  compensation: true,
  postedCompensation: true,
  postedTravel: true,
  experienceStatus: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || 'inbox';
    const logTab = searchParams.get('logTab') || 'aim_fit';
    const sort = searchParams.get('sort') || (status === 'log' ? 'newest' : 'aim_fit');
    const page = positiveInteger(searchParams.get('page'), 1);
    const limit = positiveInteger(searchParams.get('limit'), DEFAULT_JOB_PAGE_SIZE, MAX_JOB_PAGE_SIZE);
    const where: Prisma.JobWhereInput = jobWhere(status, logTab);

    // Board pagination must stay on the indexed Job projections. Score history
    // is consulted only for the returned page below, never to discover, count,
    // sort, or page the full board.
    const [pageJobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        take: limit,
        skip: (page - 1) * limit,
        orderBy: jobOrder(status, sort),
        select: listSelect,
      }),
      prisma.job.count({ where }),
    ]);

    const latestScores = await latestJobScoreEvents(pageJobs.map((job) => job.id));
    const jobs = pageJobs.map((job) => (
      projectJobScoreAuthority(job, latestScores.get(job.id) || null)
    ));

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return NextResponse.json({
      jobs,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error('Failed to fetch jobs:', error);
    return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 });
  }
}
