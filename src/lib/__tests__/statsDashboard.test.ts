import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enteredInboxCount,
  ingestionAccountedOutcomes,
  ingestionOutcomesReconcile,
  safeRate,
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
