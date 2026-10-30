import assert from 'node:assert/strict';
import test from 'node:test';
import { publicCrawlCapacity } from '../publicCrawlCapacity';

test('public crawling reserves a turn against runnable persistence and fails closed on the runtime gate', async () => {
  const previous = process.env.ATS_ACQUISITION_JOB_LOW_WATERMARK;
  process.env.ATS_ACQUISITION_JOB_LOW_WATERMARK = '1000';
  try {
    for (const [persistence, gate, healthy] of [[BigInt(0), 'open', true], [BigInt(949), 'open', true],
      [BigInt(950), 'open', false], [BigInt(0), 'paused', false], [BigInt(0), null, false]] as const) {
      const client = { $queryRaw: async () => [{ persistence, gate }] } as unknown as Parameters<typeof publicCrawlCapacity>[0];
      assert.equal((await publicCrawlCapacity(client)).healthy, healthy);
    }
    const missing = { $queryRaw: async () => [] } as unknown as Parameters<typeof publicCrawlCapacity>[0];
    assert.equal((await publicCrawlCapacity(missing)).healthy, false);
  } finally {
    if (previous === undefined) delete process.env.ATS_ACQUISITION_JOB_LOW_WATERMARK;
    else process.env.ATS_ACQUISITION_JOB_LOW_WATERMARK = previous;
  }
});
