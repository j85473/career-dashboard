import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPostingEvidenceError, browserPostingLink, cleanBrowserHtml, parseBrowserPosting } from '../../src/lib/browserAtsPosting';
import { verifiedEmptyBoard, listingSignature } from '../../src/lib/browserAtsReader';
import { advanceBrowserSweep, loadBrowserSweepPage, newBrowserSweep, readBrowserSweep, readBrowserSweepDetail, retryBrowserSweepDetails } from '../../src/lib/browserAtsProgress';
import { BrowserAtsHttpHandoff, BrowserSweepDeferred } from '../../src/lib/browserAtsTransport';

const description = 'Lead distributor activation, enablement and operating reviews. '.repeat(12);
const fresh = 'https://example.freshteam.com/jobs';
const freshLink = browserPostingLink('freshteam', fresh, '/jobs/abc42/account-manager', 'A whole listing card with location and preview')!;
function freshDetail() {
  // Reduced from the Payatu and Kuwait Steel public templates: their JSON-LD
  // uses a custom host while the application still belongs to this tenant.
  return `<a class="navbar-brand" href="https://careers.example.com"></a><h1>Account Manager</h1>
    <form name="applicant_form" action="/jobs/abc42/applicants"></form>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url: 'https://careers.example.com/jobs/abc42/Account%20Manager', title: 'Account Manager', hiringOrganization: { name: 'Example Inc' }, description: '&lt;div&gt;' + description + '&lt;/div&gt;' })}</script>`;
}
test('Freshteam binds custom-domain JSON-LD to tenant branding, exact requisition and application form', () => {
  const doc = { url: freshLink.url, html: freshDetail(), text: description };
  const result = parseBrowserPosting('freshteam', fresh, freshLink, [doc])!;
  assert.equal(result.company, 'Example Inc');
  assert.equal(result.title, 'Account Manager');
  assert.equal(result.description, description.trim());
  assert.equal(result.url, freshLink.url);
  for (const html of [doc.html.replace('jobs/abc42/Account', 'jobs/other/Account'),
    doc.html.replace('class="navbar-brand"', 'class="unrelated"'),
    doc.html.replace('action="/jobs/abc42/applicants"', 'action="https://foreign.example/jobs/abc42/applicants"'),
    doc.html.replace('<h1>Account Manager</h1>', '<h1>Different role</h1>'),
    doc.html.replace('https://careers.example.com/jobs/', 'https://elsewhere.example/jobs/')]) {
    assert.equal(parseBrowserPosting('freshteam', fresh, freshLink, [{ ...doc, html }]), null);
  }
});
test('encoded markup cannot inflate a short description or survive as executable content', () => {
  assert.equal(cleanBrowserHtml('&lt;div&gt;Short&lt;/div&gt;&lt;script&gt;bad()&lt;/script&gt;'), 'Short');
  assert.equal(parseBrowserPosting('freshteam', fresh, freshLink, [{ url: freshLink.url, html: freshDetail().replace(description, 'Too short'), text: '' }]), null);
});

const empty = { url: fresh, text: 'Open Positions\nNo jobs found\nOops, you have no jobs that match the filter conditions.',
  html: `<a class="navbar-brand" href="${fresh}">Example Careers</a><input name="query"><div data-portal-id="jobs_list"><div data-portal-id="job-role-list"><ul></ul></div></div><div data-portal-id="no_data"><div class="not-found-title">No jobs found</div></div>` };
test('Freshteam recognizes the branded unfiltered empty template without accepting filtered, loading or foreign pages', () => {
  assert.equal(verifiedEmptyBoard('freshteam', [empty], fresh), true);
  for (const doc of [{ ...empty, url: fresh + '?query=sales' }, { ...empty, text: 'Loading' },
    { ...empty, html: empty.html.replace('name="query"', 'name="query" value="sales"') },
    { ...empty, html: empty.html + '<input type="checkbox" checked>' },
    { ...empty, html: empty.html.replace('href="' + fresh + '"', 'href="https://foreign.freshteam.com/jobs"') },
    { ...empty, html: empty.html.replace('href="' + fresh + '"', 'href="https://["') },
    { ...empty, html: empty.html + `<a href="${freshLink.url}">Account Manager</a>` }]) assert.equal(verifiedEmptyBoard('freshteam', [doc], fresh), false);
});

