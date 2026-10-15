import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { kulaBoardSlugFromUrl, parseKulaRssListing } from '../kulaRssBoard';
import { kulaTestFeed } from './publicAtsFixtures';
import { buildAtsBoardRequest, parseAtsListingPayload, responseMatchesPlatform, isAtsProviderWideError } from '../atsAcquisition';
import { atsListingSourceId } from '../atsPrequeueCompaction';
import { isFirstCollectionPlatform, FIRST_COLLECTION_PLATFORMS } from '../atsFirstCollectionAdmission';
import { atsAuthFailureIsPlatformWide, atsResponseSchemaFailureIsPlatformWide, identifyAts } from '../atsUtils';
import { planAtsRequest } from '../atsRequestConcurrency';
import { atsRequestSpacingMs } from '../atsRequestPacing';
import { PLATFORMS } from '../../scripts/discoverATS';
import { discoveredAtsBoardFromJobUrl } from '../atsBoardDiscovery';
import { enrichAtsListingJob, readAtsJobEnrichmentMarker } from '../atsJobEnrichment';

const item = kulaTestFeed.match(/<item>[\s\S]*<\/item>/)![0];
const feed = (items: string, slug = 'example') => `<rss version="2.0" xmlns:job="https://kula.ai/rss"><channel><title>Example Inc</title><link>https://careers.kula.ai/${slug}</link>${items}</channel></rss>`;
const secondLocation = item.replace('<job:city>Austin</job:city><job:state>TX</job:state><job:country>United States</job:country>', '<job:city>Toronto</job:city><job:state>Ontario</job:state><job:country>Canada</job:country>');
const salary = (currency = 'USD', interval = 'YEARLY', type = 'BASE', minimum = '100000') => `<job:salary><job:currency>${currency}</job:currency><job:minAmount>${minimum}</job:minAmount><job:maxAmount>150000</job:maxAmount><job:interval>${interval}</job:interval><job:type>${type}</job:type></job:salary>`;

test('Kula discovers vendor-owned boards and postings, excluding assets and internal API paths', () => {
  for (const path of ['/example', '/example/feed', '/example/sitemap.xml', '/example/123', '/example/123/apply', '/example/123-channel-manager']) {
    const url = 'https://careers.kula.ai' + path;
    assert.equal(kulaBoardSlugFromUrl(url), 'example');
    assert.equal(identifyAts({ url }), 'Kula');
    assert.equal(PLATFORMS.kula.extract_slug(url), 'example');
    assert.deepEqual(discoveredAtsBoardFromJobUrl(url, 'Kula'), { platform: 'kula', slug: 'example' });
  }
  for (const url of ['https://careers.kula.ai/api/internal/ats_job_posts', 'https://careers.kula.ai/_next/static/a.js',
    'https://careers.kula.ai/robots.txt', 'https://careers.kula.ai/example/portal', 'https://careers.kula.ai/example/123/preview/token',
    'https://careers.kula.ai.evil.example/example/123', 'https://user@careers.kula.ai/example', 'https://careers.kula.ai/example%2Fother']) {
    assert.equal(kulaBoardSlugFromUrl(url), null, url);
  }
});

test('the acquisition lane requests the whole public RSS feed and recognizes its transport', () => {
  const request = buildAtsBoardRequest({ platform: 'kula', slug: 'example' });
  assert.equal(request.url, 'https://careers.kula.ai/example/feed');
  assert.equal(new Headers(request.init.headers).has('Authorization'), false);
  assert.equal(responseMatchesPlatform('kula', 'application/rss+xml; charset=utf-8'), true);
  assert.equal(responseMatchesPlatform('kula', 'text/html'), false);
  assert.throws(() => buildAtsBoardRequest({ platform: 'kula', slug: 'example' }, 1));
});

