import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractJsonLdJobPosting,
  jsonLdCompanyName,
  jsonLdLocationString,
} from '../../src/lib/atsApi';
import { parseBreezySalaryRange } from '../../src/lib/jobIngestion';

/**
 * Real shape verified live on
 * seeknow.breezy.hr/p/46cc4db5ad98-contractor-development-lead: two ld+json
 * blocks on the page (a WebSite one first, then the JobPosting), the
 * JobPosting itself a bare object rather than an array.
 */
const REAL_BREEZY_JOBPOSTING_PAGE = `<html><head>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"WebSite","name":"Breezy HR","url":"https://breezy.hr/"}</script>
<script type="application/ld+json">{"@context":"https://schema.org/","@type":"JobPosting","url":"https://seeknow.breezy.hr/p/46cc4db5ad98-contractor-development-lead","title":"Contractor Development Lead","description":"<p>Seek Now is looking for a Contractor Development Lead.</p><h3><strong>Key Responsibilities</strong></h3><ul><li>Coach contractors</li></ul>","employmentType":"FULL_TIME","datePosted":"2026-07-23","hiringOrganization":{"@type":"Organization","name":"Seek Now","logo":null,"sameAs":"https://seeknow.breezy.hr"},"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressCountry":"US","addressRegion":"KY","addressLocality":"Louisville"}}}</script>
</head><body></body></html>`;

test('extracts the JobPosting block from a real Breezy page with multiple ld+json scripts', () => {
  const jobPosting = extractJsonLdJobPosting(REAL_BREEZY_JOBPOSTING_PAGE);
  assert.ok(jobPosting);
  assert.equal(jobPosting!.title, 'Contractor Development Lead');
  assert.match(jobPosting!.description as string, /Key Responsibilities/);
  assert.equal(jsonLdCompanyName(jobPosting!.hiringOrganization), 'Seek Now');
  assert.equal(jsonLdLocationString(jobPosting!.jobLocation), 'Louisville, KY');
});

test('finds the JobPosting entry when the ld+json value is an array of objects', () => {
  const html = `<script type="application/ld+json">[
    {"@type":"BreadcrumbList","itemListElement":[]},
    {"@type":"JobPosting","title":"Backend Engineer","description":"Build things.","hiringOrganization":{"@type":"Organization","name":"Acme Corp"}}
  ]</script>`;
  const jobPosting = extractJsonLdJobPosting(html);
  assert.ok(jobPosting);
  assert.equal(jobPosting!.title, 'Backend Engineer');
  assert.equal(jsonLdCompanyName(jobPosting!.hiringOrganization), 'Acme Corp');
});

test('finds the JobPosting entry nested inside an @graph array', () => {
  const html = `<script type="application/ld+json">{
    "@context": "https://schema.org",
    "@graph": [
      {"@type": "Organization", "name": "Acme Corp"},
      {"@type": ["JobPosting"], "title": "Support Specialist", "description": "Help customers."}
    ]
  }</script>`;
  const jobPosting = extractJsonLdJobPosting(html);
  assert.ok(jobPosting);
  assert.equal(jobPosting!.title, 'Support Specialist');
});

test('returns null for a page with ld+json blocks but no JobPosting entry', () => {
  const html = `<script type="application/ld+json">{"@type":"WebSite","name":"Some Careers Site"}</script>
    <script type="application/ld+json">{"@type":"Organization","name":"Some Co"}</script>`;
  assert.equal(extractJsonLdJobPosting(html), null);
});

test('returns null for a page with no ld+json blocks at all', () => {
  assert.equal(extractJsonLdJobPosting('<html><body><p>No structured data here.</p></body></html>'), null);
});

test('skips a block that fails to parse rather than throwing, and still finds a valid one after it', () => {
  const html = `<script type="application/ld+json">{not valid json,,,</script>
    <script type="application/ld+json">{"@type":"JobPosting","title":"Recovers Fine","description":"Still works."}</script>`;
  const jobPosting = extractJsonLdJobPosting(html);
  assert.ok(jobPosting);
  assert.equal(jobPosting!.title, 'Recovers Fine');
});

test('jsonLdCompanyName accepts both the object and bare-string hiringOrganization shapes', () => {
  assert.equal(jsonLdCompanyName({ name: 'Widgets Inc' }), 'Widgets Inc');
  assert.equal(jsonLdCompanyName('Widgets Inc'), 'Widgets Inc');
  assert.equal(jsonLdCompanyName(undefined), null);
  assert.equal(jsonLdCompanyName({}), null);
});

