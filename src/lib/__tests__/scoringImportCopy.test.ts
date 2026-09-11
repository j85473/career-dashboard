import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pendingScoringImportCounts,
  scoringImportCompletionMessage,
  scoringImportConfirmationMessage,
  scoringImportPreviewHeadline,
  type ScoringImportCopyPreview,
} from '../scoringImportCopy';

const projections = (accepted: number, unscored: number) => [
  ...Array.from({ length: accepted }, () => ({ applicable: true })),
  ...Array.from({ length: unscored }, () => ({ applicable: false })),
];

test('fresh Aim run confirmation states that zero jobs will not move to Scoring Failed', () => {
  const preview: ScoringImportCopyPreview = {
    kind: 'run',
    stage: 'aim',
    acceptedCount: 139,
    safeFailureCount: 0,
    completedBatchCount: 0,
    projections: projections(139, 0),
  };

  assert.equal(scoringImportPreviewHeadline(preview), 'File check: 139 accepted Aim Fit scoring results · no unscored jobs');
  assert.equal(pendingScoringImportCounts(preview).accepted, 139);
  const message = scoringImportConfirmationMessage(preview, 40);
  assert.match(message, /139 accepted Aim Fit scoring results will be recorded\./);
  assert.match(message, /No unscored jobs will be sent to Scoring Failed\./);
  assert.doesNotMatch(message, /0 unscored|result\(s\)|job\(s\)/);
});

test('Experience confirmation reports accepted and unscored jobs with correct grammar', () => {
  const preview: ScoringImportCopyPreview = {
    stage: 'experience',
    acceptedCount: 1,
    safeFailureCount: 2,
    projections: projections(1, 2),
  };

  const message = scoringImportConfirmationMessage(preview, 40);
  assert.match(message, /Import this Experience Fit batch\?/);
  assert.match(message, /1 accepted Experience Fit scoring result will be recorded\./);
  assert.match(message, /2 unscored jobs will be sent to Scoring Failed\./);
  assert.doesNotMatch(message, /child batch at a time/);
});

test('resumed run confirmation counts only pending child projections', () => {
  const preview: ScoringImportCopyPreview = {
    kind: 'run',
    stage: 'experience',
    acceptedCount: 42,
    safeFailureCount: 2,
    completedBatchCount: 1,
    projections: projections(2, 1),
  };

  assert.deepEqual(pendingScoringImportCounts(preview), { accepted: 2, unscored: 1 });
  const message = scoringImportConfirmationMessage(preview, 40);
  assert.match(message, /2 accepted Experience Fit scoring results will be recorded\./);
  assert.match(message, /1 unscored job will be sent to Scoring Failed\./);
  assert.match(message, /1 completed child batch will not be applied again\./);
});

test('completion copy uses the uploaded file stage and omits zero-action phrasing', () => {
  assert.equal(
    scoringImportCompletionMessage('experience', 'run', { imported: 139, released: 0, completedBatches: 4 }),
    [
      'Experience Fit run import completed.',
      '139 accepted Experience Fit scoring results are recorded for this run.',
      'No unscored jobs from this run were sent to Scoring Failed.',
      '4 child batches completed.',
    ].join('\n'),
  );
});
