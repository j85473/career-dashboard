import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { recoverMissingSourceLocation, sourceHtmlLocation, sourceReaderLocation } from '../sourcePostingLocation';
import { parseJSearchJob } from '../jobIngestion';

const posting = {
  title: 'District Manager Allentown PA', company: 'Vontier Corp', location: 'Unknown Location', source: 'JSearch',
  url: 'https://www.monster.com/job-openings/district-manager-allentown-pa-poughkeepsie-ny--fc02f35e-88ec-4350-b0a4-bda9e80e4ec9',
};
const structured = {
  '@type': 'JobPosting', title: posting.title, url: posting.url,
  hiringOrganization: { name: 'Vontier' },
  jobLocation: { address: { addressLocality: 'Poughkeepsie', addressRegion: 'NY' } },
  jobLocationType: 'TELECOMMUTE',
};
const html = (data: unknown = structured, heading = posting.title) =>
  `<h1>${heading}</h1><script type="application/ld+json">${JSON.stringify(data)}</script>`;
const reader = (body = '  * Poughkeepsie, NY\n  * Remote\n\n## Numbers & Facts\n\nLocation | Poughkeepsie, NY (Remote)\n\n## Description\nNavigate the assigned territory.') =>
  `Title: ${posting.title} - Vontier Corp\n\nURL Source: ${posting.url}\n\nMarkdown Content:\n# ${posting.title}\n\n## Vontier Corp\n\n${body}`;

test('recovers published city and remote arrangement instead of guessing Allentown from the title', () => {
  assert.equal(sourceHtmlLocation(html(), posting), 'Poughkeepsie, NY (Remote)');
  assert.equal(sourceReaderLocation(reader(), posting), 'Poughkeepsie, NY (Remote)');
  assert.equal(sourceReaderLocation(reader('  * Poughkeepsie, NY\n  * Remote\n\n## Description\nDuties'), posting), 'Poughkeepsie, NY (Remote)');
  assert.equal(sourceHtmlLocation('<h1>District Manager Allentown PA</h1>', posting), null);
  assert.equal(sourceReaderLocation(reader('## Description\nWork in Allentown, PA.'), posting), null);
});

test('preserves every structured site, remote restrictions, and incomplete-location evidence', () => {
  const data = { ...structured, jobLocation: [structured.jobLocation, { address: { addressLocality: 'Allentown', addressRegion: 'PA' } }] };
  assert.equal(sourceHtmlLocation(html({ '@graph': [{ '@type': 'Organization' }, data] }), posting), 'Poughkeepsie, NY; Allentown, PA (Remote)');
  assert.match(sourceHtmlLocation(`${html()}<p>+ 3 more locations</p>`, posting)!, /Additional locations unresolved/);
  assert.equal(sourceHtmlLocation(html({ ...structured, jobLocation: undefined, applicantLocationRequirements: [{ name: 'New York' }, { name: 'Pennsylvania' }] }), posting), 'New York; Pennsylvania (Remote)');
});

test('rejects other roles, employers, canonical redirects, same-title recommendations and ambiguous postings', () => {
  for (const document of [
    html({ ...structured, title: 'District Manager Virginia' }),
    html({ ...structured, hiringOrganization: { name: 'Other Employer' } }),
    html(structured, 'Search jobs'),
    `<link rel="canonical" href="https://www.monster.com/jobs/search">${html()}`,
    html({ ...structured, url: `${posting.url}-other` }),
    html([structured, structured]),
    html([{ ...structured, url: undefined }, { ...structured, title: 'Other role' }]),
    html(structured, 'This job is no longer available'),
    '<h1>Search jobs</h1><script type="application/ld+json">{broken}</script>',
  ]) assert.equal(sourceHtmlLocation(document, posting), null, document);
  assert.equal(sourceHtmlLocation(html({ ...structured, url: undefined }), posting), 'Poughkeepsie, NY (Remote)');
  assert.equal(sourceHtmlLocation(html(structured, ''), posting), 'Poughkeepsie, NY (Remote)');
});

test('rendered recovery requires the exact URL and heading and excludes description/related-job geography', () => {
  for (const markdown of [
    reader().replace(`URL Source: ${posting.url}`, 'URL Source: https://www.monster.com/jobs/search'),
    reader().replace(`# ${posting.title}`, '# Other role'),
    reader().replace('## Vontier Corp', '## Another Employer'),
    reader('Location: Poughkeepsie, NY').replace('## Vontier Corp', '## Another Employer'),
    reader('## Description\nLocation: Minneapolis, MN'),
    reader('## Related Jobs\nLocation: Minneapolis, MN'),
    reader('  * Poughkeepsie, NY\n  * Allentown, PA'),
    reader('  * Poughkeepsie, NY\n  * Remote\n  * Hybrid'),
    reader('  * Poughkeepsie, NY\n  * Remote\nLocation | Poughkeepsie, NY (Hybrid)'),
    reader('Location | Unknown Location'),
    reader('Please enable JS and disable any ad blocker.'),
    `Title: monster.com\nURL Source: ${posting.url}\nMarkdown Content:\n`,
  ]) assert.equal(sourceReaderLocation(markdown, posting), null, markdown);
  const labeled = reader('Location: Poughkeepsie, NY\n\n## Description\nDuties');
  assert.equal(sourceReaderLocation(labeled, posting), 'Poughkeepsie, NY');
});

