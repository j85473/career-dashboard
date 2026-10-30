import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicCrawlReader, type PublicCrawlTransportCost } from '../../src/lib/browserAtsTransportReader';
import { BrowserAtsHttpHandoff, crawlLaneCheckpoint, crawlLaneStart, publicCrawlLaneAllows, publicCrawlLaneSql } from '../../src/lib/browserAtsTransport';
import { advanceBrowserSweep, loadBrowserSweepPage, newBrowserSweep, readBrowserSweep, type BrowserSweepProgress } from '../../src/lib/browserAtsProgress';
import { browserPostingLink, type BrowserPosting } from '../../src/lib/browserAtsPosting';
import { listingSignature, type BrowserListing } from '../../src/lib/browserAtsReader';

const board = 'https://careers-example.icims.com/jobs/search?in_iframe=1';
const link = browserPostingLink('icims', board, 'https://careers-example.icims.com/jobs/42/account-manager/job', 'Account Manager')!;
const page: BrowserListing = { links: [link], next: null, total: 1, signature: listingSignature([link]) };
const detail: BrowserPosting = { ...link, company: 'Example Inc', location: 'US', description: 'Published full description. '.repeat(20) };
function reader(progress: BrowserSweepProgress, browserAllowed: boolean, httpListing: BrowserListing | null = page, httpDetail: BrowserPosting | null = detail) {
    const cost: PublicCrawlTransportCost = { httpListings: 0, httpDetails: 0, browserListings: 0, browserDetails: 0 };
    const calls: string[] = [];
    return { cost, calls, instance: new PublicCrawlReader({ platform: 'icims', board, progress: () => progress, browserAllowed, cost,
        http: { page: async () => { calls.push('http-listing'); return httpListing; }, detail: async () => { calls.push('http-detail'); return httpDetail; } },
        browser: async () => { calls.push('browser-open'); assert.equal(browserAllowed, true, 'HTTP worker must never open a browser');
            return { page: async () => { calls.push('browser-listing'); return page; }, detail: async () => { calls.push('browser-detail'); return detail; } }; },
        adp: { listing: async () => { throw Error('wrong transport'); }, detail: async () => { throw Error('wrong transport'); } },
    }) };
}

test('HTTP listing and detail complete without acquiring a browser and keep canonical IDs', async () => {
    const progress = newBrowserSweep(board), worker = reader(progress, false);
    assert.equal(publicCrawlLaneAllows('icims', 'http'), true);
    assert.equal(publicCrawlLaneAllows('icims', 'browser'), false);
    const listing = await worker.instance.listing();
    Object.assign(progress, loadBrowserSweepPage(progress, listing));
    assert.equal((await worker.instance.detail(progress.queue[0]))?.id, '42');
    assert.deepEqual(worker.calls, ['http-listing', 'http-detail']);
    assert.equal(progress.transport, 'http-v1');
    assert.deepEqual(worker.cost, { httpListings: 1, httpDetails: 1, browserListings: 0, browserDetails: 0 });
});

test('an unsupported initial listing hands off the unchanged initial position and then uses browser pagination', async () => {
    const progress = newBrowserSweep(board), before = structuredClone(progress), http = reader(progress, false, null);
    await assert.rejects(http.instance.listing(), error => error instanceof BrowserAtsHttpHandoff && error.required === 'listing');
    assert.deepEqual(progress, { ...before, browserRequired: 'listing' });
    const saved = readBrowserSweep(JSON.parse(JSON.stringify(progress)), 'icims', board);
    assert.equal(publicCrawlLaneAllows('icims', 'http', { status: 'partial', progress: saved }), false);
    assert.equal(publicCrawlLaneAllows('icims', 'browser', { status: 'partial', progress: saved }), true);
    const browser = reader(saved, true, null);
    await browser.instance.listing();
    assert.deepEqual(browser.calls, ['http-listing', 'browser-open', 'browser-listing']);
    assert.equal(saved.transport, 'browser-v1');
});

test('an unsupported HTTP detail retains every saved ID, offset and listing cursor for licensed fallback', async () => {
    const progress = { ...loadBrowserSweepPage(newBrowserSweep(board), page), transport: 'http-v1' as const };
    const before = structuredClone(progress), http = reader(progress, false, page, null);
    await assert.rejects(http.instance.detail(progress.queue[0]), error => error instanceof BrowserAtsHttpHandoff && error.required === 'detail');
    assert.deepEqual(progress, { ...before, browserRequired: 'detail' });
    const saved = readBrowserSweep(JSON.parse(JSON.stringify(progress)), 'icims', board), browser = reader(saved, true, page, null);
    assert.equal((await browser.instance.detail(saved.queue[saved.offset]))?.id, '42');
    assert.deepEqual(browser.calls, ['browser-open', 'browser-detail']);
    saved.seen.push(link.id); saved.offset++;
    assert.equal(advanceBrowserSweep(saved), null);
    assert.equal(saved.transport, 'http-v1', 'detail fallback never changes listing pagination');
    assert.equal(publicCrawlLaneAllows('icims', 'http', { status: 'succeeded', progress: saved }), true, 'a new cycle may try HTTP again');
});

