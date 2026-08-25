import type { Prisma } from '@prisma/client';

import { JD_RECOVERY_MANUAL_REVIEW_REASON } from './jdRecoveryPolicy';
import { aimScoringPriorityOrder } from './manualScoringPriority';
import { manualScoringStatusWhere } from './manualScoringEligibility';
import { operationalQueueWhere } from './operationalQueue';

export const DEFAULT_JOB_PAGE_SIZE = 48;
export const MAX_JOB_PAGE_SIZE = 100;

const ACTIVE_SCORING_STATUSES = ['pending_af', 'inbox'] as const;

export function positiveInteger(value: string | null, fallback: number, maximum?: number) {
  const parsed = Number.parseInt(value || '', 10);
  const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return maximum ? Math.min(safe, maximum) : safe;
}

export function exactCompanyWhere(value: string | null): Prisma.JobWhereInput | null {
  const company = value?.trim();
  if (!company) return null;
  return { company: { equals: company, mode: 'insensitive' } };
}

export function logWhere(logTab: string): Prisma.JobWhereInput {
  const activeJob = { status: { in: [...ACTIVE_SCORING_STATUSES] } };
  switch (logTab) {
    case 'needs_jd':
      return { ...activeJob, OR: [{ scoringStatus: 'needs_jd' }, { jdBatchId: { not: null } }] };
    case 'context':
      return {
        status: 'passed',
        contextBatched: false,
        passReason: { not: null },
        NOT: { passReason: { contains: 'expired', mode: 'insensitive' } },
      };
    case 'local_scoring':
      return { status: { in: ['pending_af', 'inbox'] }, scoringStatus: 'queued', jdBatchId: null };
    case 'action_needed':
      return actionableQueueWhere();
    case 'aim_fit':
      return {
        ...manualScoringStatusWhere('aim'),
        scoringStatus: 'scored',
        jdBatchId: null,
        batchJobId: null,
        afBatchId: null,
        tailoringStaged: false,
        aimFailureReceipts: { none: { suppressionActive: true, clearedAt: null } },
        aimFitScore: null,
      };
    case 'experience_fit':
      return {
        ...manualScoringStatusWhere('experience'),
        scoringStatus: 'scored', tailoringStaged: false,
        aimFitScore: { not: null }, reqFitScore: null,
        scoringBatchItems: { none: { status: 'leased' } },
      };
    default:
      return { status: 'pending_af' };
  }
}

/**
 * Resolve Aim receipt authority before building a user-visible Scoring Log
 * query. `logWhere` remains the broad SQL candidate predicate used by callers
 * that have not loaded current identities yet.
 */
export function logWhereWithCurrentAimSuppressions(
  logTab: string,
  currentAimSuppressedJobIds: readonly string[],
): Prisma.JobWhereInput {
  if (logTab === 'needs_jd' || logTab === 'local_scoring' || logTab === 'action_needed'
    || logTab === 'aim_fit' || logTab === 'experience_fit') {
    return operationalQueueWhere(logTab, currentAimSuppressedJobIds);
  }
  return logWhere(logTab);
}

/**
 * Action Needed has one narrow meaning: the system could not recover a JD, or
 * Aim/Experience could not produce a valid score. Closed postings and generic
 * lifecycle contradictions are handled elsewhere and must not appear here.
 */
export function actionableQueueWhere(): Prisma.JobWhereInput {
  return {
    status: { in: [...ACTIVE_SCORING_STATUSES] },
    OR: [
      {
        scoringStatus: 'failed',
        OR: [
          { scoreError: { startsWith: 'JD recovery rejected:' } },
          { scoreError: { startsWith: 'Aim Fit could not score this job:' } },
          { scoreError: { startsWith: 'Experience Fit could not score this job:' } },
          {
            passReason: {
              in: [
                JD_RECOVERY_MANUAL_REVIEW_REASON,
                'JD recovery failed. Manual review required.',
                'Failed to fetch JD after 3 attempts. Needs manual review.',
                'Error calling Jina. Manual review required.',
              ],
            },
          },
        ],
      },
      { aimFailureReceipts: { some: { suppressionActive: true, clearedAt: null } } },
    ],
  };
}

/**
 * Exact Action Needed predicate after current Aim receipt identities have been
 * resolved in application code. Legacy Aim errors without any receipt remain
 * visible; once receipt history exists, only a current exact-identity receipt
 * is authoritative.
 */
export function actionableQueueWhereWithCurrentAimSuppressions(
  currentAimSuppressedJobIds: readonly string[],
): Prisma.JobWhereInput {
  return operationalQueueWhere('action_needed', currentAimSuppressedJobIds);
}

export function jobWhere(
  status: string,
  logTab: string,
): Prisma.JobWhereInput {
  if (status === 'log') return logWhere(logTab);
  if (status === 'dismissed') return { status: 'dismissed', aimFitScore: { not: null } };
  if (status === 'local_dismissed') return { status: 'dismissed', aimFitScore: null };
  if (status === 'tailoring') return { tailoringStaged: true };
  if (status === 'cooldown') return { status: 'cooldown' };
  if (status === 'inbox') {
    return {
      status: 'inbox',
      tailoringStaged: false,
    };
  }
  return { status };
}

export function jobWhereWithCurrentAimSuppressions(
  status: string,
  logTab: string,
  currentAimSuppressedJobIds: readonly string[],
): Prisma.JobWhereInput {
  if (status === 'log') return logWhereWithCurrentAimSuppressions(logTab, currentAimSuppressedJobIds);
  return jobWhere(status, logTab);
}

export function jobOrder(status: string, sort: string): Prisma.JobOrderByWithRelationInput[] {
  const stableOrder: Prisma.JobOrderByWithRelationInput = { id: 'asc' };
  const dateField = status === 'applied' ? 'updatedAt' : 'createdAt';
  if (status === 'log' && sort === 'aim_priority') return aimScoringPriorityOrder();
  if (status === 'log' && sort !== 'newest' && sort !== 'oldest') {
    return [{ createdAt: 'asc' }, stableOrder];
  }
  switch (sort) {
    case 'newest':
      if (status === 'log') {
        return [{ jdBatchId: { sort: 'desc', nulls: 'last' } }, { [dateField]: 'desc' }, stableOrder];
      }
      return [{ [dateField]: 'desc' }, stableOrder];
    case 'oldest':
      return [{ [dateField]: 'asc' }, stableOrder];
    case 'experience_fit':
      return [{ reqFitScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, stableOrder];
    // Travel sorts retired with the Travel Watch tab: Aim v2 folds travel into
    // the Aim score itself and no longer writes Job.travelScore, so ordering by
    // it only surfaced pre-v2 rows. Unknown sorts fall through to aim_fit.
    case 'aim_fit':
    default:
      return [{ aimFitScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, stableOrder];
  }
}
