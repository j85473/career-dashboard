import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import { runAtsV2ListingQuantum } from '../atsAcquisitionDispatcherV2';
import {
  ATS_LEDGER_QUANTUM_SOFT_MS,
  atsLedgerHash,
  commitAtsV2ListingPage,
  completeAtsV2ListingAtSavedEnd,
  materializeAtsV2PageObservations,
  type AtsLedgerClaim,
} from '../atsAcquisitionLedger';
import { prisma } from '../prisma';
import { AtsBoardContentTypeError } from '../atsAcquisition';
import { workdayPartialListingRetryAt } from '../atsAcquisitionDispatcherV2';

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
  let responseMetadata: Record<string, unknown> = {};
  let phase = 'listing';
  let contacts = 0;
  let responded = 0;
  let pauseMs = 0;
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
    completeAtsV2ListingAtSavedEnd: async () => false,
    fetchAtsBoardPage: async (_board, offset, _signal, onStart, onResponse) => {
      assert.ok(pages.every(page => page.materialized === page.responseItemCount),
        'no provider request may bypass an unfinished saved response');
      await onStart?.();
      requests.push(offset);
      await onResponse?.({ status: 200, respondedAt: new Date() });
      return {
        status: 200, metadata: responseMetadata, total,
        jobs: Array.from({ length: responseCount }, (_, i) => ({ id: String(offset + i) })),
      };
    },
    commitAtsV2ListingPage: async input => {
      const page: SavedPage = {
        id: `page-${pages.length}`, requestedOffset: input.requestedOffset,
        responseItemCount: input.jobs.length, providerTotal: input.providerTotal ?? null,
        metadata: input.metadata as Prisma.JsonValue || {}, materialized: 0,
      };
      pages.push(page);
      claim.listingOffset = input.requestedOffset + input.jobs.length;
      return {
        pageId: page.id, adopted: false, responseHash: 'hash',
        observationCount: 0, nextOffset: claim.listingOffset,
        listingComplete: input.listingComplete,
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
    markAtsV2BoardResponded: async () => { responded++; },
    recordProviderSuccess: async () => {},
    recordProviderFailure: async () => null,
    platformPauseRemainingMs: () => pauseMs,
    partialListingRetryAt: async (_claim, now) => new Date(now.getTime() + 15 * 60_000),
  };
  return {
    claim, pages, requests, chunks, dependencies,
    get phase() { return phase; },
    get contacts() { return contacts; },
    get responded() { return responded; },
    get clock() { return clock; },
    response(count: number, providerTotal: number | null, metadata: Record<string, unknown> = {}) { responseCount = count; total = providerTotal; responseMetadata = metadata; },
    chunkDuration(value: number) { chunkDuration = value; },
    pause(value: number) { pauseMs = value; },
    async turn(signal?: AbortSignal) {
      // A new claim after a yield has the persisted offset and a fresh owner.
      const current = { ...claim, acquisitionPhase: phase };
      const result = await runAtsV2ListingQuantum(current, signal, dependencies);
      claim.workType = 'listing_continuation';
      return result;
    },
  };
}

test('Workday HTML on a later page retains saved listings and does not age the board or pause the provider', async () => {
  const f = fixture('workday');
  f.response(20, 100);
  f.chunkDuration(0);
  await f.turn();
  assert.equal(f.claim.listingOffset, 20);
  const saved = structuredClone(f.pages);
  f.dependencies.fetchAtsBoardPage = async (_board, offset, _signal, onStart, onResponse) => {
    assert.equal(offset, 20);
    await onStart?.();
    await onResponse?.({ status: 200, respondedAt: new Date() });
    throw new AtsBoardContentTypeError('workday', 'text/html');
  };
  f.dependencies.recordProviderFailure = async () => { throw new Error('One refused page cannot pause Workday'); };
  let retryCalls = 0;
  f.dependencies.partialListingRetryAt = async (_claim, now) => {
    retryCalls++;
    return new Date(now.getTime() + 60 * 60_000);
  };
  const outcome = await f.turn();
  assert.equal(outcome.yieldReason, 'error');
  assert.equal(outcome.boardFailure, false);
  assert.equal(outcome.failureScope, 'board_control');
  assert.equal(retryCalls, 1);
  assert.deepEqual(f.pages, saved);
  assert.equal(f.claim.listingOffset, 20);
});

test('Workday HTML before any valid page stays a board failure', async () => {
  const f = fixture('workday');
  f.dependencies.fetchAtsBoardPage = async (_board, _offset, _signal, onStart) => {
    await onStart?.();
    throw new AtsBoardContentTypeError('workday', 'text/html');
  };
  f.dependencies.partialListingRetryAt = async () => { throw new Error('No partial batch exists'); };
  const outcome = await f.turn();
  assert.equal(outcome.boardFailure, true);
  assert.equal(outcome.failureScope, 'board');
  assert.equal(f.pages.length, 0);
});

