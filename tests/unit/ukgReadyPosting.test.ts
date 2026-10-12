import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fetchUkgReadyOpenings, fetchUkgReadyPosting, parseUkgReadyPosting } from '../../src/lib/ukgReadyPosting';
import { ukgReadyApiUrl, ukgReadyJobUrl, ukgReadyPage } from '../../src/lib/ukgReadyUrl';
import { generatePostingIdentity } from '../../src/lib/jobIngestion';
import { urlPostingIdentity } from '../../src/lib/jobUrlReconciliation';
import { assessJobDescriptionQuality } from '../../src/lib/jobDescriptionQuality';
import { CareersListingPageError, looksLikeCareersListingPage } from '../../src/lib/careersListingPage';
import { readManualImportPage } from '../../src/lib/manualImportPage';

const board = 'https://secure7.saashr.com/ta/6205439.careers?CareersSearch=&InFrameset=1&HostedBy=www.marketperformancegroup.com&lang=en-US#';
const detailUrl = ukgReadyJobUrl(board, '638037848');
const detail = JSON.parse(readFileSync(new URL('../fixtures/ukg-ready/mpg-ahold.json', import.meta.url), 'utf8'));

test('UKG Ready distinguishes tenant careers pages from ShowJob, ApplyToJob and login links', () => {
  assert.deepEqual(ukgReadyPage(board), { host: 'secure7.saashr.com', tenant: '6205439', jobId: null });
  for (const key of ['ShowJob', 'showjob', 'ApplyToJob', 'jobid']) {
    assert.equal(ukgReadyPage(`https://secure7.saashr.com/ta/6205439.jobs?${key}=638037848`)?.jobId, '638037848');
  }
  for (const url of ['https://secure7.saashr.com.evil.test/ta/6205439.careers?ShowJob=1', 'https://example.com/ta/6205439.careers?ShowJob=1', 'https://secure7.saashr.com/unrelated?ShowJob=1']) assert.equal(ukgReadyPage(url), null);
  for (const query of ['ShowJob=', 'ShowJob=1&ShowJob=2', 'ShowJob=1&jobid=2', 'ShowJob=../1', 'ShowJob=1e2']) {
    assert.throws(() => ukgReadyPage(`https://secure7.saashr.com/ta/6205439.careers?${query}`), /invalid or conflicting/);
  }
});

test('posting identities are stable across link variants and distinct across jobs, tenants and hosts', () => {
  const identity = generatePostingIdentity({ url: detailUrl });
  assert.ok(identity);
  assert.equal(urlPostingIdentity(detailUrl), identity);
  assert.equal(urlPostingIdentity(board), null);
  assert.equal(identity, generatePostingIdentity({ url: 'https://secure7.saashr.com/ta/6205439.jobs?ApplyToJob=638037848' }));
  for (const url of [detailUrl.replace('638037848', '638037847'), detailUrl.replace('6205439', '6205440'), detailUrl.replace('secure7', 'secure8')]) assert.notEqual(identity, generatePostingIdentity({ url }));
  assert.equal(generatePostingIdentity({ url: board }), null);
});

test('the MPG reproduction reads one complete role, its authored employer, remote location and salary text', () => {
  const posting = parseUkgReadyPosting(detail, detailUrl, { comp_name: 'Different parent brand' });
  assert.equal(posting?.title, 'Ahold Sales Manager');
  assert.equal(posting?.company, 'Market Performance Group');
  assert.equal(posting?.location, 'Remote');
  assert.match(posting!.text, /Key Responsibilities/);
  assert.match(posting!.text, /\$110,000 - \$140,000 annually/);
  assert.doesNotMatch(posting!.text, /East Coast Sales Manager|21 jobs|<div/);
  assert.equal(assessJobDescriptionQuality(posting!.text, { structuredSource: true }).scorable, true);
  assert.equal(parseUkgReadyPosting(detail, detailUrl.replace('638037848', '638037847')), null);
  assert.equal(parseUkgReadyPosting(detail, board), null);
});

test('Ready preserves remote residency restrictions and separate qualifications without using the office location', () => {
  const posting = parseUkgReadyPosting({ ...detail, selected_loc_value_for_cp_display: 'Remote - MN, United States', job_requirement: '<p>Qualifications: Five years of account management.</p>' }, detailUrl);
  assert.equal(posting?.location, 'Remote - MN, United States');
  assert.match(posting!.text, /Five years of account management/);
  const onsite = parseUkgReadyPosting({ ...detail, is_remote_job: false }, detailUrl);
  assert.equal(onsite?.location, 'Holmdel, NJ, USA');
});

test('employer recovery accepts explicit board branding, refuses client mentions, and never falls back to the SaaShr hostname', () => {
  const data = { ...detail, job_description: '<p>Work with Market Performance Group and our clients.</p><h2>About our clients</h2><p>Other Company is a leading agency.</p>' };
  assert.equal(parseUkgReadyPosting(data, detailUrl)?.company, undefined);
  assert.equal(parseUkgReadyPosting(data, detailUrl, { comp_name: 'Hiring Company' })?.company, 'Hiring Company');
  assert.equal(parseUkgReadyPosting(data, detailUrl, { company: { name: 'Named Legal Employer' } })?.company, 'Named Legal Employer');
});

