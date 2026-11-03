import assert from 'node:assert/strict';
import test from 'node:test';
import { browserAtsBoardFromUrl, BROWSER_ATS_PATTERNS, publicAtsWorkerPlatforms } from '../../src/lib/browserAtsBoards';
import { browserPostingLink, parseBrowserPosting, browserPostingSourceId } from '../../src/lib/browserAtsPosting';
import { paycorPublicListing } from '../../src/lib/paycorPublic';
import { paycorBoardUrl, paycorPostingUrl } from '../../src/lib/paycorIdentity';
import { BrowserAtsHttpReader } from '../../src/lib/browserAtsHttp';
import { newBrowserSweep, loadBrowserSweepPage, readBrowserSweep, advanceBrowserSweep } from '../../src/lib/browserAtsProgress';
import { PublicCrawlReader } from '../../src/lib/browserAtsTransportReader';
import { publicCrawlLaneAllows } from '../../src/lib/browserAtsTransport';
import { localCrawlPatternMatches } from '../../src/lib/localCommonCrawl';
import { identifyAts } from '../../src/lib/atsUtils';
import { boardSlugFromJobUrl } from '../../src/lib/atsBoardYield';
import { boardIdentityFromUrl } from '../../src/lib/atsDirectMatch';

const cid = '8a7883d08a24e305018a3e033608093d', other = '8a7883d084f5018f0185307964581b2d';
const id = '8a7883a8a184746e01a19cc0a0955e36', board = paycorBoardUrl(cid), url = paycorPostingUrl(cid, id);
const body = 'Manage distributor relationships, field sales training and quarterly business reviews. '.repeat(8);
const doc = (html: string, address = board) => ({ url: address, html, text: html.replace(/<[^>]+>/g, ' ') });
const row = (jobId: string) => `<div class="gnewtonCareerGroupRowClass"><div class="gnewtonCareerGroupJobTitleClass"><a href="${paycorPostingUrl(cid, jobId)}">Channel Manager</a></div><div class="gnewtonCareerGroupJobDescriptionClass">Minneapolis, MN</div></div>`;
function listing(count = 1) {
    return `<title>Careers | Example Inc</title><div id="gnewtonCareerBody"><form name="candidateHome"><input name="clientId" value="${cid}"><input name="internal" value="false"><table id="gnewtonCareerHome"><tr><td>${count ? Array.from({ length: count }, (_, i) => row(i.toString(16).padStart(32, '0'))).join('') : '<div id="gnewtonNoActiveJobs">We do not currently have any open jobs. Please check back later.</div>'}</td></tr></table></form></div>`;
}
function detail(jobId = id, company = true) {
    return `${company ? '<title>Careers | Example Inc</title>' : ''}<form id="gravityApplyJob" action="https://recruitingbypaycor.com/career/SubmitResume.action?clientId=${cid}&id=${jobId}"><table id="gnewtonJobDescription"><tr><td id="gnewtonJobPosition"><b>Position:</b> Channel Manager</td></tr><tr><td id="gnewtonJobLocationInfo">Minneapolis, MN<br>Madison, WI</td></tr><tr><td id="gnewtonJobDescriptionText"><p>${body}</p></td></tr></table></form>`;
}
const link = browserPostingLink('paycor', board, url)!;

test('Paycor and legacy Newton URLs harvest into one canonical employer and posting identity', () => {
    for (const host of ['recruitingbypaycor.com', 'newton.newtonsoftware.com']) {
        const legacy = url.replace('recruitingbypaycor.com', host) + '&source=LinkedIn';
        assert.equal(browserAtsBoardFromUrl('paycor', legacy), board);
        assert.deepEqual(browserPostingLink('paycor', board, legacy), link);
        assert.equal(boardSlugFromJobUrl(legacy, 'paycor'), board);
        assert.deepEqual(boardIdentityFromUrl(legacy), { platform: 'paycor', slug: board });
        assert.equal(identifyAts({ url: legacy }), 'Paycor');
        assert.ok(BROWSER_ATS_PATTERNS.paycor.some(pattern => localCrawlPatternMatches(pattern, legacy)));
    }
    assert.equal(identifyAts({ source: 'ATS-paycor' }), 'Paycor');
    assert.equal(browserPostingSourceId(board, link.id), browserPostingSourceId(board, id));
    assert.ok(publicAtsWorkerPlatforms(true).includes('paycor'));
    assert.equal(publicCrawlLaneAllows('paycor', 'http'), true);
    assert.equal(publicCrawlLaneAllows('paycor', 'browser'), false);
});

test('tenant ambiguity, disguised hosts, login URLs and foreign postings cannot enter discovery or the queue', () => {
    for (const bad of [board + '&clientId=' + other, board.replace(cid, 'missing'), board.replace('/CareerHome.action', '/login.action'),
        board.replace('.com/', '.com.attacker.example/'), board.replace('https://', 'https://user:pass@'), board.replace('.com/', '.com:444/'), board + '&id=bad'])
        assert.equal(browserAtsBoardFromUrl('paycor', bad), null, bad);
    for (const bad of [url.replace(cid, other), url + '&id=' + id, url.replace('https:', 'http:'), board]) {
        // HTTP discovery is allowed, but posting links always canonicalize to HTTPS.
        if (bad.startsWith('http:')) assert.equal(browserPostingLink('paycor', board, bad)?.url, url);
        else assert.equal(browserPostingLink('paycor', board, bad), null, bad);
    }
});

