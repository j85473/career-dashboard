import type { Prisma } from '@prisma/client';

import { prisma } from './prisma';
import {
  ALREADY_APPLIED_REASON,
  APPLIED_DUPLICATE_AUTHORITY_STATUSES,
  APPLIED_DUPLICATE_CANDIDATE_PROTECTED_STATUSES,
  INVISIBLE_STATUSES,
  isAppliedDuplicateAuthorityEvidence,
  isUnreliableLocation,
  planAppliedDuplicateSuppression,
  type AppliedDuplicateAuthorityJob,
  type DuplicateCandidate,
} from './appliedDuplicatePolicy';
import type { ProtectedAppliedIdentityCandidate } from './appliedDuplicateIdentity';
import { nonManualImportSourceWhere } from './manualImportPolicy';
import { recordJobPipelineEvent } from './ingestionControl';

type JobStore = Pick<Prisma.TransactionClient, 'job'>;
type DuplicateSuppressionStore = Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

const evidenceWhere = {
  OR: [
    { status: { in: [...APPLIED_DUPLICATE_AUTHORITY_STATUSES] } },
    { passReason: ALREADY_APPLIED_REASON },
  ],
};

const authoritySelect = {
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
): Promise<AppliedDuplicateAuthorityJob[]> {
  return store.job.findMany({
    where: { identityFingerprint: { not: null }, ...evidenceWhere },
    select: authoritySelect,
  });
}

export async function listUncoveredProtectedAppliedEvidence(
  store: JobStore = prisma,
): Promise<ProtectedAppliedIdentityCandidate[]> {
  return store.job.findMany({
    where: {
      identityFingerprint: null,
      OR: [
        { status: { in: [...APPLIED_DUPLICATE_AUTHORITY_STATUSES] } },
        { passReason: ALREADY_APPLIED_REASON },
      ],
    },
    select: {
      ...authoritySelect,
      updatedAt: true,
    },
  });
}

/**
 * Finds all-time affirmative application authority for the same display
 * identity. Stable source, requisition, URL, and exact-description matches are
 * handled earlier by the ordinary ingestion deduper; this is the deliberate
 * fallback for postings that reappear under changed source identity. Passed
 * and Cooldown rows are excluded even when they have stored fingerprints.
 */
export async function findAppliedDuplicateEvidence(
  candidate: DuplicateCandidate & { location: string | null },
  store: JobStore = prisma,
): Promise<AppliedDuplicateAuthorityJob | null> {
  if (!candidate.identityFingerprint || isUnreliableLocation(candidate.location)) return null;

  const authorities = await store.job.findMany({
    where: {
      identityFingerprint: candidate.identityFingerprint,
      ...evidenceWhere,
    },
    select: authoritySelect,
  });
  const [plan] = planAppliedDuplicateSuppression([candidate], authorities);
  return plan ? authorities.find((job) => job.id === plan.duplicateOfJobId) || null : null;
}

/**
 * Immediately hides already-visible copies when Joseph makes a decision. The
 * status re-check on each write prevents a concurrent human action from being
 * overwritten.
 */
export async function suppressLiveAppliedDuplicates(
  decision: AppliedDuplicateAuthorityJob,
  store: DuplicateSuppressionStore = prisma,
): Promise<string[]> {
  if (!decision.identityFingerprint || !isAppliedDuplicateAuthorityEvidence(decision)) return [];
  if (isUnreliableLocation(decision.location)) return [];

  const candidates = await store.job.findMany({
    where: {
      id: { not: decision.id },
      identityFingerprint: decision.identityFingerprint,
      status: { notIn: [...APPLIED_DUPLICATE_CANDIDATE_PROTECTED_STATUSES, ...INVISIBLE_STATUSES] },
      AND: [nonManualImportSourceWhere()],
    },
    select: { id: true, identityFingerprint: true, status: true, source: true },
  });
  const plans = planAppliedDuplicateSuppression(candidates, [decision]);
  const suppressedIds: string[] = [];

  for (const plan of plans) {
    const result = await store.job.updateMany({
      where: {
        id: plan.jobId,
        status: { notIn: [...APPLIED_DUPLICATE_CANDIDATE_PROTECTED_STATUSES, ...INVISIBLE_STATUSES] },
        AND: [nonManualImportSourceWhere()],
      },
      data: {
        status: 'dismissed',
        scoringStatus: 'skipped',
        passReason: plan.reason,
        scoreError: null,
      },
    });
    if (result.count === 1) {
      const candidate = candidates.find((row) => row.id === plan.jobId);
      await recordJobPipelineEvent({
        eventType: 'user_lifecycle',
        jobId: plan.jobId,
        stage: 'human_decision',
        source: candidate?.source || null,
        identityParts: ['applied_duplicate_suppression', decision.id, plan.jobId],
        details: {
          actor: 'user',
          protected: true,
          derived: true,
          originDecisionJobId: decision.id,
          originDecisionStatus: decision.status,
          duplicateReason: plan.reason,
          nextStatus: 'dismissed',
        },
      }, store);
      suppressedIds.push(plan.jobId);
    }
  }
  return suppressedIds;
}
