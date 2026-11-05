import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atsLedgerHash } from '../atsEvidenceHash';
import { resolveAtsItemRaw } from '../atsRawEvidence';
import { verifyCrawlArchive, encodeCrawlArchive, decodeCrawlArchive, readCrawlArchive, type CrawlArchive } from '../atsCrawlArchive';

export function archiveFixture(): CrawlArchive {
  const id = '11111111-1111-4111-8111-111111111111';
  const date = '2020-01-01T00:00:00.000';
  const rawJson = { id: 'posting-1', title: 'Channel Manager', description: 'A complete original posting.', location: 'Minnesota' };
  const rawHash = atsLedgerHash(rawJson);
  const body = { metadata: {}, jobs: [rawJson], total: 1 };
  const observation = { id: 'observation-1', batchId: id, pageId: 'page-1', generation: 0, pageOrdinal: 0, providerSourceId: 'posting-1', rawJson, rawHash };
  const item = { id: 'item-1', batchId: id, ledgerGeneration: 0, canonicalOrdinal: 0, representativeObservationId: observation.id,
    rawJson, rawHash, enrichmentOverlay: {}, enrichmentVersion: 1, enrichmentStatus: 'terminal', terminalAt: date };
  const detail = { canonicalOrdinal: 0 };
  return { version: 1, batch: { id, createdAt: date, writerMode: 'v2', ledgerVersion: 2, status: 'processed', acquisitionPhase: 'synchronized',
    operatorResetAt: null, archiveVerifiedAt: null, processedAt: date, listingCompletedAt: date, synchronizedAt: date,
    activeLedgerGeneration: 0, rawObservationCount: 1, canonicalOccurrenceCount: 1, compactedOccurrenceCount: 0,
    terminalItemCount: 1, sealedItemCount: 1, publishedItemCount: 1, segmentSize: 25 }, tables: {
    AtsIngestionPage: [{ id: 'page-1', batchId: id, rawBody: null, metadata: {}, providerTotal: 1,
      materializationOffset: 1, responseItemCount: 1, materializationCompleteAt: date,
      responseHash: atsLedgerHash(body), rawBodyHash: atsLedgerHash(body), identityMultisetHash: atsLedgerHash([['posting-1', rawHash]]) }],
    AtsListingObservation: [observation], AtsIngestionItem: [item],
    AtsListingObservationResolution: [{ id: 'resolution-1', batchId: id, ledgerGeneration: 0, observationId: observation.id,
      itemId: item.id, resolutionType: 'canonical_item', detail,
      resolutionHash: atsLedgerHash({ observationId: observation.id, rawHash, itemId: item.id, type: 'canonical_item', detail }) }],
    AtsIngestionSegment: [{ id: 'segment-1', batchId: id, ledgerGeneration: 0, segmentOrdinal: 0, firstOrdinal: 0, lastOrdinal: 0,
      itemCount: 1, status: 'processed', processingOffset: 1, insertedCount: 1, duplicateCount: 0, filteredCount: 0, processingErrorCount: 0,
      manifestHash: atsLedgerHash([{ ordinal: 0, rawHash, overlayHash: atsLedgerHash({}), enrichmentVersion: 1, terminalAt: `${date}Z` }]) }],
    AtsAcquisitionWorkReceipt: [], AtsEndpointSweepReceipt: [{ id: 'sweep-1', batchId: id, processedAt: date }],
  } };
}

test('archived evidence round-trips every value and reproduces the processing manifest', () => {
  const fixture = archiveFixture();
  const { bytes, hash } = encodeCrawlArchive(fixture);
  assert.deepEqual(decodeCrawlArchive(bytes, hash), fixture);
  assert.equal(verifyCrawlArchive(fixture).AtsListingObservation, 1);
  const item = fixture.tables.AtsIngestionItem[0];
  item.rawJson = null;
  item.rawReference = { version: 1, type: 'observation', observationId: 'observation-1', rawHash: item.rawHash };
  assert.equal(verifyCrawlArchive(fixture).AtsIngestionItem, 1);
});

test('archival refuses unfinished, recent, leased, reset, incomplete and divergent evidence', () => {
  const mutations: Array<(archive: CrawlArchive) => void> = [
    a => { a.batch.status = 'synchronized'; }, a => { a.batch.processedAt = new Date().toISOString(); },
    a => { a.batch.operatorResetAt = '2020-01-01'; },
    a => { a.batch.leaseToken = 'live'; a.batch.leaseExpiresAt = new Date(Date.now() + 60000).toISOString(); },
    a => { a.tables.AtsIngestionItem[0].enrichmentStatus = 'pending'; },
    a => { a.tables.AtsIngestionSegment[0].status = 'published'; },
    a => { a.tables.AtsIngestionSegment[0].processingErrorCount = 1; },
    a => { a.tables.AtsIngestionSegment[0].manifestHash = 'altered'; },
    a => { a.tables.AtsListingObservationResolution = []; },
    a => { a.tables.AtsListingObservation[0].rawJson = { title: 'different' }; },
    a => { a.tables.AtsEndpointSweepReceipt[0].processedAt = null; },
    a => { a.tables.AtsIngestionPage[0].materializationOffset = 0; },
    a => { a.tables.AtsListingObservationResolution[0].detail = {}; },
  ];
  for (const mutate of mutations) {
    const fixture = archiveFixture(); mutate(fixture);
    assert.throws(() => verifyCrawlArchive(fixture), /Crawl archive held/);
  }
});

test('raw references preserve the original content and refuse missing or substituted observations', () => {
  const fixture = archiveFixture();
  const observation = fixture.tables.AtsListingObservation[0];
  const item = { ...fixture.tables.AtsIngestionItem[0], rawJson: null,
    rawReference: { version: 1, type: 'observation', observationId: observation.id, rawHash: observation.rawHash },
    representativeObservation: observation } as Parameters<typeof resolveAtsItemRaw>[0];
  assert.deepEqual(resolveAtsItemRaw(item), observation.rawJson);
  assert.throws(() => resolveAtsItemRaw({ ...item, representativeObservation: null }), /Missing or divergent/);
  assert.throws(() => resolveAtsItemRaw({ ...item, batchId: 'another-batch' }), /Missing or divergent/);
  assert.throws(() => resolveAtsItemRaw({ ...item, representativeObservation: { ...item.representativeObservation!, rawJson: { changed: true } } }), /Missing or divergent/);
});

test('archive retrieval detects corruption, uses the second copy, and rejects path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-crawl-archive-'));
  try {
    const { bytes, hash } = encodeCrawlArchive(archiveFixture());
    const location = `v1/2020-01-01/11111111-1111-4111-8111-111111111111-${hash}.json.gz`;
    const roots = [join(root, 'first'), join(root, 'second')];
    for (const directory of roots) await mkdir(join(directory, 'v1/2020-01-01'), { recursive: true });
    await writeFile(join(roots[0], location), 'corrupt'); await writeFile(join(roots[1], location), bytes);
    assert.deepEqual(await readCrawlArchive(roots, location, hash), archiveFixture());
    await assert.rejects(readCrawlArchive(roots, '../outside.json.gz', hash), /invalid archive location/);
    await writeFile(join(roots[1], location), 'also corrupt');
    await assert.rejects(readCrawlArchive(roots, location, hash), /Neither crawl archive copy/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
