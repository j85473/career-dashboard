import {atsAuthFailureIsPlatformWide,atsResponseSchemaFailureIsPlatformWide} from '../../src/lib/atsUtils';
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPostingLink, browserPostingSourceId, parseBrowserPosting, structuredBrowserLocation } from '../../src/lib/browserAtsPosting';
import { newBrowserSweep, readBrowserSweep, loadBrowserSweepPage, advanceBrowserSweep } from '../../src/lib/browserAtsProgress';
import { listingSignature, listingTotal, postingLinksFromDocuments } from '../../src/lib/browserAtsReader';
import { browserPauseActive } from '../../src/lib/browserAtsWorker';
import { canonicalIngestionTaskDefinitions } from '../../src/lib/ingestionTaskCatalog';
import { BROWSER_ATS_PLATFORMS } from '../../src/lib/browserAtsBoards';
const board = 'https://careers-example.icims.com/jobs/search?in_iframe=1';
const link = browserPostingLink('icims', board, 'https://careers-example.icims.com/jobs/42/account-manager/job', 'Account Manager')!;
const description = 'Manage distributor onboarding, enablement and operating reviews. '.repeat(10);
const html = (url: string, company = 'Example Inc') => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Account Manager', hiringOrganization: { name: company }, description, jobLocation: [{ address: { addressLocality: 'Minneapolis', addressRegion: 'MN', addressCountry: 'US' } }] })}</script>`;
test('Detail matches requisition identity across iframe/canonical slug variants, and rejects a different job', () => {
    const doc = { url: 'https://careers-example.icims.com/jobs/42/job?in_iframe=1', html: html(link.url), text: description };
    assert.equal(parseBrowserPosting('icims', board, link, [doc])?.company, 'Example Inc');
    assert.equal(parseBrowserPosting('icims', board, link, [{ ...doc, html: html('https://careers-example.icims.com/jobs/43/other/job') }]), null);
    assert.equal(parseBrowserPosting('icims', board, link, [{ ...doc, html: html(link.url, 'Unknown') }]), null);
});
test('Tenant and posting identities reject off-host links and distinguish duplicate vendor requisition numbers', () => {
    assert.equal(browserPostingLink('icims', board, 'https://elsewhere.icims.com/jobs/42/job'), null);
    assert.equal(browserPostingLink('icims', board, 'http://127.0.0.1/jobs/42/job'), null);
    assert.notEqual(browserPostingSourceId(board, '42'), browserPostingSourceId('https://careers-other.icims.com/jobs/search?in_iframe=1', '42'));
    assert.equal(browserPostingLink('icims', board, link.url + '?tracking=one')?.id, '42');
});
test('Location extraction retains every place, country-only entry, and explicit applicant restriction', () => {
    const location = structuredBrowserLocation({ jobLocation: [{ address: { addressLocality: 'Minneapolis', addressRegion: 'MN', addressCountry: 'US' } }, { address: { addressCountry: { name: 'Canada' } } }], applicantLocationRequirements: [{ name: 'United States' }] });
    assert.equal(location, 'Minneapolis, MN, US; Canada; United States');
});
test('Malformed and mailto anchors cannot erase valid job links or become postings', () => {
    const docs = [{ url: board, text: '', html: `<a href="https://[">Broken</a><a href="mailto:x@example.com?body=${link.url}">Email</a><a href="${link.url}">Account Manager</a>` }];
    assert.deepEqual(postingLinksFromDocuments('icims', board, docs), [link]);
});
test('A partial job queue survives serialization and cannot be skipped by pagination', () => {
    const listing = { links: [link], signature: listingSignature([link]), next: { kind: 'click' as const }, total: 2 };
    const progress = loadBrowserSweepPage(newBrowserSweep(board), listing);
    assert.throws(() => advanceBrowserSweep(progress), /every posting/);
    assert.deepEqual(readBrowserSweep(JSON.parse(JSON.stringify(progress)), 'icims', board), progress);
    progress.offset = 1;
    progress.seen.push(link.id);
    const next = advanceBrowserSweep(progress)!;
    assert.equal(next.page, 2);
    assert.deepEqual(next.seen, ['42']);
    assert.equal(next.loaded, false);
    assert.throws(() => loadBrowserSweepPage(next, listing), /repeated/);
    assert.equal(next.page, 2);
});
test('A missing next control cannot declare an incomplete advertised catalogue complete', () => {
    const p = loadBrowserSweepPage(newBrowserSweep(board), { links: [link], signature: 'one', next: null, total: 2 });
    p.offset = 1;
    p.seen = ['42'];
    assert.throws(() => advanceBrowserSweep(p), /1 of 2/);
    p.total = 1;
    assert.equal(advanceBrowserSweep(p), null);
});
test('Corrupt or foreign saved cursor cannot reset or fetch a different employer', () => {
    const p = newBrowserSweep(board);
    assert.throws(() => readBrowserSweep({ ...p, board: 'https://other.icims.com/jobs/search' }, 'icims', board), /Invalid durable/);
    assert.throws(() => readBrowserSweep({ ...p, queue: [{ ...link, url: 'https://localhost/jobs/42/job' }] }, 'icims', board), /escaped/);
});
test('Published totals parse the live Avature, Taleo, Paylocity and Talemetry families', () => {
    for (const [text, total] of [['1-6 of 391 results', 391], ['Job Openings 1 - 25 of 86', 86], ['5 of 5 Job Opportunities', 5], ['Viewing 1-25 of 1355 results', 1355]])
        assert.equal(listingTotal(text as string), total);
    assert.equal(listingTotal('999+ results'), null);
});
test('All public-board tasks are owned separately from API acquisition', () => {
    const tasks = canonicalIngestionTaskDefinitions();
    const browser = tasks.filter(t => t.spec.ingestionMode === 'public-board');
    assert.equal(browser.length, BROWSER_ATS_PLATFORMS.length);
    for (const p of BROWSER_ATS_PLATFORMS)
        assert.equal(browser.filter(t => t.spec.source === `ATS-${p}`).length, 1);
});
test('Indefinite and future operator pauses block collection; expired pauses do not', () => {
    const now = new Date('2026-10-17T22:00:00Z');
    assert.equal(browserPauseActive({ schedulePaused: true, pausedUntil: null }, now), true);
    assert.equal(browserPauseActive({ schedulePaused: true, pausedUntil: new Date(now.getTime() + 1000) }, now), true);
    assert.equal(browserPauseActive({ schedulePaused: true, pausedUntil: new Date(now.getTime() - 1000) }, now), false);
});


test('one anonymous employer board cannot turn an auth or schema refusal into a platform-wide outage',()=>{
 for(const platform of BROWSER_ATS_PLATFORMS){assert.equal(atsAuthFailureIsPlatformWide(platform),false);assert.equal(atsResponseSchemaFailureIsPlatformWide(platform),false);}
 assert.equal(atsAuthFailureIsPlatformWide('greenhouse'),true);
});
