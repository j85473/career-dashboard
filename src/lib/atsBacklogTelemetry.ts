import { Prisma } from '@prisma/client';

import { prisma } from './prisma';

export const ATS_BACKLOG_TELEMETRY_INTERVAL_MS = 5_000;

export type AtsOperatorBacklogRow = {
  observedAt: Date;
  admissionState: string;
  publicationPaused: boolean;
  legacyPersistenceJobs: bigint | number | string;
  v2PersistenceJobs: bigint | number | string;
  legacyEnrichmentJobs: bigint | number | string;
  v2EnrichmentJobs: bigint | number | string;
  legacyListingJobs: bigint | number | string;
  v2ListingJobs: bigint | number | string;
  compactionJobs: bigint | number | string;
  publicationJobs: bigint | number | string;
  terminalUnsealedJobs: bigint | number | string;
  sealedUnpublishedJobs: bigint | number | string;
  publishedUnpersistedJobs: bigint | number | string;
};

export type AtsOperatorBacklogSnapshot = {
  observedAt: Date;
  admissionState: 'open' | 'draining';
  publicationPaused: boolean;
  legacyPersistenceJobs: number;
  v2PersistenceJobs: number;
  persistenceJobs: number;
  enrichmentJobs: number;
  listingJobs: number;
  compactionJobs: number;
  publicationJobs: number;
  terminalUnsealedJobs: number;
  sealedUnpublishedJobs: number;
  publishedUnpersistedJobs: number;
};

function count(value: bigint | number | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

export function normalizeAtsOperatorBacklogRow(
  row: AtsOperatorBacklogRow,
): AtsOperatorBacklogSnapshot {
  if (row.admissionState !== 'open' && row.admissionState !== 'draining') {
    throw new Error(`Unknown ATS admission state ${row.admissionState}.`);
  }
  const legacyPersistenceJobs = count(row.legacyPersistenceJobs);
  const v2PersistenceJobs = count(row.v2PersistenceJobs);
  const terminalUnsealedJobs = count(row.terminalUnsealedJobs);
  const sealedUnpublishedJobs = count(row.sealedUnpublishedJobs);
  return {
    observedAt: row.observedAt,
    admissionState: row.admissionState,
    publicationPaused: row.publicationPaused,
    legacyPersistenceJobs,
    v2PersistenceJobs,
    persistenceJobs: legacyPersistenceJobs + v2PersistenceJobs,
    enrichmentJobs: count(row.legacyEnrichmentJobs) + count(row.v2EnrichmentJobs),
    listingJobs: count(row.legacyListingJobs) + count(row.v2ListingJobs),
    compactionJobs: count(row.compactionJobs),
    publicationJobs: terminalUnsealedJobs + sealedUnpublishedJobs,
    terminalUnsealedJobs,
    sealedUnpublishedJobs,
    publishedUnpersistedJobs: count(row.publishedUnpersistedJobs),
  };
}

/**
 * Read the operator-facing backlog across both durable acquisition writers.
 *
 * The legacy acquisition loop keeps its own persistence-only hysteresis query;
 * this snapshot must not change that scheduling decision. It exists so the
 * Dashboard can show the lifecycle that is actually moving while legacy and v2
 * drain side by side.
 */
export async function readAtsOperatorBacklogSnapshot(): Promise<AtsOperatorBacklogSnapshot> {
  const rows = await prisma.$queryRaw<AtsOperatorBacklogRow[]>(Prisma.sql`
    WITH legacy AS (
      SELECT
        COALESCE(SUM(GREATEST(batch."jobCount" - batch."processingOffset", 0))
          FILTER (WHERE batch.status IN ('queued', 'processing')), 0)::bigint
          AS "legacyPersistenceJobs",
        COALESCE(SUM(GREATEST(
          batch."jobCount" - CASE
            WHEN batch.cursor ->> 'enrichmentOffset' ~ '^[0-9]+$'
              THEN (batch.cursor ->> 'enrichmentOffset')::bigint
            ELSE 0
          END, 0))
          FILTER (WHERE batch.status IN ('fetching', 'partial')
            AND batch.cursor ->> 'listingComplete' = 'true'), 0)::bigint
          AS "legacyEnrichmentJobs",
        COALESCE(SUM(GREATEST(batch."jobCount", 0))
          FILTER (WHERE batch.status IN ('fetching', 'partial')
            AND COALESCE(batch.cursor ->> 'listingComplete', 'false') <> 'true'), 0)::bigint
          AS "legacyListingJobs"
      FROM "AtsIngestionBatch" batch
      WHERE batch."writerMode" = 'legacy'
        AND batch.status IN ('queued', 'processing', 'fetching', 'partial')
    ),
    v2_batches AS (
      SELECT
        COALESCE(SUM(GREATEST(batch."rawObservationCount", 0))
          FILTER (WHERE batch."acquisitionPhase" = 'listing'), 0)::bigint
          AS "v2ListingJobs",
        COALESCE(SUM(GREATEST(
          batch."rawObservationCount" - batch."compactedOccurrenceCount", 0))
          FILTER (WHERE batch."acquisitionPhase" = 'compaction'), 0)::bigint
          AS "compactionJobs",
        COALESCE(SUM(GREATEST(
          batch."canonicalOccurrenceCount" - batch."terminalItemCount", 0))
          FILTER (WHERE batch."acquisitionPhase" IN ('enrichment', 'sealing')), 0)::bigint
          AS "v2EnrichmentJobs",
        COALESCE(SUM(GREATEST(
          batch."terminalItemCount" - batch."sealedItemCount", 0))
          FILTER (WHERE batch."acquisitionPhase" IN (
            'enrichment', 'sealing', 'synchronized', 'publishing'
          )), 0)::bigint AS "terminalUnsealedJobs"
      FROM "AtsIngestionBatch" batch
      WHERE batch."writerMode" = 'v2'
        AND batch.status IN ('fetching', 'partial', 'synchronized')
    ),
    v2_segments AS (
      SELECT
        COALESCE(SUM(segment."itemCount")
          FILTER (WHERE segment.status = 'sealed'), 0)::bigint
          AS "sealedUnpublishedJobs",
        COALESCE(SUM(GREATEST(
          segment."itemCount" - segment."processingOffset", 0
        )) FILTER (WHERE segment.status IN ('published', 'processing')), 0)::bigint
          AS "v2PersistenceJobs"
      FROM "AtsIngestionSegment" segment
      WHERE segment.status IN ('sealed', 'published', 'processing')
    )
    SELECT
      CURRENT_TIMESTAMP AS "observedAt",
      gate."admissionState",
      gate."publicationPaused",
      legacy."legacyPersistenceJobs",
      v2_segments."v2PersistenceJobs",
      legacy."legacyEnrichmentJobs",
      v2_batches."v2EnrichmentJobs",
      legacy."legacyListingJobs",
      v2_batches."v2ListingJobs",
      v2_batches."compactionJobs",
      v2_batches."terminalUnsealedJobs" + v2_segments."sealedUnpublishedJobs"
        AS "publicationJobs",
      v2_batches."terminalUnsealedJobs",
      v2_segments."sealedUnpublishedJobs",
      v2_segments."v2PersistenceJobs" AS "publishedUnpersistedJobs"
    FROM "AtsAcquisitionRuntimeGate" gate, legacy, v2_batches, v2_segments
    WHERE gate.id = 'global'
  `);
  const row = rows[0];
  if (!row) throw new Error('ATS runtime gate is missing while measuring backlog telemetry.');
  return normalizeAtsOperatorBacklogRow(row);
}
