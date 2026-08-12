import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'jobs', '[id]', 'route.ts'),
  'utf8',
);
const invalidationSource = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'scoreInvalidation.ts'),
  'utf8',
);
const scrapeSource = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'jobs', '[id]', 'scrape', 'route.ts'),
  'utf8',
);
const batchJdSource = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'jobs', 'batch-jd-submit', 'route.ts'),
  'utf8',
);
const localScoringSource = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'jobScoring.ts'),
  'utf8',
);

test('job detail ranks all standard A/E events and exposes explicit score authority', () => {
  assert.match(source, /evaluationType: \{ in: \[\.\.\.AUTHORITATIVE_SCORE_EVENT_TYPES\] \}/);
  assert.match(source, /orderBy: \[\{ createdAt: 'desc' \}, \{ id: 'desc' \}\]/);
  assert.match(source, /staleAt: true/);
  assert.match(source, /staleReason: true/);
  assert.match(source, /const authority = resolveScoreAuthority\(scoreHistory\)/);
  assert.match(source, /aimFitScore: currentScore\?\.aimFitScore \?\? null/);
  assert.match(source, /reqFitRationale: currentScore\?\.experienceReason \?\? null/);
  assert.match(source, /compensation: currentScore \? job\.compensation : null/);
  assert.doesNotMatch(source, /scoreHistory\?\.\[0\]/);
});

test('input edits invalidate every active standard A/E event and emit one stable event per score', () => {
  assert.match(source, /invalidateActiveJobScores\(\{/);
  assert.match(source, /shouldInvalidateScores/);
  assert.match(source, /shouldQueueRescore/);
  assert.match(invalidationSource, /staleAt: null/);
  assert.match(invalidationSource, /data: \{ staleAt: invalidatedAt, staleReason \}/);
  assert.match(invalidationSource, /eventType: 'score_invalidated'/);
  assert.match(invalidationSource, /identityParts: \['job_input_edit', scoreEvent\.id\]/);
  assert.match(invalidationSource, /invalidatedEventId: scoreEvent\.id/);
  assert.match(source, /scoreInvalidationFields/);
});

test('successful manual scrape atomically invalidates the score event before returning replacement inputs', () => {
  assert.match(scrapeSource, /\$transaction\(async \(tx\)/);
  assert.match(scrapeSource, /result\.count === 1 && \(changedFields\.length > 0 \|\| !skipRescore\)/);
  assert.doesNotMatch(scrapeSource, /result\.count === 1 && !skipRescore/);
  assert.match(scrapeSource, /invalidateActiveJobScores\(\{/);
  assert.match(scrapeSource, /route: 'manual_scrape'/);
  assert.match(scrapeSource, /\}, tx\)/);
});

test('public PATCH cannot write worker-owned score projections', () => {
  const bodyBinding = source.match(/const \{([^}]+)\} = body;/)?.[1] || '';
  for (const field of [
    'scoringStatus',
    'experienceStatus',
    'aimFitScore',
    'reqFitScore',
    'reqFitRationale',
    'travelScore',
    'recommendedResume',
  ]) {
    assert.doesNotMatch(bodyBinding, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(source, /if \(aimFitScore !== undefined/);
  assert.doesNotMatch(source, /if \(reqFitScore !== undefined/);
  assert.doesNotMatch(source, /if \(travelScore !== undefined/);
});

test('automated JD replacement and local resolution use the same transactional authority closure', () => {
  assert.match(batchJdSource, /updateClaimedInputs/);
  assert.match(batchJdSource, /\$transaction\(async \(tx\)/);
  assert.match(batchJdSource, /route: 'batch_jd_resolution'/);
  assert.match(batchJdSource, /invalidateActiveJobScores\(\{/);

  assert.match(localScoringSource, /resolvedInputChanges/);
  assert.match(localScoringSource, /\$transaction\(async \(tx\)/);
  assert.match(localScoringSource, /route: 'local_scoring_resolution'/);
  assert.match(localScoringSource, /invalidateActiveJobScores\(\{/);
});

test('JD recovery applies the strict shared quality gate and cannot recycle the same first ten rows forever', () => {
  assert.match(batchJdSource, /decideJdRecovery/);
  assert.match(batchJdSource, /orderBy: \[\{ updatedAt: 'asc' \}, \{ id: 'asc' \}\]/);
  assert.doesNotMatch(batchJdSource, /job\.description\.length >= 400/);
  assert.doesNotMatch(batchJdSource, /isValidMarkdown/);
  assert.match(batchJdSource, /scoreAttempts: recoveryDecision\.nextAttempts/);
});
