import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { reviewedSuccessFactorsImageMetadata } from '../../../scripts/lib/successFactorsImageReview';
import { parseSuccessFactorsPostingHtml, parseSuccessFactorsCareerPosting, recoverSuccessFactorsMetadata,
  successFactorsPostingIdentity, successFactorsCareerSite, successFactorsEmployerPageMatches, normalizedSuccessFactorsTitle,
  successFactorsCareerPostingLinks, successFactorsStringArray } from '../successFactorsPosting';
import { requirePublicAtsEmployer } from '../jobIngestion';

const url = 'https://career4.successfactors.com/career?company=Mahindra&career_ns=job_listing&career_job_req_id=53169';
const page = (tenant = 'Mahindra', id = '53169', fields = '<b>Chennai</b> - <b>Sales</b>') => `
<style>#masthead { background-image: url('https://performancemanager4.successfactors.com/Mahindra/Mahindra%20Logo.png'); }</style>
<input id="career_company" value="${tenant}"><input id="career_job_req_id" value="${id}">
<div><div class="pagetitle"><h1>Career Opportunities: Area Sales Manager (${id})</h1></div>
<div tabindex="0">Requisition ID <b>${id}</b> - Posted <b id="postedOnDate"></b> - ${fields}</div></div>
<div class="joqReqDescription"><div class="externalPosting">Long historical description</div></div>`;
const career = (id = '53169', title = 'Area Sales Manager') => `<script data-company-job-code="${id}-en_GB"></script>
<meta itemprop="hiringOrganization" content="Mahindra &amp; Mahindra Limited"><span itemprop="title">${title}</span>
<span itemprop="jobLocation"><meta itemprop="addressLocality" content="Chennai"><meta itemprop="addressCountry" content="IN"></span>`;

test('reviewed image fields require the exact posting, title and embedded image digest', () => {
  const sourceUrl = url.replace('Mahindra', 'corporac04');
  const bytes = Buffer.from('reviewed poster fixture');
  const html = page('corporac04').replace('Long historical description', `<img src="data:image/png;base64,${bytes.toString('base64')}">`);
  const review = { postingUrl: sourceUrl, title: 'Area Sales Manager', company: 'UNIMINUTO (Corporación Universitaria Minuto de Dios)',
    imageSha256: createHash('sha256').update(bytes).digest('hex'), location: 'Mitú, Vaupés', reviewedAt: '2026-10-14',
    companyEvidence: 'Reviewed logo', locationEvidence: 'Reviewed explicit location label' };
  assert.equal(reviewedSuccessFactorsImageMetadata(html, sourceUrl, review).location, 'Mitú, Vaupés');
  assert.equal(reviewedSuccessFactorsImageMetadata(html.replace('image/png', 'image/jpeg'), sourceUrl, review).company, review.company);
  assert.throws(() => reviewedSuccessFactorsImageMetadata(html, sourceUrl, { ...review, imageSha256: '0'.repeat(64) }), /source image changed/);
  assert.throws(() => reviewedSuccessFactorsImageMetadata(html, sourceUrl, { ...review, title: 'Another Role' }), /does not identify/);
  assert.throws(() => reviewedSuccessFactorsImageMetadata(html, sourceUrl, { ...review, locationEvidence: '' }), /reviewed fields/);
  assert.throws(() => reviewedSuccessFactorsImageMetadata(page(), url, { ...review, postingUrl: url }), /does not identify/);
});

test('multi-brand primary logos identify their own hiring business without leaking to other tenants', () => {
  const html = page('colombiana').replace('Long historical description', '<img src="https://hcm19.sapsf.com/doc/custom/colombiana/AKT.png">');
  assert.equal(parseSuccessFactorsPostingHtml(html, url.replace('Mahindra', 'colombiana'))?.company, 'AKT Motos');
  assert.equal(parseSuccessFactorsPostingHtml(html.replaceAll('colombiana', 'Other'), url.replace('Mahindra', 'Other'))?.company, undefined);
  assert.equal(parseSuccessFactorsPostingHtml(html.replace('AKT.png', 'unknown.png'), url.replace('Mahindra', 'colombiana'))?.company, undefined);
});

