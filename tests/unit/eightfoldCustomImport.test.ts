import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { eightfoldPostingIdFromUrl, eightfoldPostingPageConfig, eightfoldPostingPageMetadata, eightfoldPostingUrlsMatch, parseEightfoldConfig } from '../../src/lib/eightfoldBoard';
import { scrapeEightfoldPostingDetail, parseJsonLdPostingHtml } from '../../src/lib/atsApi';
import { readManualImportPage } from '../../src/lib/manualImportPage';
import { assessJobDescriptionQuality } from '../../src/lib/jobDescriptionQuality';

const url = 'https://jobs.kraftheinz.com/careers/job/1970324837521638?domain=kraftheinz.com&hl=en';
const id = '1970324837521638';
const config = `<code id="pcsx-data" style="display: none;">${JSON.stringify({
  domain: 'kraftheinz.com', configs: { pcsxConfig: { branding: { companyName: 'Kraft Heinz' } } },
})}</code>`;
const description = `<h2>Job Description</h2><p>${'Analyzes raw and syndicated data to inform distribution, assortment, pricing, and promotion. '.repeat(10)}</p><h3>Qualifications</h3><ul><li>Advanced Excel proficiency</li></ul><p>New Hire Base Salary Range: $89,800 - $112,200</p>`;
const body = { status: 200, data: { id, name: 'Associate Customer Sales Manager, UNFI', jobDescription: description,
  locations: ['Minneapolis Sales, Minnesota, United States of America', 'Chicago, Illinois, United States of America'] } };

const bayerUrl = 'https://talent.bayer.com/careers/job/562949975187846?hl=en';
const bayerHtml = readFileSync(new URL('../fixtures/bayer-eightfold.html', import.meta.url), 'utf8');
const bayerCanonical = 'https://talent.bayer.com/careers/job/562949975187846-sales-agronomist-iii-southwest-and-west-central-minnesota-residence-based-minnesota-united-states?domain=bayer.com';

test('Bayer legacy Eightfold imports recover the full authored JD and selected residence-based location', async () => {
  const posting = parseJsonLdPostingHtml(bayerHtml, bayerUrl);
  assert.equal(posting?.ats, 'Eightfold');
  assert.equal(posting?.company, 'Bayer');
  assert.equal(posting?.title, 'Sales Agronomist III-Southwest and West Central Minnesota');
  // The selected position is more specific than the SEO address (Roseville).
  assert.equal(posting?.location, 'Residence Based,Minnesota,United States');
  assert.ok(posting!.text.length > 5000);
  assert.match(posting!.text, /Sales Agronomist III-DEKALB\/Asgrow/);
  assert.doesNotMatch(posting!.text, /smartApplyData|companyName|themeOptions/);
  const manual = await readManualImportPage({ html: bayerHtml, url: bayerUrl }, async () => assert.fail('Published metadata must not require inference'));
  assert.equal(manual.title, posting?.title);
  assert.equal(manual.company, posting?.company);
  assert.equal(manual.location, posting?.location);
  assert.equal(manual.description, posting?.text);
});

test('legacy and current Eightfold layouts accept only aliases of the same verified employer and requisition', () => {
  for (const html of [bayerHtml, bayerHtml.replace(/<code id="smartApplyData"[\s\S]*<\/code>/,
    `<code id="pcsx-data">${JSON.stringify({ domain: 'bayer.com', configs: { pcsxConfig: { branding: { companyName: 'Bayer' } } } })}</code>`)]) {
    for (const alias of [bayerCanonical, bayerUrl, bayerUrl.replace('?hl=en', '/?hl=de'),
      'https://talent.bayer.com/careers?domain=bayer.com&pid=562949975187846&hl=de']) {
      assert.equal(eightfoldPostingUrlsMatch(alias, bayerUrl, html), true, alias);
      assert.equal(eightfoldPostingUrlsMatch(bayerUrl, alias, html), true, alias);
    }
    for (const wrong of [bayerCanonical.replace('846-', '847-'), bayerCanonical.replace('bayer.com/careers', 'other.bayer.com/careers'),
      bayerCanonical.replace('domain=bayer.com', 'domain=other.com'), bayerCanonical.replace('talent.bayer.com', 'talent.bayer.com.evil.com'),
      bayerCanonical.replace('https:', 'http:'), `${bayerUrl}&pid=123`, `${bayerUrl}&domain=bayer.com&domain=other.com`,
      'https://talent.bayer.com/careers?pid=562949975187846&pid=123']) {
      assert.equal(eightfoldPostingUrlsMatch(wrong, bayerUrl, html), false, wrong);
    }
  }
  assert.equal(eightfoldPostingUrlsMatch(bayerCanonical, bayerUrl, '<title>Bayer</title>'), false);
  assert.equal(parseJsonLdPostingHtml(bayerHtml, bayerUrl.replace('846?', '847?')), null);
  assert.equal(parseJsonLdPostingHtml(bayerHtml.replace(/<code[\s\S]*<\/code>/, ''), bayerUrl), null);
});

