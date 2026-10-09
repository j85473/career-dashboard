import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORMS, patternsFor } from '../../src/scripts/discoverATS';
import { ZOHO_RECRUIT_DOMAINS } from '../../src/lib/zohoRecruitHost';
import { zohoRecruitBoardSlugFromUrl, zohoRecruitBoardUrl, parseZohoRecruitBoardConfig } from '../../src/lib/zohoRecruitBoard';
import { buildPublicAtsBoardRequest, parsePublicAtsListing, publicAtsPageSize } from '../../src/lib/publicAtsBoards';
import { buildAtsBoardRequest, parseAtsListingPayload } from '../../src/lib/atsAcquisition';
import { planAtsV2PageCompletion } from '../../src/lib/atsAcquisitionDispatcherV2';
import { atsAuthFailureIsPlatformWide, atsResponseSchemaFailureIsPlatformWide } from '../../src/lib/atsUtils';
import { boardIdentityFromUrl, resolveDirectAtsPosting, planDirectMatchEnrichment, applyDirectMatchEnrichment } from '../../src/lib/atsDirectMatch';

const slug = 'thinkbridge.zohorecruit.in::Careers';
const boardUrl = 'https://thinkbridge.zohorecruit.in/jobs/Careers';
const postingUrl = `${boardUrl}/40078000018949076`;
const description = '<p><b>Responsibilities</b></p><p>Manage client relationships and lead quarterly business reviews.</p><p><b>Requirements</b></p><p>Five years of customer success experience.</p>';
const row = { id: '40078000018949076', Posting_Title: 'Customer Success Lead', Job_Description: description,
  Publish: true, Remote_Job: 'Yes', City: null, State: null, Country: 'United States', Date_Opened: '2026-09-28',
  $url: 'https://unrelated.example/jobs/another-posting?token=never-persist' };
const listing = (data: unknown[] = [row]) => ({ code: 'success', info: { page_name: 'Careers' }, data });
function configHtml(overrides: Record<string, unknown> = {}, org: Record<string, unknown> = {}) {
  const meta = { list_url: boardUrl, page_name: 'Careers', employee_portal: false,
    org_info: { company_name: 'thinkbridge', hide_company_name: false, ...org }, ...overrides };
  return `<input id="meta" value='${JSON.stringify(meta).replace(/&/g, '&amp;').replace(/'/g, '&#39;')}' />`;
}

test('Common Crawl extracts regional Zoho boards without merging distinct career pages', () => {
  assert.deepEqual(patternsFor(PLATFORMS.zohorecruit), ZOHO_RECRUIT_DOMAINS.map(domain => `*.${domain}/*`));
  for (const domain of ZOHO_RECRUIT_DOMAINS) {
    const host = `thinkbridge.${domain}`;
    for (const suffix of ['', '/40078000018949076', '/40078000018949076/Customer-Success-Lead?source=CareerSite']) {
      const identity = `${host}::Careers`;
      assert.equal(PLATFORMS.zohorecruit.extract_slug(`https://${host}/jobs/Careers${suffix}`), identity);
      assert.equal(zohoRecruitBoardSlugFromUrl(zohoRecruitBoardUrl(identity)), identity);
    }
  }
  const other = zohoRecruitBoardSlugFromUrl(boardUrl.replace('/Careers', '/Graduate%20Jobs'));
  assert.equal(other, 'thinkbridge.zohorecruit.in::Graduate%20Jobs');
  assert.notEqual(other, slug);
  assert.equal(boardIdentityFromUrl(postingUrl)?.slug, slug);
  for (const url of [boardUrl.replace('thinkbridge.', 'www.'), boardUrl.replace('thinkbridge.', 'nested.thinkbridge.'),
    boardUrl.replace('.in/', '.in.evil.example/'), `https://evil.example/?next=${postingUrl}`,
    boardUrl.replace('/Careers', '/Careers%2FPrivate'), boardUrl.replace('/Careers', '/%ZZ'),
    boardUrl.replace('/jobs/Careers', '/recruit/v2/public/Job_Openings'), boardUrl.replace('/Careers', '/Careers/not-a-posting')]) {
    assert.equal(PLATFORMS.zohorecruit.extract_slug(url), null, url);
  }
  assert.throws(() => zohoRecruitBoardUrl('evil.example::Careers'));
});

test('public board branding must identify the exact public catalogue and a visible employer', () => {
  assert.deepEqual(parseZohoRecruitBoardConfig(slug, configHtml()), { company: 'thinkbridge' });
  for (const html of [configHtml({ employee_portal: true }), configHtml({ page_name: 'Private' }),
    configHtml({ list_url: boardUrl.replace('thinkbridge', 'another') }), configHtml({}, { hide_company_name: true }),
    configHtml({}, { company_name: '' }), '<title>thinkbridge Careers</title>']) {
    assert.throws(() => parseZohoRecruitBoardConfig(slug, html));
  }
});

