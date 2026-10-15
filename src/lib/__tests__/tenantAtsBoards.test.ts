import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { tenantAtsBoardUrl, tenantAtsBoardSlugFromUrl, tenantAtsRequest, tenantAtsConfig,
  parseTenantAtsListing, readBoundedAtsBody, AtsFirstCollectionSizeError, TENANT_ATS_PLATFORMS } from '../tenantAtsBoards';
import { parseAtsListingPayload, isAtsBoardLevelFailure, isAtsProviderWideError } from '../atsAcquisition';
import { firstCollectionAllowance } from '../atsFirstCollectionAdmission';
import { nextFirstCollectionHealthySince } from '../atsFirstCollectionController';
import { fetchAtsPlatformResponse } from '../jobIngestion';
import { atsAuthFailureIsPlatformWide, atsResponseSchemaFailureIsPlatformWide, identifyAts } from '../atsUtils';
import { PLATFORMS } from '../../scripts/discoverATS';
import { discoveredAtsBoardFromJobUrl } from '../atsBoardDiscovery';
import { kulaTestFeed } from './publicAtsFixtures';
import { buildPublicAtsBoardRequest, parsePublicAtsListing, publicAtsNeedsConfig } from '../publicAtsBoards';

const site = 'adc5441f-f521-a46d-ad4d-ad46a1954fcc';
const description = '<p>Lead partner enablement and customer adoption.</p>';
const samples = {
  kula: {},
  gem: [{ id: 123, title: 'Channel Manager', content: description, absolute_url: 'https://jobs.gem.com/example/123', location: { name: 'Austin, TX' } }],
  jobscore: { company_name: 'Example Inc', jobs: [{ id: 'abc_DEF', title: 'Channel Manager', description,
    detail_url: 'https://careers.jobscore.com/careers/example/jobs/channel-manager-abc_DEF', location: 'Austin, TX' }] },
  manatal: { count: 1, next: null, previous: null, results: [{ hash: 'ABC123', position_name: 'Channel Manager', description, location_display: 'Austin, TX', organization_name: 'Department, not employer' }] },
  clearcompany: { totalCount: 1, currentPageIndex: 0, currentPageCount: 1, results: [{ id: 'posting123', positionTitle: 'Channel Manager', brandName: 'Example Inc', description,
    applyLink: 'https://jobs.clearcompany.com/careers/jobs/posting123/apply', location: 'Austin, TX' }] },
  hirehive: { meta: { page_size: 20, page: 1, total_items: 1, has_next_page: false }, items: [{ id: 'job_Ab123', title: 'Channel Manager', description: { html: description },
    hosted_url: 'https://example.hirehive.com/channel-manager-austin-Ab123', location: 'Austin', state_code: 'TX', country: 'US' }] },
};
const jazz = `<jobs><publisher>JazzHR</publisher><company>Example Inc</company><job><id>urn:job:abc</id><title>Channel Manager</title><description><![CDATA[${description}]]></description><url>https://jobs.example.org/apply/abc/channel-manager</url><city>Austin</city><state>TX</state><country>US</country></job></jobs>`;

test('Gem recognizes observed employer branding and keeps summary-only jobs for detail enrichment', () => {
  for (const suffix of ['Careers', 'Open Roles', 'Opportunities']) {
    const config = tenantAtsConfig('gem', 'example', `<meta property="og:url" content="https://jobs.gem.com/example"><title>Example Inc ${suffix}</title>`);
    assert.equal(config.company, 'Example Inc');
    const job = parseTenantAtsListing('gem', 'example', [{ ...samples.gem[0], content: '', content_plain: '' }], null, config).jobs[0];
    assert.equal(job.description, '');
    assert.equal(job.url, 'https://jobs.gem.com/example/123');
  }
  assert.equal(tenantAtsConfig('gem', 'example', '<title>Unrecognized marketing phrase</title>').company, '');
});

test('JazzHR upgrades legacy HTTP links only on the exact vendor tenant', () => {
  const xml = jazz.replace('https://jobs.example.org/apply/abc/channel-manager', 'http://example.applytojob.com/apply/abc/channel-manager');
  assert.equal(parseTenantAtsListing('jazzhr', 'example', {}, xml).jobs[0].url,
    'https://example.applytojob.com/apply/abc/channel-manager');
  for (const url of ['http://other.applytojob.com/apply/abc', 'http://example.applytojob.com.evil.test/apply/abc',
    'http://user@example.applytojob.com/apply/abc', 'http://example.applytojob.com:8080/apply/abc', 'http://custom.example/apply/abc']) {
    assert.throws(() => parseTenantAtsListing('jazzhr', 'example', {}, xml.replace('http://example.applytojob.com/apply/abc/channel-manager', url)));
  }
});

