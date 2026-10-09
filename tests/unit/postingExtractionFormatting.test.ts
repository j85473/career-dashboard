import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEightfoldPostingDetail, parseJsonLdPostingHtml, workdayPostingDetailUrl } from '../../src/lib/atsApi';
import { identifyAts } from '../../src/lib/atsUtils';
import { cleanHtmlText } from '../../src/lib/jobIngestion';
import { repairPostingAtsLabel, repairPostingDescriptionFormatting } from '../../src/lib/postingExtractionRepair';

const summary = 'Manage partner relationships and coordinate operational performance across customer accounts. '.repeat(9).trim();
const duties = 'Monitor performance metrics and support partner reviews with internal teams.';
const qualifications = 'Requirements: Five years of experience managing external partners and customer programs.';
const htmlDescription = `<h2>Responsibilities</h2><p>${summary}</p><ul><li>${duties}</li></ul><h2>Qualifications</h2><p>${qualifications}</p>`;
const flatDescription = `Responsibilities ${summary} ${duties} Qualifications ${qualifications}`;
const page = (url: string, description: string, body: string) => `<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting', url, title: 'Partner Manager', description,
  hiringOrganization: { name: 'Actual Employer' },
})}</script><body>${body}</body>`;

test('Workday details use the employer tenant for both public URL families and locale variants', () => {
  const path = 'Remote-Anywhere-in-US/Language-Partnerships-Manager_JR-0875';
  for (const url of [
    `https://wd12.myworkdaysite.com/recruiting/cloudbreak/Equiti/job/${path}`,
    `https://wd12.myworkdaysite.com/en-US/recruiting/cloudbreak/Equiti/job/${path}`,
  ]) assert.equal(workdayPostingDetailUrl(url), `https://wd12.myworkdaysite.com/wday/cxs/cloudbreak/Equiti/job/${path}`);
  assert.equal(workdayPostingDetailUrl(`https://cloudbreak.wd12.myworkdayjobs.com/en-US/Equiti/job/${path}`),
    `https://cloudbreak.wd12.myworkdayjobs.com/wday/cxs/cloudbreak/Equiti/job/${path}`);
  assert.equal(workdayPostingDetailUrl('https://wd3.myworkdaysite.com/en-US/recruiting/bsigroup/BSI_Careers/job/Training-Solutions-Sales-Manager_JR0021027-1'),
    'https://wd3.myworkdaysite.com/wday/cxs/bsigroup/BSI_Careers/job/Training-Solutions-Sales-Manager_JR0021027-1');
});

test('Workday posting paths retain encoded characters once and reject boards, malformed paths, and lookalike hosts', () => {
  assert.equal(workdayPostingDetailUrl('https://acme.wd5.myworkdayjobs.com/External/job/New%20York/Manager_R-1?source=board'),
    'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/New%20York/Manager_R-1');
  for (const url of [
    'https://wd3.myworkdaysite.com/recruiting/acme/External',
    'https://wd3.myworkdaysite.com/job/Manager_R-1',
    'https://wd3.myworkdaysite.com.evil.example/recruiting/acme/External/job/Manager_R-1',
    'https://acme.myworkdayjobs.com.evil.example/External/job/Manager_R-1',
    'https://acme.myworkdayjobs.com/External/job/%XX',
    'ftp://acme.myworkdayjobs.com/External/job/Manager_R-1',
  ]) assert.equal(workdayPostingDetailUrl(url), null, url);
});

test('generic extraction and historical labels report real ATS platforms across all affected host families', () => {
  const postings = [
    ['https://wd3.myworkdaysite.com/recruiting/acme/External/job/Manager_R-1', 'Workday'],
    ['https://acme.wd5.myworkdayjobs.com/External/job/Manager_R-1', 'Workday'],
    ['https://job-boards.greenhouse.io/acme/jobs/123', 'Greenhouse'],
    ['https://acme.breezy.hr/p/123-partner-manager', 'Breezy'],
    ['https://ats.rippling.com/acme/jobs/123', 'Rippling'],
    ['https://jobs.ashbyhq.com/acme/123', 'Ashby'],
    ['https://apply.workable.com/acme/j/123/', 'Workable'],
    ['https://jobs.dayforcehcm.com/acme/jobs/123', 'Dayforce'],
    ['https://acme.eightfold.ai/careers/job/123', 'Eightfold'],
    ['https://jobs.lever.co/acme/123', 'Lever'],
    ['https://www.paycomonline.net/jobs/123', 'Paycom'],
    ['https://jobs.smartrecruiters.com/acme/123', 'SmartRecruiters'],
    ['https://acme.jobs.personio.de/job/123', 'Personio'],
  ];
  for (const [url, ats] of postings) {
    const result = parseJsonLdPostingHtml(page(url, htmlDescription, ''), url);
    assert.equal(result?.ats, ats, url);
    assert.equal(result?.platform, undefined, 'a generic extraction must not invent a discovery platform');
    assert.equal(identifyAts({ url, manualAts: 'JobPosting JSON-LD' }), ats, url);
  }
  const url = 'https://www.linkedin.com/jobs/view/123';
  assert.equal(parseJsonLdPostingHtml(page(url, htmlDescription, ''), url)?.ats, 'Unknown');
  assert.equal(identifyAts({ url, source: 'ATS-workday', manualAts: 'JobPosting JSON-LD' }), 'Workday');
  assert.equal(identifyAts({ url, manualAts: 'Workday' }), 'Workday', 'real user overrides remain authoritative');
});

