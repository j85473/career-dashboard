import assert from 'node:assert/strict';
import test from 'node:test';
import { publicAtsBoardUrl, publicAtsBoardSlugFromUrl, buildPublicAtsBoardRequest,
  parsePublicAtsConfig, parsePublicAtsListing, teamtailorHasMore, type PublicAtsPlatform } from '../publicAtsBoards';
import { buildAtsBoardRequest, parseAtsListingPayload } from '../atsAcquisition';
import { planAtsV2PageCompletion } from '../atsAcquisitionDispatcherV2';
import { auditIndexOrder } from '../../../scripts/audit_ats_common_crawl';
import { publicAtsTestFixtures, publicAtsTestSlugs } from './publicAtsFixtures';

test('new public board identities round trip and never accept unrelated hosts', () => {
  for (const [platform, slug] of Object.entries(publicAtsTestSlugs)) {
    const typed = platform as PublicAtsPlatform;
    const url = publicAtsBoardUrl(typed, slug);
    assert.equal(publicAtsBoardSlugFromUrl(url, typed), slug);
    assert.equal(publicAtsBoardSlugFromUrl(url.replace(new URL(url).hostname, 'example.org'), typed), null);
    assert.throws(() => buildPublicAtsBoardRequest(typed, `example.org::${slug}`));
  }
  assert.equal(publicAtsBoardSlugFromUrl('https://career5.successfactors.eu/career?company=ONE&company=TWO', 'successfactors'), null);
  assert.equal(publicAtsBoardSlugFromUrl('https://www.comeet.com.evil.example/jobs/port/59.004', 'comeet'), null);
  assert.equal(publicAtsBoardSlugFromUrl('https://jobs.dayforcehcm.com/api/assets', 'dayforce'), null);
});

test('SuccessFactors regional host, company and locale remain distinct', () => {
  const url = 'https://career5.successfactors.eu/career?company=C0001122692P&rcm_site_locale=en_US';
  const slug = publicAtsBoardSlugFromUrl(url, 'successfactors')!;
  assert.equal(slug, 'career5.successfactors.eu::C0001122692P::en_US');
  const feed = new URL(buildPublicAtsBoardRequest('successfactors', slug).url);
  assert.equal(feed.searchParams.get('rcm_site_locale'), 'en_US');
  assert.equal(feed.searchParams.get('resultType'), 'XML');
  assert.notEqual(slug, publicAtsTestSlugs.successfactors);
});

test('Oracle and UKG reconstruct advancing pages without following provider URLs', () => {
  const oracle = new URL(buildPublicAtsBoardRequest('oracle', publicAtsTestSlugs.oracle, 25).url);
  assert.match(oracle.searchParams.get('finder')!, /siteNumber=CX,limit=25,offset=25/);
  const ukg = buildPublicAtsBoardRequest('ukg', publicAtsTestSlugs.ukg, 20);
  assert.deepEqual(JSON.parse(String(ukg.init.body)).opportunitySearch, { Top: 20, Skip: 20, QueryString: '', Filters: [] });
  assert.equal(ukg.init.method, 'POST');
});

test('new listings scope posting IDs to their board and omit truncated summaries and token-bearing fields', () => {
  for (const platform of ['dayforce', 'oracle', 'ukg', 'comeet'] as const) {
    const feed = parsePublicAtsListing(platform, publicAtsTestSlugs[platform], publicAtsTestFixtures[platform], null, { company: 'Example Inc' });
    const job = feed.jobs[0];
    assert.ok(String(job.id).startsWith(`${publicAtsTestSlugs[platform]}::`));
    assert.equal(publicAtsBoardSlugFromUrl(String(job.url), platform), publicAtsTestSlugs[platform]);
    assert.equal(JSON.stringify(feed).includes('never-persist'), false);
    if (platform === 'oracle' || platform === 'ukg') assert.equal(job.description, '');
    if (platform === 'comeet') assert.equal(job.createdAt, undefined, 'updated date is not a published date');
  }
  const other = parsePublicAtsListing('oracle', 'other.fa.us6.oraclecloud.com::CX', publicAtsTestFixtures.oracle);
  const original = parsePublicAtsListing('oracle', publicAtsTestSlugs.oracle, publicAtsTestFixtures.oracle);
  assert.notEqual(other.jobs[0].id, original.jobs[0].id);
});

test('Comeet takes only public career configuration matching the company UID', () => {
  const html = 'var COMPANY_DATA={"name":"Port","company_uid":"59.004","token":"public-read-token","other_secret":"ignore"};';
  const config = parsePublicAtsConfig('comeet', publicAtsTestSlugs.comeet, html);
  assert.deepEqual(config, { company: 'Port', token: 'public-read-token' });
  assert.throws(() => parsePublicAtsConfig('comeet', 'other::60.005', html));
  assert.equal(new URL(buildPublicAtsBoardRequest('comeet', publicAtsTestSlugs.comeet, 0, config).url).searchParams.get('token'), config.token);
});