test('JobScore and HireHive renames require a canonical vendor link and preserve the registered identity', () => {
  assert.equal(publicAtsNeedsConfig('jobscore'), true);
  const configs = {
    jobscore: tenantAtsConfig('jobscore', 'old', '<link rel="canonical" href="https://careers.jobscore.com/careers/example"><title>Example Inc Jobs &amp; Careers | Open Positions</title>'),
    hirehive: tenantAtsConfig('hirehive', 'old', '<meta property="og:url" content="https://example.hirehive.com/"><meta property="og:title" content="Jobs at Example Inc | HireHive.com">'),
  };
  for (const platform of ['jobscore', 'hirehive'] as const) {
    const config = configs[platform];
    assert.equal(config.canonicalSlug, 'example');
    assert.equal(config.company, 'Example Inc');
    assert.equal(buildPublicAtsBoardRequest(platform, 'old', 0, config).url, tenantAtsRequest(platform, 'example').url);
    const job = parsePublicAtsListing(platform, 'old', samples[platform], null, config).jobs[0];
    assert.match(String(job.id), /^old::/);
    assert.equal(job.company, 'Example Inc');
    assert.throws(() => parsePublicAtsListing(platform, 'old', samples[platform]));
    assert.throws(() => tenantAtsConfig(platform, 'old', '<meta property="og:url" content="https://evil.example/jobs/example">'));
    const html = platform === 'jobscore'
      ? '<link rel="canonical" href="https://careers.jobscore.com/careers/example"><title>Example Inc Jobs &amp; Careers | Open Positions</title>'
      : '<meta property="og:url" content="https://example.hirehive.com/"><meta property="og:title" content="Jobs at Example Inc | HireHive.com">';
    assert.throws(() => tenantAtsConfig(platform, 'old', html, 'https://evil.example/'));
    assert.equal(tenantAtsConfig(platform, 'old', html, tenantAtsBoardUrl(platform, 'example')).canonicalSlug, 'example');
    const canonicalUrl = tenantAtsBoardUrl(platform, 'example');
    const conflicting = tenantAtsBoardUrl(platform, 'different');
    assert.throws(() => tenantAtsConfig(platform, 'old', `<link rel="canonical" href="${canonicalUrl}"><meta property="og:url" content="${conflicting}">`));
  }
  assert.throws(() => tenantAtsConfig('gem', 'old', '<meta property="og:url" content="https://jobs.gem.com/example"><title>Example Inc Careers</title>'));
});

for (const platform of TENANT_ATS_PLATFORMS) test(`${platform} reaches discovery, acquisition and source labelling with exact tenant identity`, () => {
  const slug = platform === 'clearcompany' ? site : 'example';
  const url = tenantAtsBoardUrl(platform, slug);
  assert.equal(tenantAtsBoardSlugFromUrl(url, platform), slug);
  assert.equal(PLATFORMS[platform].extract_slug(url), slug);
  const label = identifyAts({ url });
  assert.deepEqual(discoveredAtsBoardFromJobUrl(url, label), { platform, slug });
  assert.equal(tenantAtsBoardSlugFromUrl(url.replace(new URL(url).hostname, 'evil.example'), platform), null);
  assert.throws(() => tenantAtsRequest(platform, '../arbitrary'));
  const feed = parseAtsListingPayload(platform, platform === 'jazzhr' ? {} : samples[platform], platform === 'kula' ? kulaTestFeed.replace('<p>Full description</p>', description) : platform === 'jazzhr' ? jazz : null,
    { platform, slug }, { company: 'Example Inc' });
  assert.equal(feed.jobs.length, 1);
  assert.equal(feed.jobs[0].company, 'Example Inc');
  assert.ok(String(feed.jobs[0].id).startsWith(`${slug}::`));
  assert.equal(feed.jobs[0].description, description);
  assert.equal(feed.metadata.listingHasMore, false);
  assert.equal(atsAuthFailureIsPlatformWide(platform), false);
  assert.equal(atsResponseSchemaFailureIsPlatformWide(platform), false);
});

test('public branding needs a known page shape and the exact tenant', () => {
  assert.deepEqual(tenantAtsConfig('gem', 'example', '<meta property="og:title" content="Example Inc Careers"><meta property="og:url" content="https://jobs.gem.com/example">'), { company: 'Example Inc' });
  assert.throws(() => tenantAtsConfig('gem', 'example', '<meta property="og:url" content="https://jobs.gem.com/other">'));
  assert.equal(tenantAtsConfig('hirehive', 'example', '<title>HTTP error</title>').company, '');
  assert.equal(tenantAtsConfig('manatal', 'example', '<meta property="og:title" content="Example Inc | Career Page">').company, 'Example Inc');
});

test('one incomplete Manatal posting retains its identity and cannot block the page or continuation', () => {
  const results = Array.from({ length: 20 }, (_, index) => ({
    ...samples.manatal.results[0], hash: 'job' + index, description: index === 7 ? '' : description,
  }));
  const payload = { count: 21, results, next: tenantAtsRequest('manatal', 'example', 20).url };
  const page = parseTenantAtsListing('manatal', 'example', payload, null, { company: 'Example Inc' });
  assert.equal(page.jobs.length, 20);
  assert.equal(page.jobs[7].description, '');
  assert.equal(page.jobs[7].id, 'example::job7');
  assert.equal(page.metadata.listingHasMore, true);
  assert.throws(() => parseTenantAtsListing('manatal', 'example', { ...payload,
    results: results.map((row, i) => i === 7 ? { ...row, hash: '' } : row),
  }, null, { company: 'Example Inc' }));
});