test('Ready fetches only the requested detail and refuses a mismatched ID before employer lookup', async () => {
  const requests: string[] = [];
  const posting = await fetchUkgReadyPosting(detailUrl, async url => {
    requests.push(url);
    return url.includes('/job-requisitions/') ? detail : { comp_name: '' };
  });
  assert.equal(posting?.company, 'Market Performance Group');
  assert.equal(requests.length, 2);
  assert.match(requests[0], /\/job-requisitions\/638037848\?/);
  assert.match(requests[0], /showMap=1/);
  let reads = 0;
  assert.equal(await fetchUkgReadyPosting(detailUrl, async () => { reads++; return { ...detail, id: 638037847 }; }), null);
  assert.equal(reads, 1);
  await assert.rejects(() => fetchUkgReadyPosting(detailUrl, async () => { throw new Error('blocked'); }), /blocked/);
  assert.equal(await fetchUkgReadyPosting(board, async () => assert.fail('No role was selected')), null);
});

test('a careers URL returns selectable postings, never a concatenated description or an automatically chosen role', async () => {
  const selection = await fetchUkgReadyOpenings(board, 1, async url => {
    assert.equal(new URL(url).origin, 'https://secure7.saashr.com');
    assert.equal(new URL(url).searchParams.get('size'), '100');
    return { job_requisitions: [detail, { ...detail, id: 638037847, job_title: 'East Coast Sales Manager' }], _paging: { offset: 1, size: 100, total: 2 } };
  });
  assert.equal(selection.kind, 'choose_opening');
  assert.equal(selection.total, 2);
  assert.equal(selection.jobs.length, 2);
  assert.equal(selection.jobs[0].location, 'Remote');
  assert.equal(selection.jobs[0].url, detailUrl);
  assert.equal('description' in selection.jobs[0], false);
  assert.equal(selection.hasMore, false);
  assert.notEqual(selection.jobs[0].url, selection.jobs[1].url);
});

test('large careers boards expose bounded pagination; invalid IDs, pagination and responses fail closed', async () => {
  const selection = await fetchUkgReadyOpenings(board, 2, async url => {
    assert.equal(new URL(url).searchParams.get('offset'), '2');
    return { job_requisitions: Array.from({ length: 100 }, (_, index) => ({ ...detail, id: 638037848 + index })), _paging: { offset: 2, size: 100, total: 201 } };
  });
  assert.equal(selection.hasMore, true);
  for (const result of [{}, { job_requisitions: [{ id: '../oops', job_title: 'Role' }] }, { job_requisitions: [detail, detail] }, { job_requisitions: [detail], _paging: { offset: 1, size: 20, total: 21 } }]) {
    await assert.rejects(() => fetchUkgReadyOpenings(board, 1, async () => result));
  }
  await assert.rejects(() => fetchUkgReadyOpenings(detailUrl, 1, async () => assert.fail()));
  await assert.rejects(() => fetchUkgReadyOpenings(board, 0, async () => assert.fail()));
  await assert.rejects(() => fetchUkgReadyOpenings(board, 1, async () => ({ job_requisitions: [detail], _paging: { offset: 1, size: 100, total: 21 } })), /incomplete page/);
  assert.match(ukgReadyApiUrl(board, 'job-requisitions'), /\/ta\/rest\/ui\/recruitment\/companies\/%7C6205439\/job-requisitions/);
});

test('an authored subsidiary introduction does not become a parenthetical or punctuation-filled employer label', () => {
  const data = { ...detail, job_description: '<p>About CPG by MPG</p><p>The Creative Partners Group (The CPG), by MPG, is a comprehensive retail solutions company.</p>' };
  assert.equal(parseUkgReadyPosting(data, detailUrl)?.company, 'The Creative Partners Group');
});

test('long careers results are rejected at import without rejecting a long complete JD', async () => {
  const listing = 'Title: 6205439:Career Search\nMarkdown Content:\n## 21 jobs: All locations\nSort by newest\nPage 1 of 2\n1 - 20 of 21 Rows\n' + 'Ahold Sales Manager Apply Remote company summary...\n'.repeat(100);
  assert.equal(looksLikeCareersListingPage(listing), true);
  assert.equal(looksLikeCareersListingPage(parseUkgReadyPosting(detail, detailUrl)!.text), false);
  assert.equal(looksLikeCareersListingPage('We manage 21 jobs: customer accounts. Search results improve our work.'), false);
  const html = '<title>Career Search</title><a href="?ShowJob=1">One</a><a href="?ShowJob=2">Two</a>';
  await assert.rejects(() => readManualImportPage({ html, url: 'https://example.com/careers' }, async () => assert.fail('A results page must not reach title inference')), CareersListingPageError);
});
