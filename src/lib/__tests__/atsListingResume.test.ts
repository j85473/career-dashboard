import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import { runAtsV2ListingQuantum } from '../atsAcquisitionDispatcherV2';
import {
  ATS_LEDGER_QUANTUM_SOFT_MS,
  atsLedgerHash,
  materializeAtsV2PageObservations,
  type AtsLedgerClaim,
} from '../atsAcquisitionLedger';
import { prisma } from '../prisma';

type Dependencies = NonNullable<Parameters<typeof runAtsV2ListingQuantum>[2]>;
type SavedPage = NonNullable<Awaited<ReturnType<Dependencies['readAtsV2ListingCheckpoint']>>['latestPage']> & {
  materialized: number;
};

function fixture(platform = 'greenhouse') {
  const pages: SavedPage[] = [];
  const requests: number[] = [];
  const chunks: string[] = [];
  let clock = 0;
  let chunkDuration = ATS_LEDGER_QUANTUM_SOFT_MS + 1;
  let responseCount = 750;
  let total: number | null = null;
  let phase = 'listing';
  let contacts = 0;
  const claim: AtsLedgerClaim = {
    batchId: 'batch', slug: 'test-board', platform, workType: 'coverage_listing',
    claimToken: 'claim', claimFence: BigInt(1), workReceiptId: 'receipt', endpointSweepId: null,
    listingGeneration: 1, listingOffset: 0, latestObservedTotal: null,
    acquisitionPhase: 'listing', segmentSize: 25,
  };
  const dependencies: Dependencies = {
    now: () => clock,
    readAtsV2ListingCheckpoint: async () => ({
      pendingPage: pages.find(page => page.materialized < page.responseItemCount) || null,
      latestPage: pages.at(-1) || null,
    }),
    fetchAtsBoardPage: async (_board, offset, _signal, onStart, onResponse) => {
      assert.ok(pages.every(page => page.materialized === page.responseItemCount),
        'no provider request may bypass an unfinished saved response');
      await onStart?.();
      requests.push(offset);
      await onResponse?.({ status: 200, respondedAt: new Date() });
      return {
        status: 200, metadata: {}, total,
        jobs: Array.from({ length: responseCount }, (_, i) => ({ id: String(offset + i) })),
      };
    },
    commitAtsV2ListingPage: async input => {
      const page: SavedPage = {
        id: `page-${pages.length}`, requestedOffset: input.requestedOffset,
        responseItemCount: input.jobs.length, providerTotal: input.providerTotal ?? null,
        materialized: 0,
      };
      pages.push(page);
      claim.listingOffset = input.requestedOffset + input.jobs.length;
      return {
        pageId: page.id, adopted: false, responseHash: 'hash',
        observationCount: 0, nextOffset: claim.listingOffset,
      };
    },
    materializeAtsV2PageObservations: async input => {
      const page = pages.find(page => page.id === input.pageId)!;
      chunks.push(page.id);
      const size = Math.min(250, page.responseItemCount - page.materialized);
      page.materialized += size;
      clock += chunkDuration;
      const complete = page.materialized === page.responseItemCount;
      if (input.listingComplete && pages.every(page => page.materialized === page.responseItemCount)) {
        phase = 'compaction';
      }
      return { materialized: size, complete };
    },
    recordAtsV2ListingDispatchIntent: async () => {},
    confirmAtsV2ListingContact: async () => { contacts++; },
    recordProviderSuccess: async () => {},
    recordProviderFailure: async () => null,
  };
  return {
    claim, pages, requests, chunks, dependencies,
    get phase() { return phase; },
    get contacts() { return contacts; },
    response(count: number, providerTotal: number | null) { responseCount = count; total = providerTotal; },
    chunkDuration(value: number) { chunkDuration = value; },
    async turn(signal?: AbortSignal) {
      // A new claim after a yield has the persisted offset and a fresh owner.
      const current = { ...claim, acquisitionPhase: phase };
      const result = await runAtsV2ListingQuantum(current, signal, dependencies);
      claim.workType = 'listing_continuation';
      return result;
    },
  };
}

for (const platform of ['greenhouse', 'lever']) {
  test(`${platform} saves a large response across timed-out turns with exactly one fetch`, async () => {
    const f = fixture(platform);
    assert.equal((await f.turn()).yieldReason, 'materialization_budget');
    assert.equal(f.claim.listingOffset, 750);
    assert.equal(f.pages[0].materialized, 250);
    await f.turn();
    assert.equal(f.pages[0].materialized, 500);
    await f.turn();
    assert.equal(f.phase, 'compaction');
    assert.deepEqual(f.requests, [0]);
    assert.equal(f.contacts, 1, 'local resume must not invent another provider contact');
    assert.equal(f.pages.length, 1);
    assert.deepEqual(f.chunks, ['page-0', 'page-0', 'page-0']);
  });
}