test('partial Workday retries escalate from receipts and reset after productive progress', async () => {
  const original = prisma.atsAcquisitionWorkReceipt.findMany;
  const refusal = { error: 'workday board returned text/html instead of the expected payload format', yieldReason: 'error', itemsProgressed: 0 };
  const now = new Date('2026-10-09T19:00:00Z');
  let receipts: typeof refusal[] = [];
  prisma.atsAcquisitionWorkReceipt.findMany = (async () => receipts) as typeof original;
  try {
    const f = fixture('workday');
    for (const [prior, minutes] of [[0, 15], [1, 60], [2, 360], [3, 360]]) {
      receipts = Array(prior).fill(refusal);
      const retry = await workdayPartialListingRetryAt(f.claim, now);
      assert.equal(retry.getTime() - now.getTime(), minutes * 60_000);
    }
    receipts = [{ ...refusal, error: '', yieldReason: 'page_budget', itemsProgressed: 20 }, refusal, refusal];
    assert.equal((await workdayPartialListingRetryAt(f.claim, now)).getTime() - now.getTime(), 15 * 60_000);
  } finally { prisma.atsAcquisitionWorkReceipt.findMany = original; }
});

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
    // The board is credited with answering once, and only because the response
    // parsed as a listing. A page served from the vendor's own marketing site
    // reaches the endpoint but never gets here.
    assert.equal(f.responded, 1, 'a readable listing credits the board exactly once');
    assert.equal(f.pages.length, 1);
    assert.deepEqual(f.chunks, ['page-0', 'page-0', 'page-0']);
  });
}

test('a restart after committing the final response but before its first chunk resumes the saved body', async () => {
  const f = fixture();
  f.pages.push({ id: 'before-crash', requestedOffset: 0, responseItemCount: 750, providerTotal: null, metadata: {}, materialized: 0 });
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
  f.pages.push({ id: 'first', requestedOffset: 0, responseItemCount: 100, providerTotal: 125, metadata: {}, materialized: 50 });
  f.claim.listingOffset = 100;
  f.claim.workType = 'listing_continuation';
  f.response(25, 125);
  f.chunkDuration(1);
  assert.equal((await f.turn()).yieldReason, 'listing_complete');
  assert.deepEqual(f.requests, [100]);
  assert.equal(f.pages[0].materialized, 100);
  assert.equal(f.phase, 'compaction');
});

test('a repeated Workday response is saved once and closes the listing phase', async t => {
  const claim = fixture('workday').claim;
  claim.listingOffset = 100;
  const writes: string[] = [];
  const tx = {
    atsIngestionBatch: {
      findUniqueOrThrow: async () => ({
        id: claim.batchId, writerMode: 'v2', ledgerVersion: 2,
        activeLedgerGeneration: 1, acquisitionClaimToken: claim.claimToken,
        acquisitionClaimFence: claim.claimFence,
        acquisitionLeaseExpiresAt: new Date(Date.now() + 60_000),
        acquisitionPhase: 'listing', listingOffset: 100,
      }),
      updateMany: async ({ data }: { data: { acquisitionPhase: string } }) => {
        writes.push(data.acquisitionPhase);
        return { count: 1 };
      },
    },
    atsIngestionPage: {
      findFirst: async () => ({ id: 'earlier-identical-page' }),
      findUnique: async () => null,
      create: async () => {},
    },
    atsListingObservation: { createMany: async () => {} },
    atsAcquisitionWorkReceipt: { update: async () => {} },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient));
  const result = await commitAtsV2ListingPage({
    claim, requestedOffset: 100, requestedLimit: 20, providerTotal: 100,
    jobs: Array.from({ length: 20 }, (_, i) => ({ id: String(i) })),
    requestedAt: new Date(), respondedAt: new Date(), httpStatus: 200,
    listingComplete: false,
  });
  assert.equal(result.listingComplete, true);
  assert.deepEqual(writes, ['compaction']);
});

