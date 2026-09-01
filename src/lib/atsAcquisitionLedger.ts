import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';

import { Prisma } from '@prisma/client';

import {
  ATS_JOB_ENRICHMENT_KEY,
  ATS_JOB_ENRICHMENT_VERSION,
  enrichAtsListingJob,
  markAtsListingsWithoutDetail,
  readAtsJobEnrichmentMarker,
} from './atsJobEnrichment';
import { boardSlugFromJobUrl } from './atsBoardYield';
import {
  atsListingSourceId,
  planAtsPrequeueCompaction,
  type AtsObservedSourceState,
} from './atsPrequeueCompaction';
import { withProviderTransactionRetry } from './ingestionControl';
import type { IngestionCounters } from './ingestionControl';
import { ATS_ACQUISITION_WRITER_VERSION } from './atsAcquisitionCompatibility';
import { prisma } from './prisma';
import { nextAtsBoardCheckDateForDay } from './atsRotation';

type JsonObject = Record<string, unknown>;
type AtsLedgerTransaction = Prisma.TransactionClient;

export const ATS_LEDGER_VERSION = 2;
export const ATS_LEDGER_OBSERVATION_CHUNK_SIZE = boundedEnvironmentInteger(
  process.env.ATS_LEDGER_OBSERVATION_CHUNK_SIZE,
  250,
  25,
  1_000,
);
export const ATS_LEDGER_MARKER_CHUNK_SIZE = boundedEnvironmentInteger(
  process.env.ATS_LEDGER_MARKER_CHUNK_SIZE,
  250,
  25,
  1_000,
);
export const ATS_LEDGER_LISTING_PAGE_BUDGET = boundedEnvironmentInteger(
  process.env.ATS_LEDGER_LISTING_PAGE_BUDGET,
  5,
  1,
  20,
);
export const ATS_LEDGER_DETAIL_REQUEST_BUDGET = boundedEnvironmentInteger(
  process.env.ATS_LEDGER_DETAIL_REQUEST_BUDGET,
  5,
  1,
  20,
);
export const ATS_LEDGER_QUANTUM_SOFT_MS = boundedEnvironmentInteger(
  process.env.ATS_LEDGER_QUANTUM_SOFT_MS,
  45_000,
  10_000,
  120_000,
);
export const ATS_LEDGER_WORK_LEASE_MS = boundedEnvironmentInteger(
  process.env.ATS_LEDGER_WORK_LEASE_MS,
  180_000,
  60_000,
  600_000,
);
export const ATS_LEDGER_SEGMENT_LEASE_MS = boundedEnvironmentInteger(
  process.env.ATS_LEDGER_SEGMENT_LEASE_MS,
  1_800_000,
  60_000,
  6 * 60 * 60_000,
);
export const ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK = boundedEnvironmentInteger(
  process.env.ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK,
  100_000,
  1_000,
  10_000_000,
);
export const ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK = BigInt(boundedEnvironmentInteger(
  process.env.ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK,
  1_500_000_000,
  10_000_000,
  20_000_000_000,
));

const LEDGER_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;

/**
 * Run one ledger transaction, retrying a serialization failure.
 *
 * Every ledger write is Serializable, where PostgreSQL aborts with 40001
 * whenever concurrent work forms a read-write dependency cycle. Under
 * concurrency that is expected rather than a fault, and the documented remedy
 * is simply to run the transaction again. Without a retry a conflict failed the
 * whole quantum and deferred the batch a full minute over something a few
 * milliseconds of backoff resolves -- and the conflict rate rises with every
 * acquisition lane added.
 *
 * A replay is safe here: each closure re-reads the rows it depends on, so it
 * restarts from the committed world rather than from stale reads. Provider
 * requests deliberately sit outside these transactions, so retrying never
 * re-issues a fetch or spends detail budget twice.
 */
function runLedgerTransaction<T>(
  run: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withProviderTransactionRetry(() => prisma.$transaction(run, LEDGER_TRANSACTION_OPTIONS));
}

const SEGMENT_RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000] as const;
const OBSERVED_SOURCE_LOOKUP_CHUNK_SIZE = 500;

async function authorizeAtsV2LifecycleWrite(transaction: AtsLedgerTransaction): Promise<void> {
  await transaction.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true)`;
}

function boundedEnvironmentInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value || '', 10);
  const candidate = Number.isSafeInteger(parsed) ? parsed : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

function isPrismaError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && String(error.code) === code);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

export function atsLedgerHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

function jsonObject(value: Prisma.JsonValue | null | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function chicagoLocalDay(value: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((entry) => entry.type === type)?.value || ''
  );
  return new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00.000Z`);
}

export class AtsLedgerAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtsLedgerAuthorityError';
  }
}

export class AtsLedgerDivergentPageError extends Error {
  constructor(
    public readonly batchId: string,
    public readonly generation: number,
    public readonly requestedOffset: number,
  ) {
    super(`ATS ledger page ${batchId}/${generation}/${requestedOffset} changed after it was committed.`);
    this.name = 'AtsLedgerDivergentPageError';
  }
}

export type AtsLedgerClaim = {
  batchId: string;
  slug: string;
  platform: string;
  workType: string;
  claimToken: string;
  claimFence: bigint;
  workReceiptId: string;
  endpointSweepId: string | null;
  listingGeneration: number;
  listingOffset: number;
  latestObservedTotal: number | null;
  acquisitionPhase: string;
  segmentSize: number;
};

export type AtsLedgerPageInput = {
  claim: AtsLedgerClaim;
  requestedOffset: number;
  requestedLimit: number;
  providerOffset?: number | null;
  providerTotal?: number | null;
  jobs: JsonObject[];
  metadata?: JsonObject;
  requestedAt: Date;
  respondedAt: Date;
  httpStatus: number;
  listingComplete: boolean;
};

export type AtsLedgerPageCommit = {
  pageId: string;
  adopted: boolean;
  responseHash: string;
  observationCount: number;
  nextOffset: number;
};

export type PrefetchedAtsSegment = {
  handoffKind: 'ledger_segment';
  id: string;
  sourceBatchId: string;
  slug: string;
  platform: string;
  jobs: JsonObject[];
  metadata: JsonObject;
  processingOffset: number;
  totalJobCount: number;
  synchronizedAt: Date | null;
  leaseToken: string;
  ledgerGeneration: number;
  segmentOrdinal: number;
  canonicalOrdinals: number[];
  manifestHash: string;
  verifiedPayloadJobCount: number;
  verifiedPayloadHash: string;
};

function assertClaimMatchesBatch(
  batch: {
    id: string;
    writerMode: string;
    ledgerVersion: number;
    activeLedgerGeneration: number;
    acquisitionClaimToken: string | null;
    acquisitionClaimFence: bigint;
    acquisitionLeaseExpiresAt: Date | null;
  },
  claim: AtsLedgerClaim,
  now: Date,
): void {
  if (batch.writerMode !== 'v2'
    || batch.ledgerVersion < ATS_LEDGER_VERSION
    || batch.activeLedgerGeneration !== claim.listingGeneration
    || batch.acquisitionClaimToken !== claim.claimToken
    || batch.acquisitionClaimFence !== claim.claimFence
    || !batch.acquisitionLeaseExpiresAt
    || batch.acquisitionLeaseExpiresAt <= now) {
    throw new AtsLedgerAuthorityError(`ATS v2 claim no longer owns batch ${batch.id}.`);
  }
}

