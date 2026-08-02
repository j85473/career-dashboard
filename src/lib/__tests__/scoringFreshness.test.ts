import assert from 'node:assert/strict';
import test from 'node:test';

import { recentDismissedRecoveryIds, staleActiveScoreIds } from '../scoringFreshness';

test('only unreviewed active jobs with stale or missing scoring provenance are requeued', () => {
  const candidates = [
    { id: 'stale', passReason: null, tailoringStaged: false },
    { id: 'missing', passReason: null, tailoringStaged: false },
    { id: 'current', passReason: null, tailoringStaged: false },
    { id: 'promoted', passReason: 'Promoted from Wildcard by user: Manually promoted by user', tailoringStaged: false },
    { id: 'tailoring', passReason: null, tailoringStaged: true },
  ];
  const versions = new Map([
    ['stale', 'standard-job-evaluator-v6.1'],
    ['current', 'standard-job-evaluator-v6.3'],
    ['promoted', 'standard-job-evaluator-v6.1'],
    ['tailoring', 'standard-job-evaluator-v6.1'],
  ]);
  assert.deepEqual(
    staleActiveScoreIds(candidates, versions, 'standard-job-evaluator-v6.3'),
    ['stale', 'missing'],
  );
});

test('recent dismissal recovery is current-filtered, stale-only, priority-ranked, and bounded', () => {
  const cutoff = new Date('2026-07-12T00:00:00.000Z');
  const candidates = [
    { id: 'target-low', title: 'Customer Success Manager', aimFitScore: 45, reqFitScore: 65, localFilterPasses: true },
    { id: 'near-miss', title: 'Growth Director', aimFitScore: 70, reqFitScore: 80, localFilterPasses: true },
    { id: 'local-reject', title: 'Territory Manager - Texas', aimFitScore: 90, reqFitScore: 90, localFilterPasses: false },
    { id: 'current', title: 'Channel Manager', aimFitScore: 70, reqFitScore: 80, localFilterPasses: true },
    { id: 'old', title: 'Account Manager', aimFitScore: 80, reqFitScore: 80, localFilterPasses: true },
    { id: 'weak', title: 'Operations Coordinator', aimFitScore: 40, reqFitScore: 50, localFilterPasses: true },
  ];
  const events = new Map([
    ['target-low', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['near-miss', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['local-reject', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['current', { promptVersion: 'standard-job-evaluator-v6.3', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['old', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-06-01T00:00:00.000Z') }],
    ['weak', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
  ]);

  assert.deepEqual(
    recentDismissedRecoveryIds(candidates, events, 'standard-job-evaluator-v6.3', cutoff, 2),
    ['target-low', 'near-miss'],
  );
  assert.deepEqual(
    recentDismissedRecoveryIds(candidates, events, 'standard-job-evaluator-v6.3', cutoff, 0),
    [],
  );
});