test('generic fallback restores the exact formatted description while excluding navigation and unrelated postings', () => {
  const url = 'https://jobs.example.com/123';
  const result = parseJsonLdPostingHtml(page(url, flatDescription, `<section id="job-description"><h2>Job Details</h2><div>${htmlDescription}</div></section>`), url);
  assert.equal(result?.text, cleanHtmlText(htmlDescription));
  assert.match(result!.text, /Responsibilities\n/);
  assert.match(result!.text, /\n• Monitor/);
  assert.doesNotMatch(result!.text, /Job Details/);
  const wrong = parseJsonLdPostingHtml(page(url, flatDescription,
    `<div class="job-description">${htmlDescription}<p>Apply now. Browse other jobs.</p></div>`), url);
  assert.equal(wrong?.text, flatDescription);
  assert.equal(parseJsonLdPostingHtml(page('https://jobs.example.com/456', flatDescription, htmlDescription), url), null);
});

test('formatted LinkedIn and BioSpace containers can restore breaks omitted from SEO text', () => {
  const url = 'https://jobs.example.com/123';
  for (const body of [
    `<div class="description__text"><section><div>${htmlDescription}</div><button>Show more</button></section></div>`,
    `<section id="job-description"><h2>Job Details</h2><div>${htmlDescription}</div></section>`,
  ]) {
    const result = parseJsonLdPostingHtml(page(url, flatDescription.replace(/ /g, ''), body), url);
    assert.equal(result?.text, cleanHtmlText(htmlDescription));
  }
});

test('Eightfold refreshes recover formatted structured descriptions only for the exact requisition', () => {
  const url = 'https://kraftheinz.eightfold.ai/careers/job/123';
  const body = { status: 200, data: { id: 123, name: 'Partner Manager', jobDescription: htmlDescription, location: 'Chicago, IL' } };
  const result = parseEightfoldPostingDetail(body, url, 'Kraft Heinz');
  assert.equal(result?.ats, 'Eightfold');
  assert.equal(result?.text, cleanHtmlText(htmlDescription));
  assert.equal(result?.company, 'Kraft Heinz');
  assert.equal(result?.location, 'Chicago, IL');
  assert.equal(parseEightfoldPostingDetail(body, url.replace('123', '456'), 'Kraft Heinz'), null);
  assert.equal(parseEightfoldPostingDetail({ ...body, status: 404 }, url, 'Kraft Heinz'), null);
});

test('historical formatting repairs preserve every word including Workday employer introductions', () => {
  const formatted = cleanHtmlText(htmlDescription);
  const old = `${flatDescription} About our company: We support equitable care for all.`;
  const repaired = repairPostingDescriptionFormatting(old, formatted);
  assert.equal(repaired, `${formatted}\n\nAbout our company: We support equitable care for all.`);
  assert.equal(repairPostingDescriptionFormatting(flatDescription, formatted), formatted);
  assert.equal(repairPostingDescriptionFormatting(`${flatDescription}\nAlready formatted`, formatted), null);
  assert.equal(repairPostingDescriptionFormatting(flatDescription.replace('Five years', 'Ten years'), formatted), null);
  assert.equal(repairPostingDescriptionFormatting(flatDescription, 'Loading...\nPlease wait'), null);
});

test('historical badge repairs change only extraction labels and rely on available provider evidence', () => {
  const job = { url: 'https://www.linkedin.com/jobs/view/123', canonicalUrl: null, source: 'JSearch', manualAts: 'JobPosting JSON-LD' };
  assert.deepEqual(repairPostingAtsLabel(job), { manualAts: null });
  assert.deepEqual(repairPostingAtsLabel({ ...job, canonicalUrl: 'https://jobs.lever.co/acme/123' }), { manualAts: 'Lever' });
  assert.equal(repairPostingAtsLabel({ ...job, manualAts: 'Workday' }), null);
});
