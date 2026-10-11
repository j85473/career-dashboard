import assert from 'node:assert/strict';
import test from 'node:test';
import { firstCollectionAllowance } from '../../src/lib/atsFirstCollectionAdmission';
import { refillFirstCollections } from '../../src/lib/atsFirstCollectionController';

const now = new Date('2026-10-11T22:00:00Z');
const spare = { mode: 'capacity', dailyBoardLimit: 0, maxUnfinished: 32, startedInWindow: 12000,
  unfinished: 7, healthySince: null, healthObservedAt: now, now };

test('spare capacity remains eligible after thousands of starts without a stability wait', () => {
  assert.equal(firstCollectionAllowance(spare), true);
  assert.equal(firstCollectionAllowance({ ...spare, healthySince: now, unfinished: 31 }), true);
  assert.equal(firstCollectionAllowance({ ...spare, unfinished: 32 }), false);
  assert.equal(firstCollectionAllowance({ ...spare, mode: 'held' }), false);
  assert.equal(firstCollectionAllowance({ ...spare, mode: 'unknown' }), false);
  assert.equal(firstCollectionAllowance({ ...spare, healthObservedAt: new Date(now.getTime() - 11 * 60_000) }), false);
});

test('pilot and ramp retain their explicit daily and stability limits', () => {
  const pilot = { ...spare, mode: 'pilot', dailyBoardLimit: 5, maxUnfinished: 1,
    startedInWindow: 4, unfinished: 0, healthySince: new Date(now.getTime() - 16 * 60_000) };
  assert.equal(firstCollectionAllowance(pilot), true);
  assert.equal(firstCollectionAllowance({ ...pilot, startedInWindow: 5 }), false);
  assert.equal(firstCollectionAllowance({ ...pilot, mode: 'ramp', healthySince: now }), false);
});

test('refill continues past bad/oversized tenants and stops when capacity is unavailable', async () => {
  const outcomes = ['ready', 'validation_deferred', 'size_review', 'retired', 'ready', 'waiting_for_admission_conditions'];
  let calls = 0;
  const result = await refillFirstCollections(async () => ({ outcome: outcomes[calls++] }), () => 0);
  assert.equal(calls, 6);
  assert.equal(result.outcomes.ready, 2);
  assert.equal(result.outcomes.validation_deferred, 1);
});

test('refill bounds both requests and elapsed time', async () => {
  let calls = 0;
  await refillFirstCollections(async () => { calls++; return { outcome: 'ready' }; }, () => 0);
  assert.equal(calls, 16);
  let elapsed = 0;
  calls = 0;
  await refillFirstCollections(async () => { calls++; elapsed += 23000; return { outcome: 'ready' }; }, () => elapsed);
  assert.equal(calls, 2);
});
