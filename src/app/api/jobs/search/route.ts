import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { currentAimSuppressedJobIds } from '@/lib/currentAimFailureSuppression';
import { jobWhereWithCurrentAimSuppressions } from '@/lib/jobListQuery';
import { companyJobsWhere } from '@/lib/companyJobQuery';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { projectJobListScoreAuthority } from '@/lib/scoreAuthority';

const searchSelect = {
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
 * five ILIKE arms below stay substring matches. And it returns the most recent
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
async function findJobIdsByDescription(query: string): Promise<string[]> {
  const recent = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH matches AS MATERIALIZED (
      SELECT "id", "createdAt" FROM "Job"
       WHERE "createdAt" >= now() - make_interval(days => ${DESCRIPTION_RECENT_WINDOW_DAYS}::int)
         AND to_tsvector('english', "description") @@ websearch_to_tsquery('english', ${query})
    )
    SELECT "id" FROM matches ORDER BY "createdAt" DESC LIMIT ${DESCRIPTION_MATCH_LIMIT}
  `;
  if (recent.length >= DESCRIPTION_MATCH_LIMIT) return recent.map((row) => row.id);

  const all = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH matches AS MATERIALIZED (
      SELECT "id", "createdAt" FROM "Job"
       WHERE to_tsvector('english', "description") @@ websearch_to_tsquery('english', ${query})
    )
    SELECT "id" FROM matches ORDER BY "createdAt" DESC LIMIT ${DESCRIPTION_MATCH_LIMIT}
  `;
  return all.map((row) => row.id);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim();
    const companyCondition = await companyJobsWhere(searchParams.get('company'), prisma);
    const status = searchParams.get('status');
    const logTab = searchParams.get('logTab') || 'aim_fit';
    const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(searchParams.get('limit') || '30', 10) || 30));

    if (!companyCondition && query.length < 2) {
      return NextResponse.json({
        jobs: [],
        pagination: { page: 1, limit, total: 0, totalPages: 1, hasMore: false },
      });
    }

    const terms = query.split(/\s+/).filter(Boolean).slice(0, 8);
    const resolvedSuppressionIds = status === 'log' && (logTab === 'aim_fit' || logTab === 'action_needed')
      ? await currentAimSuppressedJobIds(prisma)
      : [];
    const statusCondition = status
      ? jobWhereWithCurrentAimSuppressions(status, logTab, resolvedSuppressionIds)
      : {};
    const descriptionMatchIds = companyCondition ? [] : await findJobIdsByDescription(query);
    const searchCondition: Prisma.JobWhereInput = companyCondition || {
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
      ],
    };

    const where: Prisma.JobWhereInput = {
      AND: [
        statusCondition,
        searchCondition,
      ],
    };

    const [jobs, total] = await Promise.all([
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
    const authoritativeJobs = jobs.map((job) => (
      projectJobListScoreAuthority(job, latestScores.get(job.id) || null)
    ));
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return NextResponse.json({
      jobs: authoritativeJobs,
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error('Failed to search jobs:', error);
    return NextResponse.json({ error: 'Failed to search jobs' }, { status: 500 });
  }
}
