/** Destructive fixture for an EMPTY, schema-only scratch database. Never production.
 * DATABASE_URL must name career_ats_drain_fixture_20261030. */
import assert from 'node:assert/strict';
import { prisma } from '../../src/lib/prisma';
import { commitAtsV2ListingPage, resolveNextAtsV2ObservationChunk,
  terminalizeAtsV2NoNetworkItems, sealReadyAtsV2Segments, publishReadyAtsV2Segments,
  materializeAtsV2PageObservations, claimNextAtsV2Segment, completeAtsV2SegmentProcessing, type AtsLedgerClaim } from '../../src/lib/atsAcquisitionLedger';

async function main() {
  assert.equal(new URL(process.env.DATABASE_URL!).pathname, '/career_ats_drain_fixture_20261030');
  assert.equal(await prisma.atsCompany.count(), 0, 'Use an empty schema-only fixture database');
  await prisma.atsAcquisitionRuntimeGate.create({ data: { id: 'global' } });
  await prisma.atsCompany.create({ data: { slug: 'prefix-fixture', platform: 'greenhouse', acquisitionEngine: 'v2', checkDay: 5 } });
  const batch = await prisma.atsIngestionBatch.create({ data: {
    slug: 'prefix-fixture', platform: 'greenhouse', writerMode: 'v2', ledgerVersion: 2,
    activeLedgerGeneration: 1, listingGeneration: 1, acquisitionClaimToken: 'fixture-claim',
    acquisitionClaimFence: BigInt(1), acquisitionLeaseExpiresAt: new Date(Date.now() + 600_000),
  } });
  const receipt = await prisma.atsAcquisitionWorkReceipt.create({ data: { batchId: batch.id, workType: 'listing_continuation' } });
  const claim: AtsLedgerClaim = { batchId: batch.id, slug: batch.slug, platform: batch.platform,
    workType: 'listing_continuation', claimToken: 'fixture-claim', claimFence: BigInt(1),
    workReceiptId: receipt.id, endpointSweepId: null, listingGeneration: 1,
    listingOffset: 0, latestObservedTotal: null, acquisitionPhase: 'listing', segmentSize: 25 };
  async function append(count: number, end = false) {
    const saved = await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: batch.id } });
    return commitAtsV2ListingPage({ claim, requestedOffset: saved.listingOffset, requestedLimit: Math.max(1, count),
      providerTotal: 400, jobs: Array.from({ length: count }, (_, i) => ({
        id: String(saved.listingOffset + i), title: 'Registered Nurse',
        absolute_url: `https://example.com/jobs/${saved.listingOffset + i}`, content: 'A nursing job',
      })), requestedAt: new Date(), respondedAt: new Date(), httpStatus: 200, listingComplete: end });
  }
  async function drain() {
    await resolveNextAtsV2ObservationChunk({ claim, allowListingPrefix: true });
    await terminalizeAtsV2NoNetworkItems({ claim, allowListingPrefix: true });
    return sealReadyAtsV2Segments({ claim, allowListingPrefix: true });
  }
  await append(30);
  assert.deepEqual(await drain(), { sealedSegments: 1, sealedItems: 25, complete: false });
  const first = await prisma.atsIngestionSegment.findMany({ where: { batchId: batch.id } });
  assert.equal((await publishReadyAtsV2Segments({ batchId: batch.id, highWatermark: 1000, lowWatermark: 500 })).publishedItems, 25);
  const earlySegment = await claimNextAtsV2Segment();
  assert.ok(earlySegment);
  assert.equal(earlySegment.synchronizedAt, null);
  assert.equal(await completeAtsV2SegmentProcessing({ segmentId: earlySegment.id,
    leaseToken: earlySegment.leaseToken, counters: { seen: 25, inserted: 0, duplicates: 0,
      filtered: 25, processingErrors: 0, providerErrors: 0 } }), true);
  const partial = await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: batch.id } });
  assert.equal(partial.acquisitionPhase, 'listing');
  assert.equal(partial.listingOffset, 30);
  assert.equal(partial.listingCompletedAt, null);
  assert.equal(partial.synchronizedAt, null);
  assert.equal(partial.processedAt, null);
  assert.equal(partial.publishedItemCount, 25);
  await append(23);
  assert.deepEqual(await drain(), { sealedSegments: 1, sealedItems: 25, complete: false });
  assert.deepEqual(await drain(), { sealedSegments: 0, sealedItems: 0, complete: false });
  assert.equal((await prisma.atsIngestionSegment.findUniqueOrThrow({ where: { id: first[0].id } })).manifestHash, first[0].manifestHash);
  await assert.rejects(resolveNextAtsV2ObservationChunk({ claim: { ...claim, claimFence: BigInt(2) }, allowListingPrefix: true }));
  // A large saved response must be completely materialized before assigning ordinals.
  const pending = await append(300);
  assert.equal((await resolveNextAtsV2ObservationChunk({ claim, allowListingPrefix: true })).resolved, 0);
  await materializeAtsV2PageObservations({ claim, pageId: pending.pageId, listingComplete: false });
  assert.equal((await resolveNextAtsV2ObservationChunk({ claim, allowListingPrefix: true })).resolved, 0);
  await materializeAtsV2PageObservations({ claim, pageId: pending.pageId, listingComplete: false });
  await drain(); await drain();
  assert.equal((await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: batch.id } })).sealedItemCount, 350);
  await append(0, true);
  await resolveNextAtsV2ObservationChunk({ claim });
  const end = await sealReadyAtsV2Segments({ claim });
  assert.deepEqual(end, { sealedSegments: 1, sealedItems: 3, complete: true });
  const complete = await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: batch.id } });
  assert.equal(complete.listingOffset, 353);
  assert.equal(complete.acquisitionPhase, 'synchronized');
  assert.equal(complete.rawObservationCount, 353);
  assert.equal(complete.canonicalOccurrenceCount, 353);
  assert.equal(await prisma.atsListingObservation.count(), 353);
  assert.equal(complete.processedAt, null);
  console.log('PASS: partial publication, immutable seals, growing tail, materialization barrier, stale fence, final reconciliation, preserved offsets and observations');
}
main().finally(() => prisma.$disconnect()).catch(e => { console.error(e); process.exitCode = 1; });
