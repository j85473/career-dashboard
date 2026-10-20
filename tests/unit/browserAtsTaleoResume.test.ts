import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { BrowserAtsReader, listingSignature, taleoResultsReady } from '../../src/lib/browserAtsReader';
import { taleoClassicPage } from '../../src/lib/browserTaleoEvidence';
import { newBrowserSweep, loadBrowserSweepPage, readBrowserSweep } from '../../src/lib/browserAtsProgress';
import { BrowserSweepDeferred, taleoTurnError, browserTurnYieldAt } from '../../src/lib/browserAtsWorker';

const board = 'https://baptisthlth.taleo.net/careersection/1/jobsearch.ftl';
function classicDocument(page: number, pageSize: number, total: number, ids: number[]) {
    return { url: board, text: `Jobs - Page ${page} out of ${Math.ceil(total / pageSize)}`,
        html: `<input id="rlPager.currentPage" value="${page}"><input id="listRequisition.size" value="${pageSize}"><input id="listRequisition.nbElements" value="${total}"><span class="pagerlabel">Jobs - Page ${page} out of ${Math.ceil(total / pageSize)}</span>`
            + ids.map(id => `<a href="jobdetail.ftl?job=${id}" title="Account Manager">Account Manager</a>`).join('') };
}
function classicBrowser(size: number, total: number, mode = 'normal') {
    let current = 1, currentSize = size;
    const submissions: number[] = [], clicks: number[] = [];
    const empty = { count: async () => 0, nth() { return this; }, filter() { return this; } };
    const next = { count: async () => 1, nth() { return this; }, isVisible: async () => true, isDisabled: async () => false,
        getAttribute: async (name: string) => name === 'href' ? '#' : null,
        scrollIntoViewIfNeeded: async () => {}, focus: async () => {}, press: async () => { current++; clicks.push(current); } };
    const ids = () => Array.from({ length: Math.min(currentSize, total - (current - 1) * currentSize) - (mode === 'partial' && submissions.length ? 1 : 0) }, (_, i) =>
        ((mode === 'stale-ids' && submissions.length ? 1 : current) - 1) * currentSize + i + 1);
    const doc = () => classicDocument(current, currentSize, total, ids());
    const frame = { url: () => board, content: async () => doc().html,
        locator: (selector: string) => selector === 'body' ? { innerText: async () => doc().text } : selector === 'a#next' ? next : empty,
        getByRole: () => empty };
    const page = { on: () => {}, goto: async () => { current = 1; return { status: () => 200 }; }, frames: () => [frame], url: () => board,
        waitForTimeout: async () => {}, close: async () => {},
        evaluate: async (fn: (...args: never[]) => unknown, input: unknown) => runInNewContext(`(${fn.toString()})(input)`, {
            input, location: { href: board }, document: { querySelector: (selector: string) => {
                if (selector.includes('rlPager.currentPage')) return { value: String(current) };
                if (selector.includes('listRequisition.size')) return { value: String(currentSize) };
                if (selector.startsWith('a[onclick')) return {};
                return null;
            } }, window: { ftlPager_lock: () => true, ftlPager_prepareAndSend: (component: string, pager: string, list: string, target: number) => {
                assert.deepEqual([component, pager, list], ['requisitionListInterface', 'rlPager', 'listRequisition']);
                submissions.push(target);
                if (mode !== 'wrong-page') current = target;
                if (mode === 'changed-size') currentSize++;
            } },
        }),
    };
    return { context: { newPage: async () => page }, submissions, clicks };
}

test('classic Taleo readiness requires the requested page and all rows, including partial final pages', () => {
    const doc = classicDocument(13, 25, 377, Array.from({ length: 25 }, (_, i) => 301 + i));
    assert.deepEqual(taleoClassicPage([doc]), { page: 13, pageSize: 25, total: 377 });
    assert.equal(taleoResultsReady([doc], 25, 13), true);
    assert.equal(taleoResultsReady([doc], 25, 1), false);
    assert.equal(taleoResultsReady([doc], 24, 13), false);
    assert.equal(taleoResultsReady([classicDocument(16, 25, 377, [376, 377])], 2, 16), true);
    for (const html of [doc.html.replace('value="25"', 'value="0"'), doc.html.replace('out of 16', 'out of 15'), doc.html + '<input id="rlPager.currentPage" value="13">'])
        assert.equal(taleoResultsReady([{ ...doc, html }], 25, 13), false);
});

