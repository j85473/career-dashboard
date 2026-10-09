import assert from 'node:assert/strict';
import test from 'node:test';
import { nextAtsProcessingContinuationAt } from '../../src/lib/atsProcessingSchedule';
import { completeAtsV2SegmentProcessing } from '../../src/lib/atsAcquisitionLedger';
import { AtsEmployerDeferredError } from '../../src/lib/jobIngestion';
import { prisma } from '../../src/lib/prisma';

const now = new Date('2026-10-09T12:00:00.000Z');
const retryAt = new Date('2026-10-09T13:00:00.000Z');

test('employer and provider deferrals keep their retry time even after a durable prefix', () => {
  for (const cursorAdvanced of [false, true]) {
    assert.equal(nextAtsProcessingContinuationAt({
      now, interrupted: true, cursorAdvanced, retryAt,
    }).getTime(), retryAt.getTime());
  }
  assert.ok(new AtsEmployerDeferredError('oracle').retryAt!.getTime() >= Date.now() + 3_599_000);
});

test('a stop without progress waits a minute; a completed prefix remains immediately resumable', () => {
  assert.equal(nextAtsProcessingContinuationAt({ now, interrupted: true, cursorAdvanced: false }).getTime(), now.getTime() + 60_000);
  assert.equal(nextAtsProcessingContinuationAt({ now, interrupted: true, cursorAdvanced: true }).getTime(), now.getTime());
  for (const stale of [new Date('2020-01-01'), new Date(NaN)]) {
    assert.equal(nextAtsProcessingContinuationAt({ now, interrupted: true, cursorAdvanced: false, retryAt: stale }).getTime(), now.getTime() + 60_000);
  }
  assert.equal(nextAtsProcessingContinuationAt({ now, cursorAdvanced: true, retryAt }).getTime(), now.getTime());
});

test('the durable v2 release retains unprocessed work and honors its employer hold', async (t) => {
  let released: { where: Record<string, unknown>; data: Record<string, unknown> } | undefined;
  const segment = {
    id: 'segment', batchId: 'batch', processingOffset: 5, itemCount: 25,
    insertedCount: 0, duplicateCount: 5, filteredCount: 0, processingErrorCount: 0,
    leaseFence: BigInt(20_000),
  };
  const transaction = {
    $executeRaw: async () => 1,
    atsIngestionSegment: {
      findFirst: async () => segment,
      updateMany: async (input: typeof released) => { released = input; return { count: 1 }; },
    },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: typeof transaction) => Promise<unknown>) => run(transaction));
  for (const duplicates of [0, 2]) {
    assert.equal(await completeAtsV2SegmentProcessing({
      segmentId: 'segment', leaseToken: 'live-lease', now, interrupted: true,
      retryAt, counters: { seen: duplicates, inserted: 0, duplicates, filtered: 0, processingErrors: 0, providerErrors: 0, requests: 0 },
    }), true);
    assert.equal(released!.data.status, 'published');
    assert.equal((released!.data.nextProcessAt as Date).getTime(), retryAt.getTime());
    assert.equal(released!.data.processingOffset, 5 + duplicates);
    assert.equal(released!.data.duplicateCount, 5 + duplicates);
    assert.equal(released!.data.processingErrorCount, 0);
    assert.equal(released!.data.processedAt, null);
    assert.equal(released!.data.leaseToken, null);
    assert.equal(released!.where.leaseToken, 'live-lease');
    assert.equal(released!.where.processingOffset, 5);
  }
});

