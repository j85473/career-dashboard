import type { Prisma } from '@prisma/client';

import { JD_RECOVERY_MANUAL_REVIEW_REASON } from './jdRecoveryPolicy';
import { JD_ENRICHMENT_STARVED_REASON } from './jdEnrichmentDeferral';
import { LOCAL_SCORING_TERMINAL_ATTEMPTS } from './localScoringPolicy';
import { manualScoringStatusWhere } from './manualScoringEligibility';

export const OPERATIONAL_QUEUE_CATEGORIES = [
  'needs_jd',
  'local_scoring',
  'jd_failed',
  'scoring_failed',
  'aim_fit',
  'experience_fit',
] as const;

export type OperationalQueueCategory = typeof OPERATIONAL_QUEUE_CATEGORIES[number];

const ACTIVE_SCORING_STATUSES = ['pending_af', 'inbox'] as const;
const STANDARDIZED_DOWNSTREAM_FAILURE_PREFIXES = [
  'JD recovery rejected:',
  'Aim Fit could not score this job:',
  'Experience Fit could not score this job:',
] as const;
const LEGACY_JD_FAILURE_REASONS = [
  JD_RECOVERY_MANUAL_REVIEW_REASON,
  // A job that waited out its deferral budget without the provider ever being
  // asked. Nothing about the posting itself was established, so this remains
  // a pre-scoring/JD failure rather than an Aim or Experience result.
  JD_ENRICHMENT_STARVED_REASON,
  'JD recovery failed. Manual review required.',
  'Failed to fetch JD after 3 attempts. Needs manual review.',
  'Error calling Jina. Manual review required.',
] as const;

export function isRawLocalTerminalFailure(input: {
  scoringStatus: string;
  scoreAttempts: number;
  scoreError: string | null;
}): boolean {
  return input.scoringStatus === 'failed'
    && input.scoreAttempts >= LOCAL_SCORING_TERMINAL_ATTEMPTS
    && input.scoreError !== null
    && !STANDARDIZED_DOWNSTREAM_FAILURE_PREFIXES.some((prefix) => input.scoreError!.startsWith(prefix));
}

function currentSuppressionIdWhere(
  currentAimSuppressedJobIds: readonly string[],
): Prisma.JobWhereInput | null {
  return currentAimSuppressedJobIds.length > 0
    ? { id: { in: [...currentAimSuppressedJobIds] } }
    : null;
}

/**
 * One exact, user-visible operational queue partition. Current Aim suppression
 * IDs are resolved by the caller so this builder stays pure and reusable by
 * routes, exporters, Stats, and integrity audits.
 */
export function operationalQueueWhere(
  category: OperationalQueueCategory,
  currentAimSuppressedJobIds: readonly string[],
): Prisma.JobWhereInput {
  const activeJob = {
    status: { in: [...ACTIVE_SCORING_STATUSES] },
    tailoringStaged: false,
  };
  switch (category) {
    case 'needs_jd':
      return {
        ...activeJob,
        OR: [{ scoringStatus: 'needs_jd' }, { jdBatchId: { not: null } }],
      };
    case 'local_scoring':
      return {
        ...activeJob,
        scoringStatus: { in: ['queued', 'scoring'] },
        jdBatchId: null,
      };
    case 'jd_failed': {
      const jdFailureReasons: Prisma.JobWhereInput[] = [
        { scoreError: { startsWith: STANDARDIZED_DOWNSTREAM_FAILURE_PREFIXES[0] } },
        {
          AND: [
            { passReason: { in: [...LEGACY_JD_FAILURE_REASONS] } },
            // Old JD reasons can survive a later Aim/Experience attempt. The
            // current scoring failure takes precedence so one job never lands
            // in both failure menus.
            {
              OR: [
                { scoreError: null },
                {
                  AND: STANDARDIZED_DOWNSTREAM_FAILURE_PREFIXES.slice(1).map((prefix) => ({
                    NOT: { scoreError: { startsWith: prefix } },
                  })),
                },
              ],
            },
          ],
        },
        // Local scoring stores the raw exception text. Once the bounded third
        // attempt terminalizes the row, it never reached Aim/Experience and
        // stays with the pre-scoring/JD failures instead of disappearing.
        {
          AND: [
            { scoreAttempts: { gte: LOCAL_SCORING_TERMINAL_ATTEMPTS } },
            { scoreError: { not: null } },
            {
              NOT: {
                OR: STANDARDIZED_DOWNSTREAM_FAILURE_PREFIXES.map((prefix) => ({
                  scoreError: { startsWith: prefix },
                })),
              },
            },
          ],
        },
      ];
      return {
        ...activeJob,
        scoringStatus: 'failed',
        ...(currentAimSuppressedJobIds.length > 0
          ? { id: { notIn: [...currentAimSuppressedJobIds] } }
          : {}),
        OR: jdFailureReasons,
      };
    }
    case 'scoring_failed': {
      const branches: Prisma.JobWhereInput[] = [{
        scoringStatus: 'failed',
        OR: STANDARDIZED_DOWNSTREAM_FAILURE_PREFIXES.slice(1).map((prefix) => ({
          scoreError: { startsWith: prefix },
        })),
      }];
      const currentSuppression = currentSuppressionIdWhere(currentAimSuppressedJobIds);
      if (currentSuppression) branches.push(currentSuppression);
      return { ...activeJob, OR: branches };
    }
    case 'aim_fit': {
      const where: Prisma.JobWhereInput = {
        ...manualScoringStatusWhere('aim'),
        scoringStatus: 'scored',
        jdBatchId: null,
        batchJobId: null,
        afBatchId: null,
        tailoringStaged: false,
        aimFitScore: null,
      };
      if (currentAimSuppressedJobIds.length > 0) {
        where.id = { notIn: [...currentAimSuppressedJobIds] };
      }
      return where;
    }
    case 'experience_fit':
      return {
        ...manualScoringStatusWhere('experience'),
        scoringStatus: 'scored',
        tailoringStaged: false,
        aimFitScore: { not: null },
        reqFitScore: null,
      };
  }
}