test('Zoho discovery and acquisition use the public catalogue without integration API pagination', () => {
  const request = buildAtsBoardRequest({ platform: 'zohorecruit', slug });
  assert.equal(request.url, 'https://thinkbridge.zohorecruit.in/recruit/v2/public/Job_Openings?pagename=Careers');
  assert.equal(publicAtsPageSize('zohorecruit'), null);
  assert.throws(() => buildPublicAtsBoardRequest('zohorecruit', slug, 40));
  const parsed = parseAtsListingPayload('zohorecruit', listing([row, { ...row, id: '40078000018949077', Publish: false }]),
    null, { platform: 'zohorecruit', slug }, { company: 'thinkbridge' });
  assert.equal(parsed.jobs.length, 1);
  assert.deepEqual(planAtsV2PageCompletion({ platform: 'zohorecruit', requestedOffset: 0,
    responseCount: parsed.jobs.length, providerTotal: parsed.total }), { listingComplete: true, anomaly: null });
  const job = parsed.jobs[0];
  assert.equal(job.id, `${slug}::${row.id}`);
  assert.equal(job.company, 'thinkbridge');
  assert.equal(job.description, description);
  assert.equal(job.location, 'Remote, United States');
  assert.equal(job.url, postingUrl);
  assert.equal(JSON.stringify(parsed).includes('never-persist'), false);
  const unknownCountry = parsePublicAtsListing('zohorecruit', slug, listing([{ ...row, Country: null }]), null, { company: 'thinkbridge' });
  assert.equal(unknownCountry.jobs[0].location, 'Remote');
});

test('malformed feeds cannot pass as an empty board or publish filled jobs', () => {
  const parse = (value: unknown) => parsePublicAtsListing('zohorecruit', slug, value, null, { company: 'thinkbridge' });
  assert.equal(parse(listing([])).jobs.length, 0);
  assert.equal(parse(listing([{ ...row, Publish: false }])).jobs.length, 0);
  for (const payload of [{}, { ...listing(), code: 'INTERNAL_ERROR' }, { ...listing(), info: { page_name: 'Other' } },
    listing([row, row]), listing([{ ...row, id: 40078000018949076 }]), listing([{ ...row, id: '../other' }]),
    listing([{ ...row, Publish: undefined }]), listing([{ ...row, Posting_Title: '' }]), listing([{ ...row, Job_Description: '' }])]) {
    assert.throws(() => parse(payload));
  }
  assert.throws(() => parsePublicAtsListing('zohorecruit', slug, listing()));
  assert.equal(atsAuthFailureIsPlatformWide('zohorecruit'), false);
  assert.equal(atsResponseSchemaFailureIsPlatformWide('zohorecruit'), false);
});

const storedPosting = (title = row.Posting_Title) => ({ title, company: 'thinkbridge', url: postingUrl,
  canonicalUrl: postingUrl, location: 'Remote, United States', description });
const storeWith = (rows: ReturnType<typeof storedPosting>[]) => ({ job: { findMany: async () => rows } }) as unknown as Parameters<typeof resolveDirectAtsPosting>[1]['store'];
const aggregator = { title: row.Posting_Title, company: 'thinkbridge', location: 'USA', source: 'Himalayas' };

test('the aggregator worker recognizes stored Zoho canonicals before fetching a board', async () => {
  const match = await resolveDirectAtsPosting(aggregator, { store: storeWith([storedPosting()]),
    fetcher: (async () => { throw new Error('stored match must not fetch'); }) as never });
  assert.equal(match?.matchedVia, 'stored');
  assert.equal(match?.platform, 'zohorecruit');
  assert.equal(match?.slug, slug);
  assert.equal(match?.url, postingUrl);
  assert.equal(match?.description?.includes('<p>'), false);
});

test('the aggregator worker fetches the known Zoho board and enriches only links and readable JD', async () => {
  let requested = '';
  const match = await resolveDirectAtsPosting(aggregator, { store: storeWith([storedPosting('Different role')]),
    fetcher: (async (url: string) => { requested = url; return Response.json(listing()); }) as never });
  assert.equal(requested, buildPublicAtsBoardRequest('zohorecruit', slug).url);
  assert.equal(match?.matchedVia, 'live');
  assert.equal(match?.url, postingUrl);
  assert.equal(match?.description, 'Responsibilities\nManage client relationships and lead quarterly business reviews.\nRequirements\nFive years of customer success experience.');
  assert.ok(match);
  const enrichment = planDirectMatchEnrichment({ url: 'https://himalayas.app/jobs/123', description: 'Brief stub' }, match);
  assert.ok(enrichment);
  assert.deepEqual(Object.keys(enrichment).sort(), ['canonicalUrl', 'description', 'url']);
  let written: unknown;
  const stamp = new Date('2026-10-08T12:00:00Z');
  await applyDirectMatchEnrichment('aggregator-job', stamp, enrichment, {
    job: { updateMany: async (args: unknown) => { written = args; return { count: 1 }; } },
  } as unknown as Parameters<typeof applyDirectMatchEnrichment>[3]);
  assert.deepEqual(written, { where: { id: 'aggregator-job', updatedAt: stamp }, data: enrichment });
});

test('Zoho live matching refuses ambiguous titles, closed jobs and malformed feeds', async () => {
  for (const payload of [listing([row, { ...row, id: '40078000018949077' }]),
    listing([{ ...row, Publish: false }]), { ...listing(), info: { page_name: 'Other' } },
    listing([{ ...row, Remote_Job: 'No', Country: 'India' }])]) {
    assert.equal(await resolveDirectAtsPosting(aggregator, { store: storeWith([storedPosting('Different role')]),
      fetcher: (async () => Response.json(payload)) as never }), null);
  }
});