test('v2 zero-progress interruption does not immediately reclaim the segment', async (t) => {
  let released: { data: Record<string, unknown> } | undefined;
  const transaction = {
    $executeRaw: async () => 1,
    atsIngestionSegment: {
      findFirst: async () => ({ id: 'segment', batchId: 'batch', processingOffset: 0, itemCount: 25,
        insertedCount: 0, duplicateCount: 0, filteredCount: 0, processingErrorCount: 0, leaseFence: BigInt(1) }),
      updateMany: async (input: typeof released) => { released = input; return { count: 1 }; },
    },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: typeof transaction) => Promise<unknown>) => run(transaction));
  await completeAtsV2SegmentProcessing({ segmentId: 'segment', leaseToken: 'live-lease', now, interrupted: true,
    counters: { seen: 0, inserted: 0, duplicates: 0, filtered: 0, processingErrors: 0, providerErrors: 0, requests: 0 } });
  assert.equal((released!.data.nextProcessAt as Date).getTime(), now.getTime() + 60_000);
  assert.equal(released!.data.processingOffset, 0);
});

test('publisher resumes behind held records and changes only newly sealed segments', async (t) => {
  const { publishReadyAtsV2Segments } = await import('../../src/lib/atsAcquisitionLedger');
  const held = { id: 'held', status: 'published', nextProcessAt: retryAt, processingOffset: 4, itemCount: 25 };
  const before = { ...held };
  const publishedIds: string[] = [];
  let gateUpdate: Record<string, unknown> | undefined;
  let queryClock: unknown;
  const transaction = {
    $executeRaw: async () => 1,
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      // 1,500 additional held items remain in inventory. They do not occupy
      // the runnable allowance; 900 due/in-flight items still do.
      assert.match(query.sql, /segment\.status = 'processing'/);
      assert.match(query.sql, /segment\.status = 'published'[\s\S]*nextProcessAt" IS NULL OR segment\."nextProcessAt" <= \?/);
      queryClock = query.values[0];
      return [{ remaining: BigInt(900) }];
    },
    atsAcquisitionRuntimeGate: {
      findUniqueOrThrow: async () => ({ publicationPaused: true, publicationPausedAt: now, publicationBacklogJobs: 2_400 }),
      update: async (input: { data: Record<string, unknown> }) => { gateUpdate = input.data; },
    },
    atsIngestionSegment: {
      findMany: async (input: { where: { status: string } }) => {
        assert.equal(input.where.status, 'sealed');
        return [{ id: 'healthy-sealed', batchId: 'healthy-board', itemCount: 25 }];
      },
      updateMany: async (input: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        assert.equal(input.where.status, 'sealed');
        assert.equal(input.data.status, 'published');
        assert.equal(input.data.nextProcessAt, now);
        publishedIds.push(input.where.id);
        return { count: 1 };
      },
    },
    atsIngestionBatch: { update: async () => ({}) },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: typeof transaction) => Promise<unknown>) => run(transaction));
  assert.deepEqual(await publishReadyAtsV2Segments({ now, highWatermark: 2_000, lowWatermark: 1_000 }), {
    publishedSegments: 1, publishedItems: 25, remainingJobs: 925,
  });
  assert.equal(queryClock, now);
  assert.deepEqual(publishedIds, ['healthy-sealed']);
  assert.equal(gateUpdate!.publicationPaused, false);
  assert.equal(gateUpdate!.publicationBacklogJobs, 925);
  assert.deepEqual(held, before);
});

test('runnable work at the publication ceiling still blocks further publication', async (t) => {
  const { publishReadyAtsV2Segments } = await import('../../src/lib/atsAcquisitionLedger');
  const transaction = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ remaining: BigInt(2_000) }],
    atsAcquisitionRuntimeGate: {
      findUniqueOrThrow: async () => ({ publicationPaused: true, publicationPausedAt: now, publicationBacklogJobs: 2_000 }),
      update: async () => { throw new Error('The unchanged pause should not be rewritten'); },
    },
    atsIngestionSegment: { findMany: async () => { throw new Error('Runnable capacity is full'); } },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: typeof transaction) => Promise<unknown>) => run(transaction));
  assert.deepEqual(await publishReadyAtsV2Segments({ now, highWatermark: 2_000, lowWatermark: 1_000 }), {
    publishedSegments: 0, publishedItems: 0, remainingJobs: 2_000,
  });
});
