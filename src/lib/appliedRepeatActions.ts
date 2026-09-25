import type { Prisma, PrismaClient } from '@prisma/client';

import { APPLIED_REPEAT_EXCEPTION_EVENT } from './appliedDuplicateStore';
import {
  judgeAppliedRepeat,
  mayRepeat,
  repeatTitleKey,
  type AppliedRepeatEvidence,
  type RepeatSubject,
} from './appliedRepeatMatch';
import { CONSOLIDATED_REASON_PREFIX } from './jobUrlReconciliation';
import { prisma } from './prisma';
import { ALREADY_APPLIED_REASON, isAppliedDuplicateReason } from './appliedDuplicatePolicy';
import { resolveInboxAdmission } from './companyCooldown';
import { cooldownReleasePlan } from './cooldownRecovery';
import { recordJobPipelineEvent } from './ingestionControl';
import { isScorableJobDescription } from './jobDescriptionQuality';
import { humanLifecycleEvent } from './jobLifecycleEvents';
import { assertJobLifecycleInvariants } from './jobLifecycleInvariant';
import { latestJobScoreEvents } from './jobScoreAuthorityQuery';

export class NotARepeatRefused extends Error {
  constructor(message: string) { super(message); this.name = 'NotARepeatRefused'; }
}

export type HiddenRepeat = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  source: string | null;
  dismissedAt: Date;
};

/** Jobs hidden because they repeat this applied job, newest first. */
export async function listHiddenRepeats(
  store: Pick<Prisma.TransactionClient, '$queryRaw'>,
  appliedJobId: string,
): Promise<HiddenRepeat[]> {
  return store.$queryRaw<HiddenRepeat[]>`
    SELECT j.id, j.title, j.company, j.location, j.source, MAX(e."occurredAt") AS "dismissedAt"
    FROM "JobPipelineEvent" e
    JOIN "Job" j ON j.id = e."jobId"
    WHERE e."eventType" = 'user_lifecycle'
      AND e.details->>'originDecisionJobId' = ${appliedJobId}
      AND j.status = 'dismissed'
      AND j."passReason" LIKE 'Duplicate of a job already%'
    GROUP BY j.id, j.title, j.company, j.location, j.source
    ORDER BY "dismissedAt" DESC
  `;
}

/**
 * Joseph says a hidden job is not a repeat. It goes back where its scores put
 * it (Inbox, Cooldown, or waiting for scoring), and the pair is remembered so
 * the same applied job never hides it again.
 */
export async function markNotARepeat(tx: Prisma.TransactionClient, jobId: string, now = new Date()) {
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Job" WHERE id = ${jobId} FOR UPDATE`;
  if (!locked) throw new NotARepeatRefused('Job not found.');
  const job = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
  if (job.status !== 'dismissed' || !isAppliedDuplicateReason(job.passReason) || job.passReason === ALREADY_APPLIED_REASON) {
    throw new NotARepeatRefused('This job is not currently hidden as a repeat of an applied job.');
  }

  const lifecycleEvents = await tx.jobPipelineEvent.findMany({
    where: { jobId, eventType: 'user_lifecycle' },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    select: { details: true },
  });
  const authorityJobId = lifecycleEvents
    .map((event) => (event.details as Record<string, unknown> | null)?.originDecisionJobId)
    .find((value): value is string => typeof value === 'string') ?? null;

  const bundle = (await latestJobScoreEvents([jobId], tx)).get(jobId) || null;
  const plan = cooldownReleasePlan(bundle);
  if (plan.status === 'dismissed') {
    throw new NotARepeatRefused('This job\'s own score keeps it out of the Inbox, so there is nothing to restore. It stays dismissed.');
  }

  // Recorded first so the admission below already honors it.
  await recordJobPipelineEvent({
    eventType: APPLIED_REPEAT_EXCEPTION_EVENT,
    jobId,
    stage: 'human_decision',
    source: job.source,
    sourceId: job.sourceId,
    occurredAt: now,
    identityParts: ['not_a_repeat', jobId, authorityJobId || 'unknown', now.toISOString()],
    details: { actor: 'user', authorityJobId, previousReason: job.passReason },
  }, tx);
  const admission = await resolveInboxAdmission({
    jobId, title: job.title, location: job.location, company: job.company, employer: job.employer, source: job.source,
    proposedStatus: plan.status, now, store: tx, actor: 'user',
  });
  const needsScoring = plan.queueLocalScoring || (admission.status === 'pending_af' && job.scoringStatus === 'skipped');
  const updated = await tx.job.update({
    where: { id: jobId },
    data: {
      status: admission.status,
      cooldownUntil: admission.cooldownUntil,
      passReason: null,
      ...(needsScoring ? {
        scoringStatus: job.aimFitScore !== null
          ? 'scored'
          : isScorableJobDescription(job.description || '') ? 'queued' : 'needs_jd',
        batchJobId: null,
        jdBatchId: null,
        afBatchId: null,
        scoreAttempts: 0,
        scoreError: null,
      } : {}),
    },
  });

  const lifecycleEvent = humanLifecycleEvent('dismissed', plan.status === 'inbox' ? 'inbox' : admission.status, updated.status);
  if (lifecycleEvent) {
    await recordJobPipelineEvent({
      eventType: lifecycleEvent.eventType,
      jobId,
      stage: 'human_decision',
      source: updated.source,
      sourceId: updated.sourceId,
      occurredAt: now,
      identityParts: ['status_transition', lifecycleEvent.priorStatus, lifecycleEvent.nextStatus, now.toISOString()],
      details: {
        priorStatus: lifecycleEvent.priorStatus,
        nextStatus: lifecycleEvent.nextStatus,
        enteredInbox: lifecycleEvent.enteredInbox,
        actor: lifecycleEvent.actor,
        protected: lifecycleEvent.protected,
        route: 'not_a_repeat',
        reason: 'Not a repeat of an applied job',
      },
    }, tx);
  }
  await assertJobLifecycleInvariants(tx, [jobId]);
  return updated;
}

