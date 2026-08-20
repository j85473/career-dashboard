import type { Prisma } from '@prisma/client';

import { prisma } from './prisma';
import {
  ALREADY_APPLIED_REASON,
  DECIDED_STATUSES,
  INVISIBLE_STATUSES,
  isAppliedDuplicateEvidence,
  isUnreliableLocation,
  planAppliedDuplicateSuppression,
  type DecidedJob,
  type DuplicateCandidate,
} from './appliedDuplicatePolicy';

type JobStore = Pick<Prisma.TransactionClient, 'job'>;

const evidenceWhere = {
  OR: [
    { status: { in: [...DECIDED_STATUSES] } },
    { passReason: { equals: ALREADY_APPLIED_REASON, mode: 'insensitive' as const } },
  ],
};

const decidedSelect = {
  id: true,
  identityFingerprint: true,
  status: true,
  company: true,
  title: true,
  location: true,
  passReason: true,
} as const;

export async function listAppliedDuplicateEvidence(
  store: JobStore = prisma,
): Promise<DecidedJob[]> {
  return store.job.findMany({
    where: { identityFingerprint: { not: null }, ...evidenceWhere },
    select: decidedSelect,
  });
}

/**
 * Finds an all-time decision for the same display identity. Stable source,
 * requisition, URL, and exact-description matches are handled earlier by the
 * ordinary ingestion deduper; this is the deliberate fallback for postings
 * that reappear under changed source identity.
 */
export async function findAppliedDuplicateEvidence(
  candidate: DuplicateCandidate & { location: string | null },
  store: JobStore = prisma,
): Promise<DecidedJob | null> {
  if (!candidate.identityFingerprint || isUnreliableLocation(candidate.location)) return null;

  const decided = await store.job.findMany({
    where: {
      identityFingerprint: candidate.identityFingerprint,
      ...evidenceWhere,
    },
    select: decidedSelect,
  });
  const [plan] = planAppliedDuplicateSuppression([candidate], decided);
  return plan ? decided.find((job) => job.id === plan.duplicateOfJobId) || null : null;
}

/**
 * Immediately hides already-visible copies when Joseph makes a decision. The
 * status re-check on each write prevents a concurrent human action from being
 * overwritten.
 */
export async function suppressLiveAppliedDuplicates(
  decision: DecidedJob,
  store: JobStore = prisma,
): Promise<string[]> {
  if (!decision.identityFingerprint || !isAppliedDuplicateEvidence(decision)) return [];
  if (isUnreliableLocation(decision.location)) return [];

  const candidates = await store.job.findMany({
    where: {
      id: { not: decision.id },
      identityFingerprint: decision.identityFingerprint,
      status: { notIn: [...DECIDED_STATUSES, ...INVISIBLE_STATUSES] },
    },
    select: { id: true, identityFingerprint: true, status: true },
  });
  const plans = planAppliedDuplicateSuppression(candidates, [decision]);
  const suppressedIds: string[] = [];

  for (const plan of plans) {
    const result = await store.job.updateMany({
      where: {
        id: plan.jobId,
        status: { notIn: [...DECIDED_STATUSES, ...INVISIBLE_STATUSES] },
      },
      data: {
        status: 'dismissed',
        scoringStatus: 'skipped',
        passReason: plan.reason,
        scoreError: null,
      },
    });
    if (result.count === 1) suppressedIds.push(plan.jobId);
  }
  return suppressedIds;
}