async function observedAtsSourceStates(
  transaction: Pick<AtsLedgerTransaction, '$queryRaw'>,
  platform: string,
  jobs: JsonObject[],
): Promise<AtsObservedSourceState[]> {
  const sourceIds = Array.from(new Set(
    jobs.map((job) => atsListingSourceId(platform, job)).filter((value): value is string => Boolean(value)),
  )).sort();
  const observations: AtsObservedSourceState[] = [];
  for (let offset = 0; offset < sourceIds.length; offset += OBSERVED_SOURCE_LOOKUP_CHUNK_SIZE) {
    const chunk = sourceIds.slice(offset, offset + OBSERVED_SOURCE_LOOKUP_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const rows = await transaction.$queryRaw<Array<{
      sourceId: string;
      jobId: string;
      jobStatus: string | null;
      jobUpdatedAt: Date | string;
      observationUrl: string | null;
    }>>(Prisma.sql`
      SELECT
        observation."sourceId" AS "sourceId",
        observation."jobId" AS "jobId",
        job."status" AS "jobStatus",
        job."updatedAt" AS "jobUpdatedAt",
        observation."url" AS "observationUrl"
      FROM "JobSourceObservation" observation
      INNER JOIN "Job" job ON job."id" = observation."jobId"
      WHERE observation."source" = ${`ATS-${platform}`}
        AND observation."sourceId" IN (${Prisma.join(chunk)})
      ORDER BY observation."sourceId" ASC, observation."jobId" ASC
      FOR SHARE OF job
    `);
    observations.push(...rows.map((row) => ({
      sourceId: row.sourceId,
      jobId: row.jobId,
      jobStatus: row.jobStatus,
      jobUpdatedAt: new Date(row.jobUpdatedAt).toISOString(),
      boardSlug: boardSlugFromJobUrl(row.observationUrl, platform),
    })));
  }
  return observations;
}

export async function admitAtsV2Board(input: {
  slug: string;
  platform: string;
  now?: Date;
  owner?: string;
  segmentSize?: number;
}): Promise<AtsLedgerClaim | null> {
  const now = input.now || new Date();
  const owner = input.owner || `${os.hostname()}:${process.pid}`;
  const claimToken = randomUUID();
  const batchId = randomUUID();
  const sweepId = randomUUID();
  const workReceiptId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + ATS_LEDGER_WORK_LEASE_MS);
  const segmentSize = Math.max(1, Math.min(1_999, Math.floor(input.segmentSize || 25)));

  try {
    return await runLedgerTransaction(async (transaction) => {
      const board = await transaction.atsCompany.findUnique({
        where: { slug_platform: { slug: input.slug, platform: input.platform } },
        select: { acquisitionEngine: true, nextCheckDate: true, status: true },
      });
      if (!board || board.acquisitionEngine !== 'v2' || board.nextCheckDate > now) return null;
      const gate = await transaction.atsAcquisitionRuntimeGate.findUnique({
        where: { id: 'global' },
        select: {
          admissionState: true,
          minimumWriterVersion: true,
          compatibilityWriterVersion: true,
          v2AuthorityActivatedAt: true,
          activatedLedgerVersion: true,
        },
      });
      if (!gate) {
        throw new AtsLedgerAuthorityError('ATS v2 board admission requires the durable writer-3 authority gate.');
      }
      if (gate.admissionState !== 'open') return null;
      if (!gate.v2AuthorityActivatedAt
        || (gate.activatedLedgerVersion || 0) < ATS_LEDGER_VERSION
        || gate.minimumWriterVersion < ATS_ACQUISITION_WRITER_VERSION
        || gate.compatibilityWriterVersion < ATS_ACQUISITION_WRITER_VERSION) {
        throw new AtsLedgerAuthorityError('ATS v2 board admission requires the durable writer-3 authority gate.');
      }
      const active = await transaction.atsIngestionBatch.findFirst({
        where: {
          slug: input.slug,
          platform: input.platform,
          status: { in: ['fetching', 'partial', 'synchronized'] },
        },
        select: { id: true },
      });
      if (active) return null;

      await transaction.atsIngestionBatch.create({
        data: {
          id: batchId,
          slug: input.slug,
          platform: input.platform,
          writerMode: 'v2',
          ledgerVersion: ATS_LEDGER_VERSION,
          activeLedgerGeneration: 1,
          conversionGeneration: 1,
          acquisitionPhase: 'listing',
          status: 'fetching',
          listingGeneration: 1,
          listingOffset: 0,
          segmentSize,
          acquisitionClaimToken: claimToken,
          acquisitionClaimOwner: owner,
          acquisitionClaimFence: BigInt(1),
          acquisitionHeartbeatAt: now,
          acquisitionLeaseExpiresAt: leaseExpiresAt,
          lastServedAt: now,
        },
      });
      await transaction.atsEndpointSweepReceipt.create({
        data: {
          id: sweepId,
          batchId,
          slug: input.slug,
          platform: input.platform,
          admissionLocalDay: chicagoLocalDay(now),
          state: 'admitted',
          admittedAt: now,
        },
      });
      await transaction.atsAcquisitionWorkReceipt.create({
        data: {
          id: workReceiptId,
          batchId,
          endpointSweepId: sweepId,
          workType: 'coverage_listing',
          startGeneration: 1,
          startListingOffset: 0,
          startedAt: now,
          heartbeatAt: now,
          leaseOwner: owner,
          leaseToken: claimToken,
          leaseFence: BigInt(1),
          leaseExpiresAt,
        },
      });
      return {
        batchId,
        slug: input.slug,
        platform: input.platform,
        workType: 'coverage_listing',
        claimToken,
        claimFence: BigInt(1),
        workReceiptId,
        endpointSweepId: sweepId,
        listingGeneration: 1,
        listingOffset: 0,
        latestObservedTotal: null,
        acquisitionPhase: 'listing',
        segmentSize,
      };
    });
  } catch (error) {
    if (isPrismaError(error, 'P2002')) return null;
    throw error;
  }
}

function workTypeForPhase(phase: string, listingOffset: number): string {
  if (phase === 'listing') return listingOffset === 0 ? 'coverage_listing' : 'listing_continuation';
  if (phase === 'compaction') return 'compaction';
  if (phase === 'enrichment') return 'enrichment';
  if (phase === 'sealing') return 'seal';
  if (phase === 'publishing' || phase === 'synchronized') return 'publish';
  return phase;
}

/**
 * Phases that move already-acquired items toward Job rows. Listing is the only
 * continuation phase that *adds* staging pressure, so it is served last.
 *
 * Strict `lastServedAt` ordering across every phase let a large pool of listing
 * batches consume the lane while compaction and sealing received no service
 * at all, and staging kept climbing against its own admission watermark. Drain
 * work is offered first so the lane empties before it ingests.
 */
export const ATS_V2_DRAIN_PHASES = [
  'compaction',
  'enrichment',
  'sealing',
] as const;

const ATS_V2_ACQUISITION_PHASES = [
  'listing',
  ...ATS_V2_DRAIN_PHASES,
] as const;

export async function claimNextAtsV2Continuation(input: {
  now?: Date;
  owner?: string;
} = {}): Promise<AtsLedgerClaim | null> {
  const now = input.now || new Date();
  const owner = input.owner || `${os.hostname()}:${process.pid}`;
  const eligible: Prisma.AtsIngestionBatchWhereInput = {
    writerMode: 'v2',
    status: { in: ['fetching', 'partial', 'synchronized'] },
    acquisitionPhase: { in: [...ATS_V2_ACQUISITION_PHASES] },
    OR: [{ nextAcquireAt: null }, { nextAcquireAt: { lte: now } }],
    AND: [{
      OR: [
        { acquisitionClaimToken: null },
        { acquisitionLeaseExpiresAt: { lte: now } },
      ],
    }],
  };
  const orderBy: Prisma.AtsIngestionBatchOrderByWithRelationInput[] = [
    { lastServedAt: { sort: 'asc', nulls: 'first' } },
    { nextAcquireAt: { sort: 'asc', nulls: 'first' } },
    { createdAt: 'asc' },
  ];
  const candidate = await prisma.atsIngestionBatch.findFirst({
    where: {
      ...eligible,
      acquisitionPhase: { in: [...ATS_V2_DRAIN_PHASES] },
    },
    orderBy,
    select: { id: true },
  }) || await prisma.atsIngestionBatch.findFirst({
    where: eligible,
    orderBy,
    select: { id: true },
  });
  if (!candidate) return null;

  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + ATS_LEDGER_WORK_LEASE_MS);
  const claimed = await prisma.atsIngestionBatch.updateMany({
    where: {
      id: candidate.id,
      writerMode: 'v2',
      OR: [{ nextAcquireAt: null }, { nextAcquireAt: { lte: now } }],
      AND: [{
        OR: [
          { acquisitionClaimToken: null },
          { acquisitionLeaseExpiresAt: { lte: now } },
        ],
      }],
    },
    data: {
      acquisitionClaimToken: claimToken,
      acquisitionClaimOwner: owner,
      acquisitionClaimFence: { increment: BigInt(1) },
      acquisitionHeartbeatAt: now,
      acquisitionLeaseExpiresAt: leaseExpiresAt,
      lastServedAt: now,
      nextAcquireAt: null,
    },
  });
  if (claimed.count !== 1) return null;

  const batch = await prisma.atsIngestionBatch.findUniqueOrThrow({
    where: { id: candidate.id },
    select: {
      id: true,
      slug: true,
      platform: true,
      acquisitionPhase: true,
      listingGeneration: true,
      listingOffset: true,
      latestObservedTotal: true,
      acquisitionClaimFence: true,
      segmentSize: true,
      endpointSweep: { select: { id: true } },
    },
  });
  const workReceiptId = randomUUID();
  const workType = workTypeForPhase(batch.acquisitionPhase, batch.listingOffset);
  await prisma.atsAcquisitionWorkReceipt.create({
    data: {
      id: workReceiptId,
      batchId: batch.id,
      endpointSweepId: batch.endpointSweep?.id || null,
      workType,
      startGeneration: batch.listingGeneration,
      startListingOffset: batch.listingOffset,
      startedAt: now,
      heartbeatAt: now,
      leaseOwner: owner,
      leaseToken: claimToken,
      leaseFence: batch.acquisitionClaimFence,
      leaseExpiresAt,
    },
  });
  return {
    batchId: batch.id,
    slug: batch.slug,
    platform: batch.platform,
    workType,
    claimToken,
    claimFence: batch.acquisitionClaimFence,
    workReceiptId,
    endpointSweepId: batch.endpointSweep?.id || null,
    listingGeneration: batch.listingGeneration,
    listingOffset: batch.listingOffset,
    latestObservedTotal: batch.latestObservedTotal,
    acquisitionPhase: batch.acquisitionPhase,
    segmentSize: batch.segmentSize,
  };
}

export async function heartbeatAtsV2Claim(claim: AtsLedgerClaim, now = new Date()): Promise<boolean> {
  const leaseExpiresAt = new Date(now.getTime() + ATS_LEDGER_WORK_LEASE_MS);
  return runLedgerTransaction(async (transaction) => {
    const batch = await transaction.atsIngestionBatch.updateMany({
      where: {
        id: claim.batchId,
        writerMode: 'v2',
        acquisitionClaimToken: claim.claimToken,
        acquisitionClaimFence: claim.claimFence,
      },
      data: { acquisitionHeartbeatAt: now, acquisitionLeaseExpiresAt: leaseExpiresAt },
    });
    const receipt = await transaction.atsAcquisitionWorkReceipt.updateMany({
      where: {
        id: claim.workReceiptId,
        leaseToken: claim.claimToken,
        leaseFence: claim.claimFence,
        finishedAt: null,
      },
      data: { heartbeatAt: now, leaseExpiresAt },
    });
    return batch.count === 1 && receipt.count === 1;
  });
}

export async function recordAtsV2ListingDispatchIntent(
  claim: AtsLedgerClaim,
  now = new Date(),
): Promise<void> {
  await runLedgerTransaction(async (transaction) => {
    const batch = await transaction.atsIngestionBatch.findUniqueOrThrow({
      where: { id: claim.batchId },
      select: {
        id: true,
        writerMode: true,
        ledgerVersion: true,
        activeLedgerGeneration: true,
        acquisitionClaimToken: true,
        acquisitionClaimFence: true,
        acquisitionLeaseExpiresAt: true,
      },
    });
    assertClaimMatchesBatch(batch, claim, now);
    if (claim.endpointSweepId) {
      await transaction.atsEndpointSweepReceipt.updateMany({
        where: { id: claim.endpointSweepId, batchId: claim.batchId },
        data: { state: 'dispatching', dispatchIntentAt: now },
      });
    }
    await transaction.atsCompany.update({
      where: { slug_platform: { slug: claim.slug, platform: claim.platform } },
      data: { lastAttemptedAt: now },
    });
    await transaction.atsAcquisitionWorkReceipt.update({
      where: { id: claim.workReceiptId },
      data: { listingRequestCount: { increment: 1 }, heartbeatAt: now },
    });
  });
}

