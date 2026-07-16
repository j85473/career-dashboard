import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim();
    const platform = (searchParams.get('platform') || '').trim();
    const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
    const limit = Math.min(100000, Math.max(1, Number.parseInt(searchParams.get('limit') || '100', 10) || 100));
    const where: Prisma.AtsCompanyWhereInput = {
      status: 'active',
      ...(platform ? { platform } : {}),
      ...(query ? { slug: { contains: query, mode: 'insensitive' } } : {}),
    };

    const [companies, total, platformCounts] = await Promise.all([
      prisma.atsCompany.findMany({
        where,
        orderBy: [{ platform: 'asc' }, { slug: 'asc' }],
        take: limit,
        skip: (page - 1) * limit,
        select: {
          slug: true,
          platform: true,
          lastCheckedAt: true,
        },
      }),
      prisma.atsCompany.count({ where }),
      prisma.atsCompany.groupBy({
        by: ['platform'],
        where: { status: 'active' },
        _count: true,
        orderBy: { platform: 'asc' },
      }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return NextResponse.json({
      companies,
      platforms: platformCounts.map((entry) => ({ name: entry.platform, count: entry._count })),
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error('Failed to fetch ATS companies:', error);
    return NextResponse.json({ error: 'Failed to fetch ATS companies' }, { status: 500 });
  }
}
