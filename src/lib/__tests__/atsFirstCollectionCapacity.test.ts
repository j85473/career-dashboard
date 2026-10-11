import assert from 'node:assert/strict';
import test from 'node:test';
import { firstCollectionHealth } from '../atsFirstCollectionAdmission';

test('retry-held persistence remains reported without closing first-collection capacity', async () => {
  const client = { $queryRaw: async () => [{ items: BigInt(1080), bytes: BigInt(5000),
    persistence: BigInt(305), totalPersistence: BigInt(4305), gate: 'open' }] };
  const health = await firstCollectionHealth(client as unknown as Parameters<typeof firstCollectionHealth>[0]);
  assert.equal(health.healthy, true);
  assert.equal(health.persistence, 305);
  assert.equal(health.heldPersistence, 4000);
});

test('first collection keeps catalogue headroom, volume limits and the global gate', async () => {
  let snapshot = { items: BigInt(0), bytes: BigInt(0), persistence: BigInt(749), totalPersistence: BigInt(4000), gate: 'open' };
  const client = { $queryRaw: async () => [snapshot] } as unknown as Parameters<typeof firstCollectionHealth>[0];
  assert.equal((await firstCollectionHealth(client)).healthy, true);
  snapshot = { ...snapshot, persistence: BigInt(750) };
  assert.equal((await firstCollectionHealth(client)).healthy, false);
  snapshot = { ...snapshot, persistence: BigInt(0), items: BigInt(49750) };
  assert.equal((await firstCollectionHealth(client)).healthy, false);
  snapshot = { ...snapshot, items: BigInt(0), bytes: BigInt(750000000) };
  assert.equal((await firstCollectionHealth(client)).healthy, false);
  snapshot = { ...snapshot, bytes: BigInt(0), gate: 'draining' };
  assert.equal((await firstCollectionHealth(client)).healthy, false);
});
