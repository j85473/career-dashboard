import { Prisma } from '@prisma/client';

import { currentAimSuppressedJobIds } from './currentAimFailureSuppression';
import {
  expiredFailureQueueEntries,
  FAILURE_QUEUE_EXPIRATION_EVENT_TYPE,
  FAILURE_QUEUE_RETENTION_DAYS,
  FAILURE_QUEUE_RETENTION_MS,
  failureQueueExpirationReason,
  type FailureQueueRetentionCategory,
  type FailureQueueRetentionEntry,
} from './failureQueueRetentionPolicy';
import { buildPipelineEventKey } from './ingestionControl';
import { assertJobLifecycleInvariants } from './jobLifecycleInvariant';
import { operationalQueueWhere } from './operationalQueue';
import { prisma } from './prisma';
import { scoringFailureTimestamps } from './scoringFailureOrder';
import { USER_LIFECYCLE_INTENT_EVENT_TYPES } from './userLifecycleAuthority';

export type FailureQueueRetentionResult = {
  dismissed: number;
  jdFailed: number;
  scoringFailed: number;
};

const FAILURE_CATEGORIES = ['jd_failed', 'scoring_failed'] as const satisfies readonly FailureQueueRetentionCategory[];

async function queueEntries(
  tx: Prisma.TransactionClient,
  currentSuppressionIds: readonly string[],
  onlyIds?: readonly string[],
): Promise<FailureQueueRetentionEntry[]> {
  const entries: FailureQueueRetentionEntry[] = [];
  for (const category of FAILURE_CATEGORIES) {
    const categoryWhere = operationalQueueWhere(category, currentSuppressionIds);
    const where = onlyIds
      ? { AND: [categoryWhere, { id: { in: [...onlyIds] } }] }
      : categoryWhere;
    const timestamps = await scoringFailureTimestamps(where, currentSuppressionIds, tx);
    entries.push(...timestamps.map((entry) => ({ ...entry, category })));
  }
  return entries;
}

/**
 * Dismiss jobs that have remained in either failed queue for a full ten days.
 * Score events, failure receipts, error text, and scoring status are retained;
 * only the lifecycle state and its visible dismissal reason change.
 */
export async function dismissExpiredFailureQueueJobs(
  now: Date = new Date(),
): Promise<FailureQueueRetentionResult> {
  return prisma.$transaction(async (tx) => {
    const initialSuppressionIds = await currentAimSuppressedJobIds(tx);
    const initialEntries = await queueEntries(tx, initialSuppressionIds);
    const cutoff = new Date(now.valueOf() - FAILURE_QUEUE_RETENTION_MS);
    const preliminaryIds = initialEntries
      .filter((entry) => entry.failedAt <= cutoff)
      .map((entry) => entry.id)
      .sort();
    if (preliminaryIds.length === 0) return { dismissed: 0, jdFailed: 0, scoringFailed: 0 };

    // Serialize against manual lifecycle actions. Those routes lock the Job
    // row before recording their event, so a click cannot be lost between the
    // retention read and write.
    await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM "Job"
      WHERE id IN (${Prisma.join(preliminaryIds)})
      ORDER BY id
      FOR UPDATE
    `);

    const currentSuppressionIds = await currentAimSuppressedJobIds(tx, preliminaryIds);
    const currentEntries = await queueEntries(tx, currentSuppressionIds, preliminaryIds);
    const duplicateIds = currentEntries
      .map((entry) => entry.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      throw new Error(`Failed-queue retention found overlapping queue membership: ${[...new Set(duplicateIds)].join(', ')}`);
    }

    const userActivity = await tx.jobPipelineEvent.findMany({
      where: {
        jobId: { in: preliminaryIds },
        eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] },
      },
      select: { jobId: true, occurredAt: true },
    });
    const expired = expiredFailureQueueEntries(currentEntries, userActivity, now);
    if (expired.length === 0) return { dismissed: 0, jdFailed: 0, scoringFailed: 0 };

    const jobIds = expired.map((entry) => entry.id);
    const jobs = await tx.job.findMany({
      where: { id: { in: jobIds } },
      select: { id: true, status: true, source: true, sourceId: true },
    });
    const jobById = new Map(jobs.map((job) => [job.id, job]));
    const counts: Record<FailureQueueRetentionCategory, number> = { jd_failed: 0, scoring_failed: 0 };

    for (const category of FAILURE_CATEGORIES) {
      const categoryIds = expired.filter((entry) => entry.category === category).map((entry) => entry.id);
      if (categoryIds.length === 0) continue;
      const updated = await tx.job.updateMany({
        where: {
          AND: [
            { id: { in: categoryIds } },
            operationalQueueWhere(category, currentSuppressionIds),
          ],
        },
        data: {
          status: 'dismissed',
          passReason: failureQueueExpirationReason(category),
          tailoringStaged: false,
          contextBatched: true,
          contextBatchId: null,
        },
      });
      if (updated.count !== categoryIds.length) {
        throw new Error(`Failed-queue retention changed ${updated.count} of ${categoryIds.length} locked ${category} jobs.`);
      }
      counts[category] = updated.count;
    }

    await tx.jobPipelineEvent.createMany({
      data: expired.map((entry) => {
        const job = jobById.get(entry.id);
        const identityParts = [entry.category, entry.failedAt.toISOString(), `${FAILURE_QUEUE_RETENTION_DAYS}_days`];
        return {
          eventKey: buildPipelineEventKey({
            eventType: FAILURE_QUEUE_EXPIRATION_EVENT_TYPE,
            jobId: entry.id,
            source: job?.source,
            sourceId: job?.sourceId,
            identityParts,
          }),
          eventType: FAILURE_QUEUE_EXPIRATION_EVENT_TYPE,
          jobId: entry.id,
          stage: 'failure_queue_retention',
          source: job?.source || null,
          sourceId: job?.sourceId || null,
          occurredAt: now,
          details: {
            actor: 'machine',
            route: 'failure_queue_retention',
            priorStatus: job?.status || 'unknown',
            nextStatus: 'dismissed',
            category: entry.category,
            failedAt: entry.failedAt.toISOString(),
            retentionDays: FAILURE_QUEUE_RETENTION_DAYS,
          },
        };
      }),
      skipDuplicates: true,
    });

    await assertJobLifecycleInvariants(tx, jobIds);
    return {
      dismissed: counts.jd_failed + counts.scoring_failed,
      jdFailed: counts.jd_failed,
      scoringFailed: counts.scoring_failed,
    };
  }, { maxWait: 10_000, timeout: 60_000 });
}
