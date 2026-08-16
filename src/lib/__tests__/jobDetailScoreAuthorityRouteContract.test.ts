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
const ingestionSource = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'jobIngestion.ts'),
  'utf8',
);
const pipelineRunSource = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'pipeline', 'run', 'route.ts'),
  'utf8',
);
const dashboardSource = readFileSync(
  path.join(process.cwd(), 'src', 'components', 'Dashboard.tsx'),
  'utf8',
);

test('job detail resolves independent staged events and exposes explicit score authority', () => {
  assert.match(source, /evaluationType: \{ in: \[\.\.\.AUTHORITATIVE_SCORE_EVENT_TYPES\] \}/);
  assert.match(source, /orderBy: \[\{ createdAt: 'desc' \}, \{ id: 'desc' \}\]/);
  assert.match(source, /staleAt: true/);
  assert.match(source, /staleReason: true/);
  assert.match(source, /latestJobScoreEvents\(\[job\.id\]\)/);
  assert.match(source, /projectJobScoreAuthority\(job, latestScores\.get\(job\.id\) \|\| null\)/);
  assert.match(source, /\.\.\.projected/);
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
  assert.match(scrapeSource, /status: 'pending_af'/);
  assert.match(scrapeSource, /eventType: 'user_rescore'/);
  assert.match(source, /eventType: 'user_rescore'/);
  assert.match(scrapeSource, /invalidateActiveJobScores\(\{/);
  assert.match(scrapeSource, /route: 'manual_scrape'/);
  assert.match(scrapeSource, /\}, tx\)/);
});

test('an Inbox rescore removes the stale card as soon as pending_af is returned', () => {
  assert.match(dashboardSource, /const leavesInbox = dataStatus === 'inbox'/);
  assert.match(dashboardSource, /updates\.status !== undefined && updates\.status !== 'inbox'/);
  assert.match(dashboardSource, /prev\.filter\(job => job\.id !== id\)/);
  assert.match(dashboardSource, /setPagination\(previous =>/);
  assert.match(dashboardSource, /jobCacheRef\.current\.clear\(\)/);
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
  assert.match(batchJdSource, /buildClosedPostingUpdate/);
  assert.match(batchJdSource, /buildTerminalJdRecoveryUpdate/);
  assert.match(batchJdSource, /orderBy: \[\{ updatedAt: 'asc' \}, \{ id: 'asc' \}\]/);
  assert.doesNotMatch(batchJdSource, /job\.description\.length >= 400/);
  assert.doesNotMatch(batchJdSource, /isValidMarkdown/);
});

test('JD recovery dismisses affirmative non-English metadata before ATS or Jina requests', () => {
  const languageIndex = batchJdSource.indexOf('const language = assessJobInfoLanguage({');
  const atsIndex = batchJdSource.indexOf('const atsResult = await scrapeAtsApi(', languageIndex);
  const jinaIndex = batchJdSource.indexOf('const jinaUrl = await buildSafeJinaReaderUrl(', languageIndex);

  assert.ok(languageIndex >= 0, 'language gate is missing from JD recovery');
  assert.ok(atsIndex > languageIndex, 'ATS recovery must follow the language gate');
  assert.ok(jinaIndex > languageIndex, 'Jina recovery must follow the language gate');
  assert.match(batchJdSource, /status: 'dismissed'/);
  assert.match(batchJdSource, /passReason: language\.reason/);
});

test('Glassdoor JD recovery uses the provider details endpoint instead of its anti-bot tracking page', () => {
  assert.match(batchJdSource, /job\.source === GLASSDOOR_SOURCE/);
  assert.match(batchJdSource, /fetchGlassdoorJobDescription\(job\)/);
  assert.match(ingestionSource, /if \(job\.source === GLASSDOOR_SOURCE\)/);
  assert.match(ingestionSource, /return fetchGlassdoorJobDescription\(job, providerControl\)/);
  assert.match(localScoringSource, /const glassdoorDescription = await fetchGlassdoorJobDescription\(job\)/);
});

test('Glassdoor runs the local metadata gate before spending a details request', () => {
  const filterIndex = ingestionSource.indexOf('const glassdoorMetadataFilter = source === GLASSDOOR_SOURCE');
  const enrichmentIndex = ingestionSource.indexOf('const scraped = await tryFetchFullDescription({', filterIndex);
  assert.ok(filterIndex >= 0, 'Glassdoor metadata filter is missing');
  assert.ok(enrichmentIndex > filterIndex, 'Glassdoor details enrichment must follow the metadata filter');
  assert.match(ingestionSource, /glassdoorMetadataFilter\?\.passes !== false/);

  const batchFilterIndex = batchJdSource.indexOf('const metadataFilter = passesPreFilter({');
  const batchDetailsIndex = batchJdSource.indexOf('markdown = await fetchGlassdoorJobDescription(job)', batchFilterIndex);
  assert.ok(batchFilterIndex >= 0, 'JD recovery Glassdoor metadata filter is missing');
  assert.ok(batchDetailsIndex > batchFilterIndex, 'JD recovery must filter Glassdoor metadata before details');

  const scorerFilterIndex = localScoringSource.indexOf('if (claimedJob.source === GLASSDOOR_SOURCE)');
  const scorerResolveIndex = localScoringSource.indexOf('const resolved = await resolveFullDescription(claimedJob)', scorerFilterIndex);
  assert.ok(scorerFilterIndex >= 0, 'Local scorer Glassdoor metadata filter is missing');
  assert.ok(scorerResolveIndex > scorerFilterIndex, 'Local scorer must filter Glassdoor metadata before JD resolution');
});

test('JD recovery releases deployment-stranded leases into visible manual review without bypassing the retry cap', () => {
  assert.match(pipelineRunSource, /const staleLeaseCutoff = new Date\(Date\.now\(\) - 5 \* 60 \* 1000\)/);
  assert.match(pipelineRunSource, /scoreAttempts: \{ increment: 1 \}/);
  assert.match(pipelineRunSource, /JD recovery lease expired after an interrupted batch\./);
  assert.match(pipelineRunSource, /buildTerminalJdRecoveryUpdate/);
  assert.doesNotMatch(pipelineRunSource, /status: 'dismissed'/);
  assert.match(localScoringSource, /buildTerminalJdRecoveryUpdate\(reviewReason, reviewReason\)/);
});
