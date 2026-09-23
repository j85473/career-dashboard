import assert from 'node:assert/strict';
import test from 'node:test';

import { hasCleanDuplicateOnlyActivity } from '../sourceHealth';

const bamboohr = {
  recentRuns: 1187,
  recentSeenCount: 6419,
  recentDuplicateCount: 6419,
  recentFailedRuns: 0,
  recentRequestErrors: 0,
  recentProcessingErrors: 0,
  recentUnreconciledRuns: 0,
};

test('clean duplicate-only checks show a source is responding even without new jobs', () => {
  assert.equal(hasCleanDuplicateOnlyActivity(bamboohr), true);
});

test('silence, failed requests, and unreconciled counts cannot look healthy', () => {
  for (const changes of [
    { recentRuns: 0 },
    { recentSeenCount: 0, recentDuplicateCount: 0 },
    { recentDuplicateCount: 6418 },
    { recentFailedRuns: 1 },
    { recentRequestErrors: 1 },
    { recentProcessingErrors: 1 },
    { recentUnreconciledRuns: 1 },
  ]) {
    assert.equal(hasCleanDuplicateOnlyActivity({ ...bamboohr, ...changes }), false);
  }
});
