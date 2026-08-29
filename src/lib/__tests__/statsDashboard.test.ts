import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enteredInboxCount,
  ingestionAccountedOutcomes,
  ingestionOutcomesReconcile,
  safeRate,
  classifyTaskAvailability,
  taskAvailabilityReconciles,
  trackingCoverage,
} from '../statsDashboard';
import { normalizeStatsTaskContract } from '../statsClientContract';

test('ingestion reconciliation uses mutually exclusive per-job outcomes', () => {
  const counts = {
    seen: 100,
    ingested: 18,
    duplicates: 62,
    filtered: 15,
    processingErrors: 5,
    providerErrors: 9,
  };
  assert.equal(ingestionAccountedOutcomes(counts), 100);
  assert.equal(ingestionOutcomesReconcile(counts), true);
  assert.equal(ingestionOutcomesReconcile({ ...counts, duplicates: 61 }), false);
});

test('task availability categories are mutually exclusive and active counts reconcile', () => {
  const now = new Date('2026-08-14T18:00:00.000Z');
  const base = { taskKind: 'search', lifecycleStatus: 'active', status: 'succeeded', nextRunAt: now, now };
  assert.equal(classifyTaskAvailability(base), 'runnableNow');
  assert.equal(classifyTaskAvailability({ ...base, taskKind: 'orchestration' }), 'orchestration');
  assert.equal(classifyTaskAvailability({ ...base, lifecycleStatus: 'retired' }), 'retired');
  assert.equal(classifyTaskAvailability({ ...base, status: 'running', leaseToken: 'lease', leaseExpiresAt: new Date(now.getTime() - 1) }), 'staleLease');
  assert.equal(classifyTaskAvailability({ ...base, circuit: { state: 'open', openUntil: new Date(now.getTime() + 60_000), dailyUsed: 0, monthlyUsed: 0 } }), 'circuitCooldown');
  assert.equal(classifyTaskAvailability({ ...base, circuit: { state: 'closed', dailyLimit: 1, dailyUsed: 1, monthlyUsed: 1, budgetDay: '2026-08-14' } }), 'budgetBlocked');
  assert.equal(classifyTaskAvailability({ ...base, status: 'failed', nextRunAt: new Date(now.getTime() + 60_000) }), 'failedAwaitingRetry');
  assert.equal(taskAvailabilityReconciles({
    running: 1, runnableNow: 2, scheduled: 3, circuitCooldown: 4,
    budgetBlocked: 5, failedAwaitingRetry: 6, staleLease: 7,
    retired: 100, orchestration: 100,
  }, 28), true);
});

test('provider failures do not inflate the seen-job denominator', () => {
  const base = {
    seen: 2,
    ingested: 1,
    duplicates: 1,
    filtered: 0,
    processingErrors: 0,
    providerErrors: 500,
  };
  assert.equal(ingestionOutcomesReconcile(base), true);
});

test('entered inbox counts only A/E passes and explicit human promotions', () => {
  const allAePasses = 7;
  const aePassesThatChangedStatus = 4;
  assert.equal(enteredInboxCount(aePassesThatChangedStatus, 2), 6);
  assert.notEqual(enteredInboxCount(allAePasses, 2), 6);
});

test('tracking coverage makes the first event day visibly partial', () => {
  assert.equal(trackingCoverage('2026-08-08', '2026-08-09T01:03:00.000Z'), 'untracked');
  assert.equal(trackingCoverage('2026-08-09', '2026-08-09T01:03:00.000Z'), 'partial');
  assert.equal(trackingCoverage('2026-08-10', '2026-08-09T01:03:00.000Z'), 'tracked');
  assert.equal(trackingCoverage('2026-08-10', null), 'untracked');
});

test('rates are explicit about missing denominators', () => {
  assert.equal(safeRate(19, 100), 19);
  assert.equal(safeRate(1, 3), 33.3);
  assert.equal(safeRate(0, 0), null);
});