test('verified page JD survives blocked, malformed, wrong-requisition and unusable detail API responses', async () => {
  for (const fetcher of [
    async () => new Response('Forbidden', { status: 403 }),
    async () => new Response('not json'),
    async () => { throw new Error('Timed out'); },
    async () => Response.json({ status: 200, data: { ...body.data, id: 'different' } }),
    async () => Response.json({ status: 200, data: { id: '562949975187846', name: 'Selected role', jobDescription: 'Loading...' } }),
  ]) {
    const result = await scrapeEightfoldPostingDetail(bayerUrl, bayerHtml, fetcher);
    assert.equal(result?.company, 'Bayer');
    assert.equal(result?.location, 'Residence Based,Minnesota,United States');
    assert.ok(result!.text.length > 5000);
  }
});

test('configuration parsing rejects malformed, duplicate and conflicting old/new employer identities', () => {
  const legacy = `<code id="smartApplyData">${JSON.stringify({ domain: 'kraftheinz.com', branding: { companyName: 'Kraft Heinz' } })}</code>`;
  assert.deepEqual(parseEightfoldConfig(legacy), { domain: 'kraftheinz.com', company: 'Kraft Heinz' });
  assert.deepEqual(parseEightfoldConfig(config + legacy), parseEightfoldConfig(config));
  for (const html of [config + legacy.replace('Kraft Heinz', 'Other Employer'), config + legacy.replace('kraftheinz.com', 'other.com'),
    config + legacy.replace('{"domain"', '{bad"domain"'), legacy + legacy]) {
    assert.throws(() => parseEightfoldConfig(html));
  }
});

test('embedded metadata selects the exact position, retains every location and leaves missing fields available to JSON-LD', () => {
  const positions = [
    { id: '111', name: 'Unrelated role', locations: ['London, UK'] },
    { id, name: body.data.name, locations: body.data.locations },
  ];
  const legacy = (rows: object[], pid: string = id) => `<code id="smartApplyData">${JSON.stringify({
    domain: 'kraftheinz.com', branding: { companyName: 'Kraft Heinz' }, pid, positions: rows,
  })}</code>`;
  assert.deepEqual(eightfoldPostingPageMetadata(url, legacy(positions)), {
    company: 'Kraft Heinz', title: body.data.name, location: body.data.locations.join('; '),
  });
  assert.deepEqual(eightfoldPostingPageMetadata(url, legacy([{ id, name: body.data.name }])), { company: 'Kraft Heinz', title: body.data.name });
  assert.equal(eightfoldPostingPageMetadata(url, legacy(positions, '111')), null);
  assert.equal(eightfoldPostingPageMetadata(url, legacy([...positions, positions[1]])), null);
});

test('custom Eightfold domains require published employer configuration and do not create a duplicate collection board', () => {
  assert.deepEqual(eightfoldPostingPageConfig(url, config), { domain: 'kraftheinz.com', company: 'Kraft Heinz', slug: null });
  for (const target of [url.replace('jobs.kraftheinz.com', 'kraftheinz.com.evil.com'), url.replace('domain=kraftheinz.com', 'domain=other.com'),
    url.replace(`/job/${id}`, ''), url.replace(`/job/${id}`, '/dashboard')]) {
    assert.equal(eightfoldPostingPageConfig(target, config), null);
  }
  assert.equal(eightfoldPostingPageConfig(url, '<title>Careers</title>'), null);
  assert.equal(eightfoldPostingPageConfig(url, config.replace('Kraft Heinz', '')), null);
});

