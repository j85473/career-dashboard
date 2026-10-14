import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSuccessFactorsPostingHtml, parseSuccessFactorsCareerPosting, recoverSuccessFactorsMetadata,
  successFactorsPostingIdentity, successFactorsCareerSite, successFactorsEmployerPageMatches, normalizedSuccessFactorsTitle } from '../successFactorsPosting';
import { requirePublicAtsEmployer } from '../jobIngestion';

const url = 'https://career4.successfactors.com/career?company=Mahindra&career_ns=job_listing&career_job_req_id=53169';
const page = (tenant = 'Mahindra', id = '53169', fields = '<b>Chennai</b> - <b>Sales</b>') => `
<style>#masthead { background-image: url('https://performancemanager4.successfactors.com/Mahindra/Mahindra%20Logo.png'); }</style>
<input id="career_company" value="${tenant}"><input id="career_job_req_id" value="${id}">
<div><div class="pagetitle"><h1>Career Opportunities: Area Sales Manager (${id})</h1></div>
<div>Requisition ID <b>${id}</b> - Posted <b id="postedOnDate"></b> - ${fields}</div></div>
<div class="joqReqDescription"><div class="externalPosting">Long historical description</div></div>`;
const career = (id = '53169', title = 'Area Sales Manager') => `<script data-company-job-code="${id}-en_GB"></script>
<meta itemprop="hiringOrganization" content="Mahindra &amp; Mahindra Limited"><span itemprop="title">${title}</span>
<span itemprop="jobLocation"><meta itemprop="addressLocality" content="Chennai"><meta itemprop="addressCountry" content="IN"></span>`;

test('Mahindra HTML recovers Chennai from its exact requisition header without JSON-LD', () => {
  assert.deepEqual(parseSuccessFactorsPostingHtml(page(), url), { title: 'Area Sales Manager', company: 'Mahindra', location: 'Chennai' });
  assert.equal(parseSuccessFactorsPostingHtml(page('Other'), url), null);
  assert.equal(parseSuccessFactorsPostingHtml(page('Mahindra', '53828'), url), null);
  assert.equal(parseSuccessFactorsPostingHtml('<h1>Search results</h1>', url), null);
});

test('another tenant cannot turn an unlabeled department into a location or borrow Mahindra branding', () => {
  const other = url.replace('Mahindra', 'Other');
  assert.deepEqual(parseSuccessFactorsPostingHtml(page('Other', '53169', '<b>Driving</b> - <b>Field Operations</b>'), other),
    { title: 'Area Sales Manager', company: undefined, location: undefined });
  assert.equal(successFactorsPostingIdentity(url + '&company=Other'), null);
  assert.equal(successFactorsPostingIdentity(url + '&career_job_req_id=53828'), null);
  assert.equal(successFactorsPostingIdentity(url.replace('career4.successfactors.com', 'successfactors.com.evil.test')), null);
});

test('Recruiting Marketing microdata must match both requisition ID and title', () => {
  assert.deepEqual(parseSuccessFactorsCareerPosting(career(), '53169', 'Area Sales Manager'),
    { title: 'Area Sales Manager', company: 'Mahindra & Mahindra Limited', location: 'Chennai, IN' });
  assert.equal(parseSuccessFactorsCareerPosting(career('53828'), '53169', 'Area Sales Manager'), null);
  assert.equal(parseSuccessFactorsCareerPosting(career('53169', 'Other Role'), '53169', 'Area Sales Manager'), null);
  assert.equal(parseSuccessFactorsCareerPosting(career().replace('data-company-job-code', 'unbound-code'), '53169', 'Area Sales Manager'), null);
});

test('missing metadata follows the published employer site and verifies the selected search result', async () => {
  const source = page('Other') + `<script>var logoutURL="javascript:logoutUrl('/career','https://jobs.example.com/services/security/logoutp?callback=callback');";</script>`;
  assert.equal(successFactorsCareerSite(source), 'https://jobs.example.com');
  const requests: string[] = [];
  const read = async (target: string) => {
    requests.push(target);
    return target.includes('/search/') ? '<a class="jobTitle-link" href="/job/Chennai-ASM/12345/">ASM</a>' : career();
  };
  const result = await recoverSuccessFactorsMetadata(source, url.replace('Mahindra', 'Other'), read);
  assert.equal(result?.company, 'Mahindra & Mahindra Limited');
  assert.equal(result?.location, 'Chennai, IN');
  assert.equal(requests.length, 2);
  const wrong = await recoverSuccessFactorsMetadata(source, url.replace('Mahindra', 'Other'), async target =>
    target.includes('/search/') ? '<a class="jobTitle-link" href="/job/Chennai-ASM/12345/">ASM</a>' : career('53828'));
  assert.equal(wrong?.location, undefined);
});