export async function confirmAtsV2ListingContact(input: {
  claim: AtsLedgerClaim;
  contactedAt?: Date;
  responded?: boolean;
  contactKind?: 'new_cycle_listing' | 'listing_continuation';
}): Promise<void> {
  const contactedAt = input.contactedAt || new Date();
  const contactKind = input.contactKind || (
    input.claim.workType === 'coverage_listing' ? 'new_cycle_listing' : 'listing_continuation'
  );
  await runLedgerTransaction(async (transaction) => {
    const batch = await transaction.atsIngestionBatch.findUniqueOrThrow({
      where: { id: input.claim.batchId },
      select: {
        id: true,
        writerMode: true,
        ledgerVersion: true,
        activeLedgerGeneration: true,
        acquisitionClaimToken: true,
        acquisitionClaimFence: true,
        acquisitionLeaseExpiresAt: true,
      },
    });
    assertClaimMatchesBatch(batch, input.claim, contactedAt);
    if (input.claim.endpointSweepId) {
      await transaction.atsEndpointSweepReceipt.updateMany({
        where: { id: input.claim.endpointSweepId, batchId: input.claim.batchId },
        data: {
          state: input.responded ? 'responded' : 'contact_confirmed',
          contactConfirmedAt: contactedAt,
          ...(input.responded ? { respondedAt: contactedAt } : {}),
        },
      });
    }
    await transaction.atsEndpointDailyContactReceipt.upsert({
      where: {
        localDay_slug_platform_contactKind: {
          localDay: chicagoLocalDay(contactedAt),
          slug: input.claim.slug,
          platform: input.claim.platform,
          contactKind,
        },
      },
      create: {
        localDay: chicagoLocalDay(contactedAt),
        slug: input.claim.slug,
        platform: input.claim.platform,
        contactKind,
        contactConfirmedAt: contactedAt,
        sweepId: input.claim.endpointSweepId,
        workReceiptId: input.claim.workReceiptId,
      },
      update: {},
    });
    if (input.responded) {
      await transaction.atsCompany.update({
        where: { slug_platform: { slug: input.claim.slug, platform: input.claim.platform } },
        data: { lastRespondedAt: contactedAt },
      });
    }
  });
}

