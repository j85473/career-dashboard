import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { exactCompanyWhere, jobWhere } from '@/lib/jobListQuery';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { projectJobScoreAuthority } from '@/lib/scoreAuthority';

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

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim();
    const companyCondition = exactCompanyWhere(searchParams.get('company'));
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
    const statusCondition = status ? jobWhere(status, logTab) : {};
    const searchCondition: Prisma.JobWhereInput = companyCondition || {
      AND: terms.map((term) => ({
        OR: [
          { id: { contains: term, mode: 'insensitive' as const } },
          { title: { contains: term, mode: 'insensitive' as const } },
          { company: { contains: term, mode: 'insensitive' as const } },
          { source: { contains: term, mode: 'insensitive' as const } },
          { sourceId: { contains: term, mode: 'insensitive' as const } },
        ],
      })),
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
      projectJobScoreAuthority(job, latestScores.get(job.id) || null)
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
