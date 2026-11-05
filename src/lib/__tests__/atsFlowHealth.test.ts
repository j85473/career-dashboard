import assert from 'node:assert/strict';
import test from 'node:test';
import { publicCapacityStalled, readAtsFlowSnapshot } from '../atsFlowHealth';

const now = new Date('2026-11-05T00:37:00Z');
const stalled = { paused: false, checkedLast30Minutes: 0, capacityWaits: 90,
  firstCapacityWaitAt: '2026-11-05T00:08:00Z', lastRunAt: '2026-11-05T00:36:50Z' };
test('public starvation is detected even while other sources are progressing', () => {
  assert.equal(publicCapacityStalled(stalled, now), true);
  for (const patch of [{ paused: true }, { checkedLast30Minutes: 1 }, { capacityWaits: 2 },
    { firstCapacityWaitAt: '2026-11-05T00:35:00Z' }, { lastRunAt: '2026-11-05T00:15:00Z' },
    { firstCapacityWaitAt: null }, { lastRunAt: 'invalid' }]) {
    assert.equal(publicCapacityStalled({ ...stalled, ...patch }, now), false);
  }
});
test('flow reports retained holds separately and converts PostgreSQL UTC timestamps consistently', async () => {
  const client = { $queryRaw: async () => [{ readyToPublish: BigInt(20), readyToProcess: BigInt(10),
    employerHeld: BigInt(15524), scheduledRetries: BigInt(3), oldestReadyAt: new Date('2026-11-04T23:00:00Z'),
    oldestEmployerHoldAt: new Date('2026-10-12T18:00:00Z'), paused: false,
    sources: [{ source: 'ATS-adp', checkedLastHour: 0, insertedLastHour: 0, ...stalled,
      firstCapacityWaitAt: '2026-11-05T00:08:00', lastRunAt: '2026-11-05T00:36:50', lastProgressAt: null },
    { source: 'ATS-oracle', checkedLastHour: 12000, insertedLastHour: 4, checkedLast30Minutes: 6000,
      capacityWaits: 0, firstCapacityWaitAt: null, lastRunAt: now.toISOString(), lastProgressAt: now.toISOString() }] }] };
  const result = await readAtsFlowSnapshot(client as never, now);
  assert.equal(result.employerHeld, 15524); assert.equal(result.readyToProcess, 10);
  assert.equal(result.checkedLastHour, 12000); assert.equal(result.insertedLastHour, 4);
  assert.equal(result.sources[0].stalled, true); assert.equal(result.sources[1].stalled, false);
  assert.equal(result.sources[0].lastRunAt, '2026-11-05T00:36:50.000Z');
});