function pageHashes(input: AtsLedgerPageInput): {
  responseHash: string;
  identityMultisetHash: string;
  rawBodyHash: string;
  rawBodyBytes: bigint;
  rawBody: JsonObject;
} {
  const rawBody = {
    metadata: input.metadata || {},
    jobs: input.jobs,
    total: input.providerTotal ?? null,
  };
  const serialized = JSON.stringify(canonicalJson(rawBody));
  const occurrenceIdentities = input.jobs.map((job) => {
    const rawHash = atsLedgerHash(job);
    return [atsListingSourceId(input.claim.platform, job), rawHash];
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    responseHash: createHash('sha256').update(serialized).digest('hex'),
    identityMultisetHash: atsLedgerHash(occurrenceIdentities),
    rawBodyHash: createHash('sha256').update(serialized).digest('hex'),
    rawBodyBytes: BigInt(Buffer.byteLength(serialized, 'utf8')),
    rawBody,
  };
}

export async function commitAtsV2ListingPage(input: AtsLedgerPageInput): Promise<AtsLedgerPageCommit> {
  const hashes = pageHashes(input);
  const nextOffset = input.requestedOffset + input.jobs.length;
  const now = new Date();
  const inlineObservations = input.jobs.length <= ATS_LEDGER_OBSERVATION_CHUNK_SIZE;

  return runLedgerTransaction(async (transaction) => {
    const batch = await transaction.atsIngestionBatch.findUniqueOrThrow({
      where: { id: input.claim.batchId },
      select: {
        id: true,
        writerMode: true,
        ledgerVersion: true,
        activeLedgerGeneration: true,
        acquisitionClaimToken: true,
        acquisitionClaimFence: true,
        acquisitionLeaseExpiresAt: true,
        acquisitionPhase: true,
        listingOffset: true,
      },
    });
    assertClaimMatchesBatch(batch, input.claim, now);
    if (batch.acquisitionPhase !== 'listing') {
      throw new AtsLedgerAuthorityError(`ATS batch ${batch.id} is no longer in listing phase.`);
    }
    const existing = await transaction.atsIngestionPage.findUnique({
      where: {
        batchId_generation_requestedOffset: {
          batchId: input.claim.batchId,
          generation: input.claim.listingGeneration,
          requestedOffset: input.requestedOffset,
        },
      },
    });
    if (existing) {
      if (existing.responseHash !== hashes.responseHash
        || existing.identityMultisetHash !== hashes.identityMultisetHash) {
        throw new AtsLedgerDivergentPageError(
          input.claim.batchId,
          input.claim.listingGeneration,
          input.requestedOffset,
        );
      }
      await transaction.atsAcquisitionWorkReceipt.update({
        where: { id: input.claim.workReceiptId },
        data: { adoptedCheckpoint: true, heartbeatAt: now },
      });
      return {
        pageId: existing.id,
        adopted: true,
        responseHash: hashes.responseHash,
        observationCount: existing.materializationOffset,
        nextOffset,
      };
    }
    if (batch.listingOffset !== input.requestedOffset) {
      throw new AtsLedgerAuthorityError(
        `ATS batch ${batch.id} expected listing offset ${batch.listingOffset}, not ${input.requestedOffset}.`,
      );
    }

    const pageId = randomUUID();
    await transaction.atsIngestionPage.create({
      data: {
        id: pageId,
        batchId: input.claim.batchId,
        generation: input.claim.listingGeneration,
        requestedOffset: input.requestedOffset,
        requestedLimit: input.requestedLimit,
        providerOffset: input.providerOffset ?? null,
        providerTotal: input.providerTotal ?? null,
        responseItemCount: input.jobs.length,
        responseHash: hashes.responseHash,
        identityMultisetHash: hashes.identityMultisetHash,
        metadata: inputJson(input.metadata || {}),
        rawBody: inlineObservations ? Prisma.DbNull : inputJson(hashes.rawBody),
        rawBodyHash: hashes.rawBodyHash,
        rawBodyBytes: hashes.rawBodyBytes,
        materializationOffset: inlineObservations ? input.jobs.length : 0,
        requestedAt: input.requestedAt,
        respondedAt: input.respondedAt,
        httpStatus: input.httpStatus,
        materializationCompleteAt: inlineObservations ? now : null,
      },
    });
    if (inlineObservations && input.jobs.length > 0) {
      await transaction.atsListingObservation.createMany({
        data: input.jobs.map((job, pageOrdinal) => ({
          id: randomUUID(),
          batchId: input.claim.batchId,
          pageId,
          generation: input.claim.listingGeneration,
          pageOrdinal,
          providerSourceId: atsListingSourceId(input.claim.platform, job),
          rawHash: atsLedgerHash(job),
          rawJson: inputJson(job),
          observedAt: input.respondedAt,
        })),
      });
    }
    const updated = await transaction.atsIngestionBatch.updateMany({
      where: {
        id: input.claim.batchId,
        writerMode: 'v2',
        acquisitionClaimToken: input.claim.claimToken,
        acquisitionClaimFence: input.claim.claimFence,
        listingGeneration: input.claim.listingGeneration,
        listingOffset: input.requestedOffset,
      },
      data: {
        listingOffset: nextOffset,
        latestObservedTotal: input.providerTotal ?? undefined,
        rawObservationCount: { increment: inlineObservations ? input.jobs.length : 0 },
        acquisitionBytes: { increment: hashes.rawBodyBytes },
        acquisitionPhase: input.listingComplete && inlineObservations ? 'compaction' : 'listing',
        listingCompletedAt: input.listingComplete && inlineObservations ? now : null,
        acquisitionHeartbeatAt: now,
        lastServedAt: now,
      },
    });
    if (updated.count !== 1) throw new AtsLedgerAuthorityError(`ATS batch ${batch.id} lost its page fence.`);
    await transaction.atsAcquisitionWorkReceipt.update({
      where: { id: input.claim.workReceiptId },
      data: {
        endGeneration: input.claim.listingGeneration,
        endListingOffset: nextOffset,
        itemsInspected: { increment: input.jobs.length },
        itemsProgressed: { increment: input.jobs.length },
        checkpointHash: hashes.responseHash,
        transactionPhase: 'page_checkpoint',
        heartbeatAt: now,
      },
    });
    return {
      pageId,
      adopted: false,
      responseHash: hashes.responseHash,
      observationCount: inlineObservations ? input.jobs.length : 0,
      nextOffset,
    };
  });
}

export async function materializeAtsV2PageObservations(input: {
  claim: AtsLedgerClaim;
  pageId: string;
  listingComplete: boolean;
  chunkSize?: number;
}): Promise<{ materialized: number; complete: boolean }> {
  const chunkSize = Math.max(1, Math.min(
    ATS_LEDGER_OBSERVATION_CHUNK_SIZE,
    Math.floor(input.chunkSize || ATS_LEDGER_OBSERVATION_CHUNK_SIZE),
  ));
  return runLedgerTransaction(async (transaction) => {
    const now = new Date();
    const batch = await transaction.atsIngestionBatch.findUniqueOrThrow({
      where: { id: input.claim.batchId },
      select: {
        id: true,
        writerMode: true,
        ledgerVersion: true,
        activeLedgerGeneration: true,
        acquisitionClaimToken: true,
        acquisitionClaimFence: true,
        acquisitionLeaseExpiresAt: true,
      },
    });
    assertClaimMatchesBatch(batch, input.claim, now);
    const page = await transaction.atsIngestionPage.findFirstOrThrow({
      where: { id: input.pageId, batchId: input.claim.batchId },
    });
    if (page.materializationCompleteAt) return { materialized: 0, complete: true };
    const body = jsonObject(page.rawBody);
    const jobs = Array.isArray(body.jobs)
      ? body.jobs.filter((job): job is JsonObject => Boolean(job && typeof job === 'object' && !Array.isArray(job)))
      : [];
    if (jobs.length !== page.responseItemCount || atsLedgerHash(body) !== page.rawBodyHash) {
      throw new AtsLedgerAuthorityError(`ATS ledger raw page ${page.id} failed materialization integrity.`);
    }
    const start = page.materializationOffset;
    const chunk = jobs.slice(start, start + chunkSize);
    if (chunk.length > 0) {
      await transaction.atsListingObservation.createMany({
        data: chunk.map((job, index) => ({
          id: randomUUID(),
          batchId: input.claim.batchId,
          pageId: page.id,
          generation: page.generation,
          pageOrdinal: start + index,
          providerSourceId: atsListingSourceId(input.claim.platform, job),
          rawHash: atsLedgerHash(job),
          rawJson: inputJson(job),
          observedAt: page.respondedAt,
        })),
      });
    }
    const next = start + chunk.length;
    const complete = next === jobs.length;
    await transaction.atsIngestionPage.update({
      where: { id: page.id },
      data: {
        materializationOffset: next,
        materializationCompleteAt: complete ? now : null,
      },
    });
    await transaction.atsIngestionBatch.update({
      where: { id: input.claim.batchId },
      data: {
        rawObservationCount: { increment: chunk.length },
        acquisitionPhase: complete && input.listingComplete ? 'compaction' : 'listing',
        listingCompletedAt: complete && input.listingComplete ? now : undefined,
        acquisitionHeartbeatAt: now,
      },
    });
    return { materialized: chunk.length, complete };
  });
}

export async function resolveNextAtsV2ObservationChunk(input: {
  claim: AtsLedgerClaim;
  chunkSize?: number;
}): Promise<{ resolved: number; retained: number; compacted: number; complete: boolean }> {
  const chunkSize = Math.max(1, Math.min(
    ATS_LEDGER_OBSERVATION_CHUNK_SIZE,
    Math.floor(input.chunkSize || ATS_LEDGER_OBSERVATION_CHUNK_SIZE),
  ));
  return runLedgerTransaction(async (transaction) => {
    const now = new Date();
    const batch = await transaction.atsIngestionBatch.findUniqueOrThrow({
      where: { id: input.claim.batchId },
      select: {
        id: true,
        slug: true,
        platform: true,
        writerMode: true,
        ledgerVersion: true,
        activeLedgerGeneration: true,
        acquisitionClaimToken: true,
        acquisitionClaimFence: true,
        acquisitionLeaseExpiresAt: true,
        acquisitionPhase: true,
        rawObservationCount: true,
        canonicalOccurrenceCount: true,
        compactedOccurrenceCount: true,
      },
    });
    assertClaimMatchesBatch(batch, input.claim, now);
    if (batch.acquisitionPhase !== 'compaction') {
      return { resolved: 0, retained: 0, compacted: 0, complete: batch.acquisitionPhase !== 'listing' };
    }
    const observations = await transaction.atsListingObservation.findMany({
      where: {
        batchId: batch.id,
        generation: batch.activeLedgerGeneration,
        resolution: null,
      },
      orderBy: [{ page: { requestedOffset: 'asc' } }, { pageOrdinal: 'asc' }],
      take: chunkSize,
    });
    if (observations.length === 0) {
      const resolvedCount = batch.canonicalOccurrenceCount + batch.compactedOccurrenceCount;
      if (resolvedCount !== batch.rawObservationCount) {
        throw new AtsLedgerAuthorityError(`ATS batch ${batch.id} observation counts do not reconcile.`);
      }
      await transaction.atsIngestionBatch.update({
        where: { id: batch.id },
        data: {
          acquisitionPhase: 'enrichment',
          manifestHash: atsLedgerHash({
            generation: batch.activeLedgerGeneration,
            raw: batch.rawObservationCount,
            canonical: batch.canonicalOccurrenceCount,
            compacted: batch.compactedOccurrenceCount,
          }),
          acquisitionHeartbeatAt: now,
        },
      });
      return { resolved: 0, retained: 0, compacted: 0, complete: true };
    }
    const jobs = observations.map((observation) => jsonObject(observation.rawJson));
    if (jobs.some((job) => Object.keys(job).length === 0)) {
      throw new AtsLedgerAuthorityError(`ATS batch ${batch.id} has an observation without materialized JSON.`);
    }
    const sourceStates = await observedAtsSourceStates(transaction, batch.platform, jobs);
    const plan = planAtsPrequeueCompaction({
      platform: batch.platform,
      boardSlug: batch.slug,
      jobs,
      observations: sourceStates,
    });
    const compactedIndexes = new Set(plan.marker.compactedItems.map((item) => item.originalItemIndex));
    let retainedOrdinal = batch.canonicalOccurrenceCount;
    const items: Array<{
      id: string;
      batchId: string;
      ledgerGeneration: number;
      canonicalOrdinal: number;
      representativeObservationId: string;
      providerSourceId: string | null;
      rawHash: string;
      rawJson: Prisma.InputJsonValue;
    }> = [];
    const resolutions: Array<{
      id: string;
      batchId: string;
      observationId: string;
      itemId: string | null;
      ledgerGeneration: number;
      resolutionType: string;
      occurrenceKey: string | null;
      resolutionHash: string;
      detail: Prisma.InputJsonValue;
    }> = [];
    for (const [index, observation] of observations.entries()) {
      const compacted = compactedIndexes.has(index);
      const itemId = compacted ? null : randomUUID();
      if (itemId) {
        items.push({
          id: itemId,
          batchId: batch.id,
          ledgerGeneration: batch.activeLedgerGeneration,
          canonicalOrdinal: retainedOrdinal++,
          representativeObservationId: observation.id,
          providerSourceId: observation.providerSourceId,
          rawHash: observation.rawHash,
          rawJson: inputJson(jsonObject(observation.rawJson)),
        });
      }
      const detail = compacted
        ? plan.marker.compactedItems.find((entry) => entry.originalItemIndex === index) || {}
        : { canonicalOrdinal: retainedOrdinal - 1 };
      resolutions.push({
        id: randomUUID(),
        batchId: batch.id,
        observationId: observation.id,
        itemId,
        ledgerGeneration: batch.activeLedgerGeneration,
        resolutionType: compacted ? 'compacted_exact_terminal' : 'canonical_item',
        occurrenceKey: observation.providerSourceId || observation.rawHash,
        resolutionHash: atsLedgerHash({
          observationId: observation.id,
          rawHash: observation.rawHash,
          itemId,
          type: compacted ? 'compacted_exact_terminal' : 'canonical_item',
          detail,
        }),
        detail: inputJson(detail),
      });
    }
    if (items.length > 0) await transaction.atsIngestionItem.createMany({ data: items });
    await transaction.atsListingObservationResolution.createMany({ data: resolutions });
    const nextCanonical = batch.canonicalOccurrenceCount + items.length;
    const nextCompacted = batch.compactedOccurrenceCount + compactedIndexes.size;
    const complete = nextCanonical + nextCompacted === batch.rawObservationCount;
    await transaction.atsIngestionBatch.update({
      where: { id: batch.id },
      data: {
        canonicalOccurrenceCount: nextCanonical,
        compactedOccurrenceCount: nextCompacted,
        acquisitionPhase: complete ? 'enrichment' : 'compaction',
        manifestHash: complete ? atsLedgerHash({
          generation: batch.activeLedgerGeneration,
          raw: batch.rawObservationCount,
          canonical: nextCanonical,
          compacted: nextCompacted,
        }) : undefined,
        acquisitionHeartbeatAt: now,
      },
    });
    return {
      resolved: observations.length,
      retained: items.length,
      compacted: compactedIndexes.size,
      complete,
    };
  });
}

function enrichmentOverlay(job: JsonObject, platform: string): JsonObject {
  const marker = readAtsJobEnrichmentMarker(job);
  if (!marker || marker.platform !== platform) {
    throw new AtsLedgerAuthorityError(`ATS ${platform} enrichment produced no current marker.`);
  }
  return { [ATS_JOB_ENRICHMENT_KEY]: marker };
}

export async function terminalizeAtsV2NoNetworkItems(input: {
  claim: AtsLedgerClaim;
  chunkSize?: number;
}): Promise<{ inspected: number; terminalized: number }> {
  const take = Math.max(1, Math.min(
    ATS_LEDGER_MARKER_CHUNK_SIZE,
    Math.floor(input.chunkSize || ATS_LEDGER_MARKER_CHUNK_SIZE),
  ));
  return runLedgerTransaction(async (transaction) => {
    const now = new Date();
    const batch = await transaction.atsIngestionBatch.findUniqueOrThrow({
      where: { id: input.claim.batchId },
      select: {
        id: true,
        slug: true,
        platform: true,
        writerMode: true,
        ledgerVersion: true,
        activeLedgerGeneration: true,
        acquisitionClaimToken: true,
        acquisitionClaimFence: true,
        acquisitionLeaseExpiresAt: true,
        acquisitionPhase: true,
      },
    });
    assertClaimMatchesBatch(batch, input.claim, now);
    if (batch.acquisitionPhase !== 'enrichment') return { inspected: 0, terminalized: 0 };
    const items = await transaction.atsIngestionItem.findMany({
      where: {
        batchId: batch.id,
        ledgerGeneration: batch.activeLedgerGeneration,
        enrichmentStatus: 'pending',
        enrichmentReason: null,
        OR: [{ nextDetailAt: null }, { nextDetailAt: { lte: now } }],
        itemClaimToken: null,
      },
      orderBy: { canonicalOrdinal: 'asc' },
      take,
    });
    const rawJobs = items.map((item) => jsonObject(item.rawJson));
    const marked = markAtsListingsWithoutDetail({
      platform: batch.platform,
      slug: batch.slug,
      jobs: rawJobs,
    });
    let terminalized = 0;
    for (const [index, item] of items.entries()) {
      const marker = readAtsJobEnrichmentMarker(marked.jobs[index]);
      if (!marker || marker.attempted) {
        await transaction.atsIngestionItem.updateMany({
          where: { id: item.id, enrichmentStatus: 'pending', enrichmentReason: null },
          data: { enrichmentReason: 'network_required' },
        });
        continue;
      }
      const updated = await transaction.atsIngestionItem.updateMany({
        where: { id: item.id, enrichmentStatus: 'pending', itemClaimToken: null },
        data: {
          enrichmentOverlay: inputJson(enrichmentOverlay(marked.jobs[index], batch.platform)),
          enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
          enrichmentStatus: 'terminal',
          enrichmentReason: marker.reason || marker.status,
          terminalAt: now,
          nextDetailAt: null,
        },
      });
      terminalized += updated.count;
    }
    if (terminalized > 0) {
      await transaction.atsIngestionBatch.update({
        where: { id: batch.id },
        data: { terminalItemCount: { increment: terminalized }, acquisitionHeartbeatAt: now },
      });
    }
    await transaction.atsAcquisitionWorkReceipt.update({
      where: { id: input.claim.workReceiptId },
      data: {
        itemsInspected: { increment: items.length },
        itemsTerminalized: { increment: terminalized },
        itemsProgressed: { increment: terminalized },
        transactionPhase: 'item_checkpoint',
        heartbeatAt: now,
      },
    });
    return { inspected: items.length, terminalized };
  });
}

export async function enrichNextAtsV2DetailItem(input: {
  claim: AtsLedgerClaim;
  signal?: AbortSignal;
  requestTimeoutMs: number;
}): Promise<'none' | 'terminal' | 'deferred'> {
  const now = new Date();
  const item = await runLedgerTransaction(async (transaction) => {
    const batch = await transaction.atsIngestionBatch.findUniqueOrThrow({
      where: { id: input.claim.batchId },
      select: {
        id: true,
        writerMode: true,
        ledgerVersion: true,
        activeLedgerGeneration: true,
        acquisitionClaimToken: true,
        acquisitionClaimFence: true,
        acquisitionLeaseExpiresAt: true,
        acquisitionPhase: true,
      },
    });
    assertClaimMatchesBatch(batch, input.claim, now);
    if (batch.acquisitionPhase !== 'enrichment') return null;
    const candidate = await transaction.atsIngestionItem.findFirst({
      where: {
        batchId: input.claim.batchId,
        ledgerGeneration: batch.activeLedgerGeneration,
        enrichmentStatus: 'pending',
        enrichmentReason: 'network_required',
        OR: [{ nextDetailAt: null }, { nextDetailAt: { lte: now } }],
        itemClaimToken: null,
      },
      orderBy: { canonicalOrdinal: 'asc' },
    });
    if (!candidate) return null;
    const itemClaimToken = randomUUID();
    const claimed = await transaction.atsIngestionItem.updateMany({
      where: { id: candidate.id, enrichmentStatus: 'pending', itemClaimToken: null },
      data: {
        itemClaimToken,
        itemClaimOwner: input.claim.claimToken,
        itemClaimFence: { increment: BigInt(1) },
        itemHeartbeatAt: now,
        itemLeaseExpiresAt: new Date(now.getTime() + ATS_LEDGER_WORK_LEASE_MS),
        detailAttemptCount: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return null;
    return transaction.atsIngestionItem.findUniqueOrThrow({ where: { id: candidate.id } });
  });
  if (!item) return 'none';

  const rawJob = jsonObject(item.rawJson);
  try {
    const enriched = await enrichAtsListingJob({
      platform: input.claim.platform,
      slug: input.claim.slug,
      job: rawJob,
      signal: input.signal,
      requestTimeoutMs: input.requestTimeoutMs,
      onRequestStarted: async () => {
        await prisma.atsAcquisitionWorkReceipt.update({
          where: { id: input.claim.workReceiptId },
          data: { detailRequestCount: { increment: 1 }, heartbeatAt: new Date() },
        });
      },
    });
    const marker = readAtsJobEnrichmentMarker(enriched);
    if (!marker) throw new AtsLedgerAuthorityError('ATS detail result omitted its enrichment marker.');
    const terminalAt = new Date();
    const updated = await runLedgerTransaction(async (transaction) => {
      const retained = await transaction.atsIngestionItem.updateMany({
        where: {
          id: item.id,
          itemClaimToken: item.itemClaimToken,
          itemClaimFence: item.itemClaimFence,
          enrichmentStatus: 'pending',
        },
        data: {
          enrichmentOverlay: inputJson(enrichmentOverlay(enriched, input.claim.platform)),
          enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
          enrichmentStatus: 'terminal',
          enrichmentReason: marker.reason || marker.status,
          detailHttpStatus: marker.httpStatus || null,
          detailError: marker.error || null,
          terminalAt,
          nextDetailAt: null,
          itemClaimToken: null,
          itemClaimOwner: null,
          itemHeartbeatAt: terminalAt,
          itemLeaseExpiresAt: null,
        },
      });
      if (retained.count !== 1) return false;
      await transaction.atsIngestionBatch.update({
        where: { id: input.claim.batchId },
        data: { terminalItemCount: { increment: 1 }, acquisitionHeartbeatAt: terminalAt },
      });
      await transaction.atsAcquisitionWorkReceipt.update({
        where: { id: input.claim.workReceiptId },
        data: {
          itemsInspected: { increment: 1 },
          itemsTerminalized: { increment: 1 },
          itemsProgressed: { increment: 1 },
          heartbeatAt: terminalAt,
        },
      });
      return true;
    });
    if (!updated) throw new AtsLedgerAuthorityError(`ATS v2 item ${item.id} lost its fence.`);
    return 'terminal';
  } catch (error) {
    const retryAt = error && typeof error === 'object' && 'retryAt' in error
      && error.retryAt instanceof Date
      ? error.retryAt
      : new Date(Date.now() + 15 * 60_000);
    await prisma.atsIngestionItem.updateMany({
      where: { id: item.id, itemClaimToken: item.itemClaimToken, itemClaimFence: item.itemClaimFence },
      data: {
        enrichmentStatus: 'pending',
        detailError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        nextDetailAt: retryAt,
        itemClaimToken: null,
        itemClaimOwner: null,
        itemHeartbeatAt: new Date(),
        itemLeaseExpiresAt: null,
      },
    });
    if (input.signal?.aborted) throw error;
    return 'deferred';
  }
}

export async function sealReadyAtsV2Segments(input: {
  claim: AtsLedgerClaim;
}): Promise<{ sealedSegments: number; sealedItems: number; complete: boolean }> {
  return runLedgerTransaction(async (transaction) => {
    await authorizeAtsV2LifecycleWrite(transaction);
    const now = new Date();
    const batch = await transaction.atsIngestionBatch.findUniqueOrThrow({
      where: { id: input.claim.batchId },
      select: {
        id: true,
        writerMode: true,
        ledgerVersion: true,
        activeLedgerGeneration: true,
        acquisitionClaimToken: true,
        acquisitionClaimFence: true,
        acquisitionLeaseExpiresAt: true,
        canonicalOccurrenceCount: true,
        terminalItemCount: true,
        sealedItemCount: true,
        segmentSize: true,
        slug: true,
        platform: true,
        board: { select: { checkDay: true } },
      },
    });
    assertClaimMatchesBatch(batch, input.claim, now);
    const segmentCount = Math.ceil(batch.canonicalOccurrenceCount / batch.segmentSize);
    let sealedSegments = 0;
    let sealedItems = 0;
    for (let segmentOrdinal = 0; segmentOrdinal < segmentCount; segmentOrdinal++) {
      const existing = await transaction.atsIngestionSegment.findUnique({
        where: {
          batchId_ledgerGeneration_segmentOrdinal: {
            batchId: batch.id,
            ledgerGeneration: batch.activeLedgerGeneration,
            segmentOrdinal,
          },
        },
        select: { id: true },
      });
      if (existing) continue;
      const firstOrdinal = segmentOrdinal * batch.segmentSize;
      const itemCount = Math.min(batch.segmentSize, batch.canonicalOccurrenceCount - firstOrdinal);
      const lastOrdinal = firstOrdinal + itemCount - 1;
      const items = await transaction.atsIngestionItem.findMany({
        where: {
          batchId: batch.id,
          ledgerGeneration: batch.activeLedgerGeneration,
          canonicalOrdinal: { gte: firstOrdinal, lte: lastOrdinal },
        },
        orderBy: { canonicalOrdinal: 'asc' },
        select: {
          canonicalOrdinal: true,
          rawHash: true,
          enrichmentOverlay: true,
          enrichmentVersion: true,
          enrichmentStatus: true,
          terminalAt: true,
        },
      });
      if (items.length !== itemCount || items.some((item) => item.enrichmentStatus !== 'terminal')) continue;
      const manifestHash = atsLedgerHash(items.map((item) => ({
        ordinal: item.canonicalOrdinal,
        rawHash: item.rawHash,
        overlayHash: atsLedgerHash(item.enrichmentOverlay),
        enrichmentVersion: item.enrichmentVersion,
        terminalAt: item.terminalAt?.toISOString() || null,
      })));
      await transaction.atsIngestionSegment.create({
        data: {
          batchId: batch.id,
          ledgerGeneration: batch.activeLedgerGeneration,
          segmentOrdinal,
          segmentSize: batch.segmentSize,
          firstOrdinal,
          lastOrdinal,
          itemCount,
          manifestHash,
          enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
          status: 'sealed',
          sealedAt: now,
        },
      });
      sealedSegments++;
      sealedItems += itemCount;
    }
    const nextSealedItems = batch.sealedItemCount + sealedItems;
    // Sealing means "every item is terminal, only segment manifests remain".
    // Entering it while items are still pending was a one-way trapdoor: the
    // continuation quantum only terminalizes and enriches in the enrichment
    // phase, and terminalizeAtsV2NoNetworkItems/enrichNextAtsV2DetailItem
    // both no-op unless the batch reads 'enrichment'. A batch that sealed
    // before its last item went terminal could therefore never seal again.
    const allItemsTerminal = batch.terminalItemCount === batch.canonicalOccurrenceCount;
    const complete = nextSealedItems === batch.canonicalOccurrenceCount && allItemsTerminal;
    await transaction.atsIngestionBatch.update({
      where: { id: batch.id },
      data: {
        sealedItemCount: nextSealedItems,
        acquisitionPhase: complete
          ? 'synchronized'
          : allItemsTerminal ? 'sealing' : 'enrichment',
        status: complete ? 'synchronized' : 'partial',
        synchronizedAt: complete ? now : undefined,
        acquisitionHeartbeatAt: now,
      },
    });
    if (complete && input.claim.endpointSweepId) {
      await transaction.atsEndpointSweepReceipt.updateMany({
        where: { id: input.claim.endpointSweepId },
        data: {
          synchronizedAt: now,
          outcome: 'synchronized',
        },
      });
    }
    if (complete) {
      await transaction.atsCompany.update({
        where: { slug_platform: { slug: batch.slug, platform: batch.platform } },
        data: {
          failCount: 0,
          retryCount: 0,
          status: 'active',
          nextCheckDate: nextAtsBoardCheckDateForDay(batch.board.checkDay),
          lastCheckedAt: now,
          lastSynchronizedAt: now,
          jobsFound: batch.canonicalOccurrenceCount,
        },
      });
    }
    return { sealedSegments, sealedItems, complete };
  });
}

export async function atsV2PersistenceBacklog(
  transaction: Pick<AtsLedgerTransaction, '$queryRaw'> | typeof prisma = prisma,
): Promise<number> {
  const rows = await transaction.$queryRaw<Array<{ remaining: bigint | number | string }>>(Prisma.sql`
    SELECT COALESCE(SUM(GREATEST(segment."itemCount" - segment."processingOffset", 0)), 0) AS remaining
      FROM "AtsIngestionSegment" segment
     WHERE segment.status IN ('published', 'processing')
  `);
  return Number(rows[0]?.remaining || 0);
}

export type AtsV2PublicationGatePlan = {
  publishAllowed: boolean;
  publicationPaused: boolean;
  publicationPausedAt: Date | null;
  publicationBacklogJobs: number;
  changed: boolean;
};

/**
 * Preserve the start of one continuous publication pause while applying the
 * high/low hysteresis. The publisher calls this again after publishing so a
 * resume-at-low followed by an immediate refill-to-high starts a new pause.
 */
export function planAtsV2PublicationGate(input: {
  previousPaused: boolean;
  previousPausedAt: Date | null;
  previousBacklogJobs: number;
  initialBacklogJobs: number;
  finalBacklogJobs: number;
  highWatermark: number;
  lowWatermark: number;
  now: Date;
}): AtsV2PublicationGatePlan {
  const pausedBeforePublishing = input.previousPaused
    ? input.initialBacklogJobs > input.lowWatermark
    : input.initialBacklogJobs >= input.highWatermark;
  const publishAllowed = !pausedBeforePublishing;
  const publicationPaused = pausedBeforePublishing
    || input.finalBacklogJobs >= input.highWatermark;
  const publicationPausedAt = publicationPaused
    ? input.previousPaused && pausedBeforePublishing
      ? input.previousPausedAt || input.now
      : input.now
    : null;
  const previousPausedAtMs = input.previousPausedAt?.getTime() ?? null;
  const publicationPausedAtMs = publicationPausedAt?.getTime() ?? null;
  return {
    publishAllowed,
    publicationPaused,
    publicationPausedAt,
    publicationBacklogJobs: input.finalBacklogJobs,
    changed: input.previousPaused !== publicationPaused
      || previousPausedAtMs !== publicationPausedAtMs
      || input.previousBacklogJobs !== input.finalBacklogJobs,
  };
}

export async function publishReadyAtsV2Segments(input: {
  batchId?: string;
  highWatermark: number;
  lowWatermark: number;
  maxSegments?: number;
  now?: Date;
}): Promise<{ publishedSegments: number; publishedItems: number; remainingJobs: number }> {
  const now = input.now || new Date();
  const maximum = Math.max(1, Math.min(10, Math.floor(input.maxSegments || 10)));
  return runLedgerTransaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(912837465)`;
    let remainingJobs = await atsV2PersistenceBacklog(transaction);
    const gate = await transaction.atsAcquisitionRuntimeGate.findUniqueOrThrow({
      where: { id: 'global' },
      select: {
        publicationPaused: true,
        publicationPausedAt: true,
        publicationBacklogJobs: true,
      },
    });
    const initialBacklogJobs = remainingJobs;
    let gatePlan = planAtsV2PublicationGate({
      previousPaused: gate.publicationPaused,
      previousPausedAt: gate.publicationPausedAt,
      previousBacklogJobs: gate.publicationBacklogJobs,
      initialBacklogJobs,
      finalBacklogJobs: remainingJobs,
      highWatermark: input.highWatermark,
      lowWatermark: input.lowWatermark,
      now,
    });
    let publishedSegments = 0;
    let publishedItems = 0;
    if (gatePlan.publishAllowed) {
      const segments = await transaction.atsIngestionSegment.findMany({
        where: {
          status: 'sealed',
          ...(input.batchId ? { batchId: input.batchId } : {}),
        },
        orderBy: [{ sealedAt: 'asc' }, { batchId: 'asc' }, { segmentOrdinal: 'asc' }],
        take: maximum,
      });
      for (const segment of segments) {
        if (remainingJobs + segment.itemCount > input.highWatermark) break;
        const published = await transaction.atsIngestionSegment.updateMany({
          where: { id: segment.id, status: 'sealed', publishedAt: null },
          data: { status: 'published', publishedAt: now, nextProcessAt: now },
        });
        if (published.count !== 1) continue;
        await transaction.atsIngestionBatch.update({
          where: { id: segment.batchId },
          data: { publishedItemCount: { increment: segment.itemCount } },
        });
        remainingJobs += segment.itemCount;
        publishedSegments++;
        publishedItems += segment.itemCount;
      }
      gatePlan = planAtsV2PublicationGate({
        previousPaused: gate.publicationPaused,
        previousPausedAt: gate.publicationPausedAt,
        previousBacklogJobs: gate.publicationBacklogJobs,
        initialBacklogJobs,
        finalBacklogJobs: remainingJobs,
        highWatermark: input.highWatermark,
        lowWatermark: input.lowWatermark,
        now,
      });
    }
    if (gatePlan.changed) {
      await transaction.atsAcquisitionRuntimeGate.update({
        where: { id: 'global' },
        data: {
          publicationPaused: gatePlan.publicationPaused,
          publicationPausedAt: gatePlan.publicationPausedAt,
          publicationBacklogJobs: gatePlan.publicationBacklogJobs,
        },
      });
    }
    return { publishedSegments, publishedItems, remainingJobs };
  });
}

function mergeAtsLedgerItem(rawJson: Prisma.JsonValue | null, overlay: Prisma.JsonValue | null): JsonObject {
  return { ...jsonObject(rawJson), ...jsonObject(overlay) };
}

export async function claimNextAtsV2Segment(now = new Date()): Promise<PrefetchedAtsSegment | null> {
  const candidate = await prisma.atsIngestionSegment.findFirst({
    where: {
      OR: [
        { status: 'published', OR: [{ nextProcessAt: null }, { nextProcessAt: { lte: now } }] },
        { status: 'processing', leaseExpiresAt: { lte: now } },
      ],
    },
    orderBy: [
      { nextProcessAt: { sort: 'asc', nulls: 'first' } },
      { publishedAt: 'asc' },
      { createdAt: 'asc' },
    ],
    select: { id: true },
  });
  if (!candidate) return null;
  const leaseToken = randomUUID();
  const claimed = await prisma.atsIngestionSegment.updateMany({
    where: {
      id: candidate.id,
      OR: [
        { status: 'published', OR: [{ nextProcessAt: null }, { nextProcessAt: { lte: now } }] },
        { status: 'processing', leaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      status: 'processing',
      leaseToken,
      leaseOwner: `${os.hostname()}:${process.pid}`,
      leaseFence: { increment: BigInt(1) },
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + ATS_LEDGER_SEGMENT_LEASE_MS),
      nextProcessAt: null,
    },
  });
  if (claimed.count !== 1) return null;
  const segment = await prisma.atsIngestionSegment.findUniqueOrThrow({
    where: { id: candidate.id },
    include: { batch: { select: { slug: true, platform: true, synchronizedAt: true, writerMode: true } } },
  });
  if (segment.batch.writerMode !== 'v2') {
    throw new AtsLedgerAuthorityError(`ATS segment ${segment.id} belongs to a non-v2 batch.`);
  }
  const items = await prisma.atsIngestionItem.findMany({
    where: {
      batchId: segment.batchId,
      ledgerGeneration: segment.ledgerGeneration,
      canonicalOrdinal: { gte: segment.firstOrdinal, lte: segment.lastOrdinal },
      enrichmentStatus: 'terminal',
    },
    orderBy: { canonicalOrdinal: 'asc' },
  });
  const expectedOrdinals = Array.from({ length: segment.itemCount }, (_, index) => segment.firstOrdinal + index);
  if (items.length !== segment.itemCount
    || items.some((item, index) => item.canonicalOrdinal !== expectedOrdinals[index])) {
    throw new AtsLedgerAuthorityError(`ATS segment ${segment.id} item manifest is incomplete.`);
  }
  const manifestHash = atsLedgerHash(items.map((item) => ({
    ordinal: item.canonicalOrdinal,
    rawHash: item.rawHash,
    overlayHash: atsLedgerHash(item.enrichmentOverlay),
    enrichmentVersion: item.enrichmentVersion,
    terminalAt: item.terminalAt?.toISOString() || null,
  })));
  if (manifestHash !== segment.manifestHash) {
    throw new AtsLedgerAuthorityError(`ATS segment ${segment.id} manifest hash changed before processing.`);
  }
  const remainingItems = items.slice(segment.processingOffset);
  const jobs = remainingItems.map((item) => mergeAtsLedgerItem(item.rawJson, item.enrichmentOverlay));
  const canonicalOrdinals = remainingItems.map((item) => item.canonicalOrdinal);
  const pages = await prisma.atsIngestionPage.findMany({
    where: { batchId: segment.batchId, generation: segment.ledgerGeneration },
    orderBy: { requestedOffset: 'asc' },
    select: { metadata: true },
  });
  const metadata = pages.reduce<JsonObject>(
    (merged, page) => ({ ...merged, ...jsonObject(page.metadata) }),
    {},
  );
  return {
    handoffKind: 'ledger_segment',
    id: segment.id,
    sourceBatchId: segment.batchId,
    slug: segment.batch.slug,
    platform: segment.batch.platform,
    jobs,
    metadata,
    processingOffset: segment.processingOffset,
    totalJobCount: segment.itemCount,
    synchronizedAt: segment.batch.synchronizedAt,
    leaseToken,
    ledgerGeneration: segment.ledgerGeneration,
    segmentOrdinal: segment.segmentOrdinal,
    canonicalOrdinals,
    manifestHash,
    verifiedPayloadJobCount: segment.itemCount,
    verifiedPayloadHash: manifestHash,
  };
}

export async function heartbeatAtsV2Segment(input: {
  segmentId: string;
  leaseToken: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now || new Date();
  const updated = await prisma.atsIngestionSegment.updateMany({
    where: {
      id: input.segmentId,
      leaseToken: input.leaseToken,
      status: 'processing',
      leaseExpiresAt: { gt: now },
    },
    data: {
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + ATS_LEDGER_SEGMENT_LEASE_MS),
    },
  });
  return updated.count === 1;
}

function countersSeen(counters: Pick<IngestionCounters, 'inserted' | 'duplicates' | 'filtered' | 'processingErrors'>): number {
  return counters.inserted + counters.duplicates + counters.filtered + counters.processingErrors;
}

export type AtsV2BatchFinalizationSegment = {
  segmentOrdinal: number;
  firstOrdinal: number;
  lastOrdinal: number;
  itemCount: number;
  status: string;
  processingOffset: number;
  insertedCount: number;
  duplicateCount: number;
  filteredCount: number;
  processingErrorCount: number;
};

export type AtsV2BatchFinalizationSnapshot = {
  writerMode: string;
  status: string;
  processedAt: Date | null;
  listingCompletedAt: Date | null;
  synchronizedAt: Date | null;
  acquisitionPhase: string;
  rawObservationCount: number;
  observationCount: number;
  resolutionCount: number;
  canonicalOccurrenceCount: number;
  canonicalItemCount: number;
  compactedOccurrenceCount: number;
  terminalItemCount: number;
  terminalItemRowCount: number;
  sealedItemCount: number;
  publishedItemCount: number;
  segmentSize: number;
  incompletePageCount: number;
  liveAcquisitionLeaseCount: number;
  liveWorkReceiptLeaseCount: number;
  liveEnrichmentLeaseCount: number;
  liveSegmentLeaseCount: number;
  segments: readonly AtsV2BatchFinalizationSegment[];
};

/**
 * Decide whether a board cycle is truly complete, including evidence that has
 * not yet produced a segment manifest. Looking only for existing unprocessed
 * segments is unsafe once publication can begin before the board synchronizes.
 */
export function atsV2BatchFinalizationReady(
  snapshot: AtsV2BatchFinalizationSnapshot,
): boolean {
  const aggregateCounts = [
    snapshot.rawObservationCount,
    snapshot.observationCount,
    snapshot.resolutionCount,
    snapshot.canonicalOccurrenceCount,
    snapshot.canonicalItemCount,
    snapshot.compactedOccurrenceCount,
    snapshot.terminalItemCount,
    snapshot.terminalItemRowCount,
    snapshot.sealedItemCount,
    snapshot.publishedItemCount,
    snapshot.incompletePageCount,
    snapshot.liveAcquisitionLeaseCount,
    snapshot.liveWorkReceiptLeaseCount,
    snapshot.liveEnrichmentLeaseCount,
    snapshot.liveSegmentLeaseCount,
  ];
  if (snapshot.writerMode !== 'v2'
    || snapshot.status !== 'synchronized'
    || snapshot.processedAt !== null
    || snapshot.listingCompletedAt === null
    || snapshot.synchronizedAt === null
    || snapshot.acquisitionPhase !== 'synchronized'
    || snapshot.segmentSize <= 0
    || aggregateCounts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || snapshot.incompletePageCount !== 0
    || snapshot.rawObservationCount !== snapshot.observationCount
    || snapshot.rawObservationCount !== snapshot.resolutionCount
    || snapshot.rawObservationCount
      !== snapshot.canonicalOccurrenceCount + snapshot.compactedOccurrenceCount
    || snapshot.canonicalOccurrenceCount !== snapshot.canonicalItemCount
    || snapshot.canonicalOccurrenceCount !== snapshot.terminalItemCount
    || snapshot.canonicalOccurrenceCount !== snapshot.terminalItemRowCount
    || snapshot.canonicalOccurrenceCount !== snapshot.sealedItemCount
    || snapshot.canonicalOccurrenceCount !== snapshot.publishedItemCount
    || snapshot.liveAcquisitionLeaseCount !== 0
    || snapshot.liveWorkReceiptLeaseCount !== 0
    || snapshot.liveEnrichmentLeaseCount !== 0
    || snapshot.liveSegmentLeaseCount !== 0) {
    return false;
  }

  const expectedSegmentCount = Math.ceil(
    snapshot.canonicalOccurrenceCount / snapshot.segmentSize,
  );
  if (snapshot.segments.length !== expectedSegmentCount) return false;

  const segments = [...snapshot.segments].sort(
    (left, right) => left.segmentOrdinal - right.segmentOrdinal,
  );
  return segments.every((segment, index) => {
    const firstOrdinal = index * snapshot.segmentSize;
    const itemCount = Math.min(
      snapshot.segmentSize,
      snapshot.canonicalOccurrenceCount - firstOrdinal,
    );
    return segment.segmentOrdinal === index
      && [
        segment.firstOrdinal,
        segment.lastOrdinal,
        segment.itemCount,
        segment.processingOffset,
        segment.insertedCount,
        segment.duplicateCount,
        segment.filteredCount,
        segment.processingErrorCount,
      ].every((count) => Number.isSafeInteger(count) && count >= 0)
      && segment.firstOrdinal === firstOrdinal
      && segment.lastOrdinal === firstOrdinal + itemCount - 1
      && segment.itemCount === itemCount
      && segment.status === 'processed'
      && segment.processingOffset === itemCount
      && segment.insertedCount
        + segment.duplicateCount
        + segment.filteredCount
        + segment.processingErrorCount === segment.processingOffset;
  });
}

async function finalizeAtsV2BatchIfReady(
  transaction: AtsLedgerTransaction,
  batchId: string,
  now: Date,
): Promise<boolean> {
  const batch = await transaction.atsIngestionBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      slug: true,
      platform: true,
      writerMode: true,
      status: true,
      processedAt: true,
      listingCompletedAt: true,
      synchronizedAt: true,
      acquisitionPhase: true,
      activeLedgerGeneration: true,
      rawObservationCount: true,
      canonicalOccurrenceCount: true,
      compactedOccurrenceCount: true,
      terminalItemCount: true,
      sealedItemCount: true,
      publishedItemCount: true,
      segmentSize: true,
      acquisitionClaimToken: true,
      acquisitionLeaseExpiresAt: true,
    },
  });
  if (!batch
    || batch.writerMode !== 'v2'
    || batch.status !== 'synchronized'
    || batch.processedAt
    || !batch.listingCompletedAt
    || !batch.synchronizedAt
    || batch.acquisitionPhase !== 'synchronized') {
    return false;
  }

  const generation = batch.activeLedgerGeneration;
  // Most synchronized boards still have other manifests in flight. Stop at
  // the first one instead of rerunning the exhaustive whole-board audit after
  // every completed segment; the final negative result still falls through to
  // the complete evidence reconciliation below.
  const outstandingSegment = await transaction.atsIngestionSegment.findFirst({
    where: {
      batchId,
      ledgerGeneration: generation,
      status: { not: 'processed' },
    },
    select: { id: true },
  });
  if (outstandingSegment) return false;

  const [
    observationCount,
    resolutionCount,
    canonicalItemCount,
    terminalItemRowCount,
    incompletePageCount,
    liveWorkReceiptLeaseCount,
    liveEnrichmentLeaseCount,
    segments,
  ] = await Promise.all([
    transaction.atsListingObservation.count({ where: { batchId, generation } }),
    transaction.atsListingObservationResolution.count({
      where: { batchId, ledgerGeneration: generation },
    }),
    transaction.atsIngestionItem.count({ where: { batchId, ledgerGeneration: generation } }),
    transaction.atsIngestionItem.count({
      where: { batchId, ledgerGeneration: generation, enrichmentStatus: 'terminal' },
    }),
    transaction.atsIngestionPage.count({
      where: { batchId, generation, materializationCompleteAt: null },
    }),
    transaction.atsAcquisitionWorkReceipt.count({
      where: { batchId, finishedAt: null, leaseExpiresAt: { gt: now } },
    }),
    transaction.atsIngestionItem.count({
      where: {
        batchId,
        ledgerGeneration: generation,
        itemClaimToken: { not: null },
        itemLeaseExpiresAt: { gt: now },
      },
    }),
    transaction.atsIngestionSegment.findMany({
      where: { batchId, ledgerGeneration: generation },
      select: {
        segmentOrdinal: true,
        firstOrdinal: true,
        lastOrdinal: true,
        itemCount: true,
        status: true,
        processingOffset: true,
        insertedCount: true,
        duplicateCount: true,
        filteredCount: true,
        processingErrorCount: true,
        leaseToken: true,
        leaseExpiresAt: true,
      },
    }),
  ]);
  const liveAcquisitionLeaseCount = batch.acquisitionClaimToken
      && batch.acquisitionLeaseExpiresAt
      && batch.acquisitionLeaseExpiresAt > now
    ? 1
    : 0;
  const liveSegmentLeaseCount = segments.filter((segment) => (
    segment.leaseToken && segment.leaseExpiresAt && segment.leaseExpiresAt > now
  )).length;
  if (!atsV2BatchFinalizationReady({
    ...batch,
    observationCount,
    resolutionCount,
    canonicalItemCount,
    terminalItemRowCount,
    incompletePageCount,
    liveAcquisitionLeaseCount,
    liveWorkReceiptLeaseCount,
    liveEnrichmentLeaseCount,
    liveSegmentLeaseCount,
    segments,
  })) {
    return false;
  }

  const completedWithErrors = segments.some((segment) => segment.processingErrorCount > 0);
  const finalized = await transaction.atsIngestionBatch.updateMany({
    where: {
      id: batch.id,
      writerMode: 'v2',
      status: 'synchronized',
      acquisitionPhase: 'synchronized',
      synchronizedAt: { not: null },
      processedAt: null,
    },
    data: {
      status: completedWithErrors ? 'failed' : 'processed',
      processedAt: now,
      lastError: completedWithErrors
        ? 'One or more immutable ATS segments completed with quarantined processing errors.'
        : null,
    },
  });
  if (finalized.count !== 1) return false;

  await transaction.atsEndpointSweepReceipt.updateMany({
    where: { batchId: batch.id, processedAt: null },
    data: {
      processedAt: now,
      ...(batch.canonicalOccurrenceCount === 0 ? { outcome: 'processed_empty' } : {}),
    },
  });
  await transaction.atsCompany.update({
    where: { slug_platform: { slug: batch.slug, platform: batch.platform } },
    data: { lastProcessedAt: now },
  });
  return true;
}

export async function completeAtsV2SegmentProcessing(input: {
  segmentId: string;
  leaseToken: string;
  counters: IngestionCounters;
  interrupted?: boolean;
  fatalError?: string | null;
  error?: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now || new Date();
  return runLedgerTransaction(async (transaction) => {
    await authorizeAtsV2LifecycleWrite(transaction);
    const segment = await transaction.atsIngestionSegment.findFirst({
      where: {
        id: input.segmentId,
        leaseToken: input.leaseToken,
        status: 'processing',
        leaseExpiresAt: { gt: now },
      },
    });
    if (!segment) return false;
    const priorSeen = segment.insertedCount
      + segment.duplicateCount
      + segment.filteredCount
      + segment.processingErrorCount;
    if (priorSeen !== segment.processingOffset) {
      throw new AtsLedgerAuthorityError(`ATS segment ${segment.id} counters do not match its cursor.`);
    }
    const turnSeen = countersSeen(input.counters);
    const remaining = segment.itemCount - segment.processingOffset;
    if (input.fatalError || turnSeen > remaining || (!input.interrupted && turnSeen !== remaining)) {
      throw new AtsLedgerAuthorityError(input.fatalError || `ATS segment ${segment.id} turn did not reconcile.`);
    }
    if (input.counters.processingErrors > 0 && segment.leaseFence < BigInt(3)) {
      const retryIndex = Math.min(Number(segment.leaseFence - BigInt(1)), SEGMENT_RETRY_DELAYS_MS.length - 1);
      const released = await transaction.atsIngestionSegment.updateMany({
        where: {
          id: segment.id,
          leaseToken: input.leaseToken,
          status: 'processing',
          processingOffset: segment.processingOffset,
        },
        data: {
          status: 'published',
          nextProcessAt: new Date(now.getTime() + SEGMENT_RETRY_DELAYS_MS[retryIndex]),
          leaseToken: null,
          leaseOwner: null,
          heartbeatAt: now,
          leaseExpiresAt: null,
        },
      });
      return released.count === 1;
    }
    const nextOffset = segment.processingOffset + turnSeen;
    const complete = nextOffset === segment.itemCount;
    const nextCounters = {
      inserted: segment.insertedCount + input.counters.inserted,
      duplicates: segment.duplicateCount + input.counters.duplicates,
      filtered: segment.filteredCount + input.counters.filtered,
      processingErrors: segment.processingErrorCount + input.counters.processingErrors,
    };
    const updated = await transaction.atsIngestionSegment.updateMany({
      where: {
        id: segment.id,
        leaseToken: input.leaseToken,
        status: 'processing',
        processingOffset: segment.processingOffset,
      },
      data: {
        status: complete ? 'processed' : 'published',
        processingOffset: nextOffset,
        insertedCount: nextCounters.inserted,
        duplicateCount: nextCounters.duplicates,
        filteredCount: nextCounters.filtered,
        processingErrorCount: nextCounters.processingErrors,
        processedAt: complete ? now : null,
        nextProcessAt: complete ? null : now,
        leaseToken: null,
        leaseOwner: null,
        heartbeatAt: now,
        leaseExpiresAt: null,
      },
    });
    if (updated.count !== 1) return false;
    if (complete) await finalizeAtsV2BatchIfReady(transaction, segment.batchId, now);
    return true;
  });
}

export async function failAtsV2SegmentProcessing(input: {
  segmentId: string;
  leaseToken: string;
  error: unknown;
  now?: Date;
}): Promise<boolean> {
  const now = input.now || new Date();
  const segment = await prisma.atsIngestionSegment.findFirst({
    where: { id: input.segmentId, leaseToken: input.leaseToken, status: 'processing' },
    select: { leaseFence: true },
  });
  if (!segment) return false;
  const attemptIndex = Math.min(
    Math.max(0, Number(segment.leaseFence - BigInt(1))),
    SEGMENT_RETRY_DELAYS_MS.length - 1,
  );
  const updated = await prisma.atsIngestionSegment.updateMany({
    where: { id: input.segmentId, leaseToken: input.leaseToken, status: 'processing' },
    data: {
      status: 'published',
      nextProcessAt: new Date(now.getTime() + SEGMENT_RETRY_DELAYS_MS[attemptIndex]),
      leaseToken: null,
      leaseOwner: null,
      heartbeatAt: now,
      leaseExpiresAt: null,
    },
  });
  return updated.count === 1;
}

export async function finishAtsV2Claim(input: {
  claim: AtsLedgerClaim;
  yieldReason: string;
  error?: string | null;
  nextAcquireAt?: Date | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now || new Date();
  return runLedgerTransaction(async (transaction) => {
    await authorizeAtsV2LifecycleWrite(transaction);
    const receipt = await transaction.atsAcquisitionWorkReceipt.updateMany({
      where: {
        id: input.claim.workReceiptId,
        leaseToken: input.claim.claimToken,
        leaseFence: input.claim.claimFence,
        finishedAt: null,
      },
      data: {
        finishedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: null,
        yieldReason: input.yieldReason,
        error: input.error?.slice(0, 1_000) || null,
      },
    });
    if (receipt.count !== 1) return false;
    const batch = await transaction.atsIngestionBatch.updateMany({
      where: {
        id: input.claim.batchId,
        writerMode: 'v2',
        acquisitionClaimToken: input.claim.claimToken,
        acquisitionClaimFence: input.claim.claimFence,
      },
      data: {
        acquisitionClaimToken: null,
        acquisitionClaimOwner: null,
        acquisitionHeartbeatAt: now,
        acquisitionLeaseExpiresAt: null,
        nextAcquireAt: input.nextAcquireAt === undefined ? now : input.nextAcquireAt,
        lastServedAt: now,
        lastError: input.error?.slice(0, 1_000) || null,
      },
    });
    if (batch.count !== 1) return false;
    await finalizeAtsV2BatchIfReady(transaction, input.claim.batchId, now);
    return true;
  });
}

export async function reconcileExpiredAtsV2Work(now = new Date()): Promise<{
  batchClaims: number;
  itemClaims: number;
  segmentClaims: number;
  workReceipts: number;
  finalizedBatches: number;
}> {
  return runLedgerTransaction(async (transaction) => {
    await authorizeAtsV2LifecycleWrite(transaction);
    // A synchronized batch can have all of its segments processed while its
    // last acquisition claim is still live. If that owner then crashes before
    // finishAtsV2Claim releases the lease, the segment finalizer correctly
    // refuses to advance the board. Remember those exact batches so expiry
    // reconciliation can retry finalization after every live lease is gone.
    const finalizationCandidates = await transaction.atsIngestionBatch.findMany({
      where: {
        writerMode: 'v2',
        status: 'synchronized',
        acquisitionPhase: 'synchronized',
        processedAt: null,
        acquisitionLeaseExpiresAt: { lte: now },
      },
      select: { id: true },
    });
    const workReceipts = await transaction.atsAcquisitionWorkReceipt.updateMany({
      where: { finishedAt: null, leaseExpiresAt: { lte: now } },
      data: {
        finishedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: null,
        yieldReason: 'expired',
        ambiguousDispatch: true,
        error: 'ATS v2 work lease expired; only its durable checkpoint may be adopted.',
      },
    });
    const batchClaims = await transaction.atsIngestionBatch.updateMany({
      where: { writerMode: 'v2', acquisitionLeaseExpiresAt: { lte: now } },
      data: {
        acquisitionClaimToken: null,
        acquisitionClaimOwner: null,
        acquisitionHeartbeatAt: now,
        acquisitionLeaseExpiresAt: null,
        nextAcquireAt: now,
      },
    });
    const itemClaims = await transaction.atsIngestionItem.updateMany({
      where: { itemLeaseExpiresAt: { lte: now }, enrichmentStatus: 'pending' },
      data: {
        itemClaimToken: null,
        itemClaimOwner: null,
        itemHeartbeatAt: now,
        itemLeaseExpiresAt: null,
        nextDetailAt: now,
      },
    });
    const segmentClaims = await transaction.atsIngestionSegment.updateMany({
      where: { leaseExpiresAt: { lte: now }, status: 'processing' },
      data: {
        status: 'published',
        leaseToken: null,
        leaseOwner: null,
        heartbeatAt: now,
        leaseExpiresAt: null,
        nextProcessAt: now,
      },
    });
    let finalizedBatches = 0;
    for (const candidate of finalizationCandidates) {
      if (await finalizeAtsV2BatchIfReady(transaction, candidate.id, now)) {
        finalizedBatches++;
      }
    }
    return {
      batchClaims: batchClaims.count,
      itemClaims: itemClaims.count,
      segmentClaims: segmentClaims.count,
      workReceipts: workReceipts.count,
      finalizedBatches,
    };
  });
}

export async function atsV2StagingSnapshot(): Promise<{
  items: number;
  bytes: bigint;
  blocked: boolean;
}> {
  const rows = await prisma.$queryRaw<Array<{ items: bigint | number | string; bytes: bigint | number | string }>>(Prisma.sql`
    SELECT
      COALESCE(SUM(GREATEST(
        batch."rawObservationCount"
          - batch."compactedOccurrenceCount"
          - batch."publishedItemCount",
        0
      )), 0) AS items,
      COALESCE(SUM(batch."acquisitionBytes"), 0) AS bytes
      FROM "AtsIngestionBatch" batch
     WHERE batch."writerMode" = 'v2'
       AND batch.status IN ('fetching', 'partial', 'synchronized')
  `);
  const items = Number(rows[0]?.items || 0);
  const bytes = BigInt(rows[0]?.bytes || 0);
  return {
    items,
    bytes,
    blocked: items >= ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK
      || bytes >= ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK,
  };
}