test('legacy scheduler aliases are normalized before the Stats UI renders', () => {
  const payload = normalizeStatsTaskContract({
    operations: {
      tasks: {
        summary: {
          total: 10,
          due: 3,
          running: 1,
          staleLeases: 1,
          blockedBudget: 2,
          failed: 1,
          nextDueAt: '1970-01-01T00:00:00.000Z',
        },
        checkpoints: [{
          id: 'due-task',
          status: 'succeeded',
          isDue: true,
          nextRunAt: '2026-08-14T18:00:00.000Z',
        }],
      },
    },
  });

  const { summary, checkpoints } = payload.operations.tasks;
  assert.equal(summary.activeSearchTasks, 10);
  assert.equal(summary.runnableNow, 3);
  assert.equal(summary.scheduled, 2);
  assert.equal(summary.circuitCooldown, 0);
  assert.equal(summary.failedAwaitingRetry, 1);
  assert.equal(summary.categoryReconciles, false);
  assert.equal(summary.oldestRunnableSince, '2026-08-14T18:00:00.000Z');
  assert.equal(summary.nextRunnableAt, null);
  assert.equal(checkpoints[0].category, 'runnableNow');
  assert.equal(checkpoints[0].lifecycleStatus, 'active');
  assert.equal(checkpoints[0].taskKind, 'search');
  assert.deepEqual(payload.inventory.atsBoards.path, {
    available: false,
    enabled: false,
    dailyTarget: 0,
    attemptedToday: 0,
    respondedToday: 0,
    synchronizedToday: 0,
    processedToday: 0,
    failedToday: 0,
    remainingJobs: 0,
    backpressureJobs: 0,
    oldestSynchronizedAt: null,
    processedJobsLastHour: 0,
    fetchedJobsLastHour: 0,
    queuedJobsLastHour: 0,
    prequeueDuplicatesLastHour: 0,
    deferredWithoutContactLastHour: 0,
    lastAttemptedAt: null,
    lastRespondedAt: null,
    lastSynchronizedAt: null,
    lastProcessedAt: null,
    queue: {
      fetching: 0,
      partial: 0,
      queued: 0,
      processing: 0,
      failed: 0,
    },
  });
});

test('current scheduler fields remain authoritative during normalization', () => {
  const payload = normalizeStatsTaskContract({
    operations: {
      tasks: {
        summary: {
          activeSearchTasks: 4,
          categoryReconciles: true,
          runnableNow: 1,
          running: 0,
          scheduled: 3,
          staleLeases: 0,
          circuitCooldown: 0,
          blockedBudget: 0,
          failedAwaitingRetry: 0,
          retired: 5,
          orchestration: 2,
          oldestRunnableSince: null,
          nextRunnableAt: '2026-08-15T18:00:00.000Z',
          latestWatermarkAt: null,
          updatedAt: null,
        },
        checkpoints: [],
      },
    },
    inventory: {
      atsBoards: {
        path: {
          available: true,
          enabled: true,
          dailyTarget: 6_209,
          attemptedToday: 900,
          respondedToday: 880,
          synchronizedToday: 850,
          processedToday: 840,
          failedToday: 20,
          remainingJobs: 4_296,
          oldestSynchronizedAt: '2026-08-27T14:00:00.000Z',
          processedJobsLastHour: 425,
          fetchedJobsLastHour: 1_200,
          queuedJobsLastHour: 300,
          prequeueDuplicatesLastHour: 900,
          deferredWithoutContactLastHour: 801,
          lastAttemptedAt: '2026-08-27T16:00:00.000Z',
          lastRespondedAt: '2026-08-27T15:59:00.000Z',
          lastSynchronizedAt: '2026-08-27T15:58:00.000Z',
          lastProcessedAt: '2026-08-27T15:57:00.000Z',
          queue: { fetching: 3, partial: 4, queued: 5, processing: 1, failed: 2 },
        },
      },
    },
  });

  assert.equal(payload.operations.tasks.summary.categoryReconciles, true);
  assert.equal(payload.operations.tasks.summary.scheduled, 3);
  assert.equal(payload.operations.tasks.summary.retired, 5);
  assert.equal(payload.operations.tasks.summary.orchestration, 2);
  assert.equal(payload.operations.tasks.summary.nextRunnableAt, '2026-08-15T18:00:00.000Z');
  assert.equal(payload.inventory.atsBoards.path.available, true);
  assert.equal(payload.inventory.atsBoards.path.enabled, true);
  assert.equal(payload.inventory.atsBoards.path.dailyTarget, 6_209);
  assert.equal(payload.inventory.atsBoards.path.remainingJobs, 4_296);
  assert.equal(payload.inventory.atsBoards.path.processedJobsLastHour, 425);
  assert.equal(payload.inventory.atsBoards.path.fetchedJobsLastHour, 1_200);
  assert.equal(payload.inventory.atsBoards.path.queuedJobsLastHour, 300);
  assert.equal(payload.inventory.atsBoards.path.prequeueDuplicatesLastHour, 900);
  assert.equal(payload.inventory.atsBoards.path.deferredWithoutContactLastHour, 801);
  assert.equal(payload.inventory.atsBoards.path.queue.partial, 4);
  assert.equal(payload.inventory.atsBoards.path.lastProcessedAt, '2026-08-27T15:57:00.000Z');
});
