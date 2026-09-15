import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { isManualScoringQueueTab } from '../manualScoringQueueOrder';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'manualScoringQueueOrder.ts'),
  'utf8',
);

test('only Aim Fit and Experience Fit use the fixed manual-scoring queue order', () => {
  assert.equal(isManualScoringQueueTab('aim_fit'), true);
  assert.equal(isManualScoringQueueTab('experience_fit'), true);
  assert.equal(isManualScoringQueueTab('local_scoring'), false);
  assert.equal(isManualScoringQueueTab('scoring_failed'), false);
});

test('Aim Fit orders by local score and then local-scoring completion time', () => {
  assert.match(source, /ORDER BY job\."fitScore" DESC NULLS LAST/);
  assert.match(source, /FROM "JobScoringStatusHistory" history/);
  assert.match(source, /history\."scoringStatus" = 'scored'/);
  assert.match(source, /SELECT MAX\(history\."createdAt"\)/);
});

test('Experience Fit orders by Aim score and then Aim result time', () => {
  assert.match(source, /SELECT event\."aimFitScore", event\."createdAt"/);
  assert.match(source, /ORDER BY COALESCE\(latest_aim\."aimFitScore", job\."aimFitScore"\) DESC NULLS LAST/);
  assert.match(source, /FROM "JobScoreEvent" event/);
  assert.match(source, /event\."evaluationType" = 'aim_fit'/);
  assert.match(source, /COALESCE\(latest_aim\."createdAt", job\."updatedAt"\) DESC/);
});

test('manual-scoring recency never uses dashboard ingestion time', () => {
  assert.match(source, /job\."updatedAt"/);
  assert.match(source, /job\.id ASC/);
  assert.doesNotMatch(source, /job\."createdAt"/);
});
