import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const stage = new URL(request.url).searchParams.get('stage');
  if (stage !== null && stage !== 'aim' && stage !== 'experience') return NextResponse.json({ error: 'stage must be aim or experience' }, { status: 400 });
  const batches = await prisma.scoringBatch.findMany({
    where: stage ? { stage } : undefined,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
    select: {
      id: true, stage: true, status: true, schemaVersion: true, protocolVersion: true, policyVersion: true,
      exportHash: true, manifestHash: true, createdAt: true, expiresAt: true, completedAt: true, releasedAt: true,
      supersededAt: true, supersededReason: true, acceptedResultHash: true,
      _count: { select: { items: true } },
    },
  });
  const now = Date.now();
  return NextResponse.json({
    batches: batches.map((batch) => ({ ...batch, derivedExpired: batch.status === 'exported' && batch.expiresAt.valueOf() < now })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
