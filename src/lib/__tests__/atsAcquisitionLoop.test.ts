import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ATS_ACQUISITION_TASK_HEARTBEAT_MS,
  atsAcquisitionCheckpoint,
  atsFailureRetryDelayMs,
  classifyAtsAcquisitionTurn,
} from '../atsAcquisitionLoop';
import {
  ATS_FAILURE_RETRY_BASE_MS,
  ATS_FAILURE_RETRY_CEILING_MS,
} from '../ingestionTaskCatalog';
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

test('a failed ATS turn retries on loop time, not the shared task retry delay', () => {
  // completionBasedNextRunAt ignores continuationDelayMs for a failed status
  // and falls back to DEFAULT_TASK_RETRY_DELAY_MS, so an unspaced failure held
  // the whole board rotation idle for thirty minutes over one bad board.
  assert.equal(ATS_FAILURE_RETRY_BASE_MS, 15_000);
  assert.equal(ATS_FAILURE_RETRY_CEILING_MS, 300_000);
  assert.equal(atsFailureRetryDelayMs(1), 15_000);
  assert.equal(atsFailureRetryDelayMs(2), 30_000);
  assert.equal(atsFailureRetryDelayMs(3), 60_000);
  assert.equal(atsFailureRetryDelayMs(5), 240_000);
  // A genuinely hot failure loop is still damped, and stays well under the
  // thirty-minute shared retry it replaces.
  assert.equal(atsFailureRetryDelayMs(6), ATS_FAILURE_RETRY_CEILING_MS);
  assert.equal(atsFailureRetryDelayMs(500), ATS_FAILURE_RETRY_CEILING_MS);
  assert.equal(atsFailureRetryDelayMs(0), 15_000);
  assert.ok(ATS_FAILURE_RETRY_CEILING_MS < 30 * 60_000);
});

test('the ATS loop spaces only its own failures and clears the escalation on progress', () => {
  const loop = readFileSync(
    path.join(process.cwd(), 'src/lib/atsAcquisitionLoop.ts'),
    'utf8',
  );
  // The escalation must be ATS-owned: retryDelayMs is passed only when this
  // loop actually failed, so no other task's retry policy changes.
  assert.match(
    loop,
    /retryDelayMs: consecutiveFailedTurns > 0\s+\? atsFailureRetryDelayMs\(consecutiveFailedTurns\)\s+: undefined,/,
  );
  assert.match(
    loop,
    /consecutiveFailedTurns = outcome\.taskStatus === 'failed' \? consecutiveFailedTurns \+ 1 : 0;/,
  );
  // An idle or backpressured turn selected no boards and is not a failure.
  assert.match(
    loop,
    /if \(boards\.length === 0\) \{\s+consecutiveFailedTurns = 0;/,
  );
  // A stop is not a failure either, so quiescence cannot inflate the spacing.
  assert.match(loop, /if \(!stopRequested\) consecutiveFailedTurns \+= 1;/);
});
