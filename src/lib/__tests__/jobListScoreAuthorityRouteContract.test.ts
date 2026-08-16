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
const schema = readFileSync(
  path.join(process.cwd(), 'prisma', 'schema.prisma'),
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

test('posted base compensation has a dedicated Job field and is displayed after ATS', () => {
  assert.match(schema, /postedCompensation\s+String\?/);
  assert.match(card, /job\.postedCompensation/);
  assert.match(overlay, /job\.postedCompensation/);

  const cardAts = card.indexOf('⚙️ ATS:');
  const cardCompensation = card.indexOf('job.postedCompensation');
  assert.ok(cardAts >= 0 && cardCompensation > cardAts, 'card compensation badge must follow the ATS badge');

  const overlayAts = overlay.lastIndexOf('⚙️ ATS:');
  const overlayCompensation = overlay.indexOf('job.postedCompensation');
  assert.ok(overlayAts >= 0 && overlayCompensation > overlayAts, 'overlay compensation badge must follow the ATS badge');
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

test('edit UX explains that no-queue input changes still hide prior authority', () => {
  assert.match(overlay, /prior score will be hidden because it no longer matches/);
  assert.match(overlay, /updated without queueing\. The prior score is hidden/);
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
