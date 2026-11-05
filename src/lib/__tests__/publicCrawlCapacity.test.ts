import assert from 'node:assert/strict';
import test from 'node:test';
import { publicCrawlCapacity } from '../publicCrawlCapacity';
import { atsPersistenceAllocation, ATS_PUBLIC_TURN_JOBS } from '../atsPersistenceAllocation';
import { planAtsV2PublicationGate } from '../atsAcquisitionLedger';

test('public crawling reserves a turn against runnable persistence and fails closed on the runtime gate', async () => {
  const previous = process.env.ATS_ACQUISITION_JOB_HIGH_WATERMARK;
  process.env.ATS_ACQUISITION_JOB_HIGH_WATERMARK = '2000';
  try {
    for (const [persistence, gate, healthy] of [[BigInt(0), 'open', true], [BigInt(1000), 'open', true],
      [BigInt(1900), 'open', true], [BigInt(1950), 'open', true], [BigInt(1951), 'open', false],
      [BigInt(0), 'paused', false], [BigInt(0), null, false]] as const) {
      const client = { $queryRaw: async () => [{ persistence, gate }] } as unknown as Parameters<typeof publicCrawlCapacity>[0];
      assert.equal((await publicCrawlCapacity(client)).healthy, healthy);
    }
    const missing = { $queryRaw: async () => [] } as unknown as Parameters<typeof publicCrawlCapacity>[0];
    assert.equal((await publicCrawlCapacity(missing)).healthy, false);
  } finally {
    if (previous === undefined) delete process.env.ATS_ACQUISITION_JOB_HIGH_WATERMARK;
    else process.env.ATS_ACQUISITION_JOB_HIGH_WATERMARK = previous;
  }
});

test('sustained API refills leave room for both public turns without raising the total ceiling', async () => {
  for (const [low, high] of [[1000, 2000], [99, 100], [0, 500], [9999, 10000]]) {
    const allocation = atsPersistenceAllocation(low, high);
    let backlog = allocation.publicationHigh, paused = true;
    let apiPublished = 0, publicTurns = 0;
    for (let tick = 0; tick < 3000; tick++) {
      backlog = Math.max(0, backlog - 1);
      const plan = planAtsV2PublicationGate({ previousPaused: paused, previousPausedAt: null,
        previousBacklogJobs: backlog, initialBacklogJobs: backlog, finalBacklogJobs: backlog,
        lowWatermark: allocation.publicationLow, highWatermark: allocation.publicationHigh, now: new Date() });
      if (plan.publishAllowed) { apiPublished += allocation.publicationHigh - backlog; backlog = allocation.publicationHigh; }
      paused = backlog >= allocation.publicationHigh;
      if (tick % 17 === 0) {
        assert.ok(backlog + allocation.publicReserve <= high);
        assert.ok(backlog + ATS_PUBLIC_TURN_JOBS <= high);
        publicTurns++;
      }
    }
    assert.ok(apiPublished > 0); assert.ok(publicTurns > 100);
  }
});
