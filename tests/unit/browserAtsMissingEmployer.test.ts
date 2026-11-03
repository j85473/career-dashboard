import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAtsHttpReader } from '../../src/lib/browserAtsHttp';
import { BrowserAtsReader } from '../../src/lib/browserAtsReader';
import { browserPostingLink, parseBrowserPosting } from '../../src/lib/browserAtsPosting';
import { advanceBrowserSweep, loadBrowserSweepPage, newBrowserSweep, readBrowserSweep, readBrowserSweepDetail, retryBrowserSweepDetails } from '../../src/lib/browserAtsProgress';
import { PublicCrawlReader } from '../../src/lib/browserAtsTransportReader';

const board = 'https://careers-example.icims.com/jobs/search?in_iframe=1';
const description = 'Manage distributor onboarding, enablement and operating reviews. '.repeat(10);
const link = (id = '42') => browserPostingLink('icims', board, `/jobs/${id}/account-manager/job`, 'Account Manager')!;
const detail = (id = '42', company?: string, body = description) => `<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting', url: link(id).url, title: 'Account Manager', description: body,
  ...(company === undefined ? {} : { hiringOrganization: { name: company } }),
  jobLocation: { address: { addressLocality: 'Minneapolis', addressRegion: 'MN', addressCountry: 'US' } },
})}</script>`;
const doc = (html: string, url = link().url) => ({ url, html, text: description });

test('missing, placeholder and vendor employer labels preserve exact postings without inventing a name', () => {
  for (const company of [undefined, '', 'UNAVAILABLE', 'Unknown Company', 'iCIMS']) {
    const job = parseBrowserPosting('icims', board, link(), [doc(detail('42', company))]);
    assert.equal(job?.company, 'Unknown Company');
    assert.equal(job?.description, description.trim());
    assert.equal(job?.location, 'Minneapolis, MN, US');
    assert.equal(job?.url, link().url);
  }
  const job = parseBrowserPosting('icims', board, link(), [doc(detail()), doc(detail('42', 'Verified Employer'))]);
  assert.equal(job?.company, 'Verified Employer', 'later frames can still supply a verified name');
  assert.equal(parseBrowserPosting('icims', board, link(), [doc(detail('43'))]), null);
  assert.equal(parseBrowserPosting('icims', board, link(), [doc(detail('42', undefined, 'Preview'))]), null);
  assert.equal(parseBrowserPosting('icims', board, { ...link(), title: '' }, [doc('<div itemprop="description">' + description + '</div>')]), null);
});

test('HTTP crawls retain unnamed postings and reach later pages without a browser handoff, including saved employer retries', async () => {
  const nextUrl = board + '&pr=1';
  const listing = (id: string, page: number) => `<title>Job Listings at UNAVAILABLE</title><ul class="iCIMS_JobsTable"><li class="iCIMS_JobCardItem"><a href="${link(id).url}"><h3>Account Manager</h3></a></li></ul>
    <div class="iCIMS_Paging"><a class="selected">Page ${page} of 2, Current Page</a>${page === 1 ? `<a href="${nextUrl}">Next page of results</a>` : '<a class="invisible">Next page of results</a>'}</div>`;
  const replies: Record<string, string> = { [board + '&ss=1']: listing('42', 1), [nextUrl]: listing('43', 2),
    [link().url + '?in_iframe=1']: detail('42', 'UNAVAILABLE'), [link('43').url + '?in_iframe=1']: detail('43', 'Verified Employer') };
  const http = new BrowserAtsHttpReader(async () => {}, async url => {
    assert.ok(url in replies, url);
    const response = new Response(replies[url]);
    Object.defineProperty(response, 'url', { value: url });
    return response;
  });
  let progress = newBrowserSweep(board);
  const reader = new PublicCrawlReader({ platform: 'icims', board, progress: () => progress, browserAllowed: false, http,
    browser: async () => { throw Error('Missing employer must not open a browser'); },
    adp: { listing: async () => { throw Error('Wrong platform'); }, detail: async () => { throw Error('Wrong platform'); } },
    cost: { httpListings: 0, httpDetails: 0, browserListings: 0, browserDetails: 0 } });
  progress = loadBrowserSweepPage(progress, await reader.listing());
  // Resume a cursor retained by the old employer-name requirement.
  progress = retryBrowserSweepDetails(readBrowserSweep({ ...progress, offset: 1,
    detailFailures: [{ id: '42', message: 'Job detail lacks a verified employer' }] }, 'icims', board));
  const retained = [];
  for (const id of ['42', '43']) {
    const job = await readBrowserSweepDetail(progress, link(id), () => reader.detail(link(id)));
    assert.ok(job);
    retained.push(job); // The worker persists this complete payload before advancing.
    progress.seen.push(id);
    progress.detailFailures = progress.detailFailures?.filter(failure => failure.id !== id);
    progress.offset++;
    assert.equal(progress.browserRequired, undefined);
    if (id === '42') {
      progress = readBrowserSweep(JSON.parse(JSON.stringify(advanceBrowserSweep(progress))), 'icims', board);
      progress = loadBrowserSweepPage(progress, await reader.listing());
    }
  }
  assert.deepEqual(retained.map(job => [job.id, job.company]), [['42', 'Unknown Company'], ['43', 'Verified Employer']]);
  assert.equal(advanceBrowserSweep(progress), null);
});

test('browser detail collection returns an unnamed complete job without waiting for branding', async () => {
  const frame = { url: () => link().url, content: async () => detail('42', 'UNAVAILABLE'), locator: () => ({ innerText: async () => description }) };
  const page = { on: () => {}, goto: async () => ({ status: () => 200 }), frames: () => [frame], url: () => link().url,
    waitForTimeout: async () => { throw Error('Missing employer must not trigger repeated browser waits'); }, close: async () => {} };
  const reader = new BrowserAtsReader({ newPage: async () => page } as never, async () => {});
  assert.equal((await reader.detail('icims', board, link()))?.company, 'Unknown Company');
  await reader.close();
});
