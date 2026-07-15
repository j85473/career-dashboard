import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

const SCORING_ELIGIBLE_STATUSES = ['pending_af', 'inbox'];

export async function POST() {
  try {
    const [deepseek, claimedDeepseek, wildcard, needsJd, local] = await prisma.$transaction([
      prisma.job.updateMany({
        where: {
          scoringStatus: 'failed',
          status: { in: SCORING_ELIGIBLE_STATUSES },
          aimFitScore: null,
          scoreError: { startsWith: 'DeepSeek scoring is retryable:' },
        },
        data: {
          scoringStatus: 'scored',
          afBatchId: null,
          scoreAttempts: 0,
          scoreError: null,
          deepseekScoreAttempts: 0,
          deepseekScoreError: null,
        },
      }),
      prisma.job.updateMany({
        where: {
          scoringStatus: 'scored',
          status: { in: SCORING_ELIGIBLE_STATUSES },
          aimFitScore: null,
          afBatchId: { startsWith: 'deepseek:' },
        },
        data: {
          afBatchId: null,
          scoreAttempts: 0,
          scoreError: null,
          deepseekScoreAttempts: 0,
          deepseekScoreError: null,
        },
      }),
      prisma.job.updateMany({
        where: { luckyStatus: 'failed', status: 'dismissed' },
        data: {
          luckyStatus: 'pending',
          luckyBatchId: null,
          luckyScoreAttempts: 0,
          luckyScoreError: null,
        },
      }),
      prisma.job.updateMany({
        where: {
          scoringStatus: 'needs_jd',
          status: { in: SCORING_ELIGIBLE_STATUSES },
        },
        data: {
          jdBatchId: null,
          scoreAttempts: 0,
          scoreError: null,
        },
      }),
      prisma.job.updateMany({
        where: {
          status: { in: SCORING_ELIGIBLE_STATUSES },
          OR: [
            { scoringStatus: { in: ['failed', 'queued'] } },
            {
              scoringStatus: 'scoring',
              batchJobId: { startsWith: 'local:' },
            },
          ],
          NOT: {
            AND: [
              { aimFitScore: null },
              { scoreError: { startsWith: 'DeepSeek scoring is retryable:' } },
            ],
          },
        },
        data: {
          scoringStatus: 'queued',
          batchJobId: null,
          afBatchId: null,
          jdBatchId: null,
          scoreAttempts: 0,
          scoreError: null,
        },
      }),
    ]);

    return NextResponse.json({
      message: `Reset ${deepseek.count + claimedDeepseek.count + wildcard.count + needsJd.count + local.count} jobs.`,
      deepseek: deepseek.count,
      claimedDeepseek: claimedDeepseek.count,
      wildcard: wildcard.count,
      needsJd: needsJd.count,
      local: local.count,
    });
  } catch (error) {
    console.error("Error retrying jobs:", error);
    return NextResponse.json({ error: "Failed to reset jobs" }, { status: 500 });
  }
}
