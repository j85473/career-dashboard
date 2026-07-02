import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST() {
  try {
    const updated = await prisma.job.updateMany({
      where: { scoringStatus: { in: ['failed', 'skipped', 'scoring', 'needs_jd'] } },
      data: { scoringStatus: 'queued', scoreAttempts: 0, scoreError: null }
    });

    return NextResponse.json({ message: `Reset ${updated.count} jobs.` });
  } catch (error) {
    console.error("Error retrying jobs:", error);
    return NextResponse.json({ error: "Failed to reset jobs" }, { status: 500 });
  }
}
