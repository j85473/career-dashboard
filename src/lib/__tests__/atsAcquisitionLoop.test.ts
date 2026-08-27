import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATS_ACQUISITION_TASK_HEARTBEAT_MS,
  atsAcquisitionCheckpoint,
  classifyAtsAcquisitionTurn,
} from '../atsAcquisitionLoop';
import type { AtsAcquisitionOutcome, AtsAcquisitionResult } from '../atsAcquisition';

function result(
  outcome: AtsAcquisitionOutcome,
  options: { requests?: number; responded?: boolean } = {},
): AtsAcquisitionResult {
  return {
    attemptId: `attempt-${outcome}`,
    batchId: `batch-${outcome}`,
    outcome,
    requestCount: options.requests ?? (outcome === 'deferred' ? 0 : 1),
    pageCount: options.responded === false ? 0 : 1,
    jobCount: 0,
    responded: options.responded ?? !['deferred', 'timeout', 'throttled', 'error', 'interrupted'].includes(outcome),
  };
}

test('ATS acquisition turn succeeds only when every selected board synchronizes', () => {
  const outcome = classifyAtsAcquisitionTurn({
    selectedCount: 2,
    results: [result('synchronized'), result('synchronized')],
  });

  assert.equal(outcome.taskStatus, 'succeeded');
  assert.equal(outcome.phase, 'finished');
  assert.equal(outcome.synchronized, 2);
  assert.equal(outcome.providerErrors, 0);
  assert.equal(outcome.error, null);
});

test('ATS acquisition turn is partial when progress and provider failures are mixed', () => {
  const outcome = classifyAtsAcquisitionTurn({
    selectedCount: 2,
    results: [result('synchronized'), result('timeout', { responded: false })],
  });

  assert.equal(outcome.taskStatus, 'partial');
  assert.equal(outcome.phase, 'partial');
  assert.equal(outcome.synchronized, 1);
  assert.equal(outcome.providerErrors, 1);
});

test('ATS acquisition turn fails when every returned board result is an error', () => {
  const outcome = classifyAtsAcquisitionTurn({
    selectedCount: 2,
    results: [result('timeout'), result('error')],
  });

  assert.equal(outcome.taskStatus, 'failed');
  assert.equal(outcome.phase, 'failed');
  assert.equal(outcome.providerErrors, 2);
});

test('ATS acquisition turn is partial when progress is mixed with an unexplained missing board', () => {
  const outcome = classifyAtsAcquisitionTurn({
    selectedCount: 2,
    results: [result('synchronized')],
  });

  assert.equal(outcome.taskStatus, 'partial');
  assert.equal(outcome.phase, 'partial');
  assert.equal(outcome.synchronized, 1);
  assert.equal(outcome.providerErrors, 1);
  assert.match(outcome.error || '', /1 board\(s\) not processed/);
});

test('ATS acquisition pagination and provider deferral are honest partial outcomes', () => {
  const pagination = classifyAtsAcquisitionTurn({
    selectedCount: 1,
    results: [result('partial')],
  });
  const deferred = classifyAtsAcquisitionTurn({
    selectedCount: 1,
    results: [result('deferred')],
  });

  assert.equal(pagination.taskStatus, 'partial');
  assert.equal(pagination.phase, 'partial');
  assert.equal(deferred.taskStatus, 'partial');
  assert.equal(deferred.deferred, 1);
});

test('stop wins over completed receipts and marks unprocessed boards interrupted', () => {
  const outcome = classifyAtsAcquisitionTurn({
    selectedCount: 3,
    results: [result('synchronized')],
    stopRequested: true,
  });

  assert.equal(outcome.taskStatus, 'partial');
  assert.equal(outcome.phase, 'interrupted');
  assert.equal(outcome.synchronized, 1);
  assert.equal(outcome.interrupted, 2);
  assert.match(outcome.error || '', /interrupted after 1 of 3/);
});

test('live acquisition checkpoints renew well inside the scheduler lease with honest completed counters', () => {
  const checkpoint = atsAcquisitionCheckpoint({
    selectedCount: 4,
    results: [
      result('synchronized', { requests: 3, responded: true }),
      result('partial', { requests: 2, responded: true }),
      result('error', { requests: 1, responded: false }),
    ],
  });

  assert.ok(ATS_ACQUISITION_TASK_HEARTBEAT_MS < 30 * 60_000);
  assert.equal(checkpoint.counters.requests, 6);
  assert.equal(checkpoint.counters.providerErrors, 1);
  assert.deepEqual(checkpoint.cursor, {
    phase: 'running',
    selected: 4,
    completed: 3,
    synchronized: 1,
    partial: 1,
    deferred: 0,
    providerErrors: 1,
  });
});
