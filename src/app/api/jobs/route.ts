export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { NextResponse } from 'next/server';
import { observeDashboardJobList } from '@/lib/dashboardResponsiveness';
import { Prisma } from '../../../lib/prismaClient';
import { prisma } from '@/lib/prisma';
import {
  DEFAULT_JOB_PAGE_SIZE,
  MAX_JOB_PAGE_SIZE,
  inboxAtsSystem,
  inboxJobFilter,
  isFailureLogTab,
  jobOrder,
  jobWhereWithCurrentAimSuppressions,
  positiveInteger,
} from '@/lib/jobListQuery';
import { currentAimSuppressedJobIds } from '@/lib/currentAimFailureSuppression';
import { inboxAtsFilteredPage } from '@/lib/inboxEnteredAt';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { projectJobListScoreAuthority } from '@/lib/scoreAuthority';
import { selectedJobSort, usesStatusEntryTimeSort } from '@/lib/jobSort';
import { jobAttachmentSelect } from '@/lib/jobAttachments';
import { scoringFailureOrderedPage } from '@/lib/scoringFailureOrder';
import { statusEntryOrderedPage } from '@/lib/jobStatusEntryOrder';
import { withJobApplicationContext } from '@/lib/jobApplicationContext';
import {
  isManualScoringQueueTab,
  manualScoringCombinedOrderedPage,
} from '@/lib/manualScoringQueueOrder';

const listSelect = {
  id: true,
  title: true,
  company: true,
  employer: true,
  location: true,
  url: true,
  canonicalUrl: true,
  source: true,
  sourceId: true,
  manualAts: true,
  postedAt: true,
  status: true,
  contextBatched: true,
  afBatchId: true,
  jdBatchId: true,
  scoringStatus: true,
  verificationStatus: true,
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
  attachments: { select: jobAttachmentSelect, orderBy: [{ uploadedAt: 'desc' as const }, { id: 'desc' as const }] },
} satisfies Prisma.JobSelect;

export async function GET(request: Request) {
  return observeDashboardJobList(() => getJobs(request));
}

async function getJobs(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || 'inbox';
    const logTab = searchParams.get('logTab') || 'aim_fit';
    const sort = selectedJobSort(status, searchParams.get('sort'));
    const filter = inboxJobFilter(searchParams.get('filter'), status);
    const atsSystem = inboxAtsSystem(filter);
    const page = positiveInteger(searchParams.get('page'), 1);
    const limit = positiveInteger(searchParams.get('limit'), DEFAULT_JOB_PAGE_SIZE, MAX_JOB_PAGE_SIZE);
    const resolvedSuppressionIds = status === 'log'
      && ['aim_fit', 'jd_failed', 'scoring_failed', 'action_needed'].includes(logTab)
      ? await currentAimSuppressedJobIds(prisma)
      : [];
    const where: Prisma.JobWhereInput = jobWhereWithCurrentAimSuppressions(
      status,
      logTab,
      resolvedSuppressionIds,
    );

    // Resolve priority before pagination for every Inbox sort and ATS filter.
    const offset = (page - 1) * limit;
    const atsPage = status === 'inbox' ? await inboxAtsFilteredPage(atsSystem, sort, limit, offset) : null;
    const failurePage = status === 'log' && isFailureLogTab(logTab)
      ? await scoringFailureOrderedPage(where, resolvedSuppressionIds, limit, offset)
      : null;
    const manualScoringPage = status === 'log' && isManualScoringQueueTab(logTab)
      ? await manualScoringCombinedOrderedPage(where, logTab, limit, offset)
      : null;
    const statusEntryPage = usesStatusEntryTimeSort(status, sort)
      ? await statusEntryOrderedPage(where, status, sort === 'oldest' ? 'asc' : 'desc', limit, offset)
      : null;
    const historyOrderedPage = failurePage || manualScoringPage || statusEntryPage;
    const [pageJobs, total] = atsPage
      ? await Promise.all([
        atsPage.ids.length === 0
          ? []
          : prisma.job.findMany({ where: { id: { in: atsPage.ids } }, select: listSelect }).then((rows) => {
            const rowById = new Map(rows.map((row) => [row.id, row]));
            return atsPage.ids.map((id) => rowById.get(id)).filter((row): row is typeof rows[number] => Boolean(row));
          }),
        Promise.resolve(atsPage.total),
      ])
      : historyOrderedPage
      ? await Promise.all([
        historyOrderedPage.ids.length === 0
          ? []
          : prisma.job.findMany({ where: { id: { in: historyOrderedPage.ids } }, select: listSelect }).then((rows) => {
            const rowById = new Map(rows.map((row) => [row.id, row]));
            return historyOrderedPage.ids.map((id) => rowById.get(id)).filter((row): row is typeof rows[number] => Boolean(row));
          }),
        Promise.resolve(historyOrderedPage.total),
      ])
      : await Promise.all([
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
    const datedJobs = await withJobApplicationContext(pageJobs);
    const jobs = datedJobs.map((job) => (
      projectJobListScoreAuthority(job, latestScores.get(job.id) || null)
    ));

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return NextResponse.json({
      jobs,
      ...(atsPage ? { atsOptions: atsPage.atsOptions } : {}),
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
