import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildIcimsIframeUrl,
  parseIcimsPostingHtml,
} from '../../src/lib/atsApi';
import { assessJobDescriptionQuality } from '../../src/lib/jobDescriptionQuality';

const RESPONSIBILITIES = `
  <p><strong>Summary:</strong> Perform liaison and support activities related to recruitment management
  of sponsors, coordinators, and donors. Coordinate donor recruitment schedules, communicate with
  community partners, prepare drive materials, maintain accurate database records, and distribute
  daily collection performance reports.</p>
  <ul>
    <li>Coordinate blood-drive recruitment activities with sponsors and internal operations teams.</li>
    <li>Maintain customer and donor records while responding to scheduling questions.</li>
    <li>Prepare promotional materials and provide administrative support for special events.</li>
  </ul>`;

const QUALIFICATIONS = `
  <p><strong>Education:</strong> High school diploma or equivalent; an associate or bachelor degree is
  preferred.</p>
  <p><strong>Experience:</strong> Two years of experience in customer service, sales, or administrative
  support. Demonstrated working knowledge of Microsoft Office and the ability to communicate clearly
  with customers, sponsors, and coworkers.</p>`;

const OVERVIEW = `
  <p>Founded in 1948, the organization serves hospitals and healthcare partners throughout Minnesota
  and Wisconsin. The team delivers lifesaving blood products, cellular therapies, specialty pharmacy,
  and medical services while supporting research and community health programs.</p>`;

function icimsFixture(options: { jobId?: number; includeSections?: boolean; validDataLayer?: boolean } = {}) {
  const jobId = options.jobId ?? 8718;
  const includeSections = options.includeSections ?? true;
  const dataLayer = options.validDataLayer === false
    ? 'dataLayer = [not valid JSON];'
    : `dataLayer = [{"customerIdRaw":4695,"labels":["value with ] bracket"],"job":{"company":"IBR - St. Paul","location":{"country":"USA","city":"St. Paul","state":"MN"},"idRaw":${jobId},"title":"Donor Recruitment Associate"}}];`;

  return `<!doctype html><html><head><title>Donor Recruitment Associate</title></head><body>
    <script>${dataLayer}</script>
    <div id="iCIMS_NoCookiesMessage" class="iCIMS_ErrorMsg">Please Enable Cookies to Continue</div>
    <div class="container-fluid iCIMS_JobsTable">
      <div class="col-xs-12 title"><h1 class="iCIMS_Header">Donor Recruitment Associate</h1></div>
      <div class="col-xs-6 header left"><span class="sr-only field-label">Job Locations</span><span>US-MN-St. Paul</span></div>
      <dl class="iCIMS_JobHeaderGroup"><div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField">ID</dt><dd class="iCIMS_JobHeaderData">2026-8718</dd></div></dl>
      ${includeSections ? `
        <h2 class="iCIMS_InfoMsg iCIMS_InfoField_Job">Responsibilities</h2>
        <div class="iCIMS_InfoMsg iCIMS_InfoMsg_Job">${RESPONSIBILITIES}</div>
        <h2 class="iCIMS_InfoMsg iCIMS_InfoField_Job">Qualifications</h2>
        <div class="iCIMS_InfoMsg iCIMS_InfoMsg_Job">${QUALIFICATIONS}</div>
        <h2 class="iCIMS_InfoMsg iCIMS_InfoField_Job">Overview</h2>
        <div class="iCIMS_InfoMsg iCIMS_InfoMsg_Job">${OVERVIEW}</div>
      ` : ''}
    </div>
    <div class="iCIMS_JobOptions">Apply for this job online. Share this job.</div>
    <div class="iCIMS_PageFooter">Can't find what you're looking for? Sign up for job alerts.</div>
  </body></html>`;
}

function withDisplayedLocation(html: string, location: string) {
  return html.replace('US-MN-St. Paul</span>', `${location}</span>`);
}

