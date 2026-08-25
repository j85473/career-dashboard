import { Prisma, type PrismaClient } from '@prisma/client';

import { currentAimFailureIdentity } from './aimCurrentInput';
import { activeAimFailureSuppression } from './aimScoringFailure';
import { currentScoringInputVersions, type CurrentScoringInputVersions } from './scoringInputVersions';

type DbClient = PrismaClient | Prisma.TransactionClient;

const currentSuppressionInclude = {
  job: {
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      description: true,
      status: true,
    },
  },
} satisfies Prisma.AimScoringFailureReceiptInclude;

export type CurrentAimFailureSuppression = Prisma.AimScoringFailureReceiptGetPayload<{
  include: typeof currentSuppressionInclude;
}>;

/**
 * Return immutable active receipt rows whose stored identity still matches the
 * job and the current Aim input contracts. Rows with stale identities remain
 * in the database as history but no longer suppress or surface the job.
 */
export async function currentAimFailureSuppressions(
  client: DbClient,
  jobIds?: readonly string[],
  versions: CurrentScoringInputVersions = currentScoringInputVersions(),
): Promise<CurrentAimFailureSuppression[]> {
  if (jobIds && jobIds.length === 0) return [];
  const receipts = await client.aimScoringFailureReceipt.findMany({
    where: {
      suppressionActive: true,
      clearedAt: null,
      ...(jobIds ? { jobId: { in: [...new Set(jobIds)] } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: currentSuppressionInclude,
  });
  return receipts.filter((receipt) => activeAimFailureSuppression(
    receipt,
    currentAimFailureIdentity(receipt.job, versions),
  ));
}

export async function currentAimSuppressedJobIds(
  client: DbClient,
  jobIds?: readonly string[],
  versions: CurrentScoringInputVersions = currentScoringInputVersions(),
): Promise<string[]> {
  return [...new Set((await currentAimFailureSuppressions(client, jobIds, versions)).map((receipt) => receipt.jobId))];
}
