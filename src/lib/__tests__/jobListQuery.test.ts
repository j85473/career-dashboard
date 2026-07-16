import assert from 'node:assert/strict';
import test from 'node:test';
import { jobOrder, logWhere, positiveInteger } from '../jobListQuery';

test('pagination accepts positive integers and caps oversized pages', () => {
  assert.equal(positiveInteger(null, 48, 100), 48);
  assert.equal(positiveInteger('-2', 48, 100), 48);
  assert.equal(positiveInteger('500', 48, 100), 100);
  assert.equal(positiveInteger('25', 48, 100), 25);
});

test('log queues include only jobs that are still eligible for scoring', () => {
  const aimFit = logWhere('aim_fit');
  assert.deepEqual(aimFit.status, {
    in: ['pending_af', 'inbox'],
  });
});

test('travel sorting treats lower required travel as better and keeps nulls last', () => {
  assert.deepEqual(jobOrder('inbox', 'travel_fit')[0], {
    travelScore: { sort: 'asc', nulls: 'last' },
  });
});

test('applied date sorting uses the status-change timestamp', () => {
  assert.deepEqual(jobOrder('applied', 'newest')[0], { updatedAt: 'desc' });
});
