import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { Prisma } from '@prisma/client';

import {
  currentAtsEnrichmentPrefix,
  readAtsAcquisitionCursor,
  type AtsAcquisitionCursor,
} from './atsAcquisition';
import {
  ATS_JOB_ENRICHMENT_KEY,
  ATS_JOB_ENRICHMENT_VERSION,
  readAtsJobEnrichmentMarker,
  type AtsJobEnrichmentMarker,
} from './atsJobEnrichment';
import {
  atsLedgerHash,
  chicagoLocalDay,
  ATS_LEDGER_VERSION,
} from './atsAcquisitionLedger';
import {
  atsListingSourceId,
  readAtsPrequeueCompactionMarker,
  validateAtsPrequeueCompactionCheckpoint,
  type AtsCompactedObservationReceipt,
  type AtsPrequeueCompactionMarker,
} from './atsPrequeueCompaction';
import { ATS_ACQUISITION_WRITER_VERSION } from './atsAcquisitionCompatibility';
import { prisma } from './prisma';

type JsonObject = Record<string, unknown>;

const CONVERSION_CHUNK_SIZE = 250;
const CONVERSION_LEASE_MS = 30 * 60_000;
const CONVERSION_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;

export type LegacyBatchSnapshot = {
  id: string;
  slug: string;
  platform: string;
  status: string;
  payload: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  cursor: Prisma.JsonValue | null;
  jobCount: number;
  processingOffset: number;
  insertedCount: number;
  duplicateCount: number;
  filteredCount: number;
  processingErrorCount: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date;
  respondedAt: Date | null;
  synchronizedAt: Date | null;
  updatedAt: Date;
  writerMode: string;
  conversionGeneration: number;
  acquisitionClaimToken: string | null;
  acquisitionClaimFence: bigint;
  acquisitionLeaseExpiresAt: Date | null;
  attempts: Array<{ id: string; outcome: string; contactedAt: Date | null; respondedAt: Date | null }>;
};

export type LegacyAtsConversionObservation = {
  ordinal: number;
  providerSourceId: string | null;
  rawHash: string;
  rawJson: JsonObject | null;
  compactedReceipt: AtsCompactedObservationReceipt | null;
};

export type LegacyAtsConversionItem = {
  canonicalOrdinal: number;
  observationOrdinal: number;
  providerSourceId: string | null;
  rawHash: string;
  rawJson: JsonObject;
  marker: AtsJobEnrichmentMarker | null;
};

export type LegacyAtsConversionPlan = {
  batchId: string;
  slug: string;
  platform: string;
  cursor: AtsAcquisitionCursor;
  metadata: JsonObject;
  observations: LegacyAtsConversionObservation[];
  items: LegacyAtsConversionItem[];
  compactionMarker: AtsPrequeueCompactionMarker | null;
  acquisitionPhase: 'listing' | 'compaction' | 'enrichment';
  rawObservationCount: number;
  canonicalOccurrenceCount: number;
  compactedOccurrenceCount: number;
  terminalItemCount: number;
  observedAt: Date;
  admittedAt: Date;
  contactConfirmedAt: Date | null;
  responseHash: string;
  identityMultisetHash: string;
  rawBodyHash: string;
  rawBodyBytes: bigint;
  planHash: string;
};

export type LegacyAtsConversionCandidate = {
  batchId: string;
  slug: string;
  platform: string;
  status: string;
  writerMode: string;
  jobCount: number;
  listingComplete: boolean;
  listingOffset: number;
  enrichmentOffset: number;
  acquisitionPhase: LegacyAtsConversionPlan['acquisitionPhase'] | 'invalid';
  convertible: boolean;
  reason: string | null;
};

export type LegacyAtsConversionResult = LegacyAtsConversionCandidate & {
  outcome: 'converted' | 'already_v2' | 'busy' | 'invalid' | 'failed';
  conversionGeneration?: number;
  planHash?: string;
};

