import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupAtsQueueHolds, summarizeAtsHoldReason } from '../atsQueueTelemetry';
import { atsRetryLabel, type AtsQueueSnapshot } from '../atsQueueSnapshot';
import { AtsQueuePanel } from '../../components/AtsQueuePanel';
import { deriveAtsAcquisitionState, type AtsDistributedTelemetry } from '../atsDistributedTelemetry';

const observedAt = '2026-10-12T20:55:00.000Z';
const baseline: AtsDistributedTelemetry = {
  remoteSlots: 8, piSlots: 0, globalSlotLimit: 8, localSlotReserve: 0, admissionState: 'open',
  boardsContactedLastHour: 0, lastContactAt: new Date('2026-10-12T20:00:00Z'), lastProgressAt: null,
  rotationDay: 1, cohortTotal: 10319, cohortSwept: 10232, cohortReadyNow: 0, dueBatches: 0,
  nextUnlockAt: new Date('2026-10-12T21:07:50Z'), unlockWithinHour: 1,
  weekActiveBoards: 73811, weekCoveredBoards: 73714, stagingItems: 882, stagingBytes: 7357448,
  stagingItemLimit: 100000, stagingByteLimit: 1500000000, stagingBlocked: false, stagingHeldBoards: 0,
  observedAt: new Date(observedAt),
};

test('held persistence cannot cause acquisition to be stuck; genuinely due work still can', () => {
  assert.equal(deriveAtsAcquisitionState(baseline, new Date(observedAt)), 'waiting');
  assert.equal(deriveAtsAcquisitionState({ ...baseline, stagingBlocked: true }, new Date(observedAt)), 'waiting');
  assert.equal(deriveAtsAcquisitionState({ ...baseline, globalReadyNow: 1, globalLastContactAt: new Date(observedAt) }, new Date(observedAt)), 'working');
  assert.equal(deriveAtsAcquisitionState({ ...baseline, dueBatches: 1 }, new Date(observedAt)), 'stuck');
  assert.equal(deriveAtsAcquisitionState({ ...baseline, globalReadyNow: 3 }, new Date(observedAt)), 'stuck');
  assert.equal(deriveAtsAcquisitionState({ ...baseline, dueBatches: 1, lastProgressAt: new Date(observedAt) }, new Date(observedAt)), 'working');
  const finished = { ...baseline, cohortSwept: baseline.cohortTotal };
  assert.equal(deriveAtsAcquisitionState(finished, new Date(observedAt)), 'done');
  assert.equal(deriveAtsAcquisitionState({ ...finished, dueBatches: 1 }, new Date(observedAt)), 'stuck');
  assert.equal(deriveAtsAcquisitionState({ ...finished, globalReadyNow: 1, lastContactAt: new Date(observedAt) }, new Date(observedAt)), 'working');
});

test('grouped holds preserve every stage count, remaining item and retry range', () => {
  const base = { stage: 'Acquisition' as const, provider: 'oracle', unit: 'batches' as const, count: BigInt(1), items: BigInt(43),
    retryAt: new Date('2026-10-13T05:01:00Z'), lastRetryAt: new Date('2026-10-13T05:01:00Z'), example: 'board-a' };
  const holds = groupAtsQueueHolds([
    { ...base, reason: 'ATS ledger page a/1/43 changed after it was committed.' },
    { ...base, reason: 'ATS ledger page b/1/22 changed after it was committed.', items: BigInt(22),
      retryAt: new Date('2026-10-15T05:01:00Z'), lastRetryAt: new Date('2026-10-15T05:01:00Z') },
    { ...base, stage: 'Persistence', unit: 'segments', reason: 'oracle downloaded work awaits a verified employer', items: BigInt(1778) },
  ]);
  assert.equal(holds.length, 2);
  assert.deepEqual(holds.find(hold => hold.stage === 'Acquisition'), { ...base, reason: 'Listing page changed after it was saved', count: 2, items: 65,
    retryAt: '2026-10-13T05:01:00.000Z', lastRetryAt: '2026-10-15T05:01:00.000Z' });
  assert.equal(holds.find(hold => hold.stage === 'Persistence')?.items, 1778);
  assert.equal(holds.find(hold => hold.stage === 'Persistence')?.reason, 'Employer identity could not be verified');
  assert.equal(summarizeAtsHoldReason(null, 'Reason unavailable'), 'Reason unavailable');
});

test('retry times include the Central date, never promise completion or retries for size review', () => {
  assert.equal(atsRetryLabel('2026-10-13T05:01:00Z', observedAt), 'Oct 13, 12:01 AM Central');
  assert.equal(atsRetryLabel('2026-10-12T19:00:00Z', observedAt), 'Eligible now');
  assert.equal(atsRetryLabel('2026-10-13T05:01:00Z', observedAt, true), 'Review required · no automatic retry');
  assert.equal(atsRetryLabel(null, observedAt), 'No retry time recorded');
});

