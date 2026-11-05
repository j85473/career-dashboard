import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { atsLedgerHash } from './atsEvidenceHash';
import { resolveAtsItemRaw } from './atsRawEvidence';

export const CRAWL_ARCHIVE_TABLES = ['AtsIngestionPage', 'AtsListingObservation', 'AtsIngestionItem',
  'AtsListingObservationResolution', 'AtsIngestionSegment', 'AtsAcquisitionWorkReceipt', 'AtsEndpointSweepReceipt'] as const;
export const CRAWL_ARCHIVE_DELETE_ORDER = ['AtsListingObservationResolution', 'AtsIngestionItem',
  'AtsListingObservation', 'AtsIngestionPage'] as const;
export const CRAWL_ARCHIVE_MAX_BYTES = 256 * 1024 ** 2;
export const CRAWL_ARCHIVE_RETENTION_DAYS = 30;
export type ArchiveRow = Record<string, unknown>;
export type CrawlArchive = { version: 1; batch: ArchiveRow; tables: Record<typeof CRAWL_ARCHIVE_TABLES[number], ArchiveRow[]> };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Crawl archive held: ${message}`);
}
const number = (value: unknown) => Number(value);
const timestamp = (value: unknown): number => typeof value === 'string'
  ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`) : NaN;
const iso = (value: unknown) => new Date(timestamp(value)).toISOString();
const liveLease = (row: ArchiveRow, token: string, expiry: string, now: number) => Boolean(row[token]) && timestamp(row[expiry]) > now;

/** Reproduce the source and handoff evidence before any database removal.
 * Completed status alone, a checksum alone, or item terminalization is insufficient. */