test('both stalled Taleo page depths resume with one public pager submission and preserve all prior work', async () => {
    for (const [target, size, total] of [[16, 10, 1603], [13, 25, 377]]) {
        const fake = classicBrowser(size, total), reader = new BrowserAtsReader(fake.context as never, async () => {});
        const saved = { ...newBrowserSweep(board), transport: 'browser-v1' as const, page: target,
            seen: Array.from({ length: (target - 1) * size }, (_, i) => String(i + 1)), signatures: Array.from({ length: target - 1 }, (_, i) => `prior-${i}`) };
        const original = JSON.stringify(saved);
        try {
            const listing = await reader.page('taleo', board, target);
            assert.equal(listing.pageNumberJump, true);
            assert.equal(listing.links.length, size);
            assert.equal(listing.links[0].id, String((target - 1) * size + 1));
            assert.deepEqual(fake.submissions, [target]);
            assert.deepEqual(fake.clicks, []);
            const loaded = readBrowserSweep(loadBrowserSweepPage(saved, listing), 'taleo', board);
            assert.deepEqual(loaded.seen, saved.seen);
            assert.deepEqual(loaded.signatures.slice(0, -1), saved.signatures);
            assert.equal(JSON.stringify(saved), original);
            assert.equal(loaded.offset, 0);
            const next = await reader.page('taleo', board, target + 1);
            assert.notEqual(listingSignature(next.links), listing.signature);
            assert.deepEqual(fake.submissions, [target, target + 1]);
        } finally { await reader.close(); }
    }
});

test('a wrong page, stale IDs, incomplete rows or changed page size cannot advance a resumed Taleo cursor', async () => {
    for (const mode of ['wrong-page', 'stale-ids', 'partial', 'changed-size']) {
        const fake = classicBrowser(10, 1603, mode), reader = new BrowserAtsReader(fake.context as never, async () => {});
        try { await assert.rejects(reader.page('taleo', board, 16), /did not verify the requested page/); }
        finally { await reader.close(); }
        assert.deepEqual(fake.submissions, [16]);
        assert.deepEqual(fake.clicks, []);
    }
});

test('Taleo no-progress budget exhaustion enters normal board backoff without changing saved work', () => {
    const before = { ...newBrowserSweep(board), page: 16, seen: ['one', 'two'], signatures: ['saved'] };
    const after = { ...structuredClone(before), transport: 'browser-v1' as const, total: 1603 };
    const original = JSON.stringify([before, after]);
    const budget = new BrowserSweepDeferred('bounded turn', true);
    const stalled = taleoTurnError(budget, false, before, after);
    assert.ok(stalled instanceof Error);
    assert.equal(stalled instanceof BrowserSweepDeferred, false, 'must use the worker failure/backoff path');
    assert.match(stalled.message, /without advancing saved progress/);
    assert.equal(browserTurnYieldAt(stalled, false), null, 'must not receive the one-second continuation delay');
    assert.equal(JSON.stringify([before, after]), original);
    for (const changed of [{ ...after, loaded: true }, { ...after, page: 17 }, { ...after, seen: [...after.seen, 'three'] }, { ...after, next: { kind: 'click' as const } }])
        assert.equal(taleoTurnError(budget, false, before, changed), budget);
    assert.equal(taleoTurnError(budget, true, before, after), budget);
    for (const error of [new BrowserSweepDeferred('operator pause or capacity'), new BrowserSweepDeferred('lost lease'), Error('publisher failure')])
        assert.equal(taleoTurnError(error, false, before, after), error);
});