test('a saved repeated Workday page completes under its claim without another request', async t => {
  const f = fixture('workday');
  f.claim.listingOffset = 2620;
  const transitions: string[] = [];
  const tx = {
    atsIngestionBatch: {
      findUniqueOrThrow: async () => ({
        id: f.claim.batchId, writerMode: 'v2', ledgerVersion: 2,
        activeLedgerGeneration: 1, acquisitionClaimToken: f.claim.claimToken,
        acquisitionClaimFence: f.claim.claimFence,
        acquisitionLeaseExpiresAt: new Date(Date.now() + 60_000),
        acquisitionPhase: 'listing', listingGeneration: 1, listingOffset: 2620,
      }),
      updateMany: async ({ data }: { data: { acquisitionPhase: string } }) => {
        transitions.push(data.acquisitionPhase);
        return { count: 1 };
      },
    },
    atsIngestionPage: {
      findFirst: async ({ orderBy }: { orderBy?: { requestedOffset: string } }) =>
        orderBy ? {
          requestedOffset: 2600, responseItemCount: 20, requestedLimit: 20,
          providerTotal: 99, identityMultisetHash: 'same-page',
          materializationCompleteAt: new Date(),
        } : { id: 'earlier-identical-page' },
      count: async () => 0,
    },
    atsAcquisitionWorkReceipt: { update: async () => {} },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient));
  assert.equal(await completeAtsV2ListingAtSavedEnd(f.claim), true);
  assert.deepEqual(transitions, ['compaction']);
});

test('already saved duplicate responses drain without another fetch or premature compaction', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    f.pages.push({ id: `old-${i}`, requestedOffset: i * 500, responseItemCount: 500, providerTotal: null, metadata: {}, materialized: 250 });
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
  f.pages.push({ id: 'saved', requestedOffset: 0, responseItemCount: 750, providerTotal: null, metadata: {}, materialized: 0 });
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

test('a platform pause yields the lane instead of being slept out inside it', async () => {
  const f = fixture();
  f.pause(60_000);
  const outcome = await f.turn();

  // The whole point: the worker gives the slot back rather than holding it for
  // the pause. Personio's pause was waited out in-slot, and because that wait
  // sits inside the per-platform request queue the waits added up -- eight
  // lanes, 485 seconds each, to make one refused request.
  assert.equal(outcome.yieldReason, 'platform_paused');
  assert.deepEqual(f.requests, [], 'a paused platform must not be contacted');
  assert.equal(f.contacts, 0);
  assert.equal(f.clock, 0, 'the quantum must not spend time waiting for the pause');

  // The batch comes back when the pause ends, so the lane is not re-offered
  // work it still cannot do.
  assert.equal(outcome.nextAcquireAt?.getTime(), 60_000);

  // Not an error: the request never left, so nothing here may be read as the
  // board failing. Only that verdict moves a board's rotation.
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.boardFailure, undefined);
});

test('a pause too short to be worth a claim cycle is still waited out', async () => {
  const f = fixture();
  f.pause(500);
  f.chunkDuration(1);
  f.response(10, 10);
  assert.equal((await f.turn()).yieldReason, 'listing_complete');
  assert.deepEqual(f.requests, [0], 'a sub-threshold pause must not cost a whole turn');
});

test('a pause never strands rows the board already handed us', async () => {
  const f = fixture();
  // A response is saved but not yet materialized, and the platform pauses
  // before the next request. Those rows need no contact to finish, so yielding
  // in front of them would park downloaded work behind a throttle it has no
  // part in.
  f.pages.push({ id: 'saved', requestedOffset: 0, responseItemCount: 750, providerTotal: 750, metadata: {}, materialized: 0 });
  f.claim.listingOffset = 750;
  f.claim.workType = 'listing_continuation';
  f.chunkDuration(1);
  f.pause(60_000);

  assert.equal((await f.turn()).yieldReason, 'listing_complete');
  assert.equal(f.pages[0].materialized, 750, 'saved rows drain while the platform is paused');
  assert.deepEqual(f.requests, [], 'draining saved rows must not contact the paused platform');
});


test('Teamtailor resumes its saved continuation and completes a final full page', async () => {
  const f = fixture('teamtailor');
  f.pages.push({ id: 'first', requestedOffset: 0, responseItemCount: 100, providerTotal: null,
    metadata: { listingHasMore: true }, materialized: 50 });
  f.claim.listingOffset = 100;
  f.response(100, null, { listingHasMore: false });
  f.chunkDuration(1);
  assert.equal((await f.turn()).yieldReason, 'listing_complete');
  assert.deepEqual(f.requests, [100]);
  assert.equal(f.phase, 'compaction');
});

test('Teamtailor final-page metadata survives a crash before materialization', async () => {
  const f = fixture('teamtailor');
  f.pages.push({ id: 'final', requestedOffset: 100, responseItemCount: 100, providerTotal: null,
    metadata: { listingHasMore: false }, materialized: 0 });
  f.claim.listingOffset = 200;
  f.chunkDuration(1);
  assert.equal((await f.turn()).yieldReason, 'listing_complete');
  assert.deepEqual(f.requests, []);
  assert.equal(f.phase, 'compaction');
});

