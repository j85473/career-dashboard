import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { requiredAtsBoardChecksPerDay } from './atsRotation';
import { chicagoLocalDay } from './atsAcquisitionLedger';
import { prisma } from './prisma';

type CutoverDatabase = typeof prisma | Prisma.TransactionClient;

type CutoverCountRow = {
  admissionState: string;
  publicationPaused: boolean;
  confirmedContacts: bigint | number;
  legacyActiveBatches: bigint | number;
  legacyListingJobs: bigint | number;
  legacyEnrichmentJobs: bigint | number;
  legacyPersistenceJobs: bigint | number;
  legacyRunningAttempts: bigint | number;
  v2ActiveBatches: bigint | number;
  v2StagingItems: bigint | number;
  v2StagingBytes: bigint | number;
  v2OpenSegments: bigint | number;
  v2SegmentBacklogJobs: bigint | number;
  unfinishedWorkReceipts: bigint | number;
  activeBatchClaims: bigint | number;
  activeItemClaims: bigint | number;
  activeSegmentClaims: bigint | number;
  unresolvedFailures: bigint | number;
  safetyBlockedSweeps: bigint | number;
  reconciliationErrors: bigint | number;
};

type ZeroJobFailureCandidateRow = {
  id: string;
  slug: string;
  platform: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  eligible: boolean;
};

export const ATS_ZERO_JOB_FAILURE_RESOLUTION_KIND = 'verified_zero_job_transport_failure';

export type AtsZeroJobFailureResolutionPlan = {
  unresolvedFailureCount: number;
  eligibleCount: number;
  ineligibleCount: number;
  existingResolutionCount: number;
  selectionHash: string;
};

export type AtsCutoverSnapshot = {
  admissionState: string;
  publicationPaused: boolean;
  dailyTarget: number;
  confirmedContacts: number;
  legacy: {
    activeBatches: number;
    listingJobs: number;
    enrichmentJobs: number;
    persistenceJobs: number;
    runningAttempts: number;
  };
  v2: {
    activeBatches: number;
    stagingItems: number;
    stagingBytes: number;
    openSegments: number;
    segmentBacklogJobs: number;
  };
  leases: {
    unfinishedWorkReceipts: number;
    activeBatchClaims: number;
    activeItemClaims: number;
    activeSegmentClaims: number;
  };
  exceptions: {
    unresolvedFailures: number;
    resolvedZeroJobFailures: number;
    resolutionManifestHash: string | null;
    safetyBlockedSweeps: number;
  };
  reconciliationErrors: number;
  lastLegacyAttemptId: string | null;
  lastV2WorkReceiptId: string | null;
  lastV2SegmentId: string | null;
};

export type AtsCutoverReadiness = {
  ready: boolean;
  blockers: string[];
  snapshot: AtsCutoverSnapshot;
  snapshotHash: string;
};

function count(value: bigint | number | null | undefined): number {
  return Math.max(0, Number(value || 0));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function atsZeroJobFailureSelectionHash(
  rows: ReadonlyArray<{ id: string; updatedAt: Date; eligible: boolean }>,
): string {
  return createHash('sha256').update(canonical(
    [...rows]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => ({
        id: row.id,
        updatedAt: row.updatedAt.toISOString(),
        eligible: row.eligible,
      })),
  )).digest('hex');
}

