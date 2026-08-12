export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  DEFAULT_JOB_PAGE_SIZE,
  DEFAULT_TRAVEL_WATCH_MINIMUM,
  MAX_JOB_PAGE_SIZE,
  jobOrder,
  jobWhere,
  positiveInteger,
} from '@/lib/jobListQuery';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { projectJobScoreAuthority } from '@/lib/scoreAuthority';
import { currentScoringInputVersions } from '@/lib/scoringInputVersions';

const TRAVEL_WATCH_STATUSES = ['pending_af', 'inbox', 'dismissed', 'bookmarked', 'cooldown'] as const;

function authoritativeScoreCtes(aimInputVersionsHash: string, experienceInputVersionsHash: string): Prisma.Sql {
  return Prisma.sql`
    WITH ranked AS (
      SELECT e.*,
        CASE WHEN e."evaluationType" = 'aim_fit' THEN 'aim' WHEN e."evaluationType" = 'experience_fit' THEN 'experience' ELSE 'legacy' END AS family,
        ROW_NUMBER() OVER (
          PARTITION BY e."jobId", CASE WHEN e."evaluationType" = 'aim_fit' THEN 'aim' WHEN e."evaluationType" = 'experience_fit' THEN 'experience' ELSE 'legacy' END
          ORDER BY e."createdAt" DESC, e."id" DESC
        ) AS family_rank,
        ROW_NUMBER() OVER (PARTITION BY e."jobId" ORDER BY e."createdAt" DESC, e."id" DESC) AS any_rank
      FROM "JobScoreEvent" e
      WHERE e."evaluationType" IN ('standard', 'ae_fit', 'aim_fit', 'experience_fit')
    ),
    newest AS (SELECT * FROM ranked WHERE any_rank = 1),
    newest_legacy AS (SELECT * FROM ranked WHERE family = 'legacy' AND family_rank = 1),
    newest_aim AS (SELECT * FROM ranked WHERE family = 'aim' AND family_rank = 1),
    newest_experience AS (SELECT * FROM ranked WHERE family = 'experience' AND family_rank = 1),
    current_legacy AS (SELECT * FROM newest_legacy WHERE "staleAt" IS NULL),
    current_aim AS (
      SELECT aim.* FROM newest_aim aim
      JOIN "JobScoringArtifact" artifact ON artifact.id = aim."cleanedJdArtifactId" AND artifact."staleAt" IS NULL
      WHERE aim."staleAt" IS NULL AND aim."inputBindings"->>'globalInputVersionsHash' = ${aimInputVersionsHash}
    ),
    current_experience AS (
      SELECT experience.* FROM newest_experience experience
      JOIN current_aim aim ON aim."jobId" = experience."jobId" AND aim.passed = true
        AND experience."sourceAimEventId" = aim.id AND experience."cleanedJdArtifactId" = aim."cleanedJdArtifactId"
      WHERE experience."staleAt" IS NULL AND experience."inputBindings"->>'globalInputVersionsHash' = ${experienceInputVersionsHash}
    ),
    latest AS (
      SELECT newest."jobId",
        CASE WHEN newest_aim."jobId" IS NOT NULL THEN current_aim."aimFitScore" ELSE current_legacy."aimFitScore" END AS "aimFitScore",
        CASE WHEN newest_aim."jobId" IS NOT NULL THEN current_experience."experienceFitScore" ELSE current_legacy."experienceFitScore" END AS "experienceFitScore",
        CASE WHEN newest_aim."jobId" IS NOT NULL THEN current_aim."travelScore" ELSE current_legacy."travelScore" END AS "travelScore"
      FROM newest
      LEFT JOIN newest_aim ON newest_aim."jobId" = newest."jobId"
      LEFT JOIN current_aim ON current_aim."jobId" = newest."jobId"
      LEFT JOIN current_experience ON current_experience."jobId" = newest."jobId"
      LEFT JOIN current_legacy ON current_legacy."jobId" = newest."jobId"
    )
  `;
}

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
  experienceStatus: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

function authoritativeOrder(sort: string, dateField: 'createdAt' | 'updatedAt' = 'createdAt'): Prisma.Sql {
  switch (sort) {
    case 'travel_fit':
      return Prisma.sql`latest."travelScore" ASC, latest."aimFitScore" DESC NULLS LAST, job."id" ASC`;
    case 'experience_fit':
      return Prisma.sql`latest."experienceFitScore" DESC NULLS LAST, latest."travelScore" DESC, job."id" ASC`;
    case 'aim_fit':
      return Prisma.sql`latest."aimFitScore" DESC NULLS LAST, latest."travelScore" DESC, job."id" ASC`;
    case 'oldest':
      return dateField === 'updatedAt'
        ? Prisma.sql`job."updatedAt" ASC, job."id" ASC`
        : Prisma.sql`job."createdAt" ASC, job."id" ASC`;
    case 'newest':
      return dateField === 'updatedAt'
        ? Prisma.sql`job."updatedAt" DESC, job."id" ASC`
        : Prisma.sql`job."createdAt" DESC, job."id" ASC`;
    case 'travel_fit_high':
    default:
      return Prisma.sql`latest."travelScore" DESC, latest."aimFitScore" DESC NULLS LAST, job."id" ASC`;
  }
}

