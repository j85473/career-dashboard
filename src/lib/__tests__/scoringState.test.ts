import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldContinueDeepseekEvaluation,
  statusAfterScoringInputEdit,
} from '../scoringState';

test('a scoring-input edit preserves an explicit lifecycle status', () => {
  assert.equal(statusAfterScoringInputEdit('applied'), 'applied');
  assert.equal(statusAfterScoringInputEdit('passed'), 'passed');
  assert.equal(statusAfterScoringInputEdit('bookmarked'), 'bookmarked');
});

test('a scoring-input edit without an explicit status returns to pending scoring', () => {
  assert.equal(statusAfterScoringInputEdit(undefined), 'pending_af');
  assert.equal(statusAfterScoringInputEdit(null), 'pending_af');
  assert.equal(statusAfterScoringInputEdit(''), 'pending_af');
});

test('DeepSeek continues after optimistic concurrency releases a stale batch', () => {
  assert.equal(shouldContinueDeepseekEvaluation({
    scoresProcessed: 0,
    contextJobsProcessed: 0,
    contextUpdated: false,
    staleClaimsReleased: 5,
  }), true);
});

test('DeepSeek stops only when no progress or stale claims remain', () => {
  assert.equal(shouldContinueDeepseekEvaluation({
    scoresProcessed: 0,
    contextJobsProcessed: 0,
    contextUpdated: false,
    staleClaimsReleased: 0,
  }), false);
});