async function loadAtsZeroJobFailureResolutionPlan(
  database: CutoverDatabase,
): Promise<AtsZeroJobFailureResolutionPlan & { rows: ZeroJobFailureCandidateRow[] }> {
  const [rows, existingResolutionCount] = await Promise.all([
    database.$queryRaw<ZeroJobFailureCandidateRow[]>`
      SELECT
        batch.id,
        batch.slug,
        batch.platform,
        batch."lastError" AS "lastError",
        batch."createdAt" AS "createdAt",
        batch."updatedAt" AS "updatedAt",
        (
          batch."writerMode" = 'legacy'
          AND batch.status = 'failed'
          AND batch."processedAt" IS NULL
          AND batch."jobCount" = 0
          AND batch.payload = '[]'::jsonb
          AND batch."processingOffset" = 0
          AND batch."insertedCount" = 0
          AND batch."duplicateCount" = 0
          AND batch."filteredCount" = 0
          AND batch."processingErrorCount" = 0
          AND batch."leaseToken" IS NULL
          AND batch."leaseOwner" IS NULL
          AND batch."leaseStartedAt" IS NULL
          AND batch."leaseExpiresAt" IS NULL
          AND batch."acquisitionClaimToken" IS NULL
          AND batch."acquisitionClaimOwner" IS NULL
          AND batch."acquisitionLeaseExpiresAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "AtsIngestionPage" page WHERE page."batchId" = batch.id)
          AND NOT EXISTS (SELECT 1 FROM "AtsListingObservation" observation WHERE observation."batchId" = batch.id)
          AND NOT EXISTS (SELECT 1 FROM "AtsListingObservationResolution" resolution WHERE resolution."batchId" = batch.id)
          AND NOT EXISTS (SELECT 1 FROM "AtsIngestionItem" item WHERE item."batchId" = batch.id)
          AND NOT EXISTS (SELECT 1 FROM "AtsAcquisitionWorkReceipt" receipt WHERE receipt."batchId" = batch.id)
          AND NOT EXISTS (SELECT 1 FROM "AtsEndpointSweepReceipt" sweep WHERE sweep."batchId" = batch.id)
          AND NOT EXISTS (SELECT 1 FROM "AtsIngestionSegment" segment WHERE segment."batchId" = batch.id)
        ) AS eligible
      FROM "AtsIngestionBatch" batch
      WHERE batch.status = 'failed'
        AND batch."processedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "AtsZeroJobFailureResolution" resolution
           WHERE resolution."batchId" = batch.id
        )
      ORDER BY batch.id
    `,
    database.atsZeroJobFailureResolution.count(),
  ]);
  const eligibleCount = rows.filter((row) => row.eligible).length;
  return {
    unresolvedFailureCount: rows.length,
    eligibleCount,
    ineligibleCount: rows.length - eligibleCount,
    existingResolutionCount,
    selectionHash: atsZeroJobFailureSelectionHash(rows),
    rows,
  };
}

export async function readAtsZeroJobFailureResolutionPlan(
  database: CutoverDatabase = prisma,
): Promise<AtsZeroJobFailureResolutionPlan> {
  const { rows: _rows, ...plan } = await loadAtsZeroJobFailureResolutionPlan(database);
  return plan;
}

