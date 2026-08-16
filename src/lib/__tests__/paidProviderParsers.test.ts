import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  buildGlassdoorDetailsUrl,
  extractGlassdoorDetailDescription,
  glassdoorQueryString,
  isLegacyHiddenGlassdoorJdFailure,
  ingestionSourceRunStatus,
  parseGlassdoorListing,
  parseJSearchJob,
  zeroYieldRunError,
} from '../jobIngestion';

// Shapes captured from the live providers on 2026-08-15. Both sources ingested
// zero rows for weeks because the code read the wrapper object instead of the
// nested array, so these fixtures are the regression boundary.

const jsearchItem = {
  job_id: 'TU1SQkRfOURuWDhXVmFFRUZCUVVGQlFUMDlPa1Zk'.repeat(8),
  job_uid: 'i77D0ZjODvWxSMHWAAAAAA==',
  job_title: 'Channel Sales Manager',
  employer_name: 'Acme Networks',
  job_description: 'Own the two-tier distribution motion.',
  job_city: 'Minneapolis',
  job_state: 'Minnesota',
  job_apply_link: 'https://acme.example/apply/123',
  job_google_link: 'https://google.example/jobs/123',
  job_posted_at_datetime_utc: '2026-08-14T12:00:00.000Z',
};

const glassdoorListing = {
  jobview: {
    header: {
      adOrderId: 1136043,
      ageInDays: 3,
      employer: { id: 687537, name: 'Alkami Technology Inc.' },
      employerNameFromSearch: 'Alkami',
      jobViewUrl: '/partner/jobListing.htm?pos=101&ao=1136043',
      locationName: 'Remote',
      normalizedJobTitle: 'director channel sales manager',
    },
    job: {
      jobTitleText: 'Director, Channel Sales',
      listingId: 1010178531867,
      queryString: 'pos=101&ao=1136043&jobListingId=1010178531867',
    },
  },
};

test('parseJSearchJob prefers the stable job_uid over the per-search job_id', () => {
  const parsed = parseJSearchJob(jsearchItem);
  assert.ok(parsed);
  // Dedupe is keyed on (source, sourceId); job_id changes every Search call, so
  // using it would re-ingest every posting on every run.
  assert.equal(parsed.sourceId, 'i77D0ZjODvWxSMHWAAAAAA==');
  assert.notEqual(parsed.sourceId, jsearchItem.job_id);
  assert.equal(parsed.title, 'Channel Sales Manager');
  assert.equal(parsed.company, 'Acme Networks');
  assert.equal(parsed.location, 'Minneapolis, Minnesota');
  assert.equal(parsed.url, 'https://acme.example/apply/123');
  assert.equal((parsed.postedAt as Date).toISOString(), '2026-08-14T12:00:00.000Z');
});

test('parseJSearchJob fails closed when the stable job_uid is absent', () => {
  const withoutUid: Record<string, unknown> = { ...jsearchItem };
  delete withoutUid.job_uid;
  assert.equal(parseJSearchJob(withoutUid), null);
});

test('parseJSearchJob rejects items without a title or any identifier', () => {
  assert.equal(parseJSearchJob({ ...jsearchItem, job_title: '   ' }), null);
  assert.equal(parseJSearchJob({ job_title: 'Channel Sales Manager' }), null);
});

test('parseGlassdoorListing reads the nested jobview and absolutises the URL', () => {
  const now = new Date('2026-08-15T00:00:00.000Z');
  const parsed = parseGlassdoorListing(glassdoorListing, now);
  assert.ok(parsed);
  assert.equal(parsed.title, 'Director, Channel Sales');
  assert.equal(parsed.company, 'Alkami Technology Inc.');
  assert.equal(parsed.location, 'Remote');
  assert.equal(parsed.sourceId, '1010178531867');
  assert.equal(parsed.glassdoorQueryString, 'pos=101&ao=1136043&jobListingId=1010178531867');
  // jobViewUrl is site-relative and unusable as stored.
  assert.equal(parsed.url, 'https://www.glassdoor.com/partner/jobListing.htm?pos=101&ao=1136043');
  // Search carries no description; the JD queue recovers it from the URL.
  assert.equal(parsed.description, '');
  assert.equal((parsed.postedAt as Date).toISOString(), '2026-08-12T00:00:00.000Z');
});

