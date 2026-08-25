import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { LOCAL_SCORING_TERMINAL_ATTEMPTS } from '../localScoringPolicy';
import {
  inspectOperationalPartition,
  isRawLocalTerminalFailure,
  operationalPartitionScopeWhere,
  operationalQueueWhere,
  OPERATIONAL_QUEUE_CATEGORIES,
  type OperationalQueueCategory,
} from '../operationalQueue';

const emptyCategories = (): Record<OperationalQueueCategory, string[]> => ({
  needs_jd: [],
  local_scoring: [],
  action_needed: [],
  aim_fit: [],
  experience_fit: [],
});

test('covered active jobs belong to exactly one operational queue', () => {
  const categoryJobIds = emptyCategories();
  for (const category of OPERATIONAL_QUEUE_CATEGORIES) categoryJobIds[category].push(category);
  const inspected = inspectOperationalPartition([...OPERATIONAL_QUEUE_CATEGORIES], categoryJobIds);
  assert.equal(inspected.scopedJobCount, 5);
  assert.deepEqual(inspected.noCategoryJobIds, []);
  assert.deepEqual(inspected.multipleCategoryJobs, []);
  assert.deepEqual(inspected.categoryCounts, {
    needs_jd: 1,
    local_scoring: 1,
    action_needed: 1,
    aim_fit: 1,
    experience_fit: 1,
  });
});

test('partition inspection reports zero-category and multiple-category contradictions', () => {
  const categoryJobIds = emptyCategories();
  categoryJobIds.local_scoring.push('overlap');
  categoryJobIds.action_needed.push('overlap');
  const inspected = inspectOperationalPartition(['hidden', 'overlap'], categoryJobIds);
  assert.deepEqual(inspected.noCategoryJobIds, ['hidden']);
  assert.deepEqual(inspected.multipleCategoryJobs, [{
    jobId: 'overlap',
    categories: ['local_scoring', 'action_needed'],
  }]);
});

test('raw local terminal errors are visible only after the bounded attempt threshold', () => {
  const actionNeeded = JSON.stringify(operationalQueueWhere('action_needed', []));
  assert.equal(LOCAL_SCORING_TERMINAL_ATTEMPTS, 3);
  assert.match(actionNeeded, /"scoringStatus":"failed"/);
  assert.match(actionNeeded, /"scoreAttempts":\{"gte":3\}/);
  assert.match(actionNeeded, /"scoreError":\{"not":null\}/);
  assert.match(actionNeeded, /"NOT":\{"OR":\[/);

  const local = operationalQueueWhere('local_scoring', []);
  assert.deepEqual(local.scoringStatus, { in: ['queued', 'scoring'] });
  assert.equal(actionNeeded.includes('"scoreAttempts":{"lt":3}'), false);
});

test('an Aim failure stays in Action Needed when its receipt goes stale', () => {
  // A stale receipt stops suppressing the job, but the row is still `failed`,
  // and the Aim queue only accepts `scored` rows. Without this branch the job
  // belongs to no queue at all.
  const aimBranch = (currentIds: string[]) => operationalQueueWhere('action_needed', currentIds)
    .OR?.[0]?.OR?.find((branch) => (
      typeof branch.scoreError === 'object'
      && branch.scoreError !== null
      && 'startsWith' in branch.scoreError
      && branch.scoreError.startsWith === 'Aim Fit could not score this job:'
    ));

  assert.deepEqual(aimBranch([]), {
    scoreError: { startsWith: 'Aim Fit could not score this job:' },
  });
  assert.deepEqual(aimBranch(['currently-suppressed']), {
    scoreError: { startsWith: 'Aim Fit could not score this job:' },
    id: { notIn: ['currently-suppressed'] },
  });
  assert.equal(
    JSON.stringify(operationalQueueWhere('action_needed', [])).includes('aimFailureReceipts'),
    false,
  );
});

test('raw local fallback cannot revive a stale standardized Aim failure', () => {
  for (const scoreError of [
    'JD recovery rejected: stale recovery outcome',
    'Aim Fit could not score this job: stale worker receipt',
    'Experience Fit could not score this job: stale worker receipt',
  ]) {
    assert.equal(isRawLocalTerminalFailure({
      scoringStatus: 'failed',
      scoreAttempts: 7,
      scoreError,
    }), false);
  }
  assert.equal(isRawLocalTerminalFailure({
    scoringStatus: 'failed',
    scoreAttempts: 3,
    scoreError: 'socket closed before local scoring completed',
  }), true);
});

test('current Aim suppression IDs route to Action Needed and out of Aim without deleting history', () => {
  const currentId = 'current-receipt';
  assert.deepEqual(operationalQueueWhere('action_needed', [currentId]).OR?.at(-1), {
    id: { in: [currentId] },
  });
  assert.deepEqual(operationalQueueWhere('aim_fit', [currentId]).id, {
    notIn: [currentId],
  });
  assert.equal(JSON.stringify(operationalQueueWhere('aim_fit', [])).includes('aimFailureReceipts'), false);
});

test('partition scope excludes ordinary Inbox and protected terminal states', () => {
  assert.deepEqual(operationalPartitionScopeWhere([]), {
    tailoringStaged: false,
    OR: [
      { status: 'pending_af' },
      {
        status: 'inbox',
        OR: [
          { scoringStatus: { in: ['needs_jd', 'queued', 'scoring', 'failed'] } },
          { jdBatchId: { not: null } },
        ],
      },
    ],
  });
  for (const category of OPERATIONAL_QUEUE_CATEGORIES) {
    const where = operationalQueueWhere(category, []);
    assert.equal(where.tailoringStaged, false);
    assert.doesNotMatch(JSON.stringify(where), /applied|interviewing|bookmarked|dismissed|cooldown/);
  }
});

test('manual scoring readiness fails closed on operational partition violations', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'scripts', 'audit_manual_scoring_readiness.ts'),
    'utf8',
  );
  assert.match(source, /operationalPartitionScopeWhere\(currentSuppressionIds\)/);
  assert.match(source, /operationalQueueWhere\(category, currentSuppressionIds\)/);
  assert.match(source, /violations\.push\('operational_queue_partition'\)/);
});
