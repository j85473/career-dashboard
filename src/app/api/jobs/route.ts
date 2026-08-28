export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  DEFAULT_JOB_PAGE_SIZE,
  MAX_JOB_PAGE_SIZE,
  jobOrder,
  jobWhereWithCurrentAimSuppressions,
  positiveInteger,
} from '@/lib/jobListQuery';
import { currentAimSuppressedJobIds } from '@/lib/currentAimFailureSuppression';
import { inboxOrderedIds } from '@/lib/inboxEnteredAt';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { projectJobListScoreAuthority } from '@/lib/scoreAuthority';
import { defaultJobSort } from '@/lib/jobSort';

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
    const sort = searchParams.get('sort') || defaultJobSort(status);
    const page = positiveInteger(searchParams.get('page'), 1);
    const limit = positiveInteger(searchParams.get('limit'), DEFAULT_JOB_PAGE_SIZE, MAX_JOB_PAGE_SIZE);
    const resolvedSuppressionIds = status === 'log' && (logTab === 'aim_fit' || logTab === 'action_needed')
      ? await currentAimSuppressedJobIds(prisma)
      : [];
    const where: Prisma.JobWhereInput = jobWhereWithCurrentAimSuppressions(
      status,
      logTab,
      resolvedSuppressionIds,
    );

    // Board pagination must stay on the indexed Job projections. Score history
    // is consulted only for the returned page below, never to discover, count,
    // sort, or page the full board.
    //
    // Inbox "Newest"/"Oldest" is the one exception: it means true Inbox entry
    // time, not `createdAt` (original ingestion, which can predate Inbox entry
    // by weeks while a job sits in earlier pipeline stages). That value is a
    // correlated subquery over pipeline events, which Prisma's query builder
    // cannot express in `orderBy` — order+paginate the IDs via raw SQL, then
    // fetch and re-sort to match, since `IN` does not preserve input order.
    const inboxEnteredAtSort = status === 'inbox' && (sort === 'newest' || sort === 'oldest');
    const [pageJobs, total] = await Promise.all([
      inboxEnteredAtSort
        ? (async () => {
          const ids = await inboxOrderedIds(sort === 'oldest' ? 'asc' : 'desc', limit, (page - 1) * limit);
          if (ids.length === 0) return [];
          const rows = await prisma.job.findMany({ where: { id: { in: ids } }, select: listSelect });
          const rowById = new Map(rows.map((row) => [row.id, row]));
          return ids.map((id) => rowById.get(id)).filter((row): row is typeof rows[number] => Boolean(row));
        })()
        : prisma.job.findMany({
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
      projectJobListScoreAuthority(job, latestScores.get(job.id) || null)
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
