import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  atsLedgerHash, emptyAtsListingResponseOverlay, resolveNextAtsV2ObservationChunk,
  type AtsLedgerClaim,
} from '../atsAcquisitionLedger';
import { ATS_INVALID_PROVIDER_RESPONSE_REASON, readAtsJobEnrichmentMarker } from '../atsJobEnrichment';

const empty = { rawJson: {}, rawHash: atsLedgerHash({}), providerSourceId: null };

test('only the original hash-proven empty response receives an invalid disposition', () => {
  const now = new Date('2026-10-06T15:00:00Z');
  const overlay = emptyAtsListingResponseOverlay(empty, 'workday', now);
  const marker = readAtsJobEnrichmentMarker(overlay!);
  assert.equal(marker?.reason, ATS_INVALID_PROVIDER_RESPONSE_REASON);
  assert.equal(marker?.attempted, false);
  for (const observation of [
    { ...empty, rawJson: null }, { ...empty, rawJson: [] },
    { ...empty, rawHash: atsLedgerHash({ title: 'lost content' }) },
    { ...empty, providerSourceId: 'known-job' },
    { ...empty, rawJson: { title: 'existing content' } },
  ]) assert.equal(emptyAtsListingResponseOverlay(observation, 'workday', now), null);
});

function fixture(t: TestContext) {
  const claim: AtsLedgerClaim = {
    batchId: 'batch', slug: 'freudenberg.wd3::freudenberg-group', platform: 'workday',
    workType: 'compaction', claimToken: 'claim', claimFence: BigInt(1),
    workReceiptId: 'receipt', endpointSweepId: null, listingGeneration: 1,
    listingOffset: 2, latestObservedTotal: 2, acquisitionPhase: 'compaction', segmentSize: 25,
  };
  const batch = {
    id: claim.batchId, slug: claim.slug, platform: claim.platform,
    writerMode: 'v2', ledgerVersion: 2, activeLedgerGeneration: 1,
    acquisitionClaimToken: claim.claimToken, acquisitionClaimFence: claim.claimFence,
    acquisitionLeaseExpiresAt: new Date(Date.now() + 60_000), acquisitionPhase: 'compaction',
    rawObservationCount: 2, canonicalOccurrenceCount: 0, compactedOccurrenceCount: 0,
  };
  const valid = { title: 'Channel Manager', externalPath: '/job/Channel-Manager_R123' };
  const observations = [
    { id: 'empty', ...structuredClone(empty) },
    { id: 'valid', rawJson: valid, rawHash: atsLedgerHash(valid), providerSourceId: 'R123' },
  ];
  const items: Prisma.AtsIngestionItemCreateManyInput[] = [];
  const resolutions: Prisma.AtsListingObservationResolutionCreateManyInput[] = [];
  const updates: Record<string, unknown>[] = [];
  const receipts: Record<string, unknown>[] = [];
  const tx = {
    $queryRaw: async () => [],
    atsIngestionBatch: {
      findUniqueOrThrow: async () => batch,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data); Object.assign(batch, data);
      },
    },
    atsListingObservation: { findMany: async () => observations.filter(o => !resolutions.some(r => r.observationId === o.id)) },
    atsIngestionItem: { createMany: async ({ data }: { data: typeof items }) => { items.push(...data); } },
    atsListingObservationResolution: { createMany: async ({ data }: { data: typeof resolutions }) => { resolutions.push(...data); } },
    atsAcquisitionWorkReceipt: { update: async ({ data }: { data: Record<string, unknown> }) => { receipts.push(data); } },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => run(tx as unknown as Prisma.TransactionClient));
  return { claim, batch, observations, items, resolutions, updates, receipts };
}

test('an empty response remains auditable while valid work advances, without duplicate or replay inflation', async t => {
  const f = fixture(t);
  const original = structuredClone(f.observations);
  assert.deepEqual(await resolveNextAtsV2ObservationChunk({ claim: f.claim }), {
    resolved: 2, retained: 2, compacted: 0, complete: true,
  });
  assert.deepEqual(f.observations, original, 'the immutable source must never be rewritten');
  assert.equal(f.items[0].enrichmentStatus, 'terminal');
  assert.equal(f.items[0].enrichmentReason, ATS_INVALID_PROVIDER_RESPONSE_REASON);
  assert.ok(f.items[0].terminalAt instanceof Date);
  assert.deepEqual(f.items[0].rawJson, {});
  assert.equal(f.items[1].enrichmentStatus, undefined, 'valid work remains available for enrichment');
  assert.equal(f.resolutions[0].resolutionType, ATS_INVALID_PROVIDER_RESPONSE_REASON);
  assert.equal(f.resolutions[1].resolutionType, 'canonical_item');
  assert.equal(f.batch.canonicalOccurrenceCount + f.batch.compactedOccurrenceCount, f.batch.rawObservationCount);
  assert.deepEqual(f.updates[0].terminalItemCount, { increment: 1 });
  assert.deepEqual(f.receipts[0].itemsTerminalized, { increment: 1 });
  await resolveNextAtsV2ObservationChunk({ claim: f.claim });
  assert.equal(f.items.length, 2);
  assert.equal(f.resolutions.length, 2);
  assert.equal(f.receipts.length, 1);
});

test('lost nonempty content still stops the batch before any ledger writes', async t => {
  const f = fixture(t);
  f.observations[0].rawHash = atsLedgerHash({ title: 'lost' });
  await assert.rejects(resolveNextAtsV2ObservationChunk({ claim: f.claim }), /without materialized JSON/);
  assert.equal(f.items.length + f.resolutions.length + f.updates.length, 0);
});

test('an expired or replaced worker cannot dispose of an empty response', async t => {
  const f = fixture(t);
  await assert.rejects(resolveNextAtsV2ObservationChunk({ claim: { ...f.claim, claimFence: BigInt(2) } }), /no longer owns/);
  assert.equal(f.items.length + f.resolutions.length + f.updates.length, 0);
});
