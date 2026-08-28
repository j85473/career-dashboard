import { createHash } from 'node:crypto';

export const ATS_PREQUEUE_COMPACTION_METADATA_KEY = '__careerDashboardAtsPrequeueCompaction';
export const ATS_PREQUEUE_COMPACTION_VERSION = 1 as const;

const REDISCOVERY_MUTABLE_STATUSES = new Set(['pending_af', 'inbox']);

type JsonObject = Record<string, unknown>;

export type AtsPrequeueCompactionMarker = {
  version: typeof ATS_PREQUEUE_COMPACTION_VERSION;
  platform: string;
  boardSlug: string;
  fetchedJobCount: number;
  queuedJobCount: number;
  prequeueExactDuplicateCount: number;
  retainedExactObservationCount: number;
  missingIdentityCount: number;
  compactedItems: AtsCompactedObservationReceipt[];
  compactedIdentityHash: string;
  completedAt: string;
};

export type AtsObservedSourceState = {
  sourceId: string;
  jobId: string;
  jobStatus: string | null;
  jobUpdatedAt: string;
  boardSlug: string | null;
};

export type AtsCompactedObservationReceipt = {
  sourceId: string;
  jobId: string;
  jobStatus: string;
  jobUpdatedAt: string;
  originalItemIndex: number;
};