test('Paylocity reads employer branding outside header, dedicated posting title and published location', () => {
  const board = 'https://recruiting.paylocity.com/recruiting/jobs/All/04649b85-784b-4f5e-ad10-61c5be60bddb';
  const link = browserPostingLink('paylocity', board, '/Recruiting/Jobs/Details/4233861')!;
  const html = `<title>NRP Jones LLC - Utility Operator</title><div class="header-title"><h2 id="LayoutLogoName">NRP Jones LLC</h2></div><div class="job-preview-header"><span class="job-preview-title"><span>Utility Operator</span></span><div class="preview-location">LAPORTE, IN</div></div><div class="job-preview-details">${description}</div>`;
  const result = parseBrowserPosting('paylocity', board, link, [{ url: link.url, html, text: description }])!;
  assert.equal(result.company, 'NRP Jones LLC');
  assert.equal(result.title, 'Utility Operator');
  assert.equal(result.location, 'LAPORTE, IN');
});
test('SageHR retains an already verified structured employer when optional legacy branding is absent', () => {
  const board = 'https://talent.sage.hr/9a33aaab-d136-417d-be2a-de08c2ecf1a3/vacancies';
  const link = browserPostingLink('sagehr', board, '/jobs/0767d687-1b78-4240-b2c2-0356bc0ea108', 'Account Manager')!;
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url: link.url, title: link.title, hiringOrganization: { name: 'Example Inc' }, description })}</script>`;
  assert.equal(parseBrowserPosting('sagehr', board, link, [{ url: link.url, html, text: description }])?.company, 'Example Inc');
});

test('an unverifiable detail cannot block other jobs on its page or silently complete the crawl', async () => {
  const links = ['42', '43', '44'].map(id => browserPostingLink('freshteam', fresh, `/jobs/${id}/account-manager`, 'Account Manager')!);
  let progress = loadBrowserSweepPage(newBrowserSweep(fresh), { links, signature: listingSignature(links), next: { kind: 'click' }, total: 4 });
  const good = { ...links[1], company: 'Example Inc', description, location: 'US' };
  assert.equal(await readBrowserSweepDetail(progress, links[0], async () => { throw new BrowserPostingEvidenceError('Missing full description'); }), undefined);
  progress.offset++;
  for (const link of links.slice(1)) {
    assert.ok(await readBrowserSweepDetail(progress, link, async () => ({ ...good, ...link })));
    progress.seen.push(link.id); progress.offset++;
  }
  assert.deepEqual(progress.seen, ['43', '44']);
  assert.throws(() => advanceBrowserSweep(progress), /every failed posting for retry/);
  assert.throws(() => advanceBrowserSweep({ ...progress, next: null }), /every failed posting for retry/);
  assert.throws(() => loadBrowserSweepPage(progress, { links: [], signature: 'new', total: 0, next: null }), /unresolved detail retries/);
  const saved = JSON.stringify(progress);
  progress = retryBrowserSweepDetails(readBrowserSweep(JSON.parse(saved), 'freshteam', fresh));
  assert.equal(progress.offset, 0);
  assert.deepEqual(progress.detailFailures, [{ id: '42', message: 'Missing full description' }]);
  assert.deepEqual(progress.next, { kind: 'click' });
  assert.deepEqual(progress.seen, ['43', '44']);
  assert.ok(await readBrowserSweepDetail(progress, links[0], async () => ({ ...good, ...links[0] })));
  progress.seen.push('42'); progress.detailFailures = []; progress.offset = 3;
  assert.equal(advanceBrowserSweep(progress)?.page, 2);
  assert.equal(retryBrowserSweepDetails({ ...progress, offset: 1 }).offset, 1, 'unfinished page resumes before retrying earlier failed details');
  for (const detailFailures of [[{ id: 'foreign', message: 'bad' }], [{ id: '42', message: 'bad' }]]) {
    assert.throws(() => readBrowserSweep({ ...progress, detailFailures }, 'freshteam', fresh), /Invalid saved detail retries/);
  }
});
test('detail isolation propagates handoffs, shutdowns, transport failures and database failures without changing progress', async () => {
  for (const error of [new BrowserAtsHttpHandoff('detail'), new BrowserSweepDeferred('lease lost'), new Error('HTTP 429'), new Error('Transaction failure')]) {
    const p = newBrowserSweep(fresh), before = structuredClone(p);
    await assert.rejects(readBrowserSweepDetail(p, freshLink, async () => { throw error; }), e => e === error);
    assert.deepEqual(p, before);
  }
});