test('an established HTTP listing failure retains its exact traversal for retry in either worker', async () => {
    for (const browserAllowed of [false, true]) {
        const progress = { ...newBrowserSweep(board), transport: 'http-v1' as const, page: 2, pageUrl: board + '&pr=1', seen: ['42'] };
        const before = structuredClone(progress), worker = reader(progress, browserAllowed, null);
        await assert.rejects(worker.instance.listing(), /exact traversal/);
        assert.deepEqual(progress, before);
        assert.deepEqual(worker.calls, ['http-listing']);
    }
});

test('legacy page numbers and loaded legacy queues remain under the browser owner across restart', async () => {
    for (const patch of [{ page: 3 }, { loaded: true }, { seen: ['42'] }, { transport: 'browser-v1' as const, signatures: ['saved-page'] }]) {
        const progress = { ...newBrowserSweep(board), ...patch };
        assert.equal(publicCrawlLaneAllows('icims', 'http', { status: 'partial', progress }), false);
        assert.equal(publicCrawlLaneAllows('icims', 'browser', { status: 'partial', progress }), true);
        const browser = reader(progress, true);
        await browser.instance.listing();
        assert.deepEqual(browser.calls, ['browser-open', 'browser-listing']);
    }
    assert.equal(publicCrawlLaneAllows('taleo', 'browser'), true);
    assert.throws(() => readBrowserSweep({ ...newBrowserSweep(board), browserRequired: 'unknown' }, 'icims', board), /handoff/);
});

test('SQL ownership filters preserve completed cycles, saved transport and exact handoffs without mutating them', () => {
    const http = publicCrawlLaneSql('http'), browser = publicCrawlLaneSql('browser');
    for (const query of [http, browser]) {
        assert.match(query.text, /s\.status <> 'succeeded'/);
        assert.match(query.text, /browserRequired/);
        assert.match(query.text, /browser-v1/);
        assert.ok(query.values.includes('icims') && query.values.includes('paylocity'));
        assert.doesNotMatch(query.text, /UPDATE|DELETE|INSERT/);
    }
    assert.match(http.text, /NOT COALESCE/);
    assert.equal(publicCrawlLaneSql('all').text, 'TRUE');
});

test('shared provider checkpoints retain separate fairness clocks across HTTP turns, browser turns and restarts', () => {
    const browserStart = new Date('2026-10-21T14:00:00Z'), httpStart = new Date('2026-10-21T14:20:00Z');
    const initial = { board, page: 8, processed: 140, unrelated: { preserve: true } };
    let checkpoint = crawlLaneCheckpoint(initial, 'browser', browserStart);
    for (let turn=0; turn<100; turn++) {
        checkpoint = crawlLaneCheckpoint(JSON.parse(JSON.stringify(checkpoint)), 'http', new Date(httpStart.getTime()+turn*1000));
        assert.equal(crawlLaneStart(checkpoint, 'browser')?.toISOString(), browserStart.toISOString(), 'HTTP cannot make browser fallback look recently served');
    }
    assert.deepEqual(initial, { board, page: 8, processed: 140, unrelated: { preserve: true } });
    assert.equal(checkpoint.page, 8);
    assert.deepEqual(checkpoint.unrelated, { preserve: true });
    const next = crawlLaneCheckpoint(checkpoint, 'browser', new Date('2026-10-21T14:30:00Z'));
    assert.equal(crawlLaneStart(next, 'http')?.toISOString(), crawlLaneStart(checkpoint, 'http')?.toISOString());
    for (const bad of [null, [], {}, { crawlLaneStarts: [] }, { crawlLaneStarts: { browser: 'invalid' } }]) assert.equal(crawlLaneStart(bad, 'browser'), null);
});


test('updated HTTP readers recover only untouched initial handoffs and preserve acquired browser work', async () => {
    for (const transport of [undefined, 'browser-v1'] as const) {
        const progress = { ...newBrowserSweep(board), transport, browserRequired: 'listing' as const };
        const worker = reader(progress, true);
        assert.equal(await worker.instance.listing(), page);
        assert.deepEqual(worker.calls, ['http-listing']);
        assert.equal(progress.transport, 'http-v1'); assert.equal(progress.browserRequired, undefined);
    }
    for (const patch of [{ queue: [link] }, { signatures: ['old'] }, { pageUrl: board }, { page: 2 }, { seen: ['42'] }]) {
        const progress = { ...newBrowserSweep(board), transport: 'browser-v1' as const, browserRequired: 'listing' as const, ...patch };
        const before = structuredClone(progress), worker = reader(progress, true);
        await worker.instance.listing();
        assert.deepEqual(worker.calls, ['browser-open', 'browser-listing']);
        assert.deepEqual(progress, before);
    }
});