test('JazzHR uses XML export employer authority, never its vendor publisher or a status-200 HTML error', () => {
  assert.equal(parseTenantAtsListing('jazzhr', 'example', {}, jazz).jobs[0].company, 'Example Inc');
  assert.throws(() => parseTenantAtsListing('jazzhr', 'example', {}, '<html><body>Not found</body></html>'));
  assert.throws(() => parseTenantAtsListing('jazzhr', 'example', {}, jazz.replace('<company>Example Inc</company>', '')));
});

test('paged adapters reconstruct the next page and reject repetitions or contradictory totals', () => {
  assert.match(tenantAtsRequest('manatal', 'example', 20).url, /page=2/);
  assert.match(tenantAtsRequest('clearcompany', site, 20).url, /pageIndex=1/);
  assert.match(tenantAtsRequest('hirehive', 'example', 20).url, /page=2/);
  assert.throws(() => tenantAtsRequest('manatal', 'example', 1));
  assert.throws(() => parseTenantAtsListing('hirehive', 'example', samples.hirehive, null, { company: 'Example Inc' }, 20));
  assert.throws(() => parseTenantAtsListing('manatal', 'example', { ...samples.manatal, count: 40 }, null, { company: 'Example Inc' }));
  assert.throws(() => parseTenantAtsListing('clearcompany', site, { ...samples.clearcompany, results: [samples.clearcompany.results[0], samples.clearcompany.results[0]], totalCount: 2 }, null));
  assert.throws(() => parseTenantAtsListing('manatal', 'example', { ...samples.manatal, next: 'https://evil.example/jobs?page=2&page_size=20' }, null, { company: 'Example Inc' }));
});

test('bounded bodies cap decoded streams and gzip expansion, with a distinct size-review error', async () => {
  assert.equal(await readBoundedAtsBody(new Response('12345'), 5), '12345');
  await assert.rejects(readBoundedAtsBody(new Response('123456'), 5), AtsFirstCollectionSizeError);
  const zipped = gzipSync('x'.repeat(10_000));
  await assert.rejects(readBoundedAtsBody(new Response(zipped), 1000), AtsFirstCollectionSizeError);
  assert.equal(await readBoundedAtsBody(new Response(gzipSync('hello')), 100), 'hello');
  const error = new AtsFirstCollectionSizeError('bounded response allowance');
  assert.equal(isAtsBoardLevelFailure(error), false);
  assert.equal(isAtsProviderWideError(error, 'gem'), false);
});

test('malformed tenant responses cannot open a provider circuit; genuine 429 still does', async () => {
  for (const platform of [...TENANT_ATS_PLATFORMS, 'zohorecruit']) {
    let failures = 0;
    await assert.rejects(fetchAtsPlatformResponse(platform, undefined, async () => new Response('{}'), {
      waitForSlot: async () => {}, onResponse: async () => { throw new Error('listing schema missing title'); },
      recordFailure: async () => { failures++; return null; },
    }));
    assert.equal(failures, 0);
    await fetchAtsPlatformResponse(platform, undefined, async () => new Response('', { status: 429 }), {
      waitForSlot: async () => {}, recordThrottle: async () => { failures++; },
    });
    assert.equal(failures, 1);
  }
});

test('first admissions require a fresh stable health window, an open mode, daily allowance and downstream completion', () => {
  const now = new Date('2026-10-09T01:00:00Z');
  const input = { mode: 'pilot', dailyBoardLimit: 5, maxUnfinished: 1, startedInWindow: 0, unfinished: 0,
    healthySince: new Date(now.getTime() - 15 * 60_000), healthObservedAt: now, now };
  assert.equal(firstCollectionAllowance(input), true);
  for (const change of [{ mode: 'held' }, { unfinished: 1 }, { startedInWindow: 5 }, { healthySince: now },
    { healthObservedAt: new Date(now.getTime() - 11 * 60_000) }, { healthySince: null }]) assert.equal(firstCollectionAllowance({ ...input, ...change }), false);
  const health = { healthy: true, items: 100, persistence: 50, previousItems: 100, previousPersistence: 50,
    previousObservedAt: now, previousHealthySince: input.healthySince, now };
  assert.equal(nextFirstCollectionHealthySince(health), input.healthySince);
  assert.equal(nextFirstCollectionHealthySince({ ...health, items: 101 }), now);
  assert.equal(nextFirstCollectionHealthySince({ ...health, healthy: false }), null);
  assert.equal(nextFirstCollectionHealthySince({ ...health, previousObservedAt: new Date(now.getTime() - 11 * 60_000) }), now);
});
