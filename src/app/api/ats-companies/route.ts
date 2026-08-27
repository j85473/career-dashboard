import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type AtsCompanyListRow = {
  slug: string;
  platform: string;
  lastCheckedAt?: Date | null;
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim();
    const platform = (searchParams.get('platform') || '').trim();
    const overview = searchParams.get('overview') === '1';
    const identitiesOnly = searchParams.get('identitiesOnly') === '1';
    const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
    const requestedLimit = Math.max(1, Number.parseInt(searchParams.get('limit') || '100', 10) || 100);
    const limit = Math.min(identitiesOnly ? 100000 : overview ? 200 : 500, requestedLimit);
    const where: Prisma.AtsCompanyWhereInput = {
      status: 'active',
      ...(platform ? { platform } : {}),
      ...(query ? { slug: { contains: query, mode: 'insensitive' } } : {}),
    };

    if (overview) {
      const [companies, platformCounts] = await Promise.all([
        prisma.$queryRaw<AtsCompanyListRow[]>(Prisma.sql`
          WITH ranked AS (
            SELECT
              slug,
              platform,
              "lastCheckedAt",
              ROW_NUMBER() OVER (PARTITION BY platform ORDER BY slug ASC) AS rank
            FROM "AtsCompany"
            WHERE status = 'active'
          )
          SELECT slug, platform, "lastCheckedAt"
          FROM ranked
          WHERE rank <= ${limit}
          ORDER BY platform ASC, slug ASC
        `),
        prisma.atsCompany.groupBy({
          by: ['platform'],
          where: { status: 'active' },
          _count: true,
          orderBy: { platform: 'asc' },
        }),
      ]);
      const total = platformCounts.reduce((sum, entry) => sum + entry._count, 0);
      return NextResponse.json({
        companies,
        platforms: platformCounts.map((entry) => ({ name: entry.platform, count: entry._count })),
        pagination: { page: 1, limit, total, totalPages: 1, hasMore: companies.length < total },
      }, {
        headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' },
      });
    }

    const [companies, total, platformCounts] = await Promise.all([
      prisma.atsCompany.findMany({
        where,
        orderBy: [{ platform: 'asc' }, { slug: 'asc' }],
        take: limit,
        skip: (page - 1) * limit,
        select: {
          slug: true,
          platform: true,
          ...(!identitiesOnly ? { lastCheckedAt: true } : {}),
        },
      }),
      prisma.atsCompany.count({ where }),
      platform
        ? Promise.resolve([])
        : prisma.atsCompany.groupBy({
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
      headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' },
    });
  } catch (error) {
    console.error('Failed to fetch ATS companies:', error);
    return NextResponse.json({ error: 'Failed to fetch ATS companies' }, { status: 500 });
  }
}