test('an explicit Portuguese workplace list is recovered only beside its employer declaration', () => {
  const html = page('bancodepor').replace('Long historical description', '<p>O Banco de Portugal admite técnicos.</p><p>LOCAL DE TRABALHO</p><ul><li>Lisboa.</li></ul>');
  assert.equal(parseSuccessFactorsPostingHtml(html, url.replace('Mahindra', 'bancodepor'))?.location, 'Lisboa');
  assert.equal(parseSuccessFactorsPostingHtml(html.replace('O Banco de Portugal admite', 'Another organization mentions'), url.replace('Mahindra', 'bancodepor'))?.location, undefined);
});

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
    return target.includes('/search/') ? '<a class="jobTitle-link" href="/job/Chennai-ASM/12345/">Area Sales Manager</a>' : career();
  };
  const result = await recoverSuccessFactorsMetadata(source, url.replace('Mahindra', 'Other'), read);
  assert.equal(result?.company, 'Mahindra & Mahindra Limited');
  assert.equal(result?.location, 'Chennai, IN');
  assert.equal(requests.length, 2);
  const wrong = await recoverSuccessFactorsMetadata(source, url.replace('Mahindra', 'Other'), async target =>
    target.includes('/search/') ? '<a class="jobTitle-link" href="/job/Chennai-ASM/12345/">Area Sales Manager</a>' : career('53828'));
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

test('branded SAP portal paths retain named business units and filter unrelated keyword matches', () => {
  const html = '<a class="jobTitle-link" href="/SociedadesdeMediacion/job/Vigo-Manager/12345/">Area Sales Manager</a>'
    + '<a class="jobTitle-link" href="/Other/job/Other-Manager/67890/">Other Manager</a>';
  assert.deepEqual(successFactorsCareerPostingLinks(html, 'https://jobs.example.com', 'Area Sales Manager'),
    ['https://jobs.example.com/SociedadesdeMediacion/job/Vigo-Manager/12345/']);
});

test('custom SAP portals can publish the bound title in Open Graph and vary only the gender suffix', () => {
  const html = career('53169', 'Area Sales Manager (m/w/x)').replace('<span itemprop="title">Area Sales Manager (m/w/x)</span>',
    '<meta property="og:title" content="Area Sales Manager (m/w/x)">');
  assert.equal(parseSuccessFactorsCareerPosting(html, '53169', 'Area Sales Manager (m/w/d)')?.location, 'Chennai, IN');
  assert.equal(parseSuccessFactorsCareerPosting(html, '53169', 'General Sales Manager (m/w/d)'), null);
});

test('labeled SAP dropdown geography is parsed as inert strings and excludes department fields', () => {
  const controls = `<span class="jobMFieldContent" id="country" onclick="javascript:showMFieldDialog('country',['New Zealand'])">Country (1)</span>
    <span class="jobMFieldContent" id="province" onclick="javascript:showMFieldDialog('province',['Waikato'])">Location: State/ Provience (1)</span>
    <span class="jobMFieldContent" id="city" onclick="javascript:showMFieldDialog('city',['Taupo'])">Location: City (1)</span>
    <span class="jobMFieldContent" id="department" onclick="javascript:showMFieldDialog('department',['Marketing'])">Department (1)</span>`;
  const html = page('Other', '53169', controls);
  assert.equal(parseSuccessFactorsPostingHtml(html, url.replace('Mahindra', 'Other'))?.location, 'Taupo, Waikato, New Zealand');
  assert.deepEqual(successFactorsStringArray("['King\\'s Lynn','Taup\\u014d']"), ["King's Lynn", 'Taupō']);
  assert.equal(successFactorsStringArray("['Taupo',alert('execute')]"), null);
  assert.equal(successFactorsStringArray("['Taupo'];execute()"), null);
});

test('verified branded Grundfos headers require a real country before treating a bold column as geography', () => {
  const html = page('grundfosP1', '53169', '<b>United Kingdom</b> - <b>Sales</b> - <b>Manager</b> - <b>Regular</b>')
    .replace('https://performancemanager4.successfactors.com/Mahindra/Mahindra%20Logo.png',
      'http://www.grundfos.com/content/dam/Global%20Site/successfactors/Grundfos_Logo-A_neg.png');
  assert.equal(parseSuccessFactorsPostingHtml(html, url.replace('Mahindra', 'grundfosP1'))?.location, 'United Kingdom');
  assert.equal(parseSuccessFactorsPostingHtml(html.replace('United Kingdom', 'Sales Department'), url.replace('Mahindra', 'grundfosP1'))?.location, undefined);
});
