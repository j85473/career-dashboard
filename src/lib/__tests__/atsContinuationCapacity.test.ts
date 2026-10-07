import assert from 'node:assert/strict';
import test from 'node:test';
import { ATS_PRESSURE_LISTING_CONCURRENCY, withAtsListingCapacity } from '../atsContinuationCapacity';
import { findAtsContinuationCandidate } from '../atsAcquisitionLedger';
import type { Prisma } from '@prisma/client';

const now = new Date('2026-10-07T16:00:00Z');

test('eight competing workers can reserve only one listing lease when drain work exists', async () => {
  let lockTail = Promise.resolve();
  let liveListings = 0;
  const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    let unlock = () => {};
    const transaction = {
      $executeRaw: async () => {
        const previous = lockTail;
        lockTail = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        return 0;
      },
      atsIngestionBatch: { findFirst: async () => ({ id: 'unfinished-drain' }),
        count: async () => liveListings },
    } as unknown as Parameters<typeof withAtsListingCapacity>[0];
    try {
      return await withAtsListingCapacity(transaction, now, ATS_PRESSURE_LISTING_CONCURRENCY, async () => {
        // Yield between count and claim so missing serialization would allow
        // all eight workers to spend the same apparently available slot.
        await new Promise((resolve) => setTimeout(resolve, 1));
        liveListings += 1;
        return index;
      });
    } finally { unlock(); }
  }));
  assert.equal(results.filter((result) => result !== null).length, 1);
  assert.equal(liveListings, 1);
});

test('an all-listing backlog can use idle capacity to create drainable batches', async () => {
  let claims = 0;
  const transaction = { $executeRaw: async () => 0,
    atsIngestionBatch: { findFirst: async () => null,
      count: async () => { throw new Error('No drain inventory means no producer cap'); } },
  } as unknown as Parameters<typeof withAtsListingCapacity>[0];
  for (let i = 0; i < 8; i += 1) {
    assert.equal(await withAtsListingCapacity(transaction, now, 1, async () => ++claims), i + 1);
  }
});

test('delayed drain inventory still prevents producers from growing the queue unchecked', async () => {
  let drainWhere: Prisma.AtsIngestionBatchWhereInput | undefined;
  let countWhere: Prisma.AtsIngestionBatchWhereInput | undefined;
  const transaction = { $executeRaw: async () => 0,
    atsIngestionBatch: {
      findFirst: async (args: { where: Prisma.AtsIngestionBatchWhereInput }) => {
        drainWhere = args.where; return { id: 'retrying-drain' };
      },
      count: async (args: { where: Prisma.AtsIngestionBatchWhereInput }) => { countWhere = args.where; return 1; },
    },
  } as unknown as Parameters<typeof withAtsListingCapacity>[0];
  const claim = await withAtsListingCapacity(transaction, now, 1, async () => { throw new Error('Capacity is occupied'); });
  assert.equal(claim, null);
  assert.equal(drainWhere?.OR, undefined);
  assert.deepEqual(countWhere?.acquisitionLeaseExpiresAt, { gt: now });
  assert.deepEqual(countWhere?.acquisitionClaimToken, { not: null });
});

test('expired producer leases do not reserve capacity forever', async () => {
  const transaction = { $executeRaw: async () => 0,
    atsIngestionBatch: { findFirst: async () => ({ id: 'drain' }), count: async () => 0 },
  } as unknown as Parameters<typeof withAtsListingCapacity>[0];
  assert.equal(await withAtsListingCapacity(transaction, now, 1, async () => 'replacement'), 'replacement');
});

test('today continues before older weekday work, with retry guards retained', async () => {
  const retryGuard = { OR: [{ nextAcquireAt: null }, { nextAcquireAt: { lte: now } }] };
  const filters: Prisma.AtsIngestionBatchWhereInput[] = [];
  const client = { atsIngestionBatch: { findFirst: async (args: { where: Prisma.AtsIngestionBatchWhereInput }) => {
    filters.push(args.where);
    return { id: 'today', acquisitionPhase: 'enrichment' };
  } } } as unknown as Parameters<typeof findAtsContinuationCandidate>[0];
  const result = await findAtsContinuationCandidate(client, retryGuard, [{ createdAt: 'asc' }], now);
  assert.equal(result?.id, 'today');
  assert.equal(filters.length, 1);
  assert.deepEqual(filters[0].board, { status: 'active', checkDay: 3 });
  assert.equal(filters[0].OR, retryGuard.OR);
});

test('other active cohorts use spare capacity before recovery boards', async () => {
  const filters: Prisma.AtsIngestionBatchWhereInput[] = [];
  const client = { atsIngestionBatch: { findFirst: async (args: { where: Prisma.AtsIngestionBatchWhereInput }) => {
    filters.push(args.where);
    return filters.length === 2 ? { id: 'other-active', acquisitionPhase: 'enrichment' } : null;
  } } } as unknown as Parameters<typeof findAtsContinuationCandidate>[0];
  assert.equal((await findAtsContinuationCandidate(client, {}, [], now))?.id, 'other-active');
  assert.deepEqual(filters[1].board, { status: 'active' });
  assert.equal(filters.length, 2);
});