export async function recordAtsZeroJobFailureResolutions(expectedSelectionHash: string): Promise<{
  createdCount: number;
  before: AtsZeroJobFailureResolutionPlan;
  after: AtsZeroJobFailureResolutionPlan;
}> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(912837467)`;
    const loaded = await loadAtsZeroJobFailureResolutionPlan(transaction);
    const { rows, ...before } = loaded;
    if (before.selectionHash !== expectedSelectionHash) {
      throw new Error(
        `ATS zero-job failure selection changed; expected ${expectedSelectionHash}, observed ${before.selectionHash}.`,
      );
    }
    const eligible = rows.filter((row) => row.eligible);
    const resolvedAt = new Date();
    const data = eligible.map((row) => {
      const evidence = {
        batchId: row.id,
        resolutionKind: ATS_ZERO_JOB_FAILURE_RESOLUTION_KIND,
        slug: row.slug,
        platform: row.platform,
        writerMode: 'legacy',
        status: 'failed',
        jobCount: 0,
        payloadItemCount: 0,
        processingOffset: 0,
        insertedCount: 0,
        duplicateCount: 0,
        filteredCount: 0,
        processingErrorCount: 0,
        lastError: row.lastError,
        sourceCreatedAt: row.createdAt.toISOString(),
        sourceUpdatedAt: row.updatedAt.toISOString(),
      };
      return {
        batchId: row.id,
        resolutionKind: ATS_ZERO_JOB_FAILURE_RESOLUTION_KIND,
        evidence: evidence as Prisma.InputJsonValue,
        evidenceHash: createHash('sha256').update(canonical(evidence)).digest('hex'),
        resolvedAt,
      };
    });
    const created = data.length > 0
      ? await transaction.atsZeroJobFailureResolution.createMany({ data })
      : { count: 0 };
    const { rows: _afterRows, ...after } = await loadAtsZeroJobFailureResolutionPlan(transaction);
    return { createdCount: created.count, before, after };
  }, { maxWait: 10_000, timeout: 30_000 });
}

export function atsCutoverSnapshotHash(snapshot: AtsCutoverSnapshot): string {
  return createHash('sha256').update(canonical(snapshot)).digest('hex');
}

/**
 * The daily coverage line is a quality gate, not the writer interlock: it asks
 * whether the Pi did a normal day's work before authority moves. Every other
 * entry below -- drained batches, empty staging, no live lease or claim, paused
 * admissions -- is what actually stops two hosts writing the same board, and
 * none of it is waivable. An operator may accept a coverage shortfall; the
 * recorded receipt keeps the observed contacts and target, so the shortfall
 * stays visible forever.
 */
export function evaluateAtsCutoverSnapshot(
  snapshot: AtsCutoverSnapshot,
  options: { acceptCoverageShortfall?: boolean } = {},
): string[] {
  const blockers: string[] = [];
  if (snapshot.admissionState !== 'draining') blockers.push('new board admissions are not paused');
  if (!options.acceptCoverageShortfall && snapshot.confirmedContacts < snapshot.dailyTarget) {
    blockers.push(`daily coverage is ${snapshot.confirmedContacts}/${snapshot.dailyTarget}`);
  }
  if (snapshot.publicationPaused) blockers.push('v2 segment publication is paused');
  const entries: Array<[string, number]> = [
    ['legacy active batches', snapshot.legacy.activeBatches],
    ['legacy listing jobs', snapshot.legacy.listingJobs],
    ['legacy enrichment jobs', snapshot.legacy.enrichmentJobs],
    ['legacy persistence jobs', snapshot.legacy.persistenceJobs],
    ['legacy running attempts', snapshot.legacy.runningAttempts],
    ['v2 active batches', snapshot.v2.activeBatches],
    ['v2 staging items', snapshot.v2.stagingItems],
    ['v2 staging bytes', snapshot.v2.stagingBytes],
    ['v2 open segments', snapshot.v2.openSegments],
    ['v2 segment backlog jobs', snapshot.v2.segmentBacklogJobs],
    ['unfinished work receipts', snapshot.leases.unfinishedWorkReceipts],
    ['active batch claims', snapshot.leases.activeBatchClaims],
    ['active item claims', snapshot.leases.activeItemClaims],
    ['active segment claims', snapshot.leases.activeSegmentClaims],
    ['unresolved failures', snapshot.exceptions.unresolvedFailures],
    ['safety-blocked sweeps', snapshot.exceptions.safetyBlockedSweeps],
    ['reconciliation errors', snapshot.reconciliationErrors],
  ];
  for (const [label, value] of entries) {
    if (value > 0) blockers.push(`${label}: ${value}`);
  }
  return blockers;
}

export async function readAtsCutoverReadiness(
  database: CutoverDatabase = prisma,
  options: { acceptCoverageShortfall?: boolean } = {},
): Promise<AtsCutoverReadiness> {
  const [
    activeBoards,
    rows,
    lastLegacyAttempt,
    lastV2WorkReceipt,
    lastV2Segment,
    zeroJobFailureResolutions,
  ] = await Promise.all([
    database.atsCompany.count({ where: { status: 'active' } }),
    database.$queryRaw<CutoverCountRow[]>`
      WITH chicago_day AS (
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date AS local_day
      ), reconciliation AS (
        SELECT COUNT(*)::bigint AS errors
          FROM "AtsIngestionBatch" batch
         WHERE batch."writerMode" = 'v2'
           AND (
             batch."rawObservationCount" <> (
               SELECT COUNT(*) FROM "AtsListingObservation" observation
                WHERE observation."batchId" = batch.id
                  AND observation.generation = batch."activeLedgerGeneration"
             )
             OR batch."canonicalOccurrenceCount" <> (
               SELECT COUNT(*) FROM "AtsIngestionItem" item
                WHERE item."batchId" = batch.id
                  AND item."ledgerGeneration" = batch."activeLedgerGeneration"
             )
             OR batch."terminalItemCount" <> (
               SELECT COUNT(*) FROM "AtsIngestionItem" item
                WHERE item."batchId" = batch.id
                  AND item."ledgerGeneration" = batch."activeLedgerGeneration"
                  AND item."enrichmentStatus" = 'terminal'
             )
             OR EXISTS (
               SELECT 1 FROM "AtsIngestionSegment" segment
                WHERE segment."batchId" = batch.id
                  AND segment."ledgerGeneration" = batch."activeLedgerGeneration"
                  AND segment."processingOffset" <>
                    segment."insertedCount" + segment."duplicateCount"
                    + segment."filteredCount" + segment."processingErrorCount"
             )
             OR EXISTS (
               SELECT 1 FROM "AtsIngestionPage" page
                WHERE page."batchId" = batch.id
                  AND page.generation = batch."activeLedgerGeneration"
                  AND (page."materializationOffset" > page."responseItemCount"
                    OR (page."materializationCompleteAt" IS NOT NULL
                      AND page."materializationOffset" <> page."responseItemCount"))
             )
           )
      )
      SELECT
        gate."admissionState" AS "admissionState",
        gate."publicationPaused" AS "publicationPaused",
        (SELECT COUNT(*) FROM "AtsEndpointDailyContactReceipt" contact, chicago_day day
          WHERE contact."localDay" = day.local_day
            AND contact."contactKind" = 'new_cycle_listing')::bigint AS "confirmedContacts",
        (SELECT COUNT(*) FROM "AtsIngestionBatch" batch
          WHERE batch."writerMode" = 'legacy'
            AND batch.status IN ('fetching', 'partial', 'synchronized', 'queued', 'processing'))::bigint
          AS "legacyActiveBatches",
        (SELECT COALESCE(SUM(GREATEST(batch."jobCount", 0)), 0) FROM "AtsIngestionBatch" batch
          WHERE batch."writerMode" = 'legacy' AND batch.status IN ('fetching', 'partial')
            AND COALESCE(batch.cursor ->> 'listingComplete', 'false') <> 'true')::bigint
          AS "legacyListingJobs",
        (SELECT COALESCE(SUM(GREATEST(batch."jobCount" - CASE
            WHEN batch.cursor ->> 'enrichmentOffset' ~ '^[0-9]+$'
              THEN (batch.cursor ->> 'enrichmentOffset')::bigint ELSE 0 END, 0)), 0)
          FROM "AtsIngestionBatch" batch
          WHERE batch."writerMode" = 'legacy' AND batch.status IN ('fetching', 'partial')
            AND batch.cursor ->> 'listingComplete' = 'true')::bigint AS "legacyEnrichmentJobs",
        (SELECT COALESCE(SUM(GREATEST(batch."jobCount" - batch."processingOffset", 0)), 0)
          FROM "AtsIngestionBatch" batch
          WHERE batch."writerMode" = 'legacy' AND batch.status IN ('queued', 'processing'))::bigint
          AS "legacyPersistenceJobs",
        (SELECT COUNT(*) FROM "AtsBoardCheckAttempt" attempt WHERE attempt.outcome = 'running')::bigint
          AS "legacyRunningAttempts",
        (SELECT COUNT(*) FROM "AtsIngestionBatch" batch
          WHERE batch."writerMode" = 'v2' AND batch.status IN ('fetching', 'partial', 'synchronized'))::bigint
          AS "v2ActiveBatches",
        (SELECT COALESCE(SUM(GREATEST(batch."rawObservationCount"
          - batch."compactedOccurrenceCount" - batch."publishedItemCount", 0)), 0)
          FROM "AtsIngestionBatch" batch
          WHERE batch."writerMode" = 'v2' AND batch.status IN ('fetching', 'partial', 'synchronized'))::bigint
          AS "v2StagingItems",
        (SELECT COALESCE(SUM(batch."acquisitionBytes"), 0) FROM "AtsIngestionBatch" batch
          WHERE batch."writerMode" = 'v2' AND batch.status IN ('fetching', 'partial', 'synchronized'))::bigint
          AS "v2StagingBytes",
        (SELECT COUNT(*) FROM "AtsIngestionSegment" segment
          WHERE segment.status IN ('sealed', 'published', 'processing'))::bigint AS "v2OpenSegments",
        (SELECT COALESCE(SUM(GREATEST(segment."itemCount" - segment."processingOffset", 0)), 0)
          FROM "AtsIngestionSegment" segment
          WHERE segment.status IN ('published', 'processing'))::bigint AS "v2SegmentBacklogJobs",
        (SELECT COUNT(*) FROM "AtsAcquisitionWorkReceipt" receipt WHERE receipt."finishedAt" IS NULL)::bigint
          AS "unfinishedWorkReceipts",
        (SELECT COUNT(*) FROM "AtsIngestionBatch" batch
          WHERE batch."acquisitionClaimToken" IS NOT NULL)::bigint AS "activeBatchClaims",
        (SELECT COUNT(*) FROM "AtsIngestionItem" item WHERE item."itemClaimToken" IS NOT NULL)::bigint
          AS "activeItemClaims",
        (SELECT COUNT(*) FROM "AtsIngestionSegment" segment WHERE segment."leaseToken" IS NOT NULL)::bigint
          AS "activeSegmentClaims",
        (SELECT COUNT(*) FROM "AtsIngestionBatch" batch
          WHERE batch.status = 'failed'
            AND batch."processedAt" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "AtsZeroJobFailureResolution" resolution
               WHERE resolution."batchId" = batch.id
            ))::bigint AS "unresolvedFailures",
        (SELECT COUNT(*) FROM "AtsEndpointSweepReceipt" sweep
          WHERE sweep."safetyBlockReason" IS NOT NULL AND sweep."processedAt" IS NULL)::bigint
          AS "safetyBlockedSweeps",
        reconciliation.errors AS "reconciliationErrors"
      FROM "AtsAcquisitionRuntimeGate" gate, reconciliation
      WHERE gate.id = 'global'
    `,
    database.atsBoardCheckAttempt.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
    database.atsAcquisitionWorkReceipt.findFirst({
      where: { batch: { writerMode: 'v2' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
    database.atsIngestionSegment.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
    database.atsZeroJobFailureResolution.findMany({
      orderBy: { batchId: 'asc' },
      select: { batchId: true, resolutionKind: true, evidenceHash: true },
    }),
  ]);
  const row = rows[0];
  if (!row) throw new Error('ATS cutover readiness requires the global runtime gate.');
  const snapshot: AtsCutoverSnapshot = {
    admissionState: row.admissionState,
    publicationPaused: row.publicationPaused,
    dailyTarget: requiredAtsBoardChecksPerDay(activeBoards),
    confirmedContacts: count(row.confirmedContacts),
    legacy: {
      activeBatches: count(row.legacyActiveBatches),
      listingJobs: count(row.legacyListingJobs),
      enrichmentJobs: count(row.legacyEnrichmentJobs),
      persistenceJobs: count(row.legacyPersistenceJobs),
      runningAttempts: count(row.legacyRunningAttempts),
    },
    v2: {
      activeBatches: count(row.v2ActiveBatches),
      stagingItems: count(row.v2StagingItems),
      stagingBytes: count(row.v2StagingBytes),
      openSegments: count(row.v2OpenSegments),
      segmentBacklogJobs: count(row.v2SegmentBacklogJobs),
    },
    leases: {
      unfinishedWorkReceipts: count(row.unfinishedWorkReceipts),
      activeBatchClaims: count(row.activeBatchClaims),
      activeItemClaims: count(row.activeItemClaims),
      activeSegmentClaims: count(row.activeSegmentClaims),
    },
    exceptions: {
      unresolvedFailures: count(row.unresolvedFailures),
      resolvedZeroJobFailures: zeroJobFailureResolutions.length,
      resolutionManifestHash: zeroJobFailureResolutions.length > 0
        ? createHash('sha256').update(canonical(zeroJobFailureResolutions)).digest('hex')
        : null,
      safetyBlockedSweeps: count(row.safetyBlockedSweeps),
    },
    reconciliationErrors: count(row.reconciliationErrors),
    lastLegacyAttemptId: lastLegacyAttempt?.id || null,
    lastV2WorkReceiptId: lastV2WorkReceipt?.id || null,
    lastV2SegmentId: lastV2Segment?.id || null,
  };
  const blockers = evaluateAtsCutoverSnapshot(snapshot, options);
  return {
    ready: blockers.length === 0,
    blockers,
    snapshot,
    snapshotHash: atsCutoverSnapshotHash(snapshot),
  };
}

export async function recordAtsCutoverReceipt(
  expectedHash: string,
  options: { acceptCoverageShortfallAt?: number } = {},
): Promise<{
  id: string;
  snapshotHash: string;
}> {
  const waiving = typeof options.acceptCoverageShortfallAt === 'number';
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(912837466)`;
    const readiness = await readAtsCutoverReadiness(transaction, {
      acceptCoverageShortfall: waiving,
    });
    // Pin the waiver to the shortfall the operator actually reviewed, so a
    // stale dry-run cannot silently accept a different one.
    if (waiving && readiness.snapshot.confirmedContacts !== options.acceptCoverageShortfallAt) {
      throw new Error(
        `Coverage shortfall changed; reviewed ${options.acceptCoverageShortfallAt}, observed ${readiness.snapshot.confirmedContacts}.`,
      );
    }
    if (!readiness.ready) {
      throw new Error(`ATS cutover is not ready: ${readiness.blockers.join('; ')}`);
    }
    if (readiness.snapshotHash !== expectedHash) {
      throw new Error(
        `ATS cutover snapshot changed; expected ${expectedHash}, observed ${readiness.snapshotHash}.`,
      );
    }
    const existing = await transaction.atsAcquisitionCutoverReceipt.findUnique({
      where: { snapshotHash: readiness.snapshotHash },
      select: { id: true, snapshotHash: true },
    });
    if (existing) return existing;
    const verifiedAt = new Date();
    const receipt = await transaction.atsAcquisitionCutoverReceipt.create({
      data: {
        verifiedAt,
        localDay: chicagoLocalDay(verifiedAt),
        dailyTarget: readiness.snapshot.dailyTarget,
        confirmedContacts: readiness.snapshot.confirmedContacts,
        snapshot: readiness.snapshot as unknown as Prisma.InputJsonValue,
        snapshotHash: readiness.snapshotHash,
        lastLegacyAttemptId: readiness.snapshot.lastLegacyAttemptId,
        lastV2WorkReceiptId: readiness.snapshot.lastV2WorkReceiptId,
        lastV2SegmentId: readiness.snapshot.lastV2SegmentId,
        // This count is evidence, not permission to discard work: every entry
        // is backed by one immutable, database-validated zero-job receipt.
        exceptionCount: readiness.snapshot.exceptions.resolvedZeroJobFailures,
      },
      select: { id: true, snapshotHash: true },
    });
    await transaction.atsAcquisitionRuntimeGate.update({
      where: { id: 'global' },
      data: { cutoverReadyAt: verifiedAt },
    });
    return receipt;
  });
}