test('repeated GUIDs across locations produce one posting with every restricted location', () => {
  const parsed = parseAtsListingPayload('kula', {}, feed(item + secondLocation + item), { platform: 'kula', slug: 'example' });
  assert.equal(parsed.total, 1);
  assert.equal(parsed.jobs.length, 1);
  assert.equal(parsed.metadata.kulaFeedEntryCount, 3);
  assert.equal(parsed.jobs[0].id, 'example::123');
  assert.equal(atsListingSourceId('kula', parsed.jobs[0]), 'example::123');
  assert.equal(parsed.jobs[0].url, 'https://careers.kula.ai/example/123');
  assert.deepEqual(parsed.jobs[0].locations, ['Austin, TX, United States (Remote)', 'Toronto, Ontario, Canada (Remote)']);
  assert.equal(parsed.jobs[0].location, 'Austin, TX, United States (Remote); Toronto, Ontario, Canada (Remote)');
  assert.equal(parsed.metadata.listingHasMore, false);
});

test('whole feeds over 99 location entries do not truncate or inflate distinct job capacity', () => {
  const xml = feed(Array.from({ length: 142 }, () => item).join(''));
  const parsed = parseKulaRssListing('example', xml);
  assert.equal(parsed.metadata.kulaFeedEntryCount, 142);
  assert.equal(parsed.total, 1);
  const other = parseKulaRssListing('other', feed(item.replaceAll('/example/', '/other/'), 'other'));
  assert.notEqual(other.jobs[0].id, parsed.jobs[0].id);
});

test('multiple locations inside a single Kula item retain all countries and one posting identity', () => {
  const location = secondLocation.match(/<job:location>[\s\S]*?<\/job:location>/)![0];
  const multi = item.replace('</job:location>', `</job:location>${location}`);
  const parsed = parseKulaRssListing('example', feed(multi + secondLocation));
  assert.equal(parsed.total, 1);
  assert.deepEqual(parsed.jobs[0].locations, ['Austin, TX, United States (Remote)', 'Toronto, Ontario, Canada (Remote)']);
  assert.throws(() => parseKulaRssListing('example', feed(multi.replace('Ontario', 'Ontario</job:state><job:state>Other'))));
  assert.throws(() => parseKulaRssListing('example', feed(multi.replaceAll('<job:remote>true</job:remote>', '<job:remote>maybe</job:remote>'))));
});

test('missing geography retains uncertainty and office names without becoming unrestricted remote', () => {
  const xml = feed(item.replace('<job:city>Austin</job:city><job:state>TX</job:state><job:country>United States</job:country>', '<job:officeName>New Delhi</job:officeName>'));
  assert.equal(parseKulaRssListing('example', xml).jobs[0].location, 'New Delhi (Remote)');
  assert.equal(parseKulaRssListing('example', xml.replace('<job:officeName>New Delhi</job:officeName>', '')).jobs[0].location, 'Unknown Location (Remote)');
  const absent = feed(item.replace(/<job:location>[\s\S]*?<\/job:location>/, ''));
  assert.equal(parseKulaRssListing('example', absent).jobs[0].location, 'Unknown Location');
  assert.equal(parseKulaRssListing('example', absent.replace('</item>', '<job:workplace>REMOTE</job:workplace></item>')).jobs[0].location, 'Unknown Location (Remote)');
});

test('conflicting location entries, incomplete fields and unsafe links fail the board instead of importing partial data', () => {
  for (const xml of [feed(item + secondLocation.replace('Channel Manager', 'Another Role')),
    feed(item + secondLocation.replace('Full description', 'Different description')),
    feed(item.replaceAll('/example/123/', '/other/123/')),
    feed(item.replaceAll('https://careers.kula.ai/example/123/', 'https://evil.example/example/123/')),
    feed(item.replace('<p>Full description</p>', '')),
    feed(item.replace('<job:remote>true</job:remote>', '<job:remote>maybe</job:remote>')),
    feed(item.replace('</item>', '<pubDate>not a date</pubDate></item>')),
    feed(item.replace('<guid>https://careers.kula.ai/example/123/apply</guid>', '<guid>https://careers.kula.ai/example/456/apply</guid>'))]) {
    assert.throws(() => parseKulaRssListing('example', xml));
  }
});