test('buildIcimsIframeUrl selects the public iframe mode and preserves tenant parameters', () => {
  const result = buildIcimsIframeUrl(
    'https://careers-ibr.icims.com/jobs/8718/donor-recruitment-associate/job?mobile=false&width=1057',
  );
  assert.ok(result);
  assert.equal(result!.hostname, 'careers-ibr.icims.com');
  assert.equal(result!.pathname, '/jobs/8718/donor-recruitment-associate/job');
  assert.equal(result!.searchParams.get('mobile'), 'false');
  assert.equal(result!.searchParams.get('width'), '1057');
  assert.equal(result!.searchParams.get('in_iframe'), '1');
});

test('buildIcimsIframeUrl converts aggregator login links to the public job document', () => {
  const withSlug = buildIcimsIframeUrl(
    'https://careers-gdms.icims.com/jobs/74386/senior-embedded-software-engineer/login?bga=true',
  );
  const withoutSlug = buildIcimsIframeUrl(
    'https://uscareers-pepsico.icims.com/jobs/450049/login?iisn=maximus-xml',
  );
  assert.equal(withSlug?.pathname, '/jobs/74386/senior-embedded-software-engineer/job');
  assert.equal(withSlug?.searchParams.get('bga'), 'true');
  assert.equal(withSlug?.searchParams.get('in_iframe'), '1');
  assert.equal(withoutSlug?.pathname, '/jobs/450049/job');
  assert.equal(withoutSlug?.searchParams.get('iisn'), 'maximus-xml');
  assert.equal(withoutSlug?.searchParams.get('in_iframe'), '1');
});

test('buildIcimsIframeUrl rejects non-iCIMS hosts and non-job paths', () => {
  assert.equal(buildIcimsIframeUrl('https://example.com/jobs/8718/donor-recruitment-associate/job'), null);
  assert.equal(buildIcimsIframeUrl('https://careers-ibr.icims.com/jobs/search'), null);
  assert.equal(buildIcimsIframeUrl('javascript:alert(1)'), null);
});

test('parseIcimsPostingHtml extracts labeled posting content and grounded metadata', () => {
  const result = parseIcimsPostingHtml(icimsFixture(), '8718');
  assert.ok(result);
  assert.equal(result!.ats, 'iCIMS');
  assert.equal(result!.platform, 'icims');
  assert.equal(result!.title, 'Donor Recruitment Associate');
  assert.equal(result!.location, 'St. Paul, MN');
  assert.match(result!.text, /^Responsibilities\n/);
  assert.match(result!.text, /Qualifications\n/);
  assert.match(result!.text, /Overview\n/);
  assert.equal(result!.text.includes('Please Enable Cookies'), false);
  assert.equal(result!.text.includes('Apply for this job'), false);
  assert.equal(result!.text.includes('job alerts'), false);
  const quality = assessJobDescriptionQuality(result!.text, { structuredSource: true });
  assert.equal(quality.scorable, true, quality.reason ?? '');
});

test('parseIcimsPostingHtml falls back to the displayed location when dataLayer is malformed', () => {
  const result = parseIcimsPostingHtml(icimsFixture({ validDataLayer: false }), '8718');
  assert.ok(result);
  assert.equal(result!.location, 'St. Paul, MN');
});

test('parseIcimsPostingHtml normalizes each displayed multi-site location independently', () => {
  const html = withDisplayedLocation(
    icimsFixture({ validDataLayer: false }),
    'US-MN-Minneapolis/St. Paul | US-MN-Brainerd | US-MN-Rochester',
  );
  const result = parseIcimsPostingHtml(html, '8718');
  assert.ok(result);
  assert.equal(result!.location, 'Minneapolis/St. Paul, MN | Brainerd, MN | Rochester, MN');
});

test('parseIcimsPostingHtml rejects a different embedded job and a portal shell', () => {
  assert.equal(parseIcimsPostingHtml(icimsFixture({ jobId: 9999 }), '8718'), null);
  assert.equal(parseIcimsPostingHtml(icimsFixture({ includeSections: false }), '8718'), null);
});

test('scrapeAtsApi routes iCIMS hosts through the dedicated extractor before JSON-LD', () => {
  const source = readFileSync(new URL('../../src/lib/atsApi.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(isDomain\(host, 'icims\.com'\)\) \{\s+const detail = await scrapeIcimsPosting\(url\);/);
  assert.ok(source.indexOf("isDomain(host, 'icims.com')") < source.indexOf('return await scrapeJsonLdJobPosting(url)'));
});