test('Oracle continues past a nonempty short page and ends at the next empty result', async () => {
  const f = fixture('oracle');
  f.response(21, 58);
  f.chunkDuration(1);
  assert.equal((await f.turn()).yieldReason, 'page_budget');
  assert.equal(f.claim.listingOffset, 21);
  assert.equal(f.pages[0].materialized, 21);
  f.response(0, 59); // The provider total can drift without inventing another job.
  assert.equal((await f.turn()).yieldReason, 'listing_complete');
  assert.deepEqual(f.requests, [0, 21]);
  assert.equal(f.pages.length, 2);
  assert.equal(f.pages[0].responseItemCount, 21);
});

test('a saved Oracle empty end is recovered before any re-fetch or provider pause', async () => {
  const f = fixture('oracle');
  f.pages.push({ id: 'saved-empty', requestedOffset: 996, responseItemCount: 0,
    providerTotal: 997, metadata: {}, materialized: 0 });
  f.claim.listingOffset = 996;
  f.claim.workType = 'listing_continuation';
  f.pause(60_000);
  let recoveries = 0;
  f.dependencies.completeAtsV2ListingAtSavedEnd = async () => { recoveries++; return true; };
  assert.equal((await f.turn()).yieldReason, 'listing_complete');
  assert.equal(recoveries, 1);
  assert.deepEqual(f.requests, []);
  assert.equal(f.contacts, 0);
});

test('Oracle saved-end recovery keeps pages immutable and records a fenced receipt', async t => {
  const f = fixture('oracle');
  f.claim.listingOffset = 996;
  const page = {
    requestedOffset: 996, responseItemCount: 0, requestedLimit: 25,
    providerTotal: 997, identityMultisetHash: 'empty', responseHash: 'original-response',
    httpStatus: 200, materializationCompleteAt: new Date(),
  };
  const batch = {
    id: f.claim.batchId, writerMode: 'v2', ledgerVersion: 2,
    activeLedgerGeneration: 1, acquisitionClaimToken: f.claim.claimToken,
    acquisitionClaimFence: f.claim.claimFence,
    acquisitionLeaseExpiresAt: new Date(Date.now() + 60_000),
    acquisitionPhase: 'listing', listingGeneration: 1, listingOffset: 996,
  };
  let pendingPages = 0;
  let affectedRows = 1;
  const transitions: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const receipts: Array<{ data: Record<string, unknown> }> = [];
  const tx = {
    atsIngestionBatch: {
      findUniqueOrThrow: async () => batch,
      updateMany: async (input: typeof transitions[number]) => {
        transitions.push(input);
        return { count: affectedRows };
      },
    },
    atsIngestionPage: { findFirst: async () => page, count: async () => pendingPages },
    atsAcquisitionWorkReceipt: { update: async (input: typeof receipts[number]) => { receipts.push(input); } },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient));
  const original = structuredClone(page);
  assert.equal(await completeAtsV2ListingAtSavedEnd(f.claim), true);
  assert.deepEqual(page, original);
  assert.equal(transitions[0].data.acquisitionPhase, 'compaction');
  assert.equal(transitions[0].where.acquisitionClaimFence, f.claim.claimFence);
  assert.equal(transitions[0].where.listingOffset, 996);
  assert.equal(receipts[0].data.checkpointHash, 'original-response');
  assert.equal(receipts[0].data.transactionPhase, 'saved_listing_end');
  transitions.length = 0;
  receipts.length = 0;

  pendingPages = 1;
  assert.equal(await completeAtsV2ListingAtSavedEnd(f.claim), false);
  pendingPages = 0;
  page.responseItemCount = 1;
  batch.listingOffset = 997;
  assert.equal(await completeAtsV2ListingAtSavedEnd(f.claim), false);
  page.responseItemCount = 0;
  assert.equal(await completeAtsV2ListingAtSavedEnd(f.claim), false, 'cursor mismatch must fail closed');
  batch.listingOffset = 996;
  page.httpStatus = 500;
  assert.equal(await completeAtsV2ListingAtSavedEnd(f.claim), false);
  page.httpStatus = 200;
  batch.acquisitionClaimToken = 'replacement-owner';
  await assert.rejects(completeAtsV2ListingAtSavedEnd(f.claim), /no longer owns/);
  assert.equal(transitions.length, 0);
  assert.equal(receipts.length, 0);
  batch.acquisitionClaimToken = f.claim.claimToken;
  affectedRows = 0;
  await assert.rejects(completeAtsV2ListingAtSavedEnd(f.claim), /lost its saved-end fence/);
  assert.equal(receipts.length, 0, 'a failed fence must not credit recovery');
});