test('only an authoritative complete Kula RSS envelope can report an empty board', () => {
  assert.equal(parseKulaRssListing('example', feed('')).total, 0);
  for (const xml of ['<html>Not found</html>', '{"errors":["err_account_not_found"]}', feed('').slice(0, -6),
    feed(item).replace('</item>', ''), feed(item).replace('<title>Channel Manager</title>', '<title>Channel Manager</wrong>'),
    feed(item).replace('Channel Manager', 'Channel & Manager'),
    feed('').replace('https://careers.kula.ai/example', 'https://careers.kula.ai/other'),
    feed('').replace('Example Inc', 'Unknown Company'), feed('').replace('https://kula.ai/rss', 'https://evil.example/rss'),
    '<!DOCTYPE rss [<!ENTITY custom SYSTEM "file:///etc/passwd">]>' + feed('')]) {
    assert.throws(() => parseKulaRssListing('example', xml));
  }
});

test('compensation retains currency, period and location and never turns bonus or conflicting bands into base pay', () => {
  const withSalary = (s: string) => item.replace('</item>', s + '</item>');
  const valid = parseKulaRssListing('example', feed(withSalary(salary()) + secondLocation.replace('</item>', salary() + '</item>'))).jobs[0];
  assert.equal(valid.postedCompensation, '$100,000–$150,000 base');
  assert.equal(valid.kulaSalaryRanges.length, 2);
  for (const value of [salary('CAD'), salary('USD', 'HOURLY'), salary('USD', 'YEARLY', 'BONUS')]) {
    const job = parseKulaRssListing('example', feed(withSalary(value))).jobs[0];
    assert.equal(job.postedCompensation, null);
    assert.ok(job.salary);
  }
  assert.equal(parseKulaRssListing('example', feed(withSalary(salary()) + secondLocation.replace('</item>', salary('USD', 'YEARLY', 'BASE', '120000') + '</item>'))).jobs[0].postedCompensation, null);
});

test('RSS descriptions and compensation survive durable enrichment without a detail request', async () => {
  const job = parseKulaRssListing('example', feed(item.replace('</item>', salary() + '</item>'))).jobs[0];
  const enriched = await enrichAtsListingJob({ platform: 'kula', slug: 'example', job, requestTimeoutMs: 1000 }, {
    fetch: async () => { throw new Error('Kula must not need a detail fetch'); },
    reserveProviderBudgetForSource: async () => { throw new Error('Kula must not need a detail budget'); },
  });
  const marker = readAtsJobEnrichmentMarker(enriched);
  assert.equal(marker?.attempted, false);
  assert.equal(marker?.description, '<p>Full description</p>');
  assert.equal(marker?.company, 'Example Inc');
  assert.equal(marker?.compensation, '$100,000–$150,000 base');
});

test('Kula uses existing first-collection capacity, board failure isolation and shared provider pacing', () => {
  assert.equal(isFirstCollectionPlatform('kula'), true);
  assert.equal(atsAuthFailureIsPlatformWide('kula'), false);
  assert.equal(atsResponseSchemaFailureIsPlatformWide('kula'), false);
  assert.equal(isAtsProviderWideError(new Error('Kula listing schema is invalid'), 'kula'), false);
  assert.equal(atsRequestSpacingMs('kula'), 1000);
  const first = planAtsRequest('kula', 'https://careers.kula.ai/example/feed');
  const other = planAtsRequest('kula', 'https://careers.kula.ai/other/feed');
  assert.equal(first.units, 1);
  assert.equal(first.providerKey, other.providerKey);
  assert.notEqual(first.boardLeaseKey, other.boardLeaseKey);
});

test('the database migration protects Kula admissions and catalogues only the two verified employers', () => {
  const sql = readFileSync('prisma/migrations/20261012230000_kula_rss_acquisition/migration.sql', 'utf8');
  for (const platforms of sql.matchAll(/NEW\.platform (?:NOT )?IN \(([^)]+)\)/g)) {
    assert.deepEqual([...platforms[1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort(), [...FIRST_COLLECTION_PLATFORMS].sort());
  }
  assert.match(sql, /reserved_batch = NEW.id/);
  assert.match(sql, /FOR SHARE/);
  assert.match(sql, /ON CONFLICT \(slug, platform\) DO NOTHING/);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|TRUNCATE|ALTER)\b/i);
  assert.match(sql, /'10xgenomics', 'kula'/);
  assert.match(sql, /'invoca', 'kula'/);
});