function scoreListStatusWhere(status: string): Prisma.Sql {
  switch (status) {
    case 'inbox':
      return Prisma.sql`job."status" = 'inbox' AND job."tailoringStaged" = false`;
    case 'dismissed':
      return Prisma.sql`job."status" = 'dismissed' AND latest."jobId" IS NOT NULL`;
    case 'local_dismissed':
      return Prisma.sql`job."status" = 'dismissed' AND newest."jobId" IS NULL`;
    case 'tailoring':
      return Prisma.sql`job."tailoringStaged" = true`;
    default:
      return Prisma.sql`job."status" = ${status}`;
  }
}

async function authoritativeScorePage(input: {
  status: string;
  limit: number;
  page: number;
  sort: string;
}) {
  const versions = currentScoringInputVersions();
  const rows = await prisma.$queryRaw<Array<{ id: string; total: number }>>(Prisma.sql`
    ${authoritativeScoreCtes(versions.aimInputVersionsHash, versions.experienceInputVersionsHash)}
    SELECT job."id", COUNT(*) OVER()::int AS total
    FROM "Job" job
    LEFT JOIN newest ON newest."jobId" = job."id"
    LEFT JOIN latest ON latest."jobId" = job."id"
    WHERE ${scoreListStatusWhere(input.status)}
    ORDER BY ${authoritativeOrder(input.sort, input.status === 'applied' ? 'updatedAt' : 'createdAt')}
    LIMIT ${input.limit}
    OFFSET ${(input.page - 1) * input.limit}
  `);

  if (rows.length === 0) return { jobs: [], total: 0 };
  const ids = rows.map((row) => row.id);
  const unorderedJobs = await prisma.job.findMany({
    where: { id: { in: ids } },
    select: listSelect,
  });
  const jobsById = new Map(unorderedJobs.map((job) => [job.id, job]));
  return {
    jobs: ids.flatMap((id) => {
      const job = jobsById.get(id);
      return job ? [job] : [];
    }),
    total: rows[0].total,
  };
}

async function authoritativeTravelWatchPage(input: {
  minimumTravel: number;
  limit: number;
  page: number;
  sort: string;
}) {
  const versions = currentScoringInputVersions();
  const rows = await prisma.$queryRaw<Array<{ id: string; total: number }>>(Prisma.sql`
    ${authoritativeScoreCtes(versions.aimInputVersionsHash, versions.experienceInputVersionsHash)}
    SELECT job."id", COUNT(*) OVER()::int AS total
    FROM "Job" job
    JOIN latest ON latest."jobId" = job."id"
    WHERE job."status" IN (${Prisma.join([...TRAVEL_WATCH_STATUSES])})
      AND latest."travelScore" >= ${input.minimumTravel}
    ORDER BY ${authoritativeOrder(input.sort)}
    LIMIT ${input.limit}
    OFFSET ${(input.page - 1) * input.limit}
  `);

  if (rows.length === 0) return { jobs: [], total: 0 };
  const ids = rows.map((row) => row.id);
  const unorderedJobs = await prisma.job.findMany({
    where: { id: { in: ids } },
    select: listSelect,
  });
  const jobsById = new Map(unorderedJobs.map((job) => [job.id, job]));
  return {
    jobs: ids.flatMap((id) => {
      const job = jobsById.get(id);
      return job ? [job] : [];
    }),
    total: rows[0].total,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || 'inbox';
    const logTab = searchParams.get('logTab') || 'aim_fit';
    const sort = searchParams.get('sort') || (status === 'log' ? 'newest' : 'aim_fit');
    const minimumTravel = positiveInteger(
      searchParams.get('minimumTravel'),
      DEFAULT_TRAVEL_WATCH_MINIMUM,
      100,
    );
    const page = positiveInteger(searchParams.get('page'), 1);
    const limit = positiveInteger(searchParams.get('limit'), DEFAULT_JOB_PAGE_SIZE, MAX_JOB_PAGE_SIZE);
    const where = jobWhere(status, logTab);

    const result = status === 'travel_watch'
      ? await authoritativeTravelWatchPage({ minimumTravel, limit, page, sort })
      : status !== 'log'
        ? await authoritativeScorePage({ status, limit, page, sort })
      : await (async () => {
        const [jobs, total] = await Promise.all([
          prisma.job.findMany({
            where,
            take: limit,
            skip: (page - 1) * limit,
            orderBy: jobOrder(status, sort),
            select: listSelect,
          }),
          prisma.job.count({ where }),
        ]);
        return { jobs, total };
      })();

    const latestScores = await latestJobScoreEvents(result.jobs.map((job) => job.id));
    const jobs = result.jobs.map((job) => (
      projectJobScoreAuthority(job, latestScores.get(job.id) || null)
    ));
    const { total } = result;

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
