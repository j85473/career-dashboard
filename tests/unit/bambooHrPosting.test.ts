import assert from 'node:assert/strict';
import test from 'node:test';
import { bambooHrPageMetadata, bambooHrPostingIdentity, fetchBambooHrPosting, parseBambooHrPosting } from '../../src/lib/bambooHrPosting';
import { readManualImportPage } from '../../src/lib/manualImportPage';

const url = 'https://wildix.bamboohr.com/careers/347';
const title = 'New Business Partner Development Manager - USA';
const html = `<title>BambooHR</title><meta property="og:url" content="${url}">
  <meta property="og:title" content="${title} "><meta property="og:site_name" content="Wildix"><body><div id="poRoot"></div></body>`;
const opening = { jobOpeningShareUrl: url, jobOpeningName: `${title} `, jobOpeningStatus: 'Open',
  description: '<p>We’re <strong>Wildix</strong>, a global communications company.</p><p>Recruit and activate channel partners.</p>',
  atsLocation: { country: 'United States', city: null, state: null }, location: { city: 'Payroll office', state: 'Estonia' },
  employmentStatusLabel: 'EOR - Remote.com', locationType: '1' };
const body = (job = opening) => ({ result: { jobOpening: job, formFields: { country: { value: 'Canada' } } } });

test('BambooHR recovers Wildix role, employer and country-bound remote location from the exact opening', () => {
  const result = parseBambooHrPosting(body(), url, html);
  assert.equal(result?.title, title);
  assert.equal(result?.company, 'Wildix');
  assert.equal(result?.location, 'United States (Remote)');
  assert.equal(result?.ats, 'BambooHR');
  assert.match(result!.text, /Recruit and activate channel partners/);
  assert.doesNotMatch(result!.text, /<strong>|Payroll office|Canada|Remote.com/);
});

test('BambooHR metadata binds the company and role to the same tenant and opening', () => {
  assert.equal(parseBambooHrPosting(body({ ...opening, jobOpeningShareUrl: url.replace('347', '348') }), url, html), null);
  assert.equal(parseBambooHrPosting(body({ ...opening, jobOpeningShareUrl: url.replace('wildix', 'other') }), url, html), null);
  for (const invalid of [html.replace('content="'+url+'"', 'content="'+url.replace('347', '348')+'"'), html.replace('wildix.bamboohr.com', 'other.bamboohr.com'), html.replace(title, 'Other role')]) {
    assert.equal(parseBambooHrPosting(body(), url, invalid)?.company, undefined);
  }
  assert.deepEqual(bambooHrPageMetadata(html + '<meta property="og:site_name" content="Other Company">', url), { title, company: undefined });
});

test('closed, malformed and unsafe BambooHR postings cannot become a verified job', () => {
  for (const status of ['Closed', 'Draft', '']) assert.equal(parseBambooHrPosting(body({ ...opening, jobOpeningStatus: status }), url, html), null);
  for (const value of [url.replace('https:', 'http:'), url.replace('wildix.bamboohr.com', 'wildix.bamboohr.com.evil.example'), url.replace('/347', ''), `${url}/detail`, url.replace('/347', '/not-a-job'), url.replace('https://', 'https://user@')]) {
    assert.equal(bambooHrPostingIdentity(value), null);
  }
  for (const invalid of [null, {}, { result: {} }, { result: { jobOpening: { ...opening, description: null } } }]) {
    assert.equal(parseBambooHrPosting(invalid, url, html), null);
  }
  assert.equal(parseBambooHrPosting(body({ ...opening, locationType: '2' }), url, html)?.location, 'United States (Hybrid)');
  assert.equal(parseBambooHrPosting(body({ ...opening, locationType: 'unknown' }), url, html)?.location, 'United States');
});

test('the generic BambooHR browser title never wins over exact sharing metadata or becomes a role', async () => {
  const result = await readManualImportPage({ html, url }, async () => assert.fail('The posting already supplies the role and company'));
  assert.equal(result.title, title);
  assert.equal(result.company, 'Wildix');
  const blank = await readManualImportPage({ html: '<title>BambooHR</title>', url }, async () => assert.fail('A vendor name is not a role'));
  assert.equal(blank.title, 'Manual Job Import');
  const supplied = await readManualImportPage({ html, url, title: 'Reviewed role', company: 'Reviewed employer' }, async () => assert.fail());
  assert.equal(supplied.title, 'Reviewed role');
  assert.equal(supplied.company, 'Reviewed employer');
});

test('the shared BambooHR fetcher reads the exact JSON detail and same-posting branding without following redirects', async () => {
  const calls: string[] = [];
  const result = await fetchBambooHrPosting(url, async target => {
    calls.push(String(target));
    return String(target).endsWith('/detail') ? Response.json(body()) : new Response(html);
  });
  assert.equal(result?.company, 'Wildix');
  assert.deepEqual(calls.sort(), [url, `${url}/detail`]);
  for (const failed of ['detail-status', 'detail-redirect', 'page-redirect', 'page-outage']) {
    const parsed = await fetchBambooHrPosting(url, async target => {
      if (String(target).endsWith('/detail')) {
        const response = failed === 'detail-status' ? new Response('', { status: 404 }) : Response.json(body());
        if (failed === 'detail-redirect') Object.defineProperty(response, 'url', { value: `${url.replace('wildix', 'other')}/detail` });
        return response;
      }
      if (failed === 'page-outage') throw new Error('Unavailable');
      const response = new Response(html);
      if (failed === 'page-redirect') Object.defineProperty(response, 'url', { value: url.replace('wildix', 'other') });
      return response;
    });
    if (failed.startsWith('detail-')) assert.equal(parsed, null);
    else { assert.equal(parsed?.title, title); assert.equal(parsed?.company, undefined); }
  }
});