export const queueFixture: AtsQueueSnapshot = {
  observedAt, mode: 'capacity', admissionNote: 'Capacity refill enabled · up to 32 unfinished collections · no daily quota',
  validationDue: 0, validationHeld: 3679, sizeReview: 161, ready: 3, awaitingHandoff: 3, collecting: 0,
  persistenceDue: 0, persistenceHeld: 2921,
  holds: [
    { stage: 'Validation', provider: 'jazzhr', reason: 'Career page or feed is unavailable (404/410)', count: 1316, unit: 'candidates', items: 0, retryAt: '2026-10-12T22:45:28Z', lastRetryAt: '2026-10-13T20:14:17Z', example: 'example' },
    { stage: 'First collection', provider: 'hirehive', reason: 'Awaiting automatic acquisition handoff (checked every five minutes)', count: 2, unit: 'boards', items: 0, retryAt: null, lastRetryAt: null, example: 'european-metal-recycling' },
    { stage: 'Acquisition', provider: 'oracle', reason: 'Listing page changed after it was saved', count: 3, unit: 'batches', items: 82, retryAt: '2026-10-13T05:01:00Z', lastRetryAt: '2026-10-15T05:01:00Z', example: 'fa-elzs-saasfaprod1.fa.ocs.oraclecloud.com::CX' },
    { stage: 'Persistence', provider: 'oracle', reason: 'Downloaded item has no verified employer (older retry reason not recorded)', count: 91, unit: 'segments', items: 1778, retryAt: '2026-10-12T21:08:40Z', lastRetryAt: '2026-10-12T21:39:26Z', example: 'hdbc.fa.em2.oraclecloud.com::CX' },
    { stage: 'Size review', provider: 'manatal', reason: 'Catalogue exceeds the first-collection allowance', count: 127, unit: 'candidates', items: 0, retryAt: null, lastRetryAt: null, example: 'example' },
  ],
};

test('the Dashboard exposes new-board readiness and timed holds even while nothing is runnable', () => {
  const html = renderToStaticMarkup(React.createElement(AtsQueuePanel, { snapshot: queueFixture }));
  for (const label of ['Ready for validation', '3,679', 'Validated first-collection queue', 'Awaiting acquisition handoff',
    '0 runnable items', '2,921 held items', 'Employer', 'older retry reason not recorded', 'Oct 13, 12:01 AM Central',
    'Review required · no automatic retry', 'within five minutes']) {
    assert.ok(html.toLowerCase().includes(label.toLowerCase()), label);
  }
  assert.doesNotMatch(html, /nothing left today/);
  const unavailable = renderToStaticMarkup(React.createElement(AtsQueuePanel, { unavailable: true }));
  assert.match(unavailable, /temporarily unavailable/);
  assert.doesNotMatch(unavailable, /No held work/);
});

test('a persistence hold keeps its final explanation and exact retry deadline without advancing work', async () => {
  const { prisma } = await import('../prisma');
  const { completeAtsV2SegmentProcessing } = await import('../atsAcquisitionLedger');
  const originalTransaction = prisma.$transaction;
  let written: Record<string, unknown> | null = null;
  const now = new Date(observedAt);
  const retryAt = new Date('2026-10-12T21:55:00Z');
  const tx = {
    $executeRaw: async () => 0,
    atsIngestionSegment: {
      findFirst: async () => ({ id: 'held', status: 'processing', itemCount: 25, processingOffset: 0,
        insertedCount: 0, duplicateCount: 0, filteredCount: 0, processingErrorCount: 0, leaseFence: BigInt(4) }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { written = data; return { count: 1 }; },
    },
  };
  // No database is involved: exercise the processing checkpoint writer with
  // the same zero-progress employer hold that caused the live flat backlog.
  prisma.$transaction = (async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx)) as typeof prisma.$transaction;
  try {
    assert.equal(await completeAtsV2SegmentProcessing({ segmentId: 'held', leaseToken: 'test',
      counters: { seen: 0, inserted: 0, duplicates: 0, filtered: 0, processingErrors: 0, providerErrors: 0 },
      interrupted: true, error: 'oracle downloaded work awaits a verified employer', retryAt, now }), true);
    const checkpoint = written as unknown as Record<string, unknown>;
    assert.equal(checkpoint.holdReason, 'oracle downloaded work awaits a verified employer');
    assert.equal(checkpoint.status, 'published');
    assert.deepEqual(checkpoint.nextProcessAt, retryAt);
    assert.equal(checkpoint.processingOffset, 0);
    assert.equal(checkpoint.processingErrorCount, 0);
    assert.equal(checkpoint.processedAt, null);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});