test('a complete Paycor catalogue verifies titles; explicit empty state is required for zero jobs', () => {
    const list = paycorPublicListing(doc(listing(2)), board)!;
    assert.equal(list.links.length, 2); assert.equal(list.links[0].titleVerified, true); assert.equal(list.total, 2); assert.equal(list.next, null);
    assert.equal(paycorPublicListing(doc(listing(0)), board)?.emptyVerified, true);
    for (const html of [listing(0).replace('gnewtonNoActiveJobs', 'loading'), listing().replace('internal" value="false', 'internal" value="true'),
        listing().replace(cid, other), listing().replace('gnewtonCareerGroupJobTitleClass', 'unknown'), listing().replace('Channel Manager</a>', '</a>'),
        listing().replace('Channel Manager</a>', `Channel Manager</a><a href="${url}">Duplicate</a>`), listing().replace(/href="[^"]+"/, 'href="https://["')])
        assert.equal(paycorPublicListing(doc(html), board), null);
    for (const address of [board + '&keyword=sales', board + '&locationName=MN', board + '&lang=es', board.replace(cid, other)])
        assert.equal(paycorPublicListing(doc(listing(), address), board), null);
});

test('Paycor details use exact application IDs, full content and all published locations; missing employer stays unknown', () => {
    const posting = parseBrowserPosting('paycor', board, link, [doc(detail(), url)])!;
    assert.equal(posting.title, 'Channel Manager'); assert.equal(posting.company, 'Example Inc');
    assert.equal(posting.location, 'Minneapolis, MN; Madison, WI'); assert.equal(posting.description, body.trim());
    assert.equal(posting.postedAt, undefined);
    assert.equal(parseBrowserPosting('paycor', board, link, [doc(detail(id, false), url)])?.company, 'Unknown Company');
    for (const [html, address] of [[detail(other), url], [detail(), url.replace(id, other)], [detail().replace(body, 'Short preview'), url],
        [detail().replace(cid, other), url], [detail().replace('gnewtonJobDescriptionText', 'loading'), url]])
        assert.equal(parseBrowserPosting('paycor', board, link, [doc(html, address)]), null);
});

test('large single-page catalogues survive persisted partial offsets without invented pagination or lost jobs', () => {
    const page = paycorPublicListing(doc(listing(1271)), board)!;
    let progress = loadBrowserSweepPage({ ...newBrowserSweep(board), transport: 'http-v1' }, page);
    progress.offset = 50; progress.seen = page.links.slice(0, 50).map(link => link.id);
    progress = readBrowserSweep(JSON.parse(JSON.stringify(progress)), 'paycor', board);
    assert.equal(progress.queue.length, 1271); assert.equal(progress.offset, 50); assert.equal(progress.queue[50].id, (50).toString(16).padStart(32, '0'));
    assert.throws(() => advanceBrowserSweep(progress), /every posting/);
    progress.offset = page.links.length; progress.seen = page.links.map(link => link.id);
    assert.equal(advanceBrowserSweep(progress), null);
});

test('the public HTTP lane fetches Paycor listings and full details without acquiring the browser seat', async () => {
    const calls: string[] = [];
    const http = new BrowserAtsHttpReader(async () => {}, async (target) => {
        calls.push(target); return new Response(target === board ? listing() : detail('0'.repeat(32)));
    });
    let progress = newBrowserSweep(board);
    const cost = { httpListings: 0, httpDetails: 0, browserListings: 0, browserDetails: 0 };
    const reader = new PublicCrawlReader({ platform: 'paycor', board, progress: () => progress, browserAllowed: false, http, cost,
        browser: async () => { throw Error('must not launch a browser'); }, adp: { listing: async () => { throw Error('wrong provider'); }, detail: async () => null } });
    progress = loadBrowserSweepPage(progress, await reader.listing());
    assert.equal((await reader.detail(progress.queue[0]))?.company, 'Example Inc');
    assert.deepEqual(cost, { httpListings: 1, httpDetails: 1, browserListings: 0, browserDetails: 0 });
    assert.equal(calls.length, 2);
});

test('refusal, filtered redirects and shells hand off without claiming completion or losing offsets', async () => {
    for (const reply of [new Response('Forbidden', { status: 403 }), new Response('<html>Loading</html>'),
        Object.defineProperty(new Response(listing()), 'url', { value: board + '&keyword=sales' })]) {
        const http = new BrowserAtsHttpReader(async () => {}, async () => reply);
        const progress = newBrowserSweep(board);
        const reader = new PublicCrawlReader({ platform: 'paycor', board, progress: () => progress, browserAllowed: false, http,
            cost: { httpListings: 0, httpDetails: 0, browserListings: 0, browserDetails: 0 }, browser: async () => { throw Error('forbidden'); },
            adp: { listing: async () => { throw Error('wrong provider'); }, detail: async () => null } });
        await assert.rejects(reader.listing(), /needs browser verification/);
        assert.equal(progress.loaded, false); assert.deepEqual(progress.seen, []); assert.equal(progress.offset, 0);
        assert.equal(publicCrawlLaneAllows('paycor', 'browser', { status: 'partial', progress }), true);
    }
});
