import { NextResponse } from 'next/server';
import { observeDashboardJobList } from '@/lib/dashboardResponsiveness';
import { Prisma } from '../../../../lib/prismaClient';
import { prisma } from '@/lib/prisma';
import { currentAimSuppressedJobIds } from '@/lib/currentAimFailureSuppression';
import { isFailureLogTab, jobWhereWithCurrentAimSuppressions } from '@/lib/jobListQuery';
import { companyJobsWhere } from '@/lib/companyJobQuery';
import { companyJobOrderedPage } from '@/lib/companyJobOrder';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { projectJobListScoreAuthority } from '@/lib/scoreAuthority';
import { scoringFailureOrderedPage } from '@/lib/scoringFailureOrder';
import { selectedJobSort, usesStatusEntryTimeSort } from '@/lib/jobSort';
import { jobAttachmentSelect } from '@/lib/jobAttachments';
import { statusEntryOrderedPage } from '@/lib/jobStatusEntryOrder';
import { withApplicationDates } from '@/lib/jobApplicationDate';
import { jobSourceUrlMatchIds, jobUrlSearchWhere } from '@/lib/jobUrlSearch';
import { jobLocationSearchValues, LocationSearchError, resolveJobLocationFilter } from '@/lib/jobLocationSearch';
import {
  isManualScoringQueueTab,
  manualScoringCombinedOrderedPage,
} from '@/lib/manualScoringQueueOrder';
import {
  advancedJobStatusWhere,
  hasOnlyValidAdvancedJobSearchStatuses,
  isAdvancedJobSearchField,
  parseAdvancedJobSearchStatuses,
  type AdvancedJobSearchField,
  type AdvancedJobSearchStatus,
} from '@/lib/advancedJobSearch';

const searchSelect = {
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
  createdAt: true,
  updatedAt: true,
  attachments: { select: jobAttachmentSelect, orderBy: [{ uploadedAt: 'desc' as const }, { id: 'desc' as const }] },
} satisfies Prisma.JobSelect;

/**
 * Description matches are retrieved on their own and merged in by id.
 *
 * `description` is deliberately absent from the ILIKE arms below and must not
 * be added to them. Descriptions average ~2.1KB and live in TOAST, so a
 * substring match has to de-TOAST every row it inspects: measured on
 * production, `title ILIKE '%channel partner%'` returned 141 rows in 0.67s
 * while the same predicate on `description` had not finished after 12s. That
 * is why description search was removed from this route in the first place.
 *
 * Full-text search has no such cost. The GIN bitmap over
 * `to_tsvector('english', description)` is exact, so the heap recheck never
 * re-evaluates the expression and the TOAST chunks are never read.
 *
 * Two consequences worth knowing. This arm matches words and their stems, not
 * substrings -- "channel" finds "channels", "chan" finds nothing -- while the
 * metadata and URL arms below stay substring matches. And it returns the most recent
 * DESCRIPTION_MATCH_LIMIT matches rather than all of them, which is what keeps
 * the `count()` below bounded; an exact count cannot short-circuit on LIMIT,
 * and that was the other half of the original slowness.
 */
const DESCRIPTION_MATCH_LIMIT = 500;

/**
 * Recent-first window tried before the whole table.
 *
 * The ordering is what costs: every match has to be read from the heap just to
 * supply its `createdAt` for the sort, so a common word is expensive purely
 * because it matches a lot. Measured on 735k rows, "sales" matched 172,794 and
 * took 6.8s unbounded but 394ms inside this window; "channel partner" went
 * from 539ms to 243ms.
 *
 * This is exact, not an approximation. Every row outside the window is older
 * than every row inside it, so when the windowed query fills the limit those
 * rows are already the newest matches that exist and a wider search cannot
 * change the answer. Only a short result needs the unbounded pass, and a term
 * that rare is cheap to run unbounded anyway.
 */
const DESCRIPTION_RECENT_WINDOW_DAYS = 14;

/**
 * MATERIALIZED is load-bearing. Without the fence the planner inlines this and
 * sees an ORDER BY/LIMIT it can satisfy by walking `Job_createdAt_idx`
 * backward, applying the tsvector as a row filter -- which re-evaluates
 * `to_tsvector` per row and de-TOASTs the description, the exact cost this
 * index exists to avoid. Measured, that plan took 20.9s where the fenced
 * bitmap scan takes 539ms.
 */
function descriptionStatusSql(statuses: readonly AdvancedJobSearchStatus[]): Prisma.Sql {
  if (statuses.length === 0) return Prisma.empty;
  const conditions = statuses.map((status) => {
    if (status === 'inbox') return Prisma.sql`("status" = 'inbox' AND "tailoringStaged" = false)`;
    if (status === 'tailoring') return Prisma.sql`"tailoringStaged" = true`;
    return Prisma.sql`"status" = ${status}`;
  });
  return Prisma.sql`AND (${Prisma.join(conditions, ' OR ')})`;
}