function jsonObject(value: Prisma.JsonValue | null | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function jsonJobs(value: Prisma.JsonValue | null | undefined): JsonObject[] {
  if (!Array.isArray(value)) throw new Error('Legacy ATS payload is not an array.');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Legacy ATS payload item ${index} is not an object.`);
    }
    return entry as JsonObject;
  });
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function withoutEnrichmentMarker(job: JsonObject): JsonObject {
  const clone = structuredClone(job);
  delete clone[ATS_JOB_ENRICHMENT_KEY];
  return clone;
}

function deterministicId(kind: string, batchId: string, generation: number, ordinal?: number): string {
  return atsLedgerHash({ kind, batchId, generation, ordinal: ordinal ?? null });
}

function hasProcessingProvenance(batch: LegacyBatchSnapshot): boolean {
  return batch.synchronizedAt !== null
    || batch.processingOffset > 0
    || batch.insertedCount > 0
    || batch.duplicateCount > 0
    || batch.filteredCount > 0
    || batch.processingErrorCount > 0;
}

function retainedAndCompactedObservations(input: {
  jobs: JsonObject[];
  marker: AtsPrequeueCompactionMarker;
  platform: string;
}): { observations: LegacyAtsConversionObservation[]; items: LegacyAtsConversionItem[] } {
  const compactedByOrdinal = new Map(
    input.marker.compactedItems.map((receipt) => [receipt.originalItemIndex, receipt]),
  );
  const observations: LegacyAtsConversionObservation[] = [];
  const items: LegacyAtsConversionItem[] = [];
  let retainedIndex = 0;
  for (let originalOrdinal = 0; originalOrdinal < input.marker.fetchedJobCount; originalOrdinal++) {
    const compactedReceipt = compactedByOrdinal.get(originalOrdinal) || null;
    if (compactedReceipt) {
      observations.push({
        ordinal: originalOrdinal,
        providerSourceId: compactedReceipt.sourceId,
        rawHash: atsLedgerHash({ kind: 'legacy_compacted_receipt_v1', compactedReceipt }),
        rawJson: null,
        compactedReceipt,
      });
      continue;
    }
    const legacyJob = input.jobs[retainedIndex];
    if (!legacyJob) {
      throw new Error(`Legacy ATS compaction receipt omitted retained item ${retainedIndex}.`);
    }
    const marker = readAtsJobEnrichmentMarker(legacyJob);
    const rawJson = withoutEnrichmentMarker(legacyJob);
    const rawHash = atsLedgerHash(rawJson);
    observations.push({
      ordinal: originalOrdinal,
      providerSourceId: atsListingSourceId(input.platform, rawJson),
      rawHash,
      rawJson,
      compactedReceipt: null,
    });
    items.push({
      canonicalOrdinal: retainedIndex,
      observationOrdinal: originalOrdinal,
      providerSourceId: atsListingSourceId(input.platform, rawJson),
      rawHash,
      rawJson,
      marker,
    });
    retainedIndex++;
  }
  if (retainedIndex !== input.jobs.length) {
    throw new Error(
      `Legacy ATS compaction retained ${input.jobs.length} payload items but reconstructed ${retainedIndex}.`,
    );
  }
  return { observations, items };
}

export function planLegacyAtsBatchConversion(batch: LegacyBatchSnapshot): LegacyAtsConversionPlan {
  if (!['fetching', 'partial'].includes(batch.status)) {
    throw new Error(`Legacy ATS batch status ${batch.status} is not acquisition-stage work.`);
  }
  if (!['legacy', 'converting'].includes(batch.writerMode)) {
    throw new Error(`ATS batch writer mode ${batch.writerMode} is not convertible.`);
  }
  if (hasProcessingProvenance(batch)) {
    throw new Error('Legacy ATS batch has synchronization or processing provenance.');
  }
  if (batch.leaseToken && (!batch.leaseExpiresAt || batch.leaseExpiresAt > new Date())) {
    throw new Error('Legacy ATS batch has an active consumer lease.');
  }
  if (batch.attempts.some((attempt) => attempt.outcome === 'running')) {
    throw new Error('Legacy ATS batch has a running acquisition attempt.');
  }

  const jobs = jsonJobs(batch.payload);
  if (jobs.length !== batch.jobCount) {
    throw new Error(
      `Legacy ATS payload length ${jobs.length} does not match stored job count ${batch.jobCount}.`,
    );
  }
  if (jobs.length === 0) throw new Error('Legacy ATS batch has no durable listing items to convert.');

  const metadata = jsonObject(batch.metadata);
  const cursor = readAtsAcquisitionCursor(batch.cursor);
  const compactionMarker = readAtsPrequeueCompactionMarker(metadata);
  if (compactionMarker) {
    validateAtsPrequeueCompactionCheckpoint({
      marker: compactionMarker,
      platform: batch.platform,
      boardSlug: batch.slug,
      listingComplete: cursor.listingComplete,
      payloadJobCount: jobs.length,
      storedJobCount: batch.jobCount,
    });
  }
  if (!cursor.listingComplete && (cursor.enrichmentOffset !== 0 || compactionMarker)) {
    throw new Error('Listing-incomplete legacy ATS batch contains enrichment or compaction progress.');
  }
  if (!cursor.listingComplete && cursor.offset !== jobs.length) {
    throw new Error(
      `Listing-incomplete legacy ATS cursor offset ${cursor.offset} does not match ${jobs.length} stored items.`,
    );
  }

  let observations: LegacyAtsConversionObservation[];
  let items: LegacyAtsConversionItem[];
  let acquisitionPhase: LegacyAtsConversionPlan['acquisitionPhase'];
  if (compactionMarker) {
    ({ observations, items } = retainedAndCompactedObservations({
      jobs,
      marker: compactionMarker,
      platform: batch.platform,
    }));
    acquisitionPhase = 'enrichment';
  } else {
    observations = jobs.map((job, ordinal) => {
      const rawJson = withoutEnrichmentMarker(job);
      return {
        ordinal,
        providerSourceId: atsListingSourceId(batch.platform, rawJson),
        rawHash: atsLedgerHash(rawJson),
        rawJson,
        compactedReceipt: null,
      };
    });
    items = [];
    acquisitionPhase = cursor.listingComplete ? 'compaction' : 'listing';
  }

  const currentPrefix = currentAtsEnrichmentPrefix(jobs, batch.platform);
  const currentMarkerCount = jobs.filter((job) => {
    const marker = readAtsJobEnrichmentMarker(job);
    return marker?.version === ATS_JOB_ENRICHMENT_VERSION && marker.platform === batch.platform;
  }).length;
  if (currentPrefix !== cursor.enrichmentOffset) {
    throw new Error(
      `Legacy ATS enrichment cursor ${cursor.enrichmentOffset} does not match its exact current-marker prefix ${currentPrefix}.`,
    );
  }
  if (cursor.listingComplete && cursor.enrichmentVersion !== ATS_JOB_ENRICHMENT_VERSION) {
    throw new Error('Listing-complete legacy ATS batch has a stale enrichment version.');
  }
  if (!compactionMarker && currentMarkerCount > 0) {
    throw new Error('Legacy ATS enrichment markers exist without a durable compaction checkpoint.');
  }
  if (!compactionMarker && cursor.enrichmentOffset !== 0) {
    throw new Error('Legacy ATS enrichment progress exists without a durable compaction checkpoint.');
  }
  for (const [index, item] of items.entries()) {
    if (index < cursor.enrichmentOffset && !item.marker) {
      throw new Error(`Legacy ATS item ${index} is before the enrichment cursor without a marker.`);
    }
  }

  const contactConfirmedAt = batch.respondedAt
    || batch.attempts.find((attempt) => attempt.respondedAt)?.respondedAt
    || batch.attempts.find((attempt) => attempt.contactedAt)?.contactedAt
    || null;
  const observedAt = batch.respondedAt || contactConfirmedAt || batch.updatedAt;
  const importBody = {
    kind: 'legacy_import_v1',
    batchId: batch.id,
    slug: batch.slug,
    platform: batch.platform,
    cursor,
    metadata,
    observations: observations.map((observation) => ({
      ordinal: observation.ordinal,
      providerSourceId: observation.providerSourceId,
      rawHash: observation.rawHash,
      compactedReceipt: observation.compactedReceipt,
    })),
  };
  const serializedImport = JSON.stringify(importBody);
  const responseHash = atsLedgerHash(importBody);
  const identityMultisetHash = atsLedgerHash(observations.map((observation) => (
    [observation.providerSourceId, observation.rawHash]
  )).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  const rawBodyHash = atsLedgerHash({ legacyPayload: jobs, metadata, cursor });
  const rawBodyBytes = BigInt(Buffer.byteLength(serializedImport, 'utf8'));
  const terminalItemCount = currentMarkerCount;
  const planHash = atsLedgerHash({
    kind: 'legacy_conversion_plan_v1',
    responseHash,
    identityMultisetHash,
    rawBodyHash,
    rawObservationCount: observations.length,
    canonicalOccurrenceCount: items.length,
    compactedOccurrenceCount: compactionMarker?.prequeueExactDuplicateCount || 0,
    terminalItemCount,
    acquisitionPhase,
    listingOffset: cursor.offset,
    total: cursor.total,
  });

  return {
    batchId: batch.id,
    slug: batch.slug,
    platform: batch.platform,
    cursor,
    metadata,
    observations,
    items,
    compactionMarker,
    acquisitionPhase,
    rawObservationCount: observations.length,
    canonicalOccurrenceCount: items.length,
    compactedOccurrenceCount: compactionMarker?.prequeueExactDuplicateCount || 0,
    terminalItemCount,
    observedAt,
    admittedAt: batch.startedAt,
    contactConfirmedAt,
    responseHash,
    identityMultisetHash,
    rawBodyHash,
    rawBodyBytes,
    planHash,
  };
}

async function loadLegacyBatch(batchId: string): Promise<LegacyBatchSnapshot | null> {
  return prisma.atsIngestionBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      slug: true,
      platform: true,
      status: true,
      payload: true,
      metadata: true,
      cursor: true,
      jobCount: true,
      processingOffset: true,
      insertedCount: true,
      duplicateCount: true,
      filteredCount: true,
      processingErrorCount: true,
      leaseToken: true,
      leaseExpiresAt: true,
      startedAt: true,
      respondedAt: true,
      synchronizedAt: true,
      updatedAt: true,
      writerMode: true,
      conversionGeneration: true,
      acquisitionClaimToken: true,
      acquisitionClaimFence: true,
      acquisitionLeaseExpiresAt: true,
      attempts: {
        select: { id: true, outcome: true, contactedAt: true, respondedAt: true },
        orderBy: { startedAt: 'asc' },
      },
    },
  });
}

function candidateFromPlan(
  batch: LegacyBatchSnapshot,
  plan: LegacyAtsConversionPlan | null,
  reason: string | null,
): LegacyAtsConversionCandidate {
  const cursor = readAtsAcquisitionCursor(batch.cursor);
  return {
    batchId: batch.id,
    slug: batch.slug,
    platform: batch.platform,
    status: batch.status,
    writerMode: batch.writerMode,
    jobCount: batch.jobCount,
    listingComplete: cursor.listingComplete,
    listingOffset: cursor.offset,
    enrichmentOffset: cursor.enrichmentOffset,
    acquisitionPhase: plan?.acquisitionPhase || 'invalid',
    convertible: Boolean(plan),
    reason,
  };
}

export async function inspectLegacyAtsConversionCandidates(input: {
  batchIds?: string[];
  limit?: number;
} = {}): Promise<LegacyAtsConversionCandidate[]> {
  const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit || 10_000)));
  const rows = await prisma.atsIngestionBatch.findMany({
    where: {
      ...(input.batchIds?.length ? { id: { in: input.batchIds } } : {}),
      writerMode: { in: ['legacy', 'converting'] },
      status: { in: ['fetching', 'partial'] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true },
  });
  const candidates: LegacyAtsConversionCandidate[] = [];
  for (const row of rows) {
    const batch = await loadLegacyBatch(row.id);
    if (!batch) continue;
    try {
      candidates.push(candidateFromPlan(batch, planLegacyAtsBatchConversion(batch), null));
    } catch (error) {
      candidates.push(candidateFromPlan(
        batch,
        null,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }
  return candidates;
}

type ConversionClaim = {
  batchId: string;
  conversionGeneration: number;
  claimFence: bigint;
  claimToken: string;
};

async function claimLegacyBatchForConversion(
  batch: LegacyBatchSnapshot,
  owner: string,
  now = new Date(),
): Promise<ConversionClaim | null> {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + CONVERSION_LEASE_MS);
  if (batch.writerMode === 'legacy') {
    const rows = await prisma.$queryRaw<Array<{
      batchId: string;
      conversionGeneration: number;
      claimFence: bigint;
    }>>(Prisma.sql`
      SELECT * FROM "claim_ats_batch_for_v2_conversion"(
        ${batch.id}::text,
        ${claimToken}::text,
        ${owner}::text,
        (${leaseExpiresAt} AT TIME ZONE 'UTC')::timestamp(3)
      )
    `);
    const claimed = rows[0];
    return claimed ? { ...claimed, claimToken } : null;
  }
  const reclaimed = await prisma.atsIngestionBatch.updateMany({
    where: {
      id: batch.id,
      writerMode: 'converting',
      leaseToken: null,
      attempts: { none: { outcome: 'running' } },
      OR: [
        { acquisitionClaimToken: null },
        { acquisitionLeaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      acquisitionClaimToken: claimToken,
      acquisitionClaimOwner: owner,
      acquisitionClaimFence: { increment: BigInt(1) },
      acquisitionHeartbeatAt: now,
      acquisitionLeaseExpiresAt: leaseExpiresAt,
    },
  });
  if (reclaimed.count !== 1) return null;
  const claimed = await prisma.atsIngestionBatch.findUniqueOrThrow({
    where: { id: batch.id },
    select: { conversionGeneration: true, acquisitionClaimFence: true },
  });
  return {
    batchId: batch.id,
    conversionGeneration: claimed.conversionGeneration,
    claimFence: claimed.acquisitionClaimFence,
    claimToken,
  };
}

async function heartbeatConversionClaim(claim: ConversionClaim, now = new Date()): Promise<void> {
  const retained = await prisma.atsIngestionBatch.updateMany({
    where: {
      id: claim.batchId,
      writerMode: 'converting',
      conversionGeneration: claim.conversionGeneration,
      acquisitionClaimToken: claim.claimToken,
      acquisitionClaimFence: claim.claimFence,
    },
    data: {
      acquisitionHeartbeatAt: now,
      acquisitionLeaseExpiresAt: new Date(now.getTime() + CONVERSION_LEASE_MS),
    },
  });
  if (retained.count !== 1) throw new Error(`ATS conversion lost batch ${claim.batchId}.`);
}

async function releaseConversionClaim(claim: ConversionClaim): Promise<void> {
  await prisma.atsIngestionBatch.updateMany({
    where: {
      id: claim.batchId,
      writerMode: 'converting',
      conversionGeneration: claim.conversionGeneration,
      acquisitionClaimToken: claim.claimToken,
      acquisitionClaimFence: claim.claimFence,
    },
    data: {
      acquisitionClaimToken: null,
      acquisitionClaimOwner: null,
      acquisitionHeartbeatAt: new Date(),
      acquisitionLeaseExpiresAt: null,
    },
  });
}

async function stageLegacyConversion(
  claim: ConversionClaim,
  plan: LegacyAtsConversionPlan,
): Promise<void> {
  const generation = claim.conversionGeneration;
  const pageId = deterministicId('legacy_import_page_v1', claim.batchId, generation);
  const sweepId = deterministicId('legacy_import_sweep_v1', claim.batchId, generation);
  const pageMetadata = {
    ...plan.metadata,
    __careerDashboardLegacyImport: {
      version: 1,
      batchId: claim.batchId,
      conversionGeneration: generation,
      planHash: plan.planHash,
    },
  };

  await prisma.$transaction(async (transaction) => {
    const existingPage = await transaction.atsIngestionPage.findUnique({
      where: {
        batchId_generation_requestedOffset: {
          batchId: claim.batchId,
          generation,
          requestedOffset: 0,
        },
      },
    });
    if (existingPage && (
      existingPage.id !== pageId
      || existingPage.responseHash !== plan.responseHash
      || existingPage.identityMultisetHash !== plan.identityMultisetHash
      || existingPage.responseItemCount !== plan.rawObservationCount
      || existingPage.rawBodyHash !== plan.rawBodyHash
    )) {
      throw new Error(`ATS conversion page evidence diverged for batch ${claim.batchId}.`);
    }
    if (!existingPage) {
      await transaction.atsIngestionPage.create({
        data: {
          id: pageId,
          batchId: claim.batchId,
          generation,
          requestedOffset: 0,
          requestedLimit: Math.max(1, plan.rawObservationCount),
          providerOffset: 0,
          providerTotal: plan.cursor.total,
          responseItemCount: plan.rawObservationCount,
          responseHash: plan.responseHash,
          identityMultisetHash: plan.identityMultisetHash,
          metadata: inputJson(pageMetadata),
          rawBody: Prisma.DbNull,
          rawBodyHash: plan.rawBodyHash,
          rawBodyBytes: plan.rawBodyBytes,
          materializationOffset: plan.rawObservationCount,
          requestedAt: plan.admittedAt,
          respondedAt: plan.observedAt,
          httpStatus: 200,
          materializationCompleteAt: plan.observedAt,
        },
      });
    }
    await transaction.atsEndpointSweepReceipt.createMany({
      skipDuplicates: true,
      data: [{
        id: sweepId,
        batchId: claim.batchId,
        slug: plan.slug,
        platform: plan.platform,
        admissionLocalDay: chicagoLocalDay(plan.admittedAt),
        state: plan.contactConfirmedAt ? 'responded' : 'admitted',
        admittedAt: plan.admittedAt,
        dispatchIntentAt: plan.contactConfirmedAt,
        contactConfirmedAt: plan.contactConfirmedAt,
        respondedAt: plan.contactConfirmedAt,
      }],
    });
  }, CONVERSION_TRANSACTION_OPTIONS);

  for (let offset = 0; offset < plan.observations.length; offset += CONVERSION_CHUNK_SIZE) {
    const chunk = plan.observations.slice(offset, offset + CONVERSION_CHUNK_SIZE);
    await prisma.atsListingObservation.createMany({
      skipDuplicates: true,
      data: chunk.map((observation) => ({
        id: deterministicId('legacy_import_observation_v1', claim.batchId, generation, observation.ordinal),
        batchId: claim.batchId,
        pageId,
        generation,
        pageOrdinal: observation.ordinal,
        providerSourceId: observation.providerSourceId,
        rawHash: observation.rawHash,
        rawJson: observation.rawJson ? inputJson(observation.rawJson) : Prisma.DbNull,
        observedAt: plan.observedAt,
      })),
    });
    await heartbeatConversionClaim(claim);
  }

  if (plan.compactionMarker) {
    for (let offset = 0; offset < plan.observations.length; offset += CONVERSION_CHUNK_SIZE) {
      const observationChunk = plan.observations.slice(offset, offset + CONVERSION_CHUNK_SIZE);
      const retainedItems = plan.items.filter((item) => (
        item.observationOrdinal >= offset && item.observationOrdinal < offset + observationChunk.length
      ));
      await prisma.$transaction(async (transaction) => {
        if (retainedItems.length > 0) {
          await transaction.atsIngestionItem.createMany({
            skipDuplicates: true,
            data: retainedItems.map((item) => ({
              id: deterministicId(
                'legacy_import_item_v1',
                claim.batchId,
                generation,
                item.canonicalOrdinal,
              ),
              batchId: claim.batchId,
              ledgerGeneration: generation,
              canonicalOrdinal: item.canonicalOrdinal,
              representativeObservationId: deterministicId(
                'legacy_import_observation_v1',
                claim.batchId,
                generation,
                item.observationOrdinal,
              ),
              providerSourceId: item.providerSourceId,
              rawHash: item.rawHash,
              rawJson: inputJson(item.rawJson),
              rawReference: Prisma.DbNull,
              enrichmentOverlay: item.marker
                ? inputJson({ [ATS_JOB_ENRICHMENT_KEY]: item.marker })
                : Prisma.DbNull,
              enrichmentVersion: item.marker ? ATS_JOB_ENRICHMENT_VERSION : null,
              enrichmentStatus: item.marker ? 'terminal' : 'pending',
              enrichmentReason: item.marker?.reason || item.marker?.status || null,
              detailHttpStatus: item.marker?.httpStatus || null,
              detailError: item.marker?.error || null,
              terminalAt: item.marker ? new Date(item.marker.completedAt) : null,
            })),
          });
        }
        await transaction.atsListingObservationResolution.createMany({
          skipDuplicates: true,
          data: observationChunk.map((observation) => {
            const item = plan.items.find((candidate) => (
              candidate.observationOrdinal === observation.ordinal
            ));
            const itemId = item
              ? deterministicId('legacy_import_item_v1', claim.batchId, generation, item.canonicalOrdinal)
              : null;
            const resolutionType = item ? 'canonical_item' : 'legacy_compacted_receipt';
            const detail = item
              ? { canonicalOrdinal: item.canonicalOrdinal, legacyImport: true }
              : { ...observation.compactedReceipt, legacyImport: true };
            return {
              id: deterministicId(
                'legacy_import_resolution_v1',
                claim.batchId,
                generation,
                observation.ordinal,
              ),
              batchId: claim.batchId,
              observationId: deterministicId(
                'legacy_import_observation_v1',
                claim.batchId,
                generation,
                observation.ordinal,
              ),
              itemId,
              ledgerGeneration: generation,
              resolutionType,
              occurrenceKey: observation.providerSourceId || observation.rawHash,
              resolutionHash: atsLedgerHash({
                batchId: claim.batchId,
                generation,
                observationOrdinal: observation.ordinal,
                itemId,
                resolutionType,
                detail,
              }),
              detail: inputJson(detail),
            };
          }),
        });
      }, CONVERSION_TRANSACTION_OPTIONS);
      await heartbeatConversionClaim(claim);
    }
  }
}

async function verifyStagedLegacyConversion(
  claim: ConversionClaim,
  plan: LegacyAtsConversionPlan,
): Promise<void> {
  const generation = claim.conversionGeneration;
  const pageId = deterministicId('legacy_import_page_v1', claim.batchId, generation);
  const page = await prisma.atsIngestionPage.findUnique({ where: { id: pageId } });
  if (!page
    || page.responseHash !== plan.responseHash
    || page.identityMultisetHash !== plan.identityMultisetHash
    || page.responseItemCount !== plan.rawObservationCount
    || page.materializationOffset !== plan.rawObservationCount
    || page.rawBodyHash !== plan.rawBodyHash) {
    throw new Error(`ATS conversion page verification failed for batch ${claim.batchId}.`);
  }

  for (let offset = 0; offset < plan.observations.length; offset += CONVERSION_CHUNK_SIZE) {
    const expected = plan.observations.slice(offset, offset + CONVERSION_CHUNK_SIZE);
    const rows = await prisma.atsListingObservation.findMany({
      where: {
        batchId: claim.batchId,
        generation,
        pageOrdinal: { gte: offset, lt: offset + expected.length },
      },
      orderBy: { pageOrdinal: 'asc' },
      select: { id: true, pageOrdinal: true, providerSourceId: true, rawHash: true },
    });
    if (rows.length !== expected.length || rows.some((row, index) => (
      row.id !== deterministicId(
        'legacy_import_observation_v1', claim.batchId, generation, expected[index].ordinal
      )
      || row.pageOrdinal !== expected[index].ordinal
      || row.providerSourceId !== expected[index].providerSourceId
      || row.rawHash !== expected[index].rawHash
    ))) {
      throw new Error(`ATS conversion observation verification failed for batch ${claim.batchId}.`);
    }
  }

  if (plan.compactionMarker) {
    const [items, resolutionCount, terminalItemCount] = await Promise.all([
      prisma.atsIngestionItem.findMany({
        where: { batchId: claim.batchId, ledgerGeneration: generation },
        orderBy: { canonicalOrdinal: 'asc' },
        select: {
          id: true,
          canonicalOrdinal: true,
          representativeObservationId: true,
          providerSourceId: true,
          rawHash: true,
          enrichmentOverlay: true,
          enrichmentStatus: true,
        },
      }),
      prisma.atsListingObservationResolution.count({
        where: { batchId: claim.batchId, ledgerGeneration: generation },
      }),
      prisma.atsIngestionItem.count({
        where: { batchId: claim.batchId, ledgerGeneration: generation, enrichmentStatus: 'terminal' },
      }),
    ]);
    if (items.length !== plan.canonicalOccurrenceCount
      || resolutionCount !== plan.rawObservationCount
      || terminalItemCount !== plan.terminalItemCount
      || items.some((row, index) => {
        const expected = plan.items[index];
        return !expected
          || row.id !== deterministicId(
            'legacy_import_item_v1', claim.batchId, generation, expected.canonicalOrdinal
          )
          || row.canonicalOrdinal !== expected.canonicalOrdinal
          || row.representativeObservationId !== deterministicId(
            'legacy_import_observation_v1', claim.batchId, generation, expected.observationOrdinal
          )
          || row.providerSourceId !== expected.providerSourceId
          || row.rawHash !== expected.rawHash
          || row.enrichmentStatus !== (expected.marker ? 'terminal' : 'pending')
          || atsLedgerHash(row.enrichmentOverlay) !== atsLedgerHash(
            expected.marker ? { [ATS_JOB_ENRICHMENT_KEY]: expected.marker } : null
          );
      })) {
      throw new Error(`ATS conversion item/resolution counts failed for batch ${claim.batchId}.`);
    }
  }
}

async function activateStagedLegacyConversion(
  claim: ConversionClaim,
  plan: LegacyAtsConversionPlan,
): Promise<void> {
  const generation = claim.conversionGeneration;
  const sweepId = deterministicId('legacy_import_sweep_v1', claim.batchId, generation);
  const workReceiptId = deterministicId('legacy_import_work_v1', claim.batchId, generation);
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true)`;
    const batch = await transaction.atsIngestionBatch.findUniqueOrThrow({
      where: { id: claim.batchId },
      select: {
        writerMode: true,
        conversionGeneration: true,
        acquisitionClaimToken: true,
        acquisitionClaimFence: true,
        acquisitionLeaseExpiresAt: true,
        payload: true,
        metadata: true,
        cursor: true,
        jobCount: true,
        status: true,
        processingOffset: true,
        insertedCount: true,
        duplicateCount: true,
        filteredCount: true,
        processingErrorCount: true,
        synchronizedAt: true,
      },
    });
    if (batch.writerMode !== 'converting'
      || batch.conversionGeneration !== generation
      || batch.acquisitionClaimToken !== claim.claimToken
      || batch.acquisitionClaimFence !== claim.claimFence
      || !batch.acquisitionLeaseExpiresAt
      || batch.acquisitionLeaseExpiresAt <= new Date()) {
      throw new Error(`ATS conversion activation lost the fence for batch ${claim.batchId}.`);
    }
    const currentPlan = planLegacyAtsBatchConversion({
      ...batch,
      id: claim.batchId,
      slug: plan.slug,
      platform: plan.platform,
      leaseToken: null,
      leaseExpiresAt: null,
      startedAt: plan.admittedAt,
      respondedAt: plan.contactConfirmedAt,
      updatedAt: plan.observedAt,
      acquisitionLeaseExpiresAt: batch.acquisitionLeaseExpiresAt,
      attempts: [],
    });
    if (currentPlan.planHash !== plan.planHash) {
      throw new Error(`ATS conversion source bytes changed for batch ${claim.batchId}.`);
    }
    const [observationCount, itemCount, resolutionCount, terminalItemCount] = await Promise.all([
      transaction.atsListingObservation.count({ where: { batchId: claim.batchId, generation } }),
      transaction.atsIngestionItem.count({ where: { batchId: claim.batchId, ledgerGeneration: generation } }),
      transaction.atsListingObservationResolution.count({
        where: { batchId: claim.batchId, ledgerGeneration: generation },
      }),
      transaction.atsIngestionItem.count({
        where: { batchId: claim.batchId, ledgerGeneration: generation, enrichmentStatus: 'terminal' },
      }),
    ]);
    if (observationCount !== plan.rawObservationCount
      || itemCount !== plan.canonicalOccurrenceCount
      || resolutionCount !== (plan.compactionMarker ? plan.rawObservationCount : 0)
      || terminalItemCount !== plan.terminalItemCount) {
      throw new Error(`ATS conversion activation counts changed for batch ${claim.batchId}.`);
    }

    await transaction.atsAcquisitionWorkReceipt.createMany({
      skipDuplicates: true,
      data: [{
        id: workReceiptId,
        batchId: claim.batchId,
        endpointSweepId: sweepId,
        workType: 'legacy_conversion',
        startGeneration: 0,
        endGeneration: generation,
        startListingOffset: 0,
        endListingOffset: plan.cursor.offset,
        startItemOrdinal: 0,
        endItemOrdinal: plan.terminalItemCount,
        itemsInspected: plan.rawObservationCount,
        itemsTerminalized: plan.terminalItemCount,
        itemsProgressed: plan.rawObservationCount,
        startedAt: plan.observedAt,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
        yieldReason: 'legacy_conversion_activated',
        checkpointHash: plan.planHash,
        transactionPhase: 'legacy_conversion_activation',
      }],
    });
    await transaction.atsCompany.update({
      where: { slug_platform: { slug: plan.slug, platform: plan.platform } },
      data: { acquisitionEngine: 'v2' },
    });
    const manifestHash = plan.compactionMarker
      ? atsLedgerHash({
          generation,
          raw: plan.rawObservationCount,
          canonical: plan.canonicalOccurrenceCount,
          compacted: plan.compactedOccurrenceCount,
        })
      : null;
    const activated = await transaction.atsIngestionBatch.updateMany({
      where: {
        id: claim.batchId,
        writerMode: 'converting',
        conversionGeneration: generation,
        acquisitionClaimToken: claim.claimToken,
        acquisitionClaimFence: claim.claimFence,
      },
      data: {
        writerMode: 'v2',
        ledgerVersion: ATS_LEDGER_VERSION,
        activeLedgerGeneration: generation,
        listingGeneration: generation,
        listingOffset: plan.cursor.offset,
        latestObservedTotal: plan.cursor.total,
        listingCompletedAt: plan.cursor.listingComplete ? plan.observedAt : null,
        rawObservationCount: plan.rawObservationCount,
        canonicalOccurrenceCount: plan.canonicalOccurrenceCount,
        compactedOccurrenceCount: plan.compactedOccurrenceCount,
        terminalItemCount: plan.terminalItemCount,
        sealedItemCount: 0,
        publishedItemCount: 0,
        acquisitionBytes: plan.rawBodyBytes,
        manifestHash,
        acquisitionPhase: plan.acquisitionPhase,
        status: 'partial',
        segmentSize: 25,
        nextAcquireAt: new Date(),
        lastServedAt: null,
        acquisitionClaimToken: null,
        acquisitionClaimOwner: null,
        acquisitionHeartbeatAt: new Date(),
        acquisitionLeaseExpiresAt: null,
        lastError: null,
      },
    });
    if (activated.count !== 1) {
      throw new Error(`ATS conversion activation CAS failed for batch ${claim.batchId}.`);
    }
  }, CONVERSION_TRANSACTION_OPTIONS);
}