test('multiple search matches and unrelated external result links provide no metadata', async () => {
  const source = page('Other') + '<script>var endpoint="https://jobs.example.com/services/security/logoutp?callback=callback";</script>';
  let count = 0;
  const result = await recoverSuccessFactorsMetadata(source, url.replace('Mahindra', 'Other'), async () => {
    count++;
    return '<a class="jobTitle-link" href="/job/one/123/">one</a><a class="jobTitle-link" href="/job/two/456/">two</a>';
  });
  assert.equal(result?.company, undefined);
  assert.equal(count, 1);
});

test('disabled LinkedIn integration still publishes a verifiable inert requisition code', () => {
  const html = career().replace('<script data-company-job-code="53169-en_GB"></script>',
    '<script>var options={applyWithLinkedIn2Config:{"enabled":false,"internalId":"53169-en_GB"}};</script>');
  assert.equal(parseSuccessFactorsCareerPosting(html, '53169', 'Area Sales Manager')?.location, 'Chennai, IN');
  assert.equal(parseSuccessFactorsCareerPosting(html.replace('53169-en_GB', '53828-en_GB'), '53169', 'Area Sales Manager'), null);
});

test('Phenom JSON-LD retains exact SAP identity and rejects another requisition', () => {
  const posting = { '@type': 'JobPosting', identifier: { value: '53169' }, title: 'Area Sales Manager',
    hiringOrganization: { name: 'Mahindra' }, jobLocation: { address: { addressLocality: 'Chennai', addressCountry: 'IN' } } };
  const html = '<script type="application/ld+json">' + JSON.stringify(posting) + '</script>';
  assert.equal(parseSuccessFactorsCareerPosting(html, '53169', 'Area Sales Manager')?.location, 'Chennai, IN');
  assert.equal(parseSuccessFactorsCareerPosting(html, '53828', 'Area Sales Manager'), null);
});

test('SAP full-address microdata preserves all locations, including portals without itemprop title', () => {
  const html = career().replace('<span itemprop="title">Area Sales Manager</span>', '<h1>Area Sales Manager</h1>')
    .replace('<meta itemprop="addressLocality" content="Chennai"><meta itemprop="addressCountry" content="IN">',
      '<meta itemprop="streetAddress" content="Berlin, DE"><meta itemprop="streetAddress" content="Munich, DE">');
  assert.equal(parseSuccessFactorsCareerPosting(html, '53169', 'Area Sales Manager')?.location, 'Berlin, DE; Munich, DE');
});

test('a new SuccessFactors card requires verified employer and location while other providers keep their existing contract', () => {
  assert.throws(() => requirePublicAtsEmployer('successfactors', 'Unknown Company', 'Chennai'), /verified employer/);
  assert.throws(() => requirePublicAtsEmployer('successfactors', 'Mahindra', 'Unknown Location'), /verified posting location/);
  assert.doesNotThrow(() => requirePublicAtsEmployer('successfactors', 'Mahindra', 'Chennai'));
  assert.doesNotThrow(() => requirePublicAtsEmployer('ukg', 'Example Employer', 'Unknown Location'));
  assert.equal(successFactorsEmployerPageMatches('https://jobs.royalmailgroup.com/search/', 'https://careers.royalmailgroup.com/gb/en'), true);
  assert.equal(successFactorsEmployerPageMatches('https://jobs.royalmailgroup.com/search/', 'https://royalmailgroup.com.evil.test/'), false);
});

test('escaped XML titles compare as the same text without accepting different roles', () => {
  assert.equal(normalizedSuccessFactorsTitle('Asst Manager, M&amp;HCV'), normalizedSuccessFactorsTitle('Asst Manager, M&HCV'));
  assert.notEqual(normalizedSuccessFactorsTitle('Asst Manager, M&amp;HCV'), normalizedSuccessFactorsTitle('General Manager, M&HCV'));
  const html = career().replace('<meta itemprop="addressLocality" content="Chennai"><meta itemprop="addressCountry" content="IN">',
    '<meta itemprop="streetAddress" content="FBB, 53169">');
  assert.equal(parseSuccessFactorsCareerPosting(html, '53169', 'Area Sales Manager')?.location, undefined);
});
