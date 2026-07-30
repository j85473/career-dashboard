export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logWhere } from '@/lib/jobListQuery';

export async function POST() {
  try {
    const where = logWhere('aim_fit');

    const result = await prisma.job.updateMany({
      where,
      data: {
        status: 'pending_af',
        scoringStatus: 'queued',
        fitScore: null,
        fitCategory: 'unscored',
        fitRationale: null,
        passReason: null,
        travelScore: null,
        scoreAttempts: 0,
        scoreError: null,
        batchJobId: null,
      },
    });

    return NextResponse.json({ success: true, count: result.count });
  } catch (error) {
    console.error('Failed to requeue jobs:', error);
    return NextResponse.json({ error: 'Failed to requeue jobs' }, { status: 500 });
  }
}