test('a complete provider JD still recovers missing location, with no rendered request on structured success', async () => {
  let calls = 0;
  const result = await recoverMissingSourceLocation(posting, {
    fetchPosting: async (url, init) => {
      calls++;
      assert.equal(url, posting.url);
      assert.ok(init?.signal);
      return new Response(html());
    },
    readPosting: async () => { throw new Error('must not render a successful structured posting'); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { location: 'Poughkeepsie, NY (Remote)', url: posting.url, method: 'json_ld' });
  assert.equal(posting.location, 'Unknown Location');
});

test('a blocked direct response can recover from the rendered location; access walls remain unresolved', async () => {
  assert.equal((await recoverMissingSourceLocation(posting, {
    fetchPosting: async () => new Response('blocked', { status: 403 }),
    readPosting: async () => new Response(reader()),
  }))?.location, 'Poughkeepsie, NY (Remote)');
  for (const readPosting of [
    async () => new Response('CAPTCHA'),
    async () => new Response(reader(), { status: 503 }),
    async () => { throw new Error('timeout'); },
  ]) assert.equal(await recoverMissingSourceLocation(posting, {
    fetchPosting: async () => { throw new Error('network failure'); }, readPosting,
  }), null);
});

test('existing locations, other providers, unsafe URLs and cancelled work never make a request', async () => {
  const noRequest = async () => { assert.fail('must not fetch'); };
  for (const change of [
    { location: 'Minneapolis, MN' }, { location: 'Remote' }, { location: 'Remote / United States' },
    { source: 'Indeed' }, { url: 'http://127.0.0.1/jobs/123' }, { url: 'http://localhost/jobs' }, { url: '' },
  ]) assert.equal(await recoverMissingSourceLocation({ ...posting, ...change }, { fetchPosting: noRequest, readPosting: noRequest }), null);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await recoverMissingSourceLocation(posting, { fetchPosting: noRequest, readPosting: noRequest, signal: controller.signal }), null);
});

test('redirected and missing postings do not read a different opening or invoke the reader', async () => {
  for (const response of [new Response('', { status: 404 }), new Response('', { status: 410 }),
    Object.defineProperty(new Response(html()), 'url', { value: 'https://www.monster.com/jobs/search' }),
  ]) assert.equal(await recoverMissingSourceLocation(posting, {
    fetchPosting: async () => response,
    readPosting: async () => { assert.fail('must not render a different or closed posting'); },
  }), null);
});

test('JSearch trims city/state separately and preserves an unknown location for missing fields', () => {
  const row = { job_uid: 'stable', job_title: posting.title };
  assert.equal(parseJSearchJob({ ...row, job_city: '  ', job_state: ' NY ' })?.location, 'NY');
  assert.equal(parseJSearchJob({ ...row, job_city: ' Poughkeepsie ', job_state: ' ' })?.location, 'Poughkeepsie');
  assert.equal(parseJSearchJob({ ...row, job_city: ' ', job_state: ' ' })?.location, 'Unknown Location');
  assert.equal(parseJSearchJob({ ...row, job_city: ' Poughkeepsie ', job_state: ' NY ' })?.location, 'Poughkeepsie, NY');
});

test('both ingestion paths recover only new arrivals, before final identity and geography decisions', () => {
  const source = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  for (const marker of ['export async function ingestExternalJob(', 'async function processJobInternal(']) {
    const path = source.slice(source.indexOf(marker));
    const recovery = path.indexOf('await recoverMissingSourceLocation');
    assert.ok(recovery > path.indexOf("return 'duplicate'"));
    assert.ok(recovery < path.indexOf('const postingIdentity = generatePostingIdentity'));
    assert.ok(recovery < path.indexOf('evaluateAuthoritativeMetadata'));
    assert.match(path.slice(recovery, recovery + 260), /if \(locationRecovery\) location = locationRecovery.location/);
  }
  const helper = readFileSync('src/lib/sourcePostingLocation.ts', 'utf8');
  assert.doesNotMatch(helper, /prisma|job\.update|invalidateActiveJobScores/);
});