export type AtsPrequeueCompactionPlan = {
  jobs: JsonObject[];
  marker: Omit<AtsPrequeueCompactionMarker, 'completedAt'>;
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

/**
 * Returns the exact source identity used by the downstream ATS normalizer.
 * Keep this shared: acquisition-side compaction is safe only when it uses the
 * same provider-owned identifier as JobSourceObservation.
 */
export function atsListingSourceId(
  platform: string,
  job: Record<string, unknown>,
): string | null {
  let sourceId = job.id != null ? String(job.id) : null;
  if (platform === 'workday' && job.externalPath) {
    sourceId = String(job.externalPath);
  }
  if (platform === 'workable') {
    sourceId = String(job.id || job.shortcode || job.code || '');
  }
  if (platform === 'rippling' && job.uuid) {
    sourceId = String(job.uuid);
  }
  return sourceId && sourceId.trim() ? sourceId : null;
}

/**
 * Only pending/inbox jobs have a current exact-source rediscovery behavior:
 * they may be closed or receive a previously missing usable description.
 * Every other lifecycle state is already a no-op in the downstream exact
 * observation branch, so bypassing it cannot reinterpret existing work.
 */
export function canCompactExactAtsObservation(jobStatus: string | null): jobStatus is string {
  return Boolean(jobStatus) && !REDISCOVERY_MUTABLE_STATUSES.has(String(jobStatus));
}

function isCompactedObservationReceipt(value: unknown): value is AtsCompactedObservationReceipt {
  return isRecord(value)
    && typeof value.sourceId === 'string'
    && Boolean(value.sourceId.trim())
    && typeof value.jobId === 'string'
    && Boolean(value.jobId.trim())
    && typeof value.jobStatus === 'string'
    && Boolean(value.jobStatus.trim())
    && typeof value.jobUpdatedAt === 'string'
    && Number.isFinite(Date.parse(value.jobUpdatedAt))
    && nonNegativeInteger(value.originalItemIndex);
}

function compactedIdentityHash(
  platform: string,
  boardSlug: string,
  items: AtsCompactedObservationReceipt[],
): string {
  // Hash an explicit tuple representation so provider-controlled strings can
  // contain any delimiter without creating an ambiguous receipt. The raw
  // ordinal is part of the identity: a reordered response is a different
  // acquisition payload even when it contains the same source IDs.
  const canonicalItems = [...items]
    .sort((left, right) => left.originalItemIndex - right.originalItemIndex)
    .map((item) => [
      item.originalItemIndex,
      item.sourceId,
      item.jobId,
      item.jobStatus,
      item.jobUpdatedAt,
    ]);
  return createHash('sha256')
    .update(JSON.stringify({ platform, boardSlug, items: canonicalItems }))
    .digest('hex');
}

export function planAtsPrequeueCompaction(input: {
  platform: string;
  boardSlug: string;
  jobs: JsonObject[];
  observations: AtsObservedSourceState[];
}): AtsPrequeueCompactionPlan {
  const observedStates = new Map(
    input.observations
      // Several providers use IDs that are unique only within one tenant. An
      // exact source ID is compactable only when its durable observation URL
      // proves it came from this exact board; ambiguous legacy rows fail open.
      .filter((observation) => observation.boardSlug === input.boardSlug)
      .map((observation) => [observation.sourceId, observation]),
  );
  const retained: JsonObject[] = [];
  const compactedItems: AtsCompactedObservationReceipt[] = [];
  let retainedExactObservationCount = 0;
  let missingIdentityCount = 0;

  for (const [originalItemIndex, job] of input.jobs.entries()) {
    const sourceId = atsListingSourceId(input.platform, job);
    if (!sourceId) {
      missingIdentityCount++;
      retained.push(job);
      continue;
    }
    const observation = observedStates.get(sourceId);
    if (!observation) {
      retained.push(job);
      continue;
    }
    if (!canCompactExactAtsObservation(observation.jobStatus)) {
      retainedExactObservationCount++;
      retained.push(job);
      continue;
    }
    compactedItems.push({
      sourceId,
      jobId: observation.jobId,
      jobStatus: observation.jobStatus,
      jobUpdatedAt: observation.jobUpdatedAt,
      originalItemIndex,
    });
  }

  return {
    jobs: retained,
    marker: {
      version: ATS_PREQUEUE_COMPACTION_VERSION,
      platform: input.platform,
      boardSlug: input.boardSlug,
      fetchedJobCount: input.jobs.length,
      queuedJobCount: retained.length,
      prequeueExactDuplicateCount: compactedItems.length,
      retainedExactObservationCount,
      missingIdentityCount,
      compactedItems,
      compactedIdentityHash: compactedIdentityHash(input.platform, input.boardSlug, compactedItems),
    },
  };
}

export function readAtsPrequeueCompactionMarker(
  metadata: Record<string, unknown>,
): AtsPrequeueCompactionMarker | null {
  const value = metadata[ATS_PREQUEUE_COMPACTION_METADATA_KEY];
  if (value === undefined) return null;
  if (!isRecord(value)
    || value.version !== ATS_PREQUEUE_COMPACTION_VERSION
    || typeof value.platform !== 'string'
    || !value.platform.trim()
    || typeof value.boardSlug !== 'string'
    || !value.boardSlug.trim()
    || !nonNegativeInteger(value.fetchedJobCount)
    || !nonNegativeInteger(value.queuedJobCount)
    || !nonNegativeInteger(value.prequeueExactDuplicateCount)
    || !nonNegativeInteger(value.retainedExactObservationCount)
    || !nonNegativeInteger(value.missingIdentityCount)
    || !Array.isArray(value.compactedItems)
    || !value.compactedItems.every(isCompactedObservationReceipt)
    || typeof value.compactedIdentityHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.compactedIdentityHash)
    || typeof value.completedAt !== 'string'
    || !Number.isFinite(Date.parse(value.completedAt))
    || value.fetchedJobCount !== value.queuedJobCount + value.prequeueExactDuplicateCount
    || value.retainedExactObservationCount + value.missingIdentityCount > value.queuedJobCount
    || value.prequeueExactDuplicateCount !== value.compactedItems.length
    || value.compactedItems.some((item) => !canCompactExactAtsObservation(item.jobStatus))
    || value.compactedItems.some((item) => item.originalItemIndex >= Number(value.fetchedJobCount))
    || new Set(value.compactedItems.map((item) => item.originalItemIndex)).size !== value.compactedItems.length
    || value.compactedIdentityHash !== compactedIdentityHash(
      value.platform,
      value.boardSlug,
      value.compactedItems,
    )) {
    throw new Error('ATS prequeue compaction metadata is invalid.');
  }
  return value as AtsPrequeueCompactionMarker;
}

export function validateAtsPrequeueCompactionCheckpoint(input: {
  marker: AtsPrequeueCompactionMarker;
  platform: string;
  boardSlug: string;
  listingComplete: boolean;
  payloadJobCount: number;
  storedJobCount: number;
}): void {
  if (!input.listingComplete
    || input.marker.platform !== input.platform
    || input.marker.boardSlug !== input.boardSlug
    || input.marker.queuedJobCount !== input.payloadJobCount
    || input.marker.queuedJobCount !== input.storedJobCount) {
    throw new Error('ATS prequeue compaction checkpoint does not match its durable payload.');
  }
}

export function atsBatchHasProcessingProvenance(input: {
  synchronizedAt: Date | string | null;
  processingOffset: number;
  insertedCount: number;
  duplicateCount: number;
  filteredCount: number;
  processingErrorCount: number;
}): boolean {
  return input.synchronizedAt !== null
    || input.processingOffset > 0
    || input.insertedCount > 0
    || input.duplicateCount > 0
    || input.filteredCount > 0
    || input.processingErrorCount > 0;
}
