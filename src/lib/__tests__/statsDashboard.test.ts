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
