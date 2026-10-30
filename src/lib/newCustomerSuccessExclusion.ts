import type { Job, Prisma } from './prismaClient';
import { automatedLifecycleIsProtected, nonManualImportSourceWhere } from './manualImportPolicy';

export const CUSTOMER_SUCCESS_EXCLUSION_REASON = 'Locally triaged out: Customer/client success role excluded by user preference';

/** Match the occupation in the title, never incidental CS duties in the JD. */
export function isExcludedCustomerSuccessTitle(title: string): boolean {
  const normalized = title.replace(/[-\u2010-\u2015]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/\b(?:(?:customer|client)\s+success|csm)\b/i.test(normalized)) return false;

  // Preserve explicit account-management and partner/channel occupations,
  // including titles such as "Partner Success Specialist, Customer Success".
  const retainedOccupation = /\baccount\s+(?:manager|management|director|executive)\b|\b(?:partner|channel|distributor|distribution)\s+(?:success|(?:account\s+)?(?:manager|management|director|specialist|lead|sales))\b/i;
  return !retainedOccupation.test(normalized);
}

type IntakeJob = Pick<Job, 'id' | 'title' | 'status' | 'source' | 'tailoringStaged' | 'fitScore' | 'aimFitScore' | 'reqFitScore' | 'travelScore'>;
type WriteExclusion = (args: Prisma.JobUpdateManyArgs) => Promise<{ count: number }>;

/**
 * A prospective local-scoring decision for untouched intake only. Repeat every
 * protection in the atomic write so a concurrent score or human action wins.
 * Neither existing scores nor scoring artifacts are changed or invalidated.
 */
export async function filterNewCustomerSuccessRole(
  job: IntakeJob,
  leaseId: string,
  write: WriteExclusion,
): Promise<boolean> {
  if (!isExcludedCustomerSuccessTitle(job.title)
    || job.status !== 'pending_af' || job.tailoringStaged
    || automatedLifecycleIsProtected(job)
    || [job.fitScore, job.aimFitScore, job.reqFitScore, job.travelScore].some((score) => score !== null)
  ) return false;

  const result = await write({
    where: {
      id: job.id,
      title: job.title,
      status: 'pending_af',
      scoringStatus: 'scoring',
      batchJobId: leaseId,
      tailoringStaged: false,
      fitScore: null,
      aimFitScore: null,
      reqFitScore: null,
      travelScore: null,
      AND: [nonManualImportSourceWhere()],
      scoreEvents: { none: {} },
      scoringArtifacts: { none: {} },
      aimFactualExtractions: { none: {} },
      statusHistory: { none: { status: { not: 'pending_af' } } },
    },
    data: {
      status: 'dismissed',
      scoringStatus: 'skipped',
      passReason: CUSTOMER_SUCCESS_EXCLUSION_REASON,
      batchJobId: null,
      scoreAttempts: 0,
      scoreError: null,
    },
  });
  return result.count === 1;
}
