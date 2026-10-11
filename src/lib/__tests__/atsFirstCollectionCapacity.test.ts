import assert from 'node:assert/strict';
import test from 'node:test';
import { firstCollectionHealth } from '../atsFirstCollectionAdmission';
import { readAtsDistributedTelemetry } from '../atsDistributedTelemetry';
import { prisma } from '../prisma';
import type { Prisma } from '@prisma/client';

test('retry-held persistence remains reported without closing first-collection capacity', async () => {
  const client = { $queryRaw: async () => [{ items: BigInt(1080), bytes: BigInt(5000),
    persistence: BigInt(305), totalPersistence: BigInt(4305), gate: 'open' }] };
  const health = await firstCollectionHealth(client as unknown as Parameters<typeof firstCollectionHealth>[0]);
  assert.equal(health.healthy, true);
  assert.equal(health.persistence, 305);
  assert.equal(health.heldPersistence, 4000);
});

test('operator intake telemetry uses the scheduler reservation rule and reports open capacity', async () => {
  const original = prisma.$queryRaw;
  let captured: Prisma.Sql | undefined;
  prisma.$queryRaw = (async (query: Prisma.Sql) => {
    captured = query;
    return [{ stagingItems: 1080, stagingBytes: 5000, unfinishedListings: 4,
      cohortUnfinishedListings: 0, cohortReadyNow: 10, admissionState: 'open' }];
  }) as typeof prisma.$queryRaw;
  try {
    const telemetry = await readAtsDistributedTelemetry();
    assert.equal(telemetry.admissionReason, 'open');
    assert.equal(telemetry.admissionBlocked, false);
    assert.equal(telemetry.cohortReadyNow, 10);
    assert.equal(telemetry.unfinishedListings, 4);
    assert.equal(captured!.sql.match(/batch\."lastError" IS NULL/g)?.length, 2);
    assert.match(captured!.sql, /batch\."acquisitionLeaseExpiresAt" > day\.now_utc/);
  } finally { prisma.$queryRaw = original; }
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
