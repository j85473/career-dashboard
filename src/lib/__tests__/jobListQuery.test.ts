import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionableQueueWhere,
  actionableQueueWhereWithCurrentAimSuppressions,
  jobOrder,
  jobWhere,
  jobWhereWithCurrentAimSuppressions,
  logWhere,
  positiveInteger,
} from '../jobListQuery';
import { aimScoringPriorityOrder } from '../manualScoringPriority';

test('pagination accepts positive integers and caps oversized pages', () => {
  assert.equal(positiveInteger(null, 48, 100), 48);
  assert.equal(positiveInteger('-2', 48, 100), 48);
  assert.equal(positiveInteger('500', 48, 100), 100);
  assert.equal(positiveInteger('25', 48, 100), 25);
});

test('log queues include only jobs that are still eligible for scoring', () => {
  const aimFit = logWhere('aim_fit');
  assert.equal(aimFit.scoringStatus, 'scored');
  assert.deepEqual(aimFit.aimFailureReceipts, {
    none: { suppressionActive: true, clearedAt: null },
  });
  assert.equal(aimFit.aimFitScore, null);
  assert.equal(aimFit.status, 'pending_af');
  // `passReason` is nullable, and SQL evaluates `NULL LIKE '…'` to NULL rather
  // than false, so a bare NOT over it yields NULL and the row is dropped. The
  // previous shape here excluded every job that had never been passed — 26,225
  // of 26,228 eligible jobs — so the null case must be admitted explicitly.
  assert.deepEqual(aimFit.OR, [
    {
      AND: [
        { fitCategory: { not: 'promoted' } },
        {
          OR: [
            { passReason: null },
            { NOT: { passReason: { startsWith: 'Promoted by user:', mode: 'insensitive' } } },
          ],
        },
        { NOT: { pipelineEvents: { some: { eventType: { in: ['user_promote', 'user_reject', 'user_lifecycle'] } } } } },
      ],
    },
    { pipelineEvents: { some: { eventType: 'user_rescore' } } },
  ]);
  const experienceFit = logWhere('experience_fit');
  assert.deepEqual(experienceFit.aimFitScore, { not: null });
  assert.equal(experienceFit.scoringStatus, 'scored');
  assert.equal(experienceFit.reqFitScore, null);
  assert.equal(experienceFit.status, 'pending_af');
  assert.deepEqual(experienceFit.OR, [
    { pipelineEvents: { none: { eventType: { in: ['user_promote', 'user_reject', 'user_lifecycle'] } } } },
    { pipelineEvents: { some: { eventType: 'user_rescore' } } },
  ]);
  assert.deepEqual(logWhere('context'), {
    status: 'passed',
    contextBatched: false,
    passReason: { not: null },
    NOT: { passReason: { contains: 'expired', mode: 'insensitive' } },
  });
});

test('retired travel scopes and sorts fall back instead of returning a stale projection', () => {
  // Travel Watch was removed once Aim v2 folded travel into the Aim score and
  // stopped writing Job.travelScore. An unknown status must not resolve to a
  // special scope, and the old sort keys must not order by the dead column.
  assert.deepEqual(jobWhere('travel_watch', 'aim_fit'), { status: 'travel_watch' });
  assert.deepEqual(jobOrder('inbox', 'travel_fit_high')[0], {
    aimFitScore: { sort: 'desc', nulls: 'last' },
  });
  assert.deepEqual(jobOrder('inbox', 'travel_fit')[0], {
    aimFitScore: { sort: 'desc', nulls: 'last' },
  });
});

test('inbox keeps stale replay and human-promoted jobs visible without a scalar-score gate', () => {
  assert.deepEqual(jobWhere('inbox', 'aim_fit'), {
    status: 'inbox',
    tailoringStaged: false,
  });
});

test('action-needed queue is limited to unrecoverable JDs and Aim or Experience failures', () => {
  assert.deepEqual(logWhere('action_needed'), actionableQueueWhere());
  assert.deepEqual(actionableQueueWhere(), {
    status: { in: ['pending_af', 'inbox'] },
    OR: [
      {
        scoringStatus: 'failed',
        OR: [
          { scoreError: { startsWith: 'JD recovery rejected:' } },
          { scoreError: { startsWith: 'Aim Fit could not score this job:' } },
          { scoreError: { startsWith: 'Experience Fit could not score this job:' } },
          {
            passReason: {
              in: [
                'JD recovery failed after 3 attempts. Manual review required.',
                'JD recovery failed. Manual review required.',
                'Failed to fetch JD after 3 attempts. Needs manual review.',
                'Error calling Jina. Manual review required.',
              ],
            },
          },
        ],
      },
      { aimFailureReceipts: { some: { suppressionActive: true, clearedAt: null } } },
    ],
  });
});

test('current Aim receipt identities govern Aim eligibility and Action Needed visibility', () => {
  const currentId = '11111111-1111-4111-8111-111111111111';
  const aimFit = jobWhereWithCurrentAimSuppressions('log', 'aim_fit', [currentId]);
  assert.deepEqual(aimFit.id, { notIn: [currentId] });
  assert.equal(aimFit.aimFailureReceipts, undefined);

  const actionNeeded = actionableQueueWhereWithCurrentAimSuppressions([currentId]);
  assert.equal(actionNeeded.tailoringStaged, false);
  assert.deepEqual(actionNeeded.OR?.at(-1), { id: { in: [currentId] } });
  assert.deepEqual(actionNeeded.OR?.[0], {
    scoringStatus: 'failed',
    OR: [
      { scoreError: { startsWith: 'JD recovery rejected:' } },
      { scoreError: { startsWith: 'Experience Fit could not score this job:' } },
      {
        scoreError: { startsWith: 'Aim Fit could not score this job:' },
        id: { notIn: [currentId] },
      },
      {
        passReason: {
          in: [
            'JD recovery failed after 3 attempts. Manual review required.',
            'JD recovery failed. Manual review required.',
            'Failed to fetch JD after 3 attempts. Needs manual review.',
            'Error calling Jina. Manual review required.',
          ],
        },
      },
      {
        AND: [
          { scoreAttempts: { gte: 3 } },
          { scoreError: { not: null } },
          {
            NOT: {
              OR: [
                { scoreError: { startsWith: 'JD recovery rejected:' } },
                { scoreError: { startsWith: 'Aim Fit could not score this job:' } },
                { scoreError: { startsWith: 'Experience Fit could not score this job:' } },
              ],
            },
          },
        ],
      },
    ],
  });

  const noCurrentReceipts = actionableQueueWhereWithCurrentAimSuppressions([]);
  assert.equal(noCurrentReceipts.OR?.length, 1);

  const local = jobWhereWithCurrentAimSuppressions('log', 'local_scoring', []);
  assert.deepEqual(local.scoringStatus, { in: ['queued', 'scoring'] });
});

test('applied date sorting uses the status-change timestamp', () => {
  assert.deepEqual(jobOrder('applied', 'newest')[0], { updatedAt: 'desc' });
});

test('operational queues never order by mutable score projections', () => {
  assert.deepEqual(jobOrder('log', 'aim_fit'), [{ createdAt: 'asc' }, { id: 'asc' }]);
  assert.deepEqual(jobOrder('log', 'experience_fit'), [{ createdAt: 'asc' }, { id: 'asc' }]);
});

test('Aim queue and export priority is highest local score, then newest job', () => {
  const expected = [
    { fitScore: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
    { id: 'asc' },
  ];
  assert.deepEqual(aimScoringPriorityOrder(), expected);
  assert.deepEqual(jobOrder('log', 'aim_priority'), expected);
});
