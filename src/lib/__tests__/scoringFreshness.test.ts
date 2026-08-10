import assert from 'node:assert/strict';
import test from 'node:test';

import {
  latestUsablePromptVersions,
  recentDismissedRecoveryIds,
  staleActiveScoreIds,
} from '../scoringFreshness';

test('a stale newest score never falls back to an older apparently current event', () => {
  const versions = latestUsablePromptVersions([
    { jobId: 'stale', promptVersion: 'standard-job-evaluator-v6.7.1', staleAt: new Date('2026-08-09T12:00:00.000Z') },
    { jobId: 'stale', promptVersion: 'standard-job-evaluator-v6.10.0', staleAt: null },
    { jobId: 'usable', promptVersion: 'standard-job-evaluator-v6.10.0', staleAt: null },
  ]);

  assert.equal(versions.has('stale'), false);
  assert.equal(versions.get('usable'), 'standard-job-evaluator-v6.10.0');
});

test('only unreviewed active jobs with stale or missing scoring provenance are requeued', () => {
  const candidates = [
    { id: 'stale', passReason: null, tailoringStaged: false },
    { id: 'missing', passReason: null, tailoringStaged: false },
    { id: 'current', passReason: null, tailoringStaged: false },
    { id: 'promoted', passReason: 'Promoted by user: Manually promoted by user', tailoringStaged: false },
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
    { id: 'stale-event', title: 'Channel Manager', aimFitScore: 90, reqFitScore: 90, localFilterPasses: true },
  ];
  const events = new Map([
    ['target-low', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['near-miss', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['local-reject', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['current', { promptVersion: 'standard-job-evaluator-v6.3', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['old', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-06-01T00:00:00.000Z') }],
    ['weak', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['stale-event', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z'), staleAt: new Date('2026-08-09T00:00:00.000Z') }],
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
