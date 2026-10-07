import assert from 'node:assert/strict';
import test from 'node:test';
import { ATS_LANE_PLAN_MAX_AGE_MS, createAtsLanePlanReader } from '../atsLanePlanCache';

test('eight workers share one pending plan scan and reuse its fresh result', async () => {
  let scans = 0;
  let finish!: (value: { coverageSlots: number }) => void;
  const read = createAtsLanePlanReader(() => {
    scans += 1;
    return new Promise<{ coverageSlots: number }>((resolve) => { finish = resolve; });
  }, () => 0);
  const waiting = Array.from({ length: 8 }, () => read());
  await Promise.resolve();
  assert.equal(scans, 1);
  const plan = { coverageSlots: 1 };
  finish(plan);
  assert.ok((await Promise.all(waiting)).every((result) => result === plan));
  assert.equal(await read(), plan);
  assert.equal(scans, 1);
});

test('the first request at expiry refreshes once for all competing workers', async () => {
  let clock = 0;
  let scans = 0;
  const read = createAtsLanePlanReader(async () => ++scans, () => clock);
  assert.equal(await read(), 1);
  clock = ATS_LANE_PLAN_MAX_AGE_MS - 1;
  assert.equal(await read(), 1);
  clock += 1;
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => read())), Array(8).fill(2));
  assert.equal(scans, 2);
});

test('time spent scanning counts toward freshness instead of extending a slow plan', async () => {
  let clock = 0;
  let scans = 0;
  const read = createAtsLanePlanReader(async () => {
    scans += 1;
    clock += ATS_LANE_PLAN_MAX_AGE_MS;
    return scans;
  }, () => clock);
  assert.equal(await read(), 1);
  assert.equal(await read(), 2);
});

test('a failed refresh rejects every waiter and is retried without serving the expired plan', async () => {
  let clock = 0;
  let scans = 0;
  const failure = new Error('Plan query failed');
  const read = createAtsLanePlanReader(async () => {
    scans += 1;
    if (scans === 2) throw failure;
    return scans;
  }, () => clock);
  assert.equal(await read(), 1);
  clock = ATS_LANE_PLAN_MAX_AGE_MS;
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => read()));
  assert.ok(outcomes.every((outcome) => outcome.status === 'rejected' && outcome.reason === failure));
  assert.equal(scans, 2);
  assert.equal(await read(), 3);
});

test('separate dispatcher sessions never share cached or pending plans', async () => {
  let scans = 0;
  const load = async () => ++scans;
  const firstSession = createAtsLanePlanReader(load, () => 0);
  const secondSession = createAtsLanePlanReader(load, () => 0);
  assert.deepEqual(await Promise.all([firstSession(), secondSession()]), [1, 2]);
  assert.deepEqual(await Promise.all([firstSession(), secondSession()]), [1, 2]);
  assert.equal(scans, 2);
});
