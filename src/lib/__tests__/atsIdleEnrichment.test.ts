import assert from 'node:assert/strict';
import test from 'node:test';
import { atsV2IdleEnrichmentRetryAt, atsV2UnproductiveDetailRetryMs, ATS_V2_CONTINUATION_IDLE_RETRY_MS } from '../atsAcquisitionDispatcherV2';

const now = new Date('2026-10-16T16:00:00Z');
const claim = { batchId: 'retained', listingGeneration: 2, platform: 'successfactors', workReceiptId: 'current' };
const unsuccessful = { itemsProgressed: 0, detailRequestCount: 1, yieldReason: 'enrichment_budget' };

async function retry(itemRetry: Date | null | undefined, state: string, openUntil: Date | null,
  enrichmentReason: string | null = 'network_required', recent = [] as (typeof unsuccessful)[]) {
  const client = {
    atsIngestionItem: { findFirst: async (input: unknown) => {
      const query = input as { where: Record<string, unknown>; orderBy: unknown };
      assert.deepEqual(query.where, { batchId: 'retained', ledgerGeneration: 2, enrichmentStatus: 'pending' });
      assert.deepEqual(query.orderBy, { nextDetailAt: { sort: 'asc', nulls: 'first' } });
      return itemRetry === undefined ? null : { nextDetailAt: itemRetry, enrichmentReason };
    } },
    providerCircuit: { findUnique: async () => ({ state, openUntil }) },
    atsAcquisitionWorkReceipt: { findMany: async (input: { where: unknown; take: number }) => {
      assert.deepEqual(input.where, { batchId: 'retained', startGeneration: 2, workType: 'enrichment',
        OR: [{ id: 'current' }, { finishedAt: { not: null } }] });
      assert.equal(input.take, 8);
      return recent;
    } },
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
  assert.equal(await retry(undefined, 'closed', null, 'network_required', Array(8).fill(unsuccessful)),
    new Date(now.getTime() + ATS_V2_CONTINUATION_IDLE_RETRY_MS).toISOString());
});

test('items still awaiting local classification are not parked behind a network cooldown', async () => {
  assert.equal(await retry(null, 'open', new Date('2026-10-16T18:00:00Z'), null),
    new Date(now.getTime() + ATS_V2_CONTINUATION_IDLE_RETRY_MS).toISOString());
  assert.equal(await retry(null, 'closed', null, null, Array(8).fill(unsuccessful)),
    new Date(now.getTime() + ATS_V2_CONTINUATION_IDLE_RETRY_MS).toISOString());
});

test('a board full of failed details backs off even while other item retries are already due', async () => {
  assert.equal(await retry(null, 'closed', null, 'network_required', Array(3).fill(unsuccessful)),
    '2026-10-16T16:05:00.000Z');
  assert.equal(await retry(new Date('2026-10-16T15:00:00Z'), 'closed', null, 'network_required', Array(8).fill(unsuccessful)),
    '2026-10-16T17:00:00.000Z');
  assert.equal(await retry(new Date('2026-10-16T18:00:00Z'), 'closed', null, 'network_required', Array(8).fill(unsuccessful)),
    '2026-10-16T18:00:00.000Z', 'an existing longer item hold is preserved');
});

test('only repeated unsuccessful detail requests earn the bounded board delay', () => {
  for (const [count, minutes] of [[0, 1], [1, 1], [2, 1], [3, 5], [4, 15], [5, 30], [6, 60], [8, 60]])
    assert.equal(atsV2UnproductiveDetailRetryMs(Array(count).fill(unsuccessful)), minutes * 60_000);
  assert.equal(atsV2UnproductiveDetailRetryMs([
    { ...unsuccessful, yieldReason: null }, ...Array(2).fill(unsuccessful),
  ]), 5 * 60_000, 'the current unfinished receipt contributes its already-recorded request');
  assert.equal(atsV2UnproductiveDetailRetryMs([
    { ...unsuccessful, itemsProgressed: 1 }, ...Array(6).fill(unsuccessful),
  ]), 60_000, 'a productive turn resets the streak');
  assert.equal(atsV2UnproductiveDetailRetryMs([
    { ...unsuccessful, detailRequestCount: 0 }, ...Array(2).fill(unsuccessful),
  ]), 60_000, 'an idle turn is not another failed request');
  for (const yieldReason of ['interrupted', 'expired', 'error'])
    assert.equal(atsV2UnproductiveDetailRetryMs([
      { ...unsuccessful, yieldReason }, ...Array(6).fill(unsuccessful),
    ]), 60_000, 'shutdown and control failures do not inflate the streak');
});