test('a restart after committing the final response but before its first chunk resumes the saved body', async () => {
  const f = fixture();
  f.pages.push({ id: 'before-crash', requestedOffset: 0, responseItemCount: 750, providerTotal: null, materialized: 0 });
  f.claim.listingOffset = 750;
  f.claim.workType = 'listing_continuation';
  f.chunkDuration(1);
  assert.equal((await f.turn()).yieldReason, 'listing_complete');
  assert.equal(f.phase, 'compaction');
  assert.equal(f.pages[0].materialized, 750);
  assert.deepEqual(f.requests, []);
});

test('pagination resumes at the committed offset only after the earlier response is saved', async () => {
  const f = fixture('smartrecruiters');
  f.pages.push({ id: 'first', requestedOffset: 0, responseItemCount: 100, providerTotal: 125, materialized: 50 });
  f.claim.listingOffset = 100;
  f.claim.workType = 'listing_continuation';
  f.response(25, 125);
  f.chunkDuration(1);
  assert.equal((await f.turn()).yieldReason, 'listing_complete');
  assert.deepEqual(f.requests, [100]);
  assert.equal(f.pages[0].materialized, 100);
  assert.equal(f.phase, 'compaction');
});

test('already saved duplicate responses drain without another fetch or premature compaction', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    f.pages.push({ id: `old-${i}`, requestedOffset: i * 500, responseItemCount: 500, providerTotal: null, materialized: 250 });
  }
  f.claim.listingOffset = 1000;
  await f.turn();
  assert.equal(f.phase, 'listing');
  assert.equal(f.pages[1].materialized, 250);
  await f.turn();
  assert.equal(f.phase, 'compaction');
  assert.deepEqual(f.requests, []);
});

test('an abort between saved chunks stops local work without issuing a request', async () => {
  const f = fixture();
  f.pages.push({ id: 'saved', requestedOffset: 0, responseItemCount: 750, providerTotal: null, materialized: 0 });
  f.claim.listingOffset = 750;
  f.chunkDuration(1);
  const controller = new AbortController();
  const materialize = f.dependencies.materializeAtsV2PageObservations;
  f.dependencies.materializeAtsV2PageObservations = async input => {
    const result = await materialize(input);
    controller.abort(new Error('operator pause'));
    return result;
  };
  await assert.rejects(f.turn(controller.signal), /operator pause/);
  assert.equal(f.pages[0].materialized, 250);
  assert.deepEqual(f.requests, []);
});

test('ledger materialization retains every saved page and advances only after the last one', async t => {
  const f = fixture();
  const body = { metadata: {}, jobs: [{ id: 'a' }, { id: 'b' }], total: null };
  const page = {
    id: 'saved', generation: 1, responseItemCount: 2, materializationOffset: 1,
    materializationCompleteAt: null as Date | null,
    rawBody: body, rawBodyHash: atsLedgerHash(body), respondedAt: new Date(),
  };
  let otherPendingPages = 1;
  const writes: Array<{ acquisitionPhase: string; rawObservationCount: { increment: number } }> = [];
  const observations: unknown[] = [];
  const tx = {
    atsIngestionBatch: {
      findUniqueOrThrow: async () => ({
        id: 'batch', writerMode: 'v2', ledgerVersion: 2, activeLedgerGeneration: 1,
        acquisitionClaimToken: 'claim', acquisitionClaimFence: BigInt(1),
        acquisitionLeaseExpiresAt: new Date(Date.now() + 60_000),
      }),
      update: async ({ data }: { data: typeof writes[number] }) => { writes.push(data); },
    },
    atsIngestionPage: {
      findFirstOrThrow: async () => page,
      update: async ({ data }: { data: Partial<typeof page> }) => { Object.assign(page, data); },
      count: async () => otherPendingPages,
    },
    atsListingObservation: {
      createMany: async ({ data }: { data: unknown[] }) => { observations.push(...data); },
    },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient));
  await materializeAtsV2PageObservations({ claim: f.claim, pageId: 'saved', listingComplete: true });
  assert.equal(writes[0].acquisitionPhase, 'listing');
  assert.equal(writes[0].rawObservationCount.increment, 1);
  assert.equal(observations.length, 1, 'resume inserts only the missing row');
  // Replaying a completed page is idempotent.
  await materializeAtsV2PageObservations({ claim: f.claim, pageId: 'saved', listingComplete: true });
  assert.equal(writes.length, 1);
  otherPendingPages = 0;
  page.id = 'last-saved';
  page.materializationCompleteAt = null;
  page.materializationOffset = 1;
  await materializeAtsV2PageObservations({ claim: f.claim, pageId: 'last-saved', listingComplete: true });
  assert.equal(writes[1].acquisitionPhase, 'compaction');
  assert.equal(observations.length, 2);
});