async function findJobIdsByDescription(
  query: string,
  statuses: readonly AdvancedJobSearchStatus[] = [],
  locationValues: string[] | null = null,
): Promise<string[]> {
  const statusCondition = descriptionStatusSql(statuses);
  // Apply geography before the 500-description limit so local matches cannot
  // be crowded out by newer jobs elsewhere. One JSON bind avoids parameter limits.
  const locationCondition = locationValues === null ? Prisma.empty : Prisma.sql`AND "location" IN (
    SELECT jsonb_array_elements_text(${JSON.stringify(locationValues)}::jsonb)
  )`;
  const recent = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH matches AS MATERIALIZED (
      SELECT "id", "createdAt" FROM "Job"
       WHERE "createdAt" >= now() - make_interval(days => ${DESCRIPTION_RECENT_WINDOW_DAYS}::int)
         ${statusCondition}
         ${locationCondition}
         AND to_tsvector('english', "description") @@ websearch_to_tsquery('english', ${query})
    )
    SELECT "id" FROM matches ORDER BY "createdAt" DESC LIMIT ${DESCRIPTION_MATCH_LIMIT}
  `;
  if (recent.length >= DESCRIPTION_MATCH_LIMIT) return recent.map((row) => row.id);

  const all = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH matches AS MATERIALIZED (
      SELECT "id", "createdAt" FROM "Job"
       WHERE to_tsvector('english', "description") @@ websearch_to_tsquery('english', ${query})
         ${statusCondition}
         ${locationCondition}
    )
    SELECT "id" FROM matches ORDER BY "createdAt" DESC LIMIT ${DESCRIPTION_MATCH_LIMIT}
  `;
  return all.map((row) => row.id);
}

