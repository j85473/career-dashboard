import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

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
  luckyStatus: true,
  luckyAimFitScore: true,
  luckyFitCategory: true,
  luckyPassReason: true,
  reqFitScore: true,
  travelScore: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim();
    const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(searchParams.get('limit') || '30', 10) || 30));

    if (query.length < 2) {
      return NextResponse.json({
        jobs: [],
        pagination: { page: 1, limit, total: 0, totalPages: 1, hasMore: false },
      });
    }

    const terms = query.split(/\s+/).filter(Boolean).slice(0, 8);
    const where: Prisma.JobWhereInput = {
      AND: terms.map((term) => ({
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { company: { contains: term, mode: 'insensitive' } },
          { description: { contains: term, mode: 'insensitive' } },
          { source: { contains: term, mode: 'insensitive' } },
        ],
      })),
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
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return NextResponse.json({
      jobs,
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error('Failed to search jobs:', error);
    return NextResponse.json({ error: 'Failed to search jobs' }, { status: 500 });
  }
}