export function verifyCrawlArchive(archive: CrawlArchive, now = Date.now()): Record<string, number> {
  const b = archive.batch;
  check(archive.version === 1 && b && /^[0-9a-f-]{36}$/.test(String(b.id)), 'invalid archive identity');
  check(b.writerMode === 'v2' && b.ledgerVersion === 2 && b.status === 'processed'
    && b.acquisitionPhase === 'synchronized' && b.operatorResetAt === null && b.archiveVerifiedAt === null
    && timestamp(b.processedAt) <= now - CRAWL_ARCHIVE_RETENTION_DAYS * 86400000
    && Number.isFinite(timestamp(b.listingCompletedAt)) && Number.isFinite(timestamp(b.synchronizedAt)), 'batch is unfinished, reset, archived, or too recent');
  check(!liveLease(b, 'acquisitionClaimToken', 'acquisitionLeaseExpiresAt', now)
    && !liveLease(b, 'leaseToken', 'leaseExpiresAt', now), 'batch lease remains active');
  const counts: Record<string, number> = {};
  for (const table of CRAWL_ARCHIVE_TABLES) {
    const rows = archive.tables[table];
    check(Array.isArray(rows) && rows.every(row => row.batchId === b.id), `foreign or missing ${table} rows`);
    check(new Set(rows.map(row => row.id)).size === rows.length, `duplicate ${table} rows`);
    counts[table] = rows.length;
  }
  const observations = archive.tables.AtsListingObservation;
  const observationById = new Map(observations.map(row => [row.id, row]));
  const items = archive.tables.AtsIngestionItem;
  const itemById = new Map(items.map(row => [row.id, row]));
  const pages = archive.tables.AtsIngestionPage;
  const pagesById = new Map(pages.map(row => [row.id, row]));
  const byPage = new Map<unknown, ArchiveRow[]>();
  for (const row of observations) {
    check(pagesById.has(row.pageId) && row.rawJson && atsLedgerHash(row.rawJson) === row.rawHash, `observation ${row.id} lost its raw content`);
    const list = byPage.get(row.pageId) || [];
    list.push(row); byPage.set(row.pageId, list);
  }
  for (const page of pages) {
    const rows = (byPage.get(page.id) || []).sort((a, b) => number(a.pageOrdinal) - number(b.pageOrdinal));
    check(Number.isFinite(timestamp(page.materializationCompleteAt)) && page.materializationOffset === page.responseItemCount
      && rows.length === page.responseItemCount && rows.every((row, index) => row.pageOrdinal === index), `page ${page.id} is not fully materialized`);
    const body = page.rawBody || { metadata: page.metadata || {}, jobs: rows.map(row => row.rawJson), total: page.providerTotal ?? null };
    check(atsLedgerHash(body) === page.rawBodyHash && page.responseHash === page.rawBodyHash, `page ${page.id} response hash differs`);
    const identities = rows.map(row => [row.providerSourceId, row.rawHash])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    check(atsLedgerHash(identities) === page.identityMultisetHash, `page ${page.id} identities differ`);
  }
  for (const item of items) {
    check(item.enrichmentStatus === 'terminal' && Number.isFinite(timestamp(item.terminalAt))
      && !liveLease(item, 'itemClaimToken', 'itemLeaseExpiresAt', now), `item ${item.id} remains unfinished`);
    const representative = observationById.get(item.representativeObservationId);
    const raw = resolveAtsItemRaw({ ...item, rawJson: item.rawJson,
      representativeObservation: representative } as Parameters<typeof resolveAtsItemRaw>[0]);
    check(atsLedgerHash(raw) === item.rawHash, `item ${item.id} raw hash differs`);
  }
  const resolutions = archive.tables.AtsListingObservationResolution;
  check(new Set(resolutions.map(row => row.observationId)).size === observations.length
    && resolutions.length === observations.length, 'observation resolution counts differ');
  for (const row of resolutions) {
    const observation = observationById.get(row.observationId);
    check(observation && (row.itemId === null || itemById.has(row.itemId)), `resolution ${row.id} has a missing source or item`);
    check(atsLedgerHash({ observationId: row.observationId, rawHash: observation.rawHash,
      itemId: row.itemId, type: row.resolutionType, detail: row.detail || {} }) === row.resolutionHash,
    `resolution ${row.id} hash differs`);
  }
  const generation = b.activeLedgerGeneration;
  const activeItems = items.filter(row => row.ledgerGeneration === generation).sort((a, b) => number(a.canonicalOrdinal) - number(b.canonicalOrdinal));
  const activeObservations = observations.filter(row => row.generation === generation);
  const activeResolutions = resolutions.filter(row => row.ledgerGeneration === generation);
  check(activeObservations.length === b.rawObservationCount && activeResolutions.length === b.rawObservationCount
    && activeItems.length === b.canonicalOccurrenceCount
    && number(b.rawObservationCount) === number(b.canonicalOccurrenceCount) + number(b.compactedOccurrenceCount)
    && [b.terminalItemCount, b.sealedItemCount, b.publishedItemCount].every(value => value === activeItems.length)
    && activeItems.every((item, index) => item.canonicalOrdinal === index), 'batch counts or canonical ordinals differ');
  const segments = archive.tables.AtsIngestionSegment;
  check(segments.every(row => row.status === 'processed' && row.processingErrorCount === 0
    && row.processingOffset === row.itemCount && !liveLease(row, 'leaseToken', 'leaseExpiresAt', now)), 'a segment is unprocessed or has errors');
  const activeSegments = segments.filter(row => row.ledgerGeneration === generation).sort((a, b) => number(a.segmentOrdinal) - number(b.segmentOrdinal));
  check(number(b.segmentSize) > 0 && activeSegments.length === Math.ceil(activeItems.length / number(b.segmentSize)), 'segment coverage differs');
  for (const [index, segment] of activeSegments.entries()) {
    const first = index * number(b.segmentSize);
    const members = activeItems.slice(first, first + number(b.segmentSize));
    check(segment.segmentOrdinal === index && segment.firstOrdinal === first && segment.lastOrdinal === first + members.length - 1
      && segment.itemCount === members.length && number(segment.insertedCount) + number(segment.duplicateCount)
        + number(segment.filteredCount) + number(segment.processingErrorCount) === members.length, 'segment outcomes differ');
    check(atsLedgerHash(members.map(item => ({ ordinal: item.canonicalOrdinal, rawHash: item.rawHash,
      overlayHash: atsLedgerHash(item.enrichmentOverlay), enrichmentVersion: item.enrichmentVersion,
      terminalAt: iso(item.terminalAt) }))) === segment.manifestHash, `segment ${segment.id} manifest differs`);
  }
  check(archive.tables.AtsAcquisitionWorkReceipt.every(row => !liveLease(row, 'leaseToken', 'leaseExpiresAt', now)), 'work receipt lease remains active');
  check(archive.tables.AtsEndpointSweepReceipt.length === 1
    && Number.isFinite(timestamp(archive.tables.AtsEndpointSweepReceipt[0].processedAt)), 'endpoint sweep has no completed lifecycle');
  return counts;
}

export function encodeCrawlArchive(archive: CrawlArchive): { bytes: Buffer; hash: string } {
  verifyCrawlArchive(archive);
  const body = Buffer.from(JSON.stringify(archive));
  if (body.length > CRAWL_ARCHIVE_MAX_BYTES) throw new Error('Crawl archive exceeds the bounded 256 MiB batch budget');
  const bytes = gzipSync(body);
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}

export function decodeCrawlArchive(bytes: Buffer, expectedHash: string): CrawlArchive {
  check(/^[a-f0-9]{64}$/.test(expectedHash) && createHash('sha256').update(bytes).digest('hex') === expectedHash, 'archive file checksum differs');
  const archive = JSON.parse(gunzipSync(bytes, { maxOutputLength: CRAWL_ARCHIVE_MAX_BYTES }).toString('utf8')) as CrawlArchive;
  verifyCrawlArchive(archive);
  return archive;
}

export async function readCrawlArchive(roots: readonly string[], location: string, hash: string): Promise<CrawlArchive> {
  check(/^v1\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}-[a-f0-9]{64}\.json\.gz$/.test(location), 'invalid archive location');
  const errors: string[] = [];
  for (const root of roots) {
    try { return decodeCrawlArchive(await readFile(join(root, location)), hash); }
    catch (error) { errors.push(String(error)); }
  }
  throw new Error(`Neither crawl archive copy could be verified: ${errors.join('; ')}`);
}