test('jsonLdLocationString never hands back a country-only value', () => {
  assert.equal(
    jsonLdLocationString({ address: { addressLocality: 'Louisville', addressRegion: 'KY', addressCountry: 'US' } }),
    'Louisville, KY',
  );
  // No locality at all -- a bare country is never worth trading a caller's
  // existing, more specific stored value for.
  assert.equal(jsonLdLocationString({ address: { addressCountry: 'US' } }), null);
  assert.equal(jsonLdLocationString(undefined), null);
});

test('jsonLdLocationString preserves country evidence when a posting has no region', () => {
  assert.equal(
    jsonLdLocationString({
      address: { addressLocality: 'Cluj-Napoca', addressCountry: 'RO' },
    }),
    'Cluj-Napoca, RO',
  );
  assert.equal(
    jsonLdLocationString({
      address: { addressLocality: 'Cluj-Napoca', addressCountry: { name: 'Romania' } },
    }),
    'Cluj-Napoca, Romania',
  );
});

test('jsonLdLocationString reads the first usable entry out of a multi-location array', () => {
  assert.equal(
    jsonLdLocationString([
      { address: { addressCountry: 'US' } },
      { address: { addressLocality: 'Austin', addressRegion: 'TX' } },
    ]),
    'Austin, TX',
  );
});

test('parseBreezySalaryRange accepts an explicit annual USD range', () => {
  assert.equal(parseBreezySalaryRange('$150,000 – $170,000 / year'), '$150,000–$170,000 base');
});

test('parseBreezySalaryRange rejects hourly, non-USD, and unlabelled ranges', () => {
  assert.equal(parseBreezySalaryRange('$18 – $24 / hour'), null);
  assert.equal(parseBreezySalaryRange('£28,000 – £35,000'), null);
  // No period stated at all -- ambiguous, not "unambiguous" as required.
  assert.equal(parseBreezySalaryRange('$55,000 – $80,000'), null);
  assert.equal(parseBreezySalaryRange(''), null);
  assert.equal(parseBreezySalaryRange(undefined), null);
});

test('a JobPosting whose description carries raw newlines is still recovered', () => {
  // Teamtailor emits exactly this: the description holds literal newline
  // characters inside a JSON string, which JSON forbids. JSON.parse throws on
  // the first one and the whole posting was discarded -- which is why 17,109
  // Teamtailor jobs, two thirds of that platform's catalog, arrived with no
  // location and had to be held out of scoring. The location was in the page
  // the whole time, one parse error away.
  const html = `<html><head><script type="application/ld+json">{
    "@context": "http://schema.org/",
    "@type": "JobPosting",
    "title": "Customer Success Manager",
    "description": "<p>Line one
line two</p>",
    "jobLocation": [{"@type":"Place","address":{"addressLocality":"East Rutherford","addressCountry":"US","addressRegion":null,"@type":"PostalAddress"}}]
  }</script></head><body></body></html>`;

  const posting = extractJsonLdJobPosting(html);
  assert.ok(posting, 'a posting with raw newlines must still be recovered');
  assert.equal(posting?.title, 'Customer Success Manager');
  assert.equal(jsonLdLocationString(posting!.jobLocation), 'East Rutherford, US');
});

test('lenient recovery never rewrites structure or well-formed documents', () => {
  // Escaping is string-literal aware: a newline between JSON tokens is
  // structure and must be left alone, and an already-escaped \n must not be
  // double-escaped into a literal backslash-n in the value.
  const html = `<html><script type="application/ld+json">{
    "@type": "JobPosting",
    "title": "Ok",
    "description": "already\\nescaped",
    "jobLocation": [{"@type":"Place","address":{"addressLocality":"Oslo","addressCountry":"NO","@type":"PostalAddress"}}]
  }</script></html>`;
  const posting = extractJsonLdJobPosting(html);
  assert.equal(posting?.description, 'already\nescaped');
  assert.equal(jsonLdLocationString(posting!.jobLocation), 'Oslo, NO');

  // Genuinely broken JSON still yields nothing rather than a wrong answer.
  assert.equal(extractJsonLdJobPosting('<script type="application/ld+json">{"@type":</script>'), null);
});
