import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectJobScoreAuthority,
  resolveScoreAuthority,
  scoreInvalidationReason,
  scoringInputMutationPolicy,
} from '../scoreAuthority';

test('a stale newest score suppresses an older nonstale score instead of resurrecting it', () => {
  const newestStale = {
    id: 'newest-stale',
    evaluationType: 'standard',
    promptVersion: 'standard-job-evaluator-v6.7.1',
    staleAt: '2026-08-09T12:00:00.000Z',
    staleReason: 'invalid evidence binding',
  };
  const olderNonstale = {
    id: 'older-valid',
    evaluationType: 'standard',
    promptVersion: 'standard-job-evaluator-v6.6.0',
    staleAt: null,
    staleReason: null,
  };

  const authority = resolveScoreAuthority([newestStale, olderNonstale]);

  assert.equal(authority.scoreAuthorityState, 'stale_replay_needed');
  assert.equal(authority.currentScore, null);
  assert.equal(authority.staleScore?.id, 'newest-stale');
  assert.equal(authority.staleScoreReason, 'invalid evidence binding');
});

test('only the newest nonstale standard A/E event is current authority', () => {
  const authority = resolveScoreAuthority([
    { id: 'context-only', evaluationType: 'context', staleAt: null },
    { id: 'current', evaluationType: 'ae_fit', staleAt: null },
    { id: 'older', evaluationType: 'standard', staleAt: null },
  ]);

  assert.equal(authority.scoreAuthorityState, 'current');
  assert.equal(authority.currentScore?.id, 'current');
  assert.equal(authority.staleScore, null);
});

test('score invalidation reasons are deterministic and field-specific', () => {
  assert.equal(
    scoreInvalidationReason(['title', 'description', 'title']),
    'job-input-edited:description,title',
  );
  assert.equal(scoreInvalidationReason([]), 'job-input-edited:forced_rescore');
});

test('list projection hides stale machine scalars but preserves an explicit human promotion', () => {
  const projected = projectJobScoreAuthority({
    id: 'job-1',
    status: 'inbox',
    passReason: 'Promoted by user: strong channel fit',
    aimFitScore: 91,
    reqFitScore: 88,
    travelScore: 95,
    compensation: '$150K',
  }, {
    id: 'stale-score',
    evaluationType: 'standard',
    staleAt: new Date('2026-08-09T12:00:00.000Z'),
    staleReason: 'invalid prompt cohort',
    aimFitScore: 91,
    experienceFitScore: 88,
    travelScore: 95,
  });

  assert.equal(projected.scoreAuthorityState, 'stale_replay_needed');
  assert.equal(projected.currentScore, null);
  assert.equal(projected.aimFitScore, null);
  assert.equal(projected.reqFitScore, null);
  assert.equal(projected.travelScore, null);
  assert.equal(projected.compensation, null);
  assert.equal(projected.passReason, 'Promoted by user: strong channel fit');
});

test('skip-rescore suppresses queueing but never preserves authority after an input edit', () => {
  assert.deepEqual(scoringInputMutationPolicy({
    scoringInputChanged: true,
    forceRescore: false,
    skipRescore: true,
  }), {
    shouldInvalidateScores: true,
    shouldQueueRescore: false,
  });
  assert.deepEqual(scoringInputMutationPolicy({
    scoringInputChanged: false,
    forceRescore: false,
    skipRescore: true,
  }), {
    shouldInvalidateScores: false,
    shouldQueueRescore: false,
  });
});

test('current score authority projects the durable travel range payload', () => {
  const projected = projectJobScoreAuthority({
    status: 'inbox', passReason: null, compensation: '$100K base',
  }, {
    evaluationType: 'standard',
    staleAt: null,
    aimFitScore: 90,
    experienceFitScore: 80,
    travelScore: 75,
    mandatoryRequirementAssessments: {
      version: 1,
      criteria: [],
      travelRange: {
        kind: 'range', minimumPercent: 50, maximumPercent: 75, label: '50-75%', sourceText: 'Travel 50-75%.',
      },
    },
  });
  assert.deepEqual(projected.travelRange, {
    kind: 'range', minimumPercent: 50, maximumPercent: 75, label: '50-75%', sourceText: 'Travel 50-75%.',
  });
});