test('Glassdoor details bind the listing ID and exact search query string', () => {
  const queryString = 'pos=101&ao=1136043&jobListingId=1010178531867';
  const detailsUrl = new URL(buildGlassdoorDetailsUrl('1010178531867', queryString));

  assert.equal(detailsUrl.pathname, '/jobs/details');
  assert.equal(detailsUrl.searchParams.get('listingId'), '1010178531867');
  assert.equal(detailsUrl.searchParams.get('queryString'), queryString);
  assert.equal(
    glassdoorQueryString(null, `https://www.glassdoor.com/partner/jobListing.htm?${queryString}`),
    queryString,
  );
});

test('Glassdoor details extract the full provider JD and fail closed on missing content', () => {
  const description = '<div><h2>Responsibilities</h2><p>Manage channel partners.</p></div>';
  assert.equal(extractGlassdoorDetailDescription({ data: { job: { description } } }), description);
  assert.equal(extractGlassdoorDetailDescription({ data: { job: {} } }), null);
  assert.equal(extractGlassdoorDetailDescription({ data: null }), null);
});

test('only legacy Glassdoor rows hidden by JD failure qualify for bounded rediscovery recovery', () => {
  const legacyFailure = {
    source: 'Glassdoor (RapidAPI)',
    status: 'dismissed',
    scoringStatus: 'failed',
    passReason: 'JD recovery failed after 3 attempts. Manual review required.',
    scoreError: 'No text to extract',
  };
  assert.equal(isLegacyHiddenGlassdoorJdFailure(legacyFailure), true);
  assert.equal(isLegacyHiddenGlassdoorJdFailure({
    ...legacyFailure,
    scoringStatus: 'skipped',
    passReason: 'Software Engineering role rejected',
  }), false);
  assert.equal(isLegacyHiddenGlassdoorJdFailure({
    ...legacyFailure,
    source: 'LinkedIn',
  }), false);
  assert.equal(isLegacyHiddenGlassdoorJdFailure({
    ...legacyFailure,
    status: 'pending_af',
  }), false);
});

test('parseGlassdoorListing falls back to adOrderId when listingId is missing', () => {
  const listing = structuredClone(glassdoorListing) as typeof glassdoorListing;
  delete (listing.jobview.job as Record<string, unknown>).listingId;
  assert.equal(parseGlassdoorListing(listing)?.sourceId, '1136043');
});

test('parseGlassdoorListing rejects a bare wrapper, which is what the old reader saw', () => {
  assert.equal(parseGlassdoorListing({}), null);
  assert.equal(parseGlassdoorListing({ jobview: { header: {}, job: {} } }), null);
});

test('zeroYieldRunError names a clean run that returned nothing', () => {
  assert.match(
    zeroYieldRunError({ seen: 0, requests: 12, processingErrors: 0, requestErrors: 0 }) || '',
    /Zero yield: 12 provider request/,
  );
});

test('zeroYieldRunError stays silent when there is nothing suspicious', () => {
  // No request was ever issued: genuinely idle, not broken.
  assert.equal(zeroYieldRunError({ seen: 0, requests: 0 }), null);
  // Rows came back.
  assert.equal(zeroYieldRunError({ seen: 30, requests: 1 }), null);
  // An error already explains the emptiness.
  assert.equal(zeroYieldRunError({ seen: 0, requests: 3, requestErrors: 3 }), null);
  assert.equal(zeroYieldRunError({ seen: 0, requests: 3, processingErrors: 1 }), null);
});

test('a clean empty run still reports idle rather than success', () => {
  assert.equal(ingestionSourceRunStatus({ seen: 0, inserted: 0, duplicates: 0, filtered: 0 }), 'idle');
});

test('zero yield is diagnostic, not a provider fault', async () => {
  // Adzuna answers HTTP 200 with zero results for the us_remote and
  // upper_midwest lanes, which it does not recognise as places. Treating that
  // as a failure would open the circuit and park the two lanes that work.
  const source = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  const sweep = source.slice(
    source.indexOf('const zeroYieldErrors = new Map'),
    source.indexOf('await settleProviderState(pendingProviderState);'),
  );
  assert.ok(sweep.length > 0, 'zero-yield sweep should be locatable');
  assert.doesNotMatch(sweep, /recordProviderFailure/);
  // It must still be withheld from the success sweep, or a drifted parser keeps
  // resetting the failure counter that would otherwise reveal it.
  assert.match(sweep, /providerFailures\.has\(source\) \|\| zeroYieldErrors\.has\(source\)/);
});