export type JobCardSummary = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  status: string;
  source: string | null;
  url: string | null;
  passReason: string | null;
  tailoringStaged: boolean;
  /** When the card entered its current status, when history records it. */
  statusSince: Date | null;
};

const summarySelect = {
  id: true, title: true, company: true, location: true, status: true, source: true, url: true,
  passReason: true, tailoringStaged: true, updatedAt: true,
} as const;

type SummaryClient = Pick<PrismaClient, 'job' | 'jobStatusHistory'>;

export async function jobCardSummary(id: string, client: SummaryClient = prisma): Promise<JobCardSummary | null> {
  const job = await client.job.findUnique({ where: { id }, select: summarySelect });
  if (!job) return null;
  const history = await client.jobStatusHistory.findFirst({
    where: { jobId: id, status: job.status },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const { updatedAt, ...rest } = job;
  return { ...rest, statusSince: history?.createdAt ?? updatedAt };
}

/** A card Joseph has acted on is the one he means; machine-dismissed copies come last. */
function cardRank(status: string): number {
  if (['applied', 'interviewing'].includes(status)) return 3;
  if (['dismissed', 'expired'].includes(status)) return 1;
  return 2;
}

/**
 * The saved card that is most likely the same job as a freshly pasted one,
 * using the same-role test that hides repeats (appliedRepeatMatch.ts). Used to
 * ask Joseph, never to act on its own.
 */
export async function findSameRoleCard(
  candidate: RepeatSubject,
  client: SummaryClient = prisma,
): Promise<{ job: JobCardSummary; evidence: AppliedRepeatEvidence } | null> {
  const [longestWord] = repeatTitleKey(candidate.title)
    .split(' ')
    .filter((word) => word.length > 3)
    .sort((left, right) => right.length - left.length);
  if (!longestWord) return null;
  const notConsolidated = { OR: [{ passReason: null }, { passReason: { not: { startsWith: CONSOLIDATED_REASON_PREFIX } } }] };
  const titleWhere = { title: { contains: longestWord, mode: 'insensitive' as const } };
  const [decided, recent] = await Promise.all([
    client.job.findMany({
      where: { id: { not: candidate.id }, status: { in: ['applied', 'interviewing'] }, ...titleWhere },
      select: { id: true, title: true, company: true, status: true },
    }),
    client.job.findMany({
      where: { id: { not: candidate.id }, status: { not: 'archived' }, ...titleWhere, AND: [notConsolidated] },
      orderBy: { createdAt: 'desc' },
      take: 2000,
      select: { id: true, title: true, company: true, status: true },
    }),
  ]);
  const plausible = [...new Map([...decided, ...recent].map((row) => [row.id, row])).values()]
    .filter((row) => mayRepeat(candidate, row));
  if (plausible.length === 0) return null;
  const full = await client.job.findMany({
    where: { id: { in: plausible.map((row) => row.id) } },
    select: { id: true, title: true, company: true, location: true, description: true, status: true },
  });
  const cache = new Map<string, Set<string>>();
  let best: { id: string; status: string; evidence: AppliedRepeatEvidence } | null = null;
  for (const row of full) {
    const evidence = judgeAppliedRepeat(candidate, row, cache);
    if (!evidence) continue;
    const better = !best
      || cardRank(row.status) > cardRank(best.status)
      || (cardRank(row.status) === cardRank(best.status) && (evidence.containment ?? 0) > (best.evidence.containment ?? 0));
    if (better) best = { id: row.id, status: row.status, evidence };
  }
  if (!best) return null;
  const job = await jobCardSummary(best.id, client);
  return job ? { job, evidence: best.evidence } : null;
}
