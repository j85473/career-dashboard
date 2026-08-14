import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionableQueueWhere,
  jobOrder,
  jobWhere,
  logWhere,
  positiveInteger,
} from '../jobListQuery';

test('pagination accepts positive integers and caps oversized pages', () => {
  assert.equal(positiveInteger(null, 48, 100), 48);
  assert.equal(positiveInteger('-2', 48, 100), 48);
  assert.equal(positiveInteger('500', 48, 100), 100);
  assert.equal(positiveInteger('25', 48, 100), 25);
});

test('log queues include only jobs that are still eligible for scoring', () => {
  const aimFit = logWhere('aim_fit');
  assert.equal(aimFit.status, 'pending_af');
  assert.equal(aimFit.scoringStatus, 'scored');
  assert.deepEqual(aimFit.aimFailureReceipts, {
    none: { suppressionActive: true, clearedAt: null },
  });
  assert.deepEqual(aimFit.OR, [{ aimFitScore: null }]);
  assert.deepEqual(logWhere('experience_fit').aimFitScore, { not: null });
  assert.equal(logWhere('experience_fit').scoringStatus, 'scored');
  assert.equal(logWhere('experience_fit').reqFitScore, null);
  assert.deepEqual(logWhere('context'), {
    status: 'passed',
    contextBatched: false,
    passReason: { not: null },
    NOT: { passReason: { contains: 'expired', mode: 'insensitive' } },
  });
});

test('travel watch exposes its status scope for an indexed projected-score filter', () => {
  assert.deepEqual(jobWhere('travel_watch', 'aim_fit'), {
    status: { in: ['pending_af', 'inbox', 'dismissed', 'bookmarked', 'cooldown'] },
  });
  assert.deepEqual(jobOrder('travel_watch', 'travel_fit_high')[0], {
    travelScore: { sort: 'desc', nulls: 'last' },
  });
});

test('inbox keeps stale replay and human-promoted jobs visible without a scalar-score gate', () => {
  assert.deepEqual(jobWhere('inbox', 'aim_fit'), {
    status: 'inbox',
    tailoringStaged: false,
  });
});

test('action-needed queue is limited to active terminal or contradictory scoring states', () => {
  assert.deepEqual(logWhere('action_needed'), actionableQueueWhere());
  assert.deepEqual(actionableQueueWhere(), {
    status: { in: ['pending_af', 'inbox'] },
    OR: [
      { scoringStatus: 'failed' },
      { scoreAttempts: { gte: 6 } },
      { status: 'pending_af', scoringStatus: 'skipped' },
      { aimFailureReceipts: { some: { suppressionActive: true, clearedAt: null } } },
    ],
  });
});

test('applied date sorting uses the status-change timestamp', () => {
  assert.deepEqual(jobOrder('applied', 'newest')[0], { updatedAt: 'desc' });
});

test('operational queues never order by mutable score projections', () => {
  assert.deepEqual(jobOrder('log', 'aim_fit'), [{ createdAt: 'asc' }, { id: 'asc' }]);
  assert.deepEqual(jobOrder('log', 'experience_fit'), [{ createdAt: 'asc' }, { id: 'asc' }]);
});