test('SuccessFactors retains CDATA descriptions and never guesses a company from an opaque ID', () => {
  const body = '<Job-Listing><Job><ReqId>9660</ReqId><JobTitle>Channel Manager</JobTitle><Job-Description><![CDATA[<p>Full description &amp; benefits</p>]]></Job-Description><Location>Remote US</Location><Posted-Date>09/23/2026</Posted-Date></Job></Job-Listing>';
  const config = parsePublicAtsConfig('successfactors', publicAtsTestSlugs.successfactors, '<style>background-image:url(https://store.delaval.com/globalassets/logo_delaval_ats.png)</style>');
  assert.equal(config.company, 'DeLaval');
  assert.equal(parsePublicAtsConfig('successfactors', 'career5.successfactors.eu::unverified::default', '<title>Career Opportunities</title>').company, '');
  const job = parsePublicAtsListing('successfactors', publicAtsTestSlugs.successfactors, {}, body, config).jobs[0];
  assert.equal(job.company, 'DeLaval');
  assert.equal(job.description, '<p>Full description &amp; benefits</p>');
  assert.equal(new URL(String(job.url)).searchParams.get('career_job_req_id'), '9660');
  assert.throws(() => parsePublicAtsListing('successfactors', publicAtsTestSlugs.successfactors, {}, '<html>Login</html>'));
  assert.throws(() => parsePublicAtsListing('successfactors', publicAtsTestSlugs.successfactors, {}, '<Job-Listing><Job><JobTitle>Missing ID</JobTitle></Job></Job-Listing>'));
});

test('a malformed envelope or cross-board posting cannot masquerade as a successful empty board', () => {
  for (const platform of ['dayforce', 'oracle', 'ukg', 'comeet'] as const) {
    assert.throws(() => parsePublicAtsListing(platform, publicAtsTestSlugs[platform], { error: 'Forbidden' }));
  }
  const bad = structuredClone(publicAtsTestFixtures.comeet) as Array<Record<string, unknown>>;
  bad[0].url_comeet_hosted_page = 'https://www.comeet.com/jobs/other/42.005/x/F3.27B';
  assert.throws(() => parsePublicAtsListing('comeet', publicAtsTestSlugs.comeet, bad));
});

test('Teamtailor follows every full page and honors an explicit final page at a 100-job boundary', () => {
  const next = 'https://morrisgroupsite.teamtailor.com/jobs.json?page=2&per_page=100';
  const firstRequest = buildAtsBoardRequest({ slug: 'morrisgroupsite', platform: 'teamtailor' });
  assert.equal(teamtailorHasMore({ next_url: next }, firstRequest.url), true);
  assert.match(buildAtsBoardRequest({ slug: 'morrisgroupsite', platform: 'teamtailor' }, 100).url, /page=2&per_page=100/);
  const parsed = parseAtsListingPayload('teamtailor', { items: [], next_url: next });
  assert.deepEqual(planAtsV2PageCompletion({ platform: 'teamtailor', requestedOffset: 0, responseCount: 100,
    providerTotal: null, listingHasMore: parsed.metadata.listingHasMore }), { listingComplete: false, anomaly: null });
  assert.deepEqual(planAtsV2PageCompletion({ platform: 'teamtailor', requestedOffset: 100, responseCount: 100,
    providerTotal: null, listingHasMore: false }), { listingComplete: true, anomaly: null });
  assert.ok(planAtsV2PageCompletion({ platform: 'teamtailor', requestedOffset: 0, responseCount: 10,
    providerTotal: null, listingHasMore: true }).anomaly);
  assert.throws(() => teamtailorHasMore({ next_url: next.replace('morrisgroupsite', 'other') }, firstRequest.url));
  assert.throws(() => teamtailorHasMore({ next_url: next.replace('page=2', 'page=1') }, firstRequest.url));
});

test('new provider crawl audits start with recent indexes while retaining all historical work', () => {
  const indices = ['old', 'middle', 'new'];
  for (const platform of Object.keys(publicAtsTestSlugs)) assert.deepEqual(auditIndexOrder(platform, indices), [...indices].reverse());
  assert.deepEqual(auditIndexOrder('workday', indices), indices);
});


test('Dayforce keeps distinct locale and client-site views of one requisition', () => {
  const rows = structuredClone(publicAtsTestFixtures.dayforce) as Array<Record<string, unknown>>;
  rows.push({ ...rows[0], JobDetailsUrl: String(rows[0].JobDetailsUrl).replace('/en-US/', '/hi-IN/') });
  rows.push({ ...rows[0], JobDetailsUrl: String(rows[0].JobDetailsUrl).replace('/ALLJOBS/', '/CAREERS/') });
  const feed = parsePublicAtsListing('dayforce', publicAtsTestSlugs.dayforce, rows);
  assert.equal(new Set(feed.jobs.map(job => job.id)).size, 3);
  assert.equal(new Set(feed.jobs.map(job => job.publicAtsPostingId)).size, 1);
});
