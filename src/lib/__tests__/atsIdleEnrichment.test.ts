import assert from 'node:assert/strict';
import test from 'node:test';
import { atsV2IdleEnrichmentRetryAt, ATS_V2_CONTINUATION_IDLE_RETRY_MS } from '../atsAcquisitionDispatcherV2';

const now = new Date('2026-10-16T16:00:00Z');
const claim = { batchId: 'retained', listingGeneration: 2, platform: 'successfactors' };

async function retry(itemRetry: Date | null | undefined, state: string, openUntil: Date | null,
  enrichmentReason: string | null = 'network_required') {
  const client = {
    atsIngestionItem: { findFirst: async (input: unknown) => {
      const query = input as { where: Record<string, unknown>; orderBy: unknown };
      assert.deepEqual(query.where, { batchId: 'retained', ledgerGeneration: 2, enrichmentStatus: 'pending' });
      assert.deepEqual(query.orderBy, { nextDetailAt: { sort: 'asc', nulls: 'first' } });
      return itemRetry === undefined ? null : { nextDetailAt: itemRetry, enrichmentReason };
    } },
    providerCircuit: { findUnique: async () => ({ state, openUntil }) },
  } as unknown as Parameters<typeof atsV2IdleEnrichmentRetryAt>[2];
  return (await atsV2IdleEnrichmentRetryAt(claim, now, client)).toISOString();
}

test('idle enrichment sleeps until the provider cooldown ends without discarding pending items', async () => {
  assert.equal(await retry(null, 'open', new Date('2026-10-16T17:00:00Z')), '2026-10-16T17:00:00.000Z');
});

test('the earliest pending detail retry also bounds the next empty turn', async () => {
  assert.equal(await retry(new Date('2026-10-16T18:00:00Z'), 'open', new Date('2026-10-16T17:00:00Z')), '2026-10-16T18:00:00.000Z');
  assert.equal(await retry(new Date('2026-10-16T16:30:00Z'), 'closed', null), '2026-10-16T16:30:00.000Z');
});

test('expired or closed cooldowns retain the ordinary idle floor', async () => {
  const floor = new Date(now.getTime() + ATS_V2_CONTINUATION_IDLE_RETRY_MS).toISOString();
  assert.equal(await retry(null, 'closed', new Date('2026-10-16T18:00:00Z')), floor);
  assert.equal(await retry(null, 'open', new Date('2026-10-16T15:00:00Z')), floor);
});

test('a provider cooldown does not delay sealing when no pending details remain', async () => {
  assert.equal(await retry(undefined, 'open', new Date('2026-10-16T18:00:00Z')),
    new Date(now.getTime() + ATS_V2_CONTINUATION_IDLE_RETRY_MS).toISOString());
});

test('items still awaiting local classification are not parked behind a network cooldown', async () => {
  assert.equal(await retry(null, 'open', new Date('2026-10-16T18:00:00Z'), null),
    new Date(now.getTime() + ATS_V2_CONTINUATION_IDLE_RETRY_MS).toISOString());
});