test('custom-domain recovery calls the same-origin detail API and preserves complete formatting, locations and compensation', async () => {
  const requests: string[] = [];
  const result = await scrapeEightfoldPostingDetail(url, config, async target => {
    requests.push(String(target));
    return Response.json(body);
  });
  assert.equal(requests.length, 1);
  const request = new URL(requests[0]);
  assert.equal(request.origin, new URL(url).origin);
  assert.equal(request.pathname, '/api/pcsx/position_details');
  assert.equal(request.searchParams.get('position_id'), id);
  assert.equal(request.searchParams.get('domain'), 'kraftheinz.com');
  assert.equal(result?.ats, 'Eightfold');
  assert.equal(result?.atsSlug, undefined);
  assert.equal(result?.company, 'Kraft Heinz');
  assert.match(result!.text, /Job Description\n/);
  assert.match(result!.text, /\n• Advanced Excel/);
  assert.match(result!.text, /\$89,800 - \$112,200/);
  assert.equal(result?.location, body.data.locations.join('; '));
});

test('Eightfold recovery rejects another requisition, error envelopes and unverified pages', async () => {
  for (const payload of [{ ...body, data: { ...body.data, id: '123' } }, { ...body, status: 404 }]) {
    assert.equal(await scrapeEightfoldPostingDetail(url, config, async () => Response.json(payload)), null);
  }
  assert.equal(await scrapeEightfoldPostingDetail(url, '', async () => assert.fail('An unverified page cannot authorize a detail fetch')), null);
});

test('both hosted and employer-domain Eightfold links support a selected pid without treating a listing as a posting', async () => {
  for (const host of ['jobs.kraftheinz.com', 'kraftheinz.eightfold.ai']) {
    const target = `https://${host}/careers?domain=kraftheinz.com&pid=${id}`;
    assert.equal(eightfoldPostingIdFromUrl(target), id);
    assert.equal((await scrapeEightfoldPostingDetail(target, config, async () => Response.json(body)))?.title, body.data.name);
  }
  assert.equal(eightfoldPostingIdFromUrl('https://jobs.kraftheinz.com/careers?pid=invalid'), null);
  assert.equal(eightfoldPostingIdFromUrl('https://jobs.kraftheinz.com/careers'), null);
  assert.equal(eightfoldPostingIdFromUrl('not a URL'), null);
});

test('manual import prefers the authored JD, removes hidden configuration and retains descriptions longer than 5000 characters', async () => {
  const long = 'Analyzes customer data and presents findings. '.repeat(160);
  const posting = { '@type': 'JobPosting', url, title: body.data.name, hiringOrganization: { name: 'Kraft Heinz' }, description: long };
  const html = `<title>Role</title><script type="application/ld+json">${JSON.stringify(posting)}</script><body>${config}<p>Page summary</p></body>`;
  const result = await readManualImportPage({ html, url }, async () => assert.fail('Structured metadata is complete'));
  assert.equal(result.description, long.trim());
  assert.ok(result.description.length > 5000);
  const fallback = await readManualImportPage({ html: `<title>Role</title><body>${config}<div hidden>Hidden data</div><div aria-hidden="true">Decorative text</div><p>${long}</p></body>`, url,
    title: 'Role', company: 'Kraft Heinz' }, async () => ({}));
  assert.equal(fallback.description, long.trim());
});

test('a structured JD need not use our English duties vocabulary, but configuration and shells are never scorable', () => {
  const text = 'Analyzes raw and syndicated data to inform distribution, assortment, pricing, and promotion. '.repeat(12).trim();
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, description: text })}</script>`;
  assert.equal(parseJsonLdPostingHtml(html, url)?.text, text);
  const configuration = JSON.stringify({ themeOptions: { customTheme: { varTheme: { font: 'Roboto' } } }, content: description.repeat(10) });
  for (const options of [{}, { structuredSource: true }]) {
    assert.equal(assessJobDescriptionQuality(configuration, options).scorable, false);
    assert.equal(assessJobDescriptionQuality(`Sign in to apply. Create an account. ${'Welcome. '.repeat(100)}`, options).scorable, false);
  }
});