export async function convertLegacyAtsBatchToV2(
  batchId: string,
  owner = `legacy-converter:${os.hostname()}:${process.pid}`,
): Promise<LegacyAtsConversionResult> {
  const before = await loadLegacyBatch(batchId);
  if (!before) {
    return {
      batchId,
      slug: '',
      platform: '',
      status: 'missing',
      writerMode: 'missing',
      jobCount: 0,
      listingComplete: false,
      listingOffset: 0,
      enrichmentOffset: 0,
      acquisitionPhase: 'invalid',
      convertible: false,
      reason: 'ATS batch does not exist.',
      outcome: 'invalid',
    };
  }
  if (before.writerMode === 'v2') {
    return { ...candidateFromPlan(before, null, null), outcome: 'already_v2' };
  }
  let planned: LegacyAtsConversionPlan;
  try {
    planned = planLegacyAtsBatchConversion(before);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...candidateFromPlan(before, null, reason), outcome: 'invalid' };
  }
  const candidate = candidateFromPlan(before, planned, null);
  const claim = await claimLegacyBatchForConversion(before, owner);
  if (!claim) return { ...candidate, outcome: 'busy', reason: 'Conversion claim was not available.' };
  try {
    const claimedBatch = await loadLegacyBatch(batchId);
    if (!claimedBatch) throw new Error(`ATS batch ${batchId} disappeared after conversion claim.`);
    const claimedPlan = planLegacyAtsBatchConversion(claimedBatch);
    if (claimedPlan.planHash !== planned.planHash) {
      throw new Error('Legacy ATS source changed between conversion planning and fenced claim.');
    }
    await stageLegacyConversion(claim, claimedPlan);
    await verifyStagedLegacyConversion(claim, claimedPlan);
    await activateStagedLegacyConversion(claim, claimedPlan);
    return {
      ...candidateFromPlan(claimedBatch, claimedPlan, null),
      writerMode: 'v2',
      outcome: 'converted',
      conversionGeneration: claim.conversionGeneration,
      planHash: claimedPlan.planHash,
    };
  } catch (error) {
    await releaseConversionClaim(claim).catch(() => undefined);
    return {
      ...candidate,
      outcome: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      conversionGeneration: claim.conversionGeneration,
      planHash: planned.planHash,
    };
  }
}

export async function assertLegacyAtsConversionAuthority(): Promise<void> {
  const gate = await prisma.atsAcquisitionRuntimeGate.findUnique({
    where: { id: 'global' },
    select: {
      minimumWriterVersion: true,
      compatibilityWriterVersion: true,
      v2AuthorityActivatedAt: true,
      activatedLedgerVersion: true,
    },
  });
  if (!gate
    || !gate.v2AuthorityActivatedAt
    || (gate.activatedLedgerVersion || 0) < ATS_LEDGER_VERSION
    || gate.minimumWriterVersion < ATS_ACQUISITION_WRITER_VERSION
    || gate.compatibilityWriterVersion < ATS_ACQUISITION_WRITER_VERSION) {
    throw new Error('Legacy ATS conversion requires the active writer-3/ledger-2 authority gate.');
  }
}
