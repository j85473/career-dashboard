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
  assert.match(source, /const scoringInputChanged = titleChanged \|\| companyChanged \|\| locationChanged \|\| descriptionChanged/);
  assert.doesNotMatch(source, /const scoringInputChanged =[^;]*(?:urlChanged|canonicalUrlChanged)/);
});

test('URL-only replacement preserves score authority and bypasses scraping', () => {
  assert.match(scrapeSource, /if \(linkOnly === true\)/);
  assert.match(scrapeSource, /scoreInvalidated: false/);
  assert.match(scrapeSource, /linkOnly: true/);
  assert.doesNotMatch(scrapeSource, /changedFields = \[\s*cleanedUrl !== claimedJob\.url/);
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
  assert.match(scrapeSource, /identityFingerprint: generateV4Fingerprint\(/);
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

test('deferred Workday recovery persists authoritative company and locations and refreshes identity', () => {
  assert.match(batchJdSource, /if \(atsResult\?\.location\) newLocation = atsResult\.location/);
  assert.match(batchJdSource, /if \(atsResult\?\.company\) newCompany = atsResult\.company/);
  assert.match(batchJdSource, /const resolvedLocation = newLocation \|\| job\.location/);
  assert.match(batchJdSource, /const resolvedCompany = newCompany \|\| job\.company/);
  assert.match(batchJdSource, /location: resolvedLocation/);
  assert.match(batchJdSource, /identityFingerprint: generateV4Fingerprint\(resolvedTitle, resolvedCompany, resolvedLocation\)/);
  assert.match(batchJdSource, /\.\.\.resolvedMetadataUpdate/);
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

  const batchFilterIndex = batchJdSource.indexOf('if (hasAuthoritativeMetadata(job.source)) {');
  const batchDetailsIndex = batchJdSource.indexOf('markdown = await fetchGlassdoorJobDescription(job)', batchFilterIndex);
  assert.ok(batchFilterIndex >= 0, 'JD recovery authoritative metadata gate is missing');
  assert.ok(batchDetailsIndex > batchFilterIndex, 'JD recovery must filter Glassdoor metadata before details');

  const scorerFilterIndex = [
    'if (claimedJob.source === GLASSDOOR_SOURCE || isStructuredAtsSource(claimedJob.source))',
    'if (hasAuthoritativeMetadata(claimedJob.source))',
  ]
    .map((gate) => localScoringSource.indexOf(gate))
    .find((index) => index >= 0) ?? -1;
  const scorerResolveIndex = localScoringSource.indexOf('const resolved = await resolveFullDescription(claimedJob)', scorerFilterIndex);
  assert.ok(scorerFilterIndex >= 0, 'Local scorer Glassdoor metadata filter is missing');
  assert.ok(scorerResolveIndex > scorerFilterIndex, 'Local scorer must filter Glassdoor metadata before JD resolution');
});

test('JD recovery dismisses an out-of-scope authoritative posting before spending an ATS or Jina fetch', () => {
  // Regression for the French-Canadian ATS-rippling postings that reached
  // Action Needed: the recovery route only ran this gate for Glassdoor, so a
  // structured ATS source with a disqualifying location paid for a Jina call
  // it could never pass. The gate must now cover every authoritative source,
  // not just Glassdoor, and it must run before any fetch — that "without
  // fetching" property is the point, since the avoided cost is a paid call.
  const gateIndex = batchJdSource.indexOf('if (hasAuthoritativeMetadata(job.source)) {');
  const atsIndex = batchJdSource.indexOf('const atsResult = await scrapeAtsApi(', gateIndex);
  const jinaIndex = batchJdSource.indexOf('const jinaUrl = await buildSafeJinaReaderUrl(', gateIndex);
  const glassdoorFetchIndex = batchJdSource.indexOf('markdown = await fetchGlassdoorJobDescription(job)', gateIndex);

  assert.ok(gateIndex >= 0, 'authoritative metadata gate is missing from JD recovery');
  assert.ok(atsIndex > gateIndex, 'ATS API recovery must follow the authoritative metadata gate');
  assert.ok(jinaIndex > gateIndex, 'Jina recovery must follow the authoritative metadata gate');
  assert.ok(glassdoorFetchIndex > gateIndex, 'Glassdoor details recovery must follow the authoritative metadata gate');

  // The gate is not scoped to Glassdoor: it is keyed off the shared predicate,
  // which extends coverage to every ATS-* source without widening it to
  // aggregators (Adzuna/Himalayas/TheMuse), whose location is still a guess
  // until the description resolves.
  assert.doesNotMatch(batchJdSource, /if \(job\.source === GLASSDOOR_SOURCE\) \{\s*const metadataFilter/);
  assert.match(batchJdSource, /evaluateAuthoritativeMetadata\(\{/);

  // Rejected rows here must be indistinguishable from a lane-one rejection in
  // local scoring, since the reason string is user-visible in the Log tab.
  const dismissalBlock = batchJdSource.slice(gateIndex, atsIndex);
  assert.match(dismissalBlock, /scoringStatus: 'skipped'/);
  assert.match(dismissalBlock, /status: 'dismissed'/);
  assert.match(dismissalBlock, /passReason: metadataVerdict\.reason/);
});

test('JD recovery releases deployment-stranded leases into visible manual review without bypassing the retry cap', () => {
  assert.match(pipelineRunSource, /const staleLeaseCutoff = new Date\(Date\.now\(\) - 5 \* 60 \* 1000\)/);
  assert.match(pipelineRunSource, /scoreAttempts: \{ increment: 1 \}/);
  assert.match(pipelineRunSource, /JD recovery lease expired after an interrupted batch\./);
  assert.match(pipelineRunSource, /buildTerminalJdRecoveryUpdate/);
  assert.doesNotMatch(pipelineRunSource, /status: 'dismissed'/);
  assert.match(localScoringSource, /buildTerminalJdRecoveryUpdate\(reviewReason, reviewReason\)/);
});
