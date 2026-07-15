import type { Job, Prisma } from '@prisma/client';
import { appendWildcardFeedback, type WildcardFeedbackDecision } from './wildcardFeedback';

export class WildcardDecisionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'WildcardDecisionError';
  }
}

export async function applyWildcardDecision(
  tx: Prisma.TransactionClient,
  jobId: string,
  decision: WildcardFeedbackDecision,
  rawReason: unknown,
): Promise<Job> {
  if (typeof rawReason !== 'string') throw new WildcardDecisionError('Reason is required', 400);
  const reason = rawReason.replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!reason) throw new WildcardDecisionError('Reason is required', 400);

  const job = await tx.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      title: true,
      company: true,
      luckyStatus: true,
      luckyPassReason: true,
    },
  });
  if (!job) throw new WildcardDecisionError('Job not found', 404);
  if (job.luckyStatus === 'none') {
    throw new WildcardDecisionError('This job is not in the wildcard workflow', 409);
  }

  const wildcardProfile = await tx.wildcardProfile.findUnique({ where: { id: 'global' } });
  const nextProfileText = appendWildcardFeedback(
    wildcardProfile?.profileText || '- No wildcard profile has been established.',
    {
      decision,
      title: job.title,
      company: job.company,
      reason,
    },
  );
  await tx.wildcardProfile.upsert({
    where: { id: 'global' },
    update: { profileText: nextProfileText },
    create: { id: 'global', profileText: nextProfileText },
  });

  if (decision === 'promote') {
    return tx.job.update({
      where: { id: job.id },
      data: {
        status: 'inbox',
        luckyStatus: 'none',
        luckyBatchId: null,
        luckyScoreError: null,
        fitCategory: 'promoted',
        passReason: `Promoted from Wildcard by user: ${reason}`,
      },
    });
  }

  const feedbackMarker = '[User feedback — wildcard pass]';
  const modelRationale = (job.luckyPassReason || '').split(`\n\n${feedbackMarker}`)[0].trim();
  return tx.job.update({
    where: { id: job.id },
    data: {
      luckyStatus: 'dismissed',
      luckyBatchId: null,
      luckyScoreError: null,
      luckyPassReason: [modelRationale, `${feedbackMarker} ${reason}`].filter(Boolean).join('\n\n'),
    },
  });
}
