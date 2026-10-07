import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { ATS_LEDGER_SEAL_SEGMENTS_PER_PASS, atsLedgerHash, sealReadyAtsV2Segments, type AtsLedgerClaim } from '../atsAcquisitionLedger';

function fixture(t: TestContext, count = 52) {
  const claim: AtsLedgerClaim = {
    batchId: 'batch', slug: 'example::CX', platform: 'oracle', workType: 'enrichment',
    claimToken: 'claim', claimFence: BigInt(1), workReceiptId: 'receipt', endpointSweepId: 'sweep',
    listingGeneration: 1, listingOffset: 1, latestObservedTotal: count, acquisitionPhase: 'enrichment', segmentSize: 25,
  };
  const batch = {
    id: claim.batchId, slug: claim.slug, platform: claim.platform, writerMode: 'v2', ledgerVersion: 2,
    activeLedgerGeneration: 1, acquisitionClaimToken: claim.claimToken, acquisitionClaimFence: claim.claimFence,
    acquisitionLeaseExpiresAt: new Date(Date.now() + 60_000), canonicalOccurrenceCount: count,
    terminalItemCount: count, sealedItemCount: 0, segmentSize: 25, operatorResetAt: null as Date | null,
    board: { checkDay: 3 },
  };
  const terminalAt = new Date('2026-10-07T14:00:00Z');
  const items = Array.from({ length: count }, (_, canonicalOrdinal) => ({
    canonicalOrdinal, rawHash: atsLedgerHash({ canonicalOrdinal }), enrichmentOverlay: { status: 'ready' },
    enrichmentVersion: 1, enrichmentStatus: 'terminal', terminalAt,
  }));
  const manifests: Prisma.AtsIngestionSegmentCreateManyInput[] = [];
  const queries: Prisma.Sql[] = [];
  let payloadReads = 0;
  let boardWrites = 0;
  let sweepWrites = 0;
  let corruptPayload = false;
  const updates: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async (query: Prisma.Sql) => {
      queries.push(query);
      // SQL semantics are additionally verified read-only against PostgreSQL.
      const candidates = [];
      for (let segmentOrdinal = 0; segmentOrdinal < Math.ceil(count / 25); segmentOrdinal++) {
        const first = segmentOrdinal * 25;
        const range = items.filter(i => i.canonicalOrdinal >= first && i.canonicalOrdinal < Math.min(first + 25, count));
        if (!manifests.some(s => s.segmentOrdinal === segmentOrdinal)
          && range.length === Math.min(25, count - first) && range.every(i => i.enrichmentStatus === 'terminal')) {
          candidates.push({ segmentOrdinal });
        }
      }
      return candidates.slice(0, ATS_LEDGER_SEAL_SEGMENTS_PER_PASS);
    },
    atsIngestionBatch: {
      findUniqueOrThrow: async () => batch,
      update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); Object.assign(batch, data); },
    },
    atsIngestionItem: { findMany: async ({ where }: { where: { OR: { canonicalOrdinal: { gte: number; lte: number } }[] } }) => {
      payloadReads++;
      const result = items.filter(i => where.OR.some(r => i.canonicalOrdinal >= r.canonicalOrdinal.gte && i.canonicalOrdinal <= r.canonicalOrdinal.lte));
      return corruptPayload ? result.slice(1) : result;
    } },
    atsIngestionSegment: { createMany: async ({ data }: { data: typeof manifests }) => { manifests.push(...data); return { count: data.length }; } },
    atsCompany: { update: async () => { boardWrites++; } },
    atsEndpointSweepReceipt: { updateMany: async () => { sweepWrites++; } },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => run(tx as unknown as Prisma.TransactionClient));
  return { claim, batch, items, manifests, queries, updates, counts: () => ({ payloadReads, boardWrites, sweepWrites }), corrupt: () => { corruptPayload = true; } };
}

test('bulk sealing preserves exact manifests, tail sizes, completion and repeat safety', async t => {
  const f = fixture(t);
  assert.deepEqual(await sealReadyAtsV2Segments({ claim: f.claim }), { sealedSegments: 3, sealedItems: 52, complete: true });
  assert.deepEqual(f.manifests.map(s => s.itemCount), [25, 25, 2]);
  assert.equal(f.counts().payloadReads, 1);
  const expected = atsLedgerHash(f.items.slice(0, 25).map(item => ({
    ordinal: item.canonicalOrdinal, rawHash: item.rawHash, overlayHash: atsLedgerHash(item.enrichmentOverlay),
    enrichmentVersion: item.enrichmentVersion, terminalAt: item.terminalAt.toISOString(),
  })));
  assert.equal(f.manifests[0].manifestHash, expected);
  assert.deepEqual(await sealReadyAtsV2Segments({ claim: f.claim }), { sealedSegments: 0, sealedItems: 0, complete: true });
  assert.equal(f.manifests.length, 3);
  assert.equal(f.batch.sealedItemCount, 52);
  assert.equal(f.counts().payloadReads, 1, 'already sealed work has no payload reads');
});

test('one missing or pending item keeps its segment open while later complete segments advance', async t => {
  const f = fixture(t);
  f.items[0].enrichmentStatus = 'pending';
  f.batch.terminalItemCount--;
  f.items.splice(30, 1);
  f.batch.terminalItemCount--;
  assert.deepEqual(await sealReadyAtsV2Segments({ claim: f.claim }), { sealedSegments: 1, sealedItems: 2, complete: false });
  assert.equal(f.manifests[0].segmentOrdinal, 2);
  assert.equal(f.updates[0].acquisitionPhase, 'enrichment');
  assert.equal(f.counts().boardWrites + f.counts().sweepWrites, 0);
});

test('large boards seal in bounded passes without advancing completion early', async t => {
  const f = fixture(t, 600);
  assert.deepEqual(await sealReadyAtsV2Segments({ claim: f.claim }), { sealedSegments: 10, sealedItems: 250, complete: false });
  assert.equal(f.updates[0].acquisitionPhase, 'sealing');
  assert.equal(f.counts().boardWrites, 0);
  await sealReadyAtsV2Segments({ claim: f.claim });
  assert.deepEqual(await sealReadyAtsV2Segments({ claim: f.claim }), { sealedSegments: 4, sealedItems: 100, complete: true });
  assert.equal(new Set(f.manifests.map(s => s.segmentOrdinal)).size, 24);
  assert.equal(f.counts().payloadReads, 3);
});

test('expired claims and inconsistent payloads cannot seal or update accounting', async t => {
  const f = fixture(t);
  await assert.rejects(sealReadyAtsV2Segments({ claim: { ...f.claim, claimFence: BigInt(2) } }), /no longer owns/);
  assert.equal(f.queries.length, 0);
  f.corrupt();
  await assert.rejects(sealReadyAtsV2Segments({ claim: f.claim }), /is not complete/);
  assert.equal(f.manifests.length + f.updates.length, 0);
});

test('operator reset drain remains separate and empty boards need no item reads', async t => {
  const f = fixture(t, 0);
  f.batch.operatorResetAt = new Date();
  assert.deepEqual(await sealReadyAtsV2Segments({ claim: f.claim }), { sealedSegments: 0, sealedItems: 0, complete: true });
  assert.equal(f.updates[0].status, 'reset_synchronized');
  assert.equal(f.counts().payloadReads + f.counts().boardWrites, 0);
});