function fieldSearchWhere(
  field: AdvancedJobSearchField,
  terms: string[],
  descriptionMatchIds: string[],
  query: string,
  sourceUrlMatchIds: string[],
): Prisma.JobWhereInput {
  if (field === 'description') return { id: { in: descriptionMatchIds } };
  if (field === 'url') return jobUrlSearchWhere(query, sourceUrlMatchIds);
  if (field === 'all') {
    // A pasted URL is a link lookup. Metadata substring arms would force a
    // full-table scan even when the URL indexes can identify one exact job.
    if (/^https?:\/\//i.test(query)) return jobUrlSearchWhere(query, sourceUrlMatchIds);
    return {
      OR: [
        {
          AND: terms.map((term) => ({
            OR: [
              { id: { contains: term, mode: 'insensitive' as const } },
              { title: { contains: term, mode: 'insensitive' as const } },
              { company: { contains: term, mode: 'insensitive' as const } },
              { source: { contains: term, mode: 'insensitive' as const } },
              { sourceId: { contains: term, mode: 'insensitive' as const } },
            ],
          })),
        },
        ...(descriptionMatchIds.length > 0 ? [{ id: { in: descriptionMatchIds } }] : []),
        jobUrlSearchWhere(query, sourceUrlMatchIds),
      ],
    };
  }
  return {
    AND: terms.map((term) => ({
      [field]: { contains: term, mode: 'insensitive' as const },
    })),
  };
}

export async function GET(request: Request) {
  return observeDashboardJobList(() => searchJobs(request));
}

async function searchJobs(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim();
    const companyCondition = await companyJobsWhere(searchParams.get('company'), prisma);
    const status = searchParams.get('status');
    const logTab = searchParams.get('logTab') || 'aim_fit';
    const sort = selectedJobSort(status || '', searchParams.get('sort'));
    const fieldValue = searchParams.get('field');
    const field: AdvancedJobSearchField = fieldValue === null ? 'all' : isAdvancedJobSearchField(fieldValue) ? fieldValue : 'all';
    const advancedStatusesValue = searchParams.get('statuses');
    const advancedStatuses = parseAdvancedJobSearchStatuses(advancedStatusesValue);
    const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(searchParams.get('limit') || '30', 10) || 30));
    const locationFilter = resolveJobLocationFilter(searchParams.get('location') || '', searchParams.get('radius'));

    if ((fieldValue !== null && !isAdvancedJobSearchField(fieldValue))
      || !hasOnlyValidAdvancedJobSearchStatuses(advancedStatusesValue)) {
      return NextResponse.json({ error: 'Invalid advanced search options.' }, { status: 400 });
    }

    if (!companyCondition && !locationFilter && query.length < 2) {
      return NextResponse.json({
        jobs: [],
        pagination: { page: 1, limit, total: 0, totalPages: 1, hasMore: false },
      });
    }

    const terms = query.split(/\s+/).filter(Boolean).slice(0, 8);
    const resolvedSuppressionIds = status === 'log'
      && ['aim_fit', 'jd_failed', 'scoring_failed', 'action_needed'].includes(logTab)
      ? await currentAimSuppressedJobIds(prisma)
      : [];
    const statusCondition = status
      ? jobWhereWithCurrentAimSuppressions(status, logTab, resolvedSuppressionIds)
      : {};
    const scopedStatusCondition = advancedStatuses.length > 0
      ? advancedJobStatusWhere(advancedStatuses)
      : statusCondition;
    const descriptionStatuses = advancedStatuses.length > 0
      ? advancedStatuses
      : status && ['inbox', 'tailoring', 'pending_af', 'applied', 'interviewing', 'cooldown', 'bookmarked', 'archived', 'expired', 'passed', 'dismissed'].includes(status)
        ? [status as AdvancedJobSearchStatus]
        : [];
    const searchesDescriptions = field === 'description'
      || (field === 'all' && !/^https?:\/\//i.test(query));
    const locationValues = locationFilter
      ? await jobLocationSearchValues(locationFilter, { AND: [
        scopedStatusCondition,
        companyCondition || (query && (field === 'title' || field === 'company')
          ? fieldSearchWhere(field, terms, [], query, []) : {}),
      ] }, prisma)
      : null;
    const descriptionMatchIds = companyCondition || !searchesDescriptions || !query
      ? []
      : await findJobIdsByDescription(query, descriptionStatuses, locationValues);
    const sourceUrlMatchIds = query && !companyCondition && (field === 'url' || field === 'all')
      ? await jobSourceUrlMatchIds(query, prisma)
      : [];
    const searchCondition: Prisma.JobWhereInput = companyCondition || (!query ? {} : fieldSearchWhere(
      field,
      terms,
      descriptionMatchIds,
      query,
      sourceUrlMatchIds,
    ));

    const where: Prisma.JobWhereInput = {
      AND: [
        scopedStatusCondition,
        searchCondition,
        ...(locationValues === null ? [] : [{ location: { in: locationValues } }]),
      ],
    };

    const companyPage = companyCondition
      ? await companyJobOrderedPage(where, limit, (page - 1) * limit, prisma)
      : null;
    const failurePage = status === 'log' && isFailureLogTab(logTab)
      ? await scoringFailureOrderedPage(where, resolvedSuppressionIds, limit, (page - 1) * limit)
      : null;
    const manualScoringPage = status === 'log' && isManualScoringQueueTab(logTab)
      ? await manualScoringCombinedOrderedPage(where, logTab, limit, (page - 1) * limit)
      : null;
    const statusEntrySearchCandidates = status && usesStatusEntryTimeSort(status, sort)
      ? await prisma.job.findMany({ where, select: { id: true } })
      : null;
    const statusEntryPage = status && usesStatusEntryTimeSort(status, sort)
      ? await statusEntryOrderedPage(
        where,
        status,
        sort === 'oldest' ? 'asc' : 'desc',
        limit,
        (page - 1) * limit,
        prisma,
        statusEntrySearchCandidates?.map((candidate) => candidate.id),
      )
      : null;
    const historyOrderedPage = companyPage || failurePage || manualScoringPage || statusEntryPage;
    const [jobs, total] = historyOrderedPage
      ? await Promise.all([
        historyOrderedPage.ids.length === 0
          ? []
          : prisma.job.findMany({ where: { id: { in: historyOrderedPage.ids } }, select: searchSelect }).then((rows) => {
            const rowById = new Map(rows.map((row) => [row.id, row]));
            return historyOrderedPage.ids.map((id) => rowById.get(id)).filter((row): row is typeof rows[number] => Boolean(row));
          }),
        Promise.resolve(historyOrderedPage.total),
      ])
      : await Promise.all([
        prisma.job.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: limit,
          skip: (page - 1) * limit,
          select: searchSelect,
        }),
        prisma.job.count({ where }),
      ]);
    const latestScores = await latestJobScoreEvents(jobs.map((job) => job.id));
    const datedJobs = await withApplicationDates(jobs);
    const authoritativeJobs = datedJobs.map((job) => (
      projectJobListScoreAuthority(job, latestScores.get(job.id) || null)
    ));
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return NextResponse.json({
      jobs: authoritativeJobs,
      location: locationFilter ? { label: locationFilter.label } : null,
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (error instanceof LocationSearchError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Failed to search jobs:', error);
    return NextResponse.json({ error: 'Failed to search jobs' }, { status: 500 });
  }
}