/**
 * Rows expected to be represented by the six operational queues. Ordinary
 * Inbox work and protected terminal lifecycle states are deliberately outside
 * this scope; active Inbox rows re-enter only when they carry pipeline work or
 * a current Aim suppression.
 */
export function operationalPartitionScopeWhere(
  currentAimSuppressedJobIds: readonly string[],
): Prisma.JobWhereInput {
  const inboxWork: Prisma.JobWhereInput[] = [
    { scoringStatus: { in: ['needs_jd', 'queued', 'scoring', 'failed'] } },
    { jdBatchId: { not: null } },
  ];
  const currentSuppression = currentSuppressionIdWhere(currentAimSuppressedJobIds);
  if (currentSuppression) inboxWork.push(currentSuppression);
  return {
    tailoringStaged: false,
    OR: [
      { status: 'pending_af' },
      { status: 'inbox', OR: inboxWork },
    ],
  };
}

export type OperationalPartitionInspection = {
  scopedJobCount: number;
  noCategoryJobIds: string[];
  multipleCategoryJobs: Array<{ jobId: string; categories: OperationalQueueCategory[] }>;
  categoryCounts: Record<OperationalQueueCategory, number>;
};

export function inspectOperationalPartition(
  scopedJobIds: readonly string[],
  categoryJobIds: Readonly<Record<OperationalQueueCategory, readonly string[]>>,
): OperationalPartitionInspection {
  const memberships = new Map<string, OperationalQueueCategory[]>();
  for (const jobId of scopedJobIds) memberships.set(jobId, []);
  for (const category of OPERATIONAL_QUEUE_CATEGORIES) {
    for (const jobId of categoryJobIds[category]) {
      if (!memberships.has(jobId)) continue;
      memberships.get(jobId)!.push(category);
    }
  }
  const noCategoryJobIds: string[] = [];
  const multipleCategoryJobs: OperationalPartitionInspection['multipleCategoryJobs'] = [];
  for (const [jobId, categories] of memberships) {
    if (categories.length === 0) noCategoryJobIds.push(jobId);
    else if (categories.length > 1) multipleCategoryJobs.push({ jobId, categories });
  }
  noCategoryJobIds.sort();
  multipleCategoryJobs.sort((left, right) => left.jobId.localeCompare(right.jobId));
  return {
    scopedJobCount: scopedJobIds.length,
    noCategoryJobIds,
    multipleCategoryJobs,
    categoryCounts: Object.fromEntries(OPERATIONAL_QUEUE_CATEGORIES.map((category) => (
      [category, categoryJobIds[category].length]
    ))) as Record<OperationalQueueCategory, number>,
  };
}
