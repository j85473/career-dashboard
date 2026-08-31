import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const stage = new URL(request.url).searchParams.get('stage');
  if (stage !== null && stage !== 'aim' && stage !== 'experience') {
    return NextResponse.json({ error: 'stage must be aim or experience' }, { status: 400 });
  }
  const runs = await prisma.scoringRun.findMany({
    where: stage ? { stage } : undefined,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    select: {
      id: true,
      stage: true,
      status: true,
      createdAt: true,
      expiresAt: true,
      completedAt: true,
      releasedAt: true,
      exportHash: true,
      jobCount: true,
      batchCount: true,
      batches: {
        orderBy: { runOrdinal: 'asc' },
        select: { id: true, status: true, runOrdinal: true, _count: { select: { items: true } } },
      },
    },
  });
  const now = Date.now();
  return NextResponse.json({
    runs: runs.map((run) => ({
      ...run,
      derivedExpired: run.status === 'exported' && run.expiresAt.valueOf() < now,
      completedBatchCount: run.batches.filter((batch) => batch.status === 'completed').length,
      completedJobCount: run.batches
        .filter((batch) => batch.status === 'completed')
        .reduce((sum, batch) => sum + batch._count.items, 0),
      blockedBatchCount: run.batches.filter((batch) => !['exported', 'completed'].includes(batch.status)).length,
      blockedJobCount: run.batches
        .filter((batch) => !['exported', 'completed'].includes(batch.status))
        .reduce((sum, batch) => sum + batch._count.items, 0),
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
