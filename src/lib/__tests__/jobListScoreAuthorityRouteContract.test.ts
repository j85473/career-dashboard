import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const listRoute = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'jobs', 'route.ts'),
  'utf8',
);
const searchRoute = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'jobs', 'search', 'route.ts'),
  'utf8',
);
const authorityQuery = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'jobScoreAuthorityQuery.ts'),
  'utf8',
);
const card = readFileSync(
  path.join(process.cwd(), 'src', 'components', 'JobCard.tsx'),
  'utf8',
);
const overlay = readFileSync(
  path.join(process.cwd(), 'src', 'components', 'ExpandOverlay.tsx'),
  'utf8',
);

test('list and search project mutable Job scalars through newest-event authority', () => {
  assert.match(listRoute, /latestJobScoreEvents/);
  assert.match(listRoute, /projectJobScoreAuthority/);
  assert.match(searchRoute, /latestJobScoreEvents/);
  assert.match(searchRoute, /projectJobScoreAuthority/);
  assert.match(authorityQuery, /ROW_NUMBER\(\) OVER/);
  assert.match(authorityQuery, /ORDER BY e\."createdAt" DESC, e\."id" DESC/);
  assert.match(authorityQuery, /WHERE r\.rank = 1/);
  assert.doesNotMatch(authorityQuery, /"staleAt" IS NULL[\s\S]*ROW_NUMBER/);
});

test('Travel Watch filters and sorts only current staged Aim travel percentage', () => {
  assert.match(listRoute, /family = 'aim' AND family_rank = 1/);
  assert.match(listRoute, /artifact\."staleAt" IS NULL/);
  assert.match(listRoute, /aim\."inputBindings"->>'globalInputVersionsHash'/);
  assert.match(listRoute, /latest\."travelScore" >= \$\{input\.minimumTravel\}/);
  assert.match(listRoute, /latest\."travelScore" DESC/);
});

test('all non-log list ordering joins newest event authority before pagination', () => {
  assert.match(listRoute, /authoritativeScorePage/);
  assert.match(listRoute, /LEFT JOIN newest ON newest\."jobId" = job\."id"/);
  assert.match(listRoute, /LEFT JOIN latest ON latest\."jobId" = job\."id"/);
  assert.match(listRoute, /status !== 'log'/);
  assert.match(listRoute, /latest\."aimFitScore" DESC NULLS LAST/);
  assert.match(listRoute, /latest\."experienceFitScore" DESC NULLS LAST/);
  assert.match(listRoute, /input\.status === 'applied' \? 'updatedAt' : 'createdAt'/);
});

test('cards render stale jobs as replaying and never fall back to local scalar scores', () => {
  assert.match(card, /scoreAuthorityState === 'stale_replay_needed'/);
  assert.match(card, /Prior score hidden · replay in progress/);
  assert.match(card, /hasCurrentScoreAuthority \? job\.aimFitScore : null/);
  assert.doesNotMatch(card, /job\.aimFitScore \?\? job\.fitScore/);
});

test('edit UX explains that no-queue input changes still hide prior authority', () => {
  assert.match(overlay, /prior score will be hidden because it no longer matches/);
  assert.match(overlay, /updated without queueing\. The prior score is hidden/);
  assert.doesNotMatch(overlay, /experienceStatus: 'queued'/);
  assert.doesNotMatch(overlay, /reqFitScore: null/);
});
