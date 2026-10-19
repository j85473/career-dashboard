import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { symphonyBoardSlugFromUrl, symphonyBoardRequest, parseSymphonyConfig, parseSymphonyListing } from '../symphonyAtsBoard';
import { buildAtsBoardRequest, parseAtsListingPayload } from '../atsAcquisition';
import { identifyAts } from '../atsUtils';
import { discoveredAtsBoardFromJobUrl } from '../atsBoardDiscovery';
import { isFirstCollectionPlatform, FIRST_COLLECTION_PLATFORMS } from '../atsFirstCollectionAdmission';
import { planAtsV2PageCompletion } from '../atsAcquisitionDispatcherV2';
import { publicAtsTestFixtures } from './publicAtsFixtures';

const fixture = () => structuredClone(publicAtsTestFixtures.symphony) as { totalHits: number; nextPageToken: string | null; searchResults: { job: Record<string, unknown> }[] };

test('Deltek reaches discovery and API acquisition with its verified public organization', () => {
  const url = 'https://careers.deltek.com/job/23859428/partner-enablement-specialist-remote/';
  assert.equal(identifyAts({ url }), 'Symphony Talent');
  assert.deepEqual(discoveredAtsBoardFromJobUrl(url, 'Symphony Talent'), { slug: 'deltek', platform: 'symphony' });
  assert.equal(identifyAts({ source: 'ATS-symphony' }), 'Symphony Talent');
  assert.equal(isFirstCollectionPlatform('symphony'), true);
  const request = buildAtsBoardRequest({ platform: 'symphony', slug: 'deltek' }, 20);
  const api = new URL(request.url);
  assert.equal(api.origin + api.pathname, 'https://jobsapi-google.m-cloud.io/api/job/search');
  assert.equal(api.searchParams.get('companyName'), 'companies/d78c5717-c840-461e-8f42-7e005f1a8068');
  assert.equal(api.searchParams.get('offset'), '20');
  assert.equal(api.searchParams.get('pageSize'), '20');
  assert.equal(api.searchParams.get('customAttributeFilter'), 'ats_portalid="Kenexa"');
});

test('vanity domains, unsafe schemes and arbitrary organizations never identify a board', () => {
  for (const url of ['javascript://careers.deltek.com/', 'data:text/html,careers.deltek.com', 'https://careers.deltek.com.evil.test/', 'https://user:pass@careers.deltek.com/', 'https://careers.deltek.com:444/', 'https://careers.deltek.com/wp-admin/', 'https://careers.stranger.com/']) assert.equal(symphonyBoardSlugFromUrl(url), null);
  assert.throws(() => symphonyBoardRequest('constructor'));
  for (const offset of [-1, 1, NaN, Infinity]) assert.throws(() => symphonyBoardRequest('deltek', offset));
});

test('public configuration must confirm the exact API organization and career site', () => {
  const html = '<title>Deltek</title>companies/d78c5717-c840-461e-8f42-7e005f1a8068 https://jobsapi-google.m-cloud.io/api/';
  assert.deepEqual(parseSymphonyConfig('deltek', html, 'https://careers.deltek.com/'), { company: 'Deltek' });
  assert.throws(() => parseSymphonyConfig('deltek', html.replace('d78c5717', '00000000')));
  assert.throws(() => parseSymphonyConfig('deltek', html, 'https://example.com/'));
});

test('listing preserves the public posting, full description and remote display location', () => {
  const result = parseAtsListingPayload('symphony', fixture(), null, { slug: 'deltek', platform: 'symphony' });
  const job = result.jobs[0];
  assert.equal(job.id, 'deltek::23859428');
  assert.equal(job.publicAtsPostingId, '23859428');
  assert.equal(job.symphonyRequisition, '11196BR');
  assert.equal(job.location, 'US (Remote)');
  assert.equal(job.company, 'Deltek');
  assert.equal(job.description, '<p>Full description</p>');
  assert.equal(result.metadata.listingHasMore, false);
});

test('malformed, cross-company, mismatched and repeated postings fail closed', () => {
  for (const change of [ { scout_orgid: 1 }, { company_name: 'Other Company' }, { ats_portalid: 'Other' }, { id: 1 },
    { url: 'https://evil.test/job/23859428/' }, { url: 'http://careers.deltek.com/job/23859428/' }, { title: '' }, { description: '' } ]) {
    const data = fixture(); Object.assign(data.searchResults[0].job, change);
    assert.throws(() => parseSymphonyListing('deltek', data));
  }
  const repeated = fixture(); repeated.totalHits = 2; repeated.searchResults.push(repeated.searchResults[0]);
  assert.throws(() => parseSymphonyListing('deltek', repeated));
  for (const invalid of [{}, { totalHits: 1, searchResults: [] }, { totalHits: -1, searchResults: [] }, { ...fixture(), nextPageToken: 'unexpected' }]) assert.throws(() => parseSymphonyListing('deltek', invalid));
});

test('only complete pages continue and final pages reconcile against the total', () => {
  const data = fixture();
  data.totalHits = 21;
  data.searchResults = Array.from({ length: 20 }, (_, i) => ({ job: { ...data.searchResults[0].job, id: 100 + i, url: `https://careers.deltek.com/job/${100 + i}/role/` } }));
  assert.equal(parseSymphonyListing('deltek', data).metadata.listingHasMore, true);
  assert.deepEqual(planAtsV2PageCompletion({ platform: 'symphony', requestedOffset: 0, responseCount: 20, providerTotal: 21, listingHasMore: true }), { listingComplete: false, anomaly: null });
  const last = fixture(); last.totalHits = 21;
  assert.equal(parseSymphonyListing('deltek', last, 20).metadata.listingHasMore, false);
  data.searchResults.pop();
  assert.throws(() => parseSymphonyListing('deltek', data));
  assert.deepEqual(parseSymphonyListing('deltek', { totalHits: 0, nextPageToken: null, searchResults: [] }).jobs, []);
});

test('database admission fences cover Symphony without changing existing data or operator settings', () => {
  const sql = readFileSync('prisma/migrations/20261019170000_symphony_talent_acquisition/migration.sql', 'utf8');
  for (const platforms of sql.matchAll(/NEW\.platform (?:NOT )?IN \(([^)]+)\)/g)) {
    assert.deepEqual([...platforms[1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort(), [...FIRST_COLLECTION_PLATFORMS].sort());
  }
  assert.match(sql, /reserved_batch = NEW.id/);
  assert.match(sql, /FOR SHARE/);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|TRUNCATE|ALTER|INSERT)\b/i);
});
