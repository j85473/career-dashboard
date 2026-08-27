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
  assert.match(listRoute, /projectJobListScoreAuthority/);
  assert.match(searchRoute, /latestJobScoreEvents/);
  assert.match(searchRoute, /projectJobListScoreAuthority/);
  assert.match(authorityQuery, /ROW_NUMBER\(\) OVER/);
  assert.match(authorityQuery, /ORDER BY e\."createdAt" DESC, e\."id" DESC/);
  assert.match(authorityQuery, /WHERE r\.rank = 1/);
  assert.doesNotMatch(authorityQuery, /"staleAt" IS NULL[\s\S]*ROW_NUMBER/);
});

test('collapsed cards receive scalar display metadata without full score-event payloads', () => {
  assert.match(card, /job\.aimDisplayBand/);
  assert.match(card, /job\.aimSchemaVersion/);
  assert.doesNotMatch(card, /job\.currentAim/);
  assert.match(overlay, /fetch\(`\/api\/jobs\/\$\{initialJob\.id\}`/);
});

test('the retired Travel Watch filter is gone from the list route', () => {
  assert.doesNotMatch(listRoute, /travel_watch/);
  assert.doesNotMatch(listRoute, /minimumTravel/);
  assert.match(listRoute, /orderBy: jobOrder\(status, sort\)/);
});

test('board discovery, counting, sorting, and paging never scan score-event history', () => {
  assert.match(listRoute, /prisma\.job\.findMany/);
  assert.match(listRoute, /prisma\.job\.count/);
  assert.match(listRoute, /latestJobScoreEvents\(pageJobs\.map/);
  assert.doesNotMatch(listRoute, /authoritativeScorePage/);
  assert.doesNotMatch(listRoute, /FROM "JobScoreEvent"/);
  assert.doesNotMatch(listRoute, /ROW_NUMBER\(\) OVER/);
  assert.doesNotMatch(listRoute, /COUNT\(\*\) OVER/);
});

test('cards render stale jobs as replaying and never fall back to local scalar scores', () => {
  assert.match(card, /scoreAuthorityState === 'stale_replay_needed'/);
  assert.match(card, /Prior score hidden · replay in progress/);
  assert.match(card, /hasCurrentScoreAuthority \? job\.aimFitScore : null/);
  assert.doesNotMatch(card, /job\.aimFitScore \?\? job\.fitScore/);
});

test('edit UX tells the truth about what declining a rescore does to the score', () => {
  // The prompt is the only place the trade is stated: the retained score
  // describes the job as it read before the edit. If the copy and the policy
  // ever disagree, the copy is the one users act on.
  assert.match(overlay, /keeps the current score, which will still reflect the description as it read before this edit/);
  assert.match(overlay, /keeps the current score, which will still reflect the details as they read before this edit/);
  assert.match(overlay, /The existing score was kept and still reflects the previous description/);
  assert.match(overlay, /The existing score was kept and still reflects the previous details/);
  assert.doesNotMatch(overlay, /prior score will be hidden/);
  assert.doesNotMatch(overlay, /The prior score is hidden/);
  assert.doesNotMatch(overlay, /experienceStatus: 'queued'/);
  assert.doesNotMatch(overlay, /reqFitScore: null/);
});

test('reordered Aim and Experience detail sections retain stable React keys', () => {
  assert.match(overlay, /className="scoring-detail-section" key="aimComponents"/);
  assert.equal(
    overlay.match(/className="scoring-detail-section" key="experienceCriteria"/g)?.length,
    2,
  );
  assert.match(
    overlay,
    /primaryScore === 'experience' \? \[experienceCriteriaSection, aimComponentsSection\] : \[aimComponentsSection, experienceCriteriaSection\]/,
  );
});
