import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAtsReader, listingSignature, taleoResultsReady, verifiedBrowserPageEnd } from '../../src/lib/browserAtsReader';
import { advanceBrowserSweep, newBrowserSweep, readBrowserSweep, recoverTaleoBrowserSweepPage } from '../../src/lib/browserAtsProgress';
import { browserPostingLink, parseBrowserPosting } from '../../src/lib/browserAtsPosting';
const board = 'https://ieee.taleo.net/careersection/2/jobsearch.ftl';
const links = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => browserPostingLink('taleo', board, board.replace('jobsearch.ftl', 'jobdetail.ftl?job=' + (start + i)), 'Account Manager')!);

test('Taleo waits for every row in the published range and the requested page', () => {
    const doc = { url: board, html: '', text: 'Job Openings 26 - 42 of 42\nThe list of jobs has reloaded. 26 – 42 of 42. Page 2' };
    assert.equal(taleoResultsReady([doc], 11, 2), false);
    assert.equal(taleoResultsReady([doc], 17, 1), false);
    assert.equal(taleoResultsReady([doc], 17, 2), true);
});
function incrementalTaleo() {
    let current = 1, ticks = 0, scrolled = false, focused = false, scrolls = 0;
    const empty = { count: async () => 0, nth() { return this; }, filter() { return this; } };
    const ids = () => current === 1 ? links(1, 25) : links(26, ticks < 2 ? 36 : 42);
    const control = { count: async () => 1, nth() { return this; }, isVisible: async () => true, isDisabled: async () => false,
        getAttribute: async (name: string) => name === 'href' ? '#' : name === 'aria-disabled' ? String(current === 2) : null,
        scrollIntoViewIfNeeded: async () => { scrolled = true; scrolls++; }, focus: async () => { focused = true; }, press: async () => { assert.equal(scrolled, true, 'control starts below the viewport'); assert.equal(focused, true, 'an unfocused CloakBrowser press would click Next before sending Enter'); current = 2; ticks = 0; } };
    const frame = { url: () => board,
        content: async () => ids().map(link => `<a href="${link.url}" title="Account Manager">Account Manager</a>`).join('') + `<a id="next" href="#" aria-disabled="${current === 2}">Next</a>`,
        locator: (selector: string) => selector === 'body' ? { innerText: async () => `Job Openings ${current === 1 ? '1 - 25' : '26 - 42'} of 42\nPage ${current}` } : selector === 'a#next' ? control : empty,
        getByRole: () => empty };
    const page = { on: () => {}, goto: async () => ({ status: () => 200 }), frames: () => [frame], url: () => board,
        waitForTimeout: async () => { ticks++; }, close: async () => {} };
    return { context: { newPage: async () => page }, get scrolls() { return scrolls; } };
}
test('Taleo scrolls before activating pagination and does not save a half-rendered last page', async () => {
    const fake = incrementalTaleo(), reader = new BrowserAtsReader(fake.context as never, async () => {});
    const first = await reader.page('taleo', board, 1), last = await reader.page('taleo', board, 2);
    assert.equal(first.links.length, 25);
    assert.equal(last.links.length, 17);
    assert.equal(new Set([...first.links, ...last.links].map(link => link.id)).size, 42);
    assert.equal(last.next, null);
    assert.equal(last.terminal, undefined); // A final control cannot excuse missing rows from earlier pages.
    assert.equal(fake.scrolls, 1);
    await reader.close();
});
test('a saved incomplete Taleo page appends missing jobs and retains processed IDs and repair evidence', () => {
    const partial = links(26, 36), complete = links(26, 42);
    const p = { ...newBrowserSweep(board), transport: 'browser-v1' as const, page: 2, loaded: true, queue: partial, offset: 11,
        total: 42, seen: links(1, 36).map(link => link.id), signatures: ['first-page', listingSignature(partial)] };
    const original = JSON.stringify(p), signature = listingSignature(complete);
    const listing = { links: complete, next: null, total: 42, signature };
    const repaired = recoverTaleoBrowserSweepPage(p, listing);
    assert.equal(JSON.stringify(p), original);
    assert.equal(repaired.seen, p.seen);
    assert.equal(repaired.offset, 11);
    assert.deepEqual(repaired.queue.map(link => link.id), complete.map(link => link.id));
    assert.equal(repaired.pageRepairs?.[0].previousSignature, p.signatures[1]);
    assert.deepEqual(repaired.pageRepairs?.[0].addedIds, ['37', '38', '39', '40', '41', '42']);
    assert.throws(() => advanceBrowserSweep(repaired), /every posting/);
    const saved = readBrowserSweep(JSON.parse(JSON.stringify(repaired)), 'taleo', board);
    assert.equal(advanceBrowserSweep({ ...saved, offset: 17, seen: links(1, 42).map(link => link.id) }), null);
    assert.throws(() => recoverTaleoBrowserSweepPage(p, { ...listing, links: links(27, 42) }), /every saved posting/);
    assert.throws(() => recoverTaleoBrowserSweepPage({ ...p, offset: 10 }, listing), /fully processed/);
    assert.throws(() => readBrowserSweep({ ...saved, pageRepairs: [{ page: 3 }] }, 'taleo', board), /page-repair evidence/);
});
test('a missing or enabled Next and an incomplete render cannot certify the final Taleo page', () => {
    const jobs = links(26, 42), doc = { url: board, text: 'Job Openings 26 - 42 of 42\nPage 2', html: '<a id="next" aria-disabled="true">Next</a>' };
    assert.equal(verifiedBrowserPageEnd('taleo', board, [doc], 2, jobs, false), undefined);
    for (const changed of [{ ...doc, html: '' }, { ...doc, html: '<a id="next">Next</a>' }, { ...doc, text: 'Job Openings 26 - 42 of 42\nPage 1' }, { ...doc, url: board.replace('/2/', '/other/') }])
        assert.equal(verifiedBrowserPageEnd('taleo', board, [changed], 2, jobs, false), undefined);
    assert.equal(verifiedBrowserPageEnd('taleo', board, [doc], 2, jobs.slice(0, 11), false), undefined);
});
test('Taleo uses published copyright branding and the exact localized detail title and requisition', () => {
    const link = links(42, 42)[0], description = 'Lead distributor activation, onboarding and operating reviews. '.repeat(10);
    const doc = { url: link.url, text: description, html: `<span id="requisitionDescriptionInterface.reqContestNumberValue.row1">42</span><span id="requisitionDescriptionInterface.reqTitleLinkAction.row1">Published Director Title</span><div id="requisitionDescriptionInterface.descRequisition">${description}</div><div id="footer">© Mary Kay Inc.</div>` };
    const posting = parseBrowserPosting('taleo', board, link, [doc]);
    assert.equal(posting?.company, 'Mary Kay Inc.');
    assert.equal(posting?.title, 'Published Director Title');
    assert.equal(parseBrowserPosting('taleo', board, link, [{ ...doc, html: doc.html.replace('>42<', '>43<') }]), null);
    assert.equal(parseBrowserPosting('taleo', board, link, [{ ...doc, html: doc.html.replace('<div id="footer">', '<div>') }]), null);
    assert.equal(parseBrowserPosting('taleo', board, link, [{ ...doc, html: doc.html + '<footer>© Other Employer</footer>' }]), null);
});
test('a Taleo publisher outage defers immediately without interpreting it as an empty board', async () => {
    const doc = { url: () => board, content: async () => '<h1>Career Section Unavailable</h1>', locator: () => ({ innerText: async () => 'Career Section Unavailable' }) };
    const page = { on: () => {}, goto: async () => ({ status: () => 200 }), url: () => board, frames: () => [doc], close: async () => {}, waitForTimeout: async () => { throw Error('Must identify the outage without waiting for jobs'); } };
    const reader = new BrowserAtsReader({ newPage: async () => page } as never, async () => {});
    await assert.rejects(reader.page('taleo', board, 1), /temporarily unavailable; retaining progress/);
    await reader.close();
});
test('DZConneX parses the exact published detail without waiting for stalled external scripts', async () => {
    const dz = 'https://ir-jobs.dzconnex.com/', link = browserPostingLink('dzconnex', dz, dz + 'job-details/director-in-sales-jobs-42', 'Sales Director')!;
    const html = `<h2>Sales Director</h2><div class="job-description">${'Ingersoll Rand is an equal opportunity employer. Lead account growth. '.repeat(10)}</div>`;
    const page = { on: () => {}, goto: async (url: string, options: { waitUntil: string }) => { assert.equal(url, link.url); assert.equal(options.waitUntil, 'commit'); return { status: () => 200 }; },
        waitForFunction: async () => {}, url: () => link.url, frames: () => [{ url: () => link.url, content: async () => html, locator: () => ({ innerText: async () => '© 2026 Ingersoll Rand. All Rights Reserved' }) }], close: async () => {} };
    const reader = new BrowserAtsReader({ newPage: async () => page } as never, async () => {});
    const posting = await reader.detail('dzconnex', dz, link);
    assert.equal(posting?.id, '42');
    assert.equal(posting?.company, 'Ingersoll Rand');
    await reader.close();
});

test('Taleo stale totals require the exact public response, matching portal, all returned rows and disabled final Next', async () => {
    const { taleoSearchPage, taleoPageMatches } = await import('../../src/lib/browserTaleoEvidence');
    const request = { pageNo: 2, fieldData: { fields: { KEYWORD: '', LOCATION: '' }, valid: true }, filterSelectionParam: { searchFilterSelections: [{ selectedValues: [] }] }, advancedSearchFiltersSelectionParam: { searchFilterSelections: [] } };
    const url = 'https://ieee.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal=101430233';
    const returned = links(26, 36), signature = listingSignature(returned);
    const data = { careerSectionUnAvailable: false, pagingData: { currentPageNo: 2, pageSize: 25, totalCount: 42 }, requisitionList: returned.map(link => ({ contestNo: link.id })), queryString: 'f=null&s=3|D&a=null&page=2&multiline=false' };
    const evidence = taleoSearchPage(board, url, request, data)!;
    assert.ok(evidence);
    const doc = { url: board, text: 'Job Openings 26 - 42 of 42\nPage 2', html: '<script>var settings={portalNo:"101430233"};</script><a id="next" aria-disabled="true">Next</a>' };
    assert.equal(taleoResultsReady([doc], 11, 2), false);
    assert.equal(taleoPageMatches(board, [doc], returned, 2, evidence), true);
    const terminal = verifiedBrowserPageEnd('taleo', board, [doc], 2, returned, false, evidence)!;
    assert.ok(terminal);
    const saved = { ...newBrowserSweep(board), page: 2, loaded: true, queue: returned, offset: 11, total: 42, seen: links(1, 36).map(link => link.id), signatures: ['first-page', signature] };
    const repaired = recoverTaleoBrowserSweepPage(saved, { links: returned, total: 42, signature, next: null, terminal });
    assert.equal(repaired.seen, saved.seen);
    assert.equal(repaired.total, 42);
    assert.equal(advanceBrowserSweep(readBrowserSweep(JSON.parse(JSON.stringify(repaired)), 'taleo', board)), null);
    assert.throws(() => readBrowserSweep({ ...repaired, terminal: { ...terminal, publicSearchPage: { ...evidence, ids: ['wrong'] } } }, 'taleo', board), /final-page evidence/);
    assert.equal(taleoPageMatches(board, [doc], returned.slice(0, 10), 2, evidence), false);
    assert.equal(taleoPageMatches(board, [{ ...doc, html: doc.html.replace('101430233', '999') }], returned, 2, evidence), false);
    assert.equal(verifiedBrowserPageEnd('taleo', board, [{ ...doc, html: doc.html.replace('aria-disabled="true"', 'aria-disabled="false"') }], 2, returned, false, evidence), undefined);
    assert.equal(taleoSearchPage(board, url.replace('ieee.taleo.net', 'other.taleo.net'), request, data), null);
    assert.equal(taleoSearchPage(board, url, { ...request, fieldData: { valid: true, fields: { KEYWORD: 'sales' } } }, data), null);
    assert.equal(taleoSearchPage(board, url, request, { ...data, queryString: 'f=selected&a=null&page=2' }), null);
    assert.equal(taleoSearchPage(board, url, request, { ...data, requisitionList: [...data.requisitionList, data.requisitionList[0]] }), null);
});

test('verified Avature and Paycom titles survive later action links and keep uncertain cards on the detail path', async () => {
    const { postingLinksFromDocuments } = await import('../../src/lib/browserAtsReader');
    const { previewBrowserAtsListingTitle } = await import('../../src/lib/browserAtsListingFilter');
    const avature = 'https://example.avature.net/en_US/careers/SearchJobs', path = '/en_US/careers/JobDetail/Engineer/42';
    const av = postingLinksFromDocuments('avature', avature, [{ url: avature, text: '', html: `<h3 class="article__header__text__title"><a class="link_result" href="${path}">Software Engineer</a></h3><a href="${path}">Más información</a>` }]);
    assert.equal(av[0].title, 'Software Engineer');
    assert.equal(av[0].titleVerified, true);
    assert.equal(previewBrowserAtsListingTitle({ title: av[0].title, titleComplete: av[0].titleVerified }).wouldSkip, true);
    const paycom = 'https://www.paycomonline.net/v4/ats/web.php/portal/1B23FA91E160A7B33C1D2C0054C6493D/career-page', job = paycom.replace('career-page', 'jobs/42');
    const pc = postingLinksFromDocuments('paycom', paycom, [{ url: paycom, text: '', html: `<a href="${job}"><h2 data-testid="typography">Certified Medical Assistant (CMA)</h2><p>Full-time | Minnesota</p></a><a href="${job}">Apply</a>` }]);
    assert.equal(pc[0].title, 'Certified Medical Assistant (CMA)');
    assert.equal(pc[0].titleVerified, true);
    assert.equal(previewBrowserAtsListingTitle({ title: pc[0].title, titleComplete: pc[0].titleVerified }).wouldSkip, true);
    const uncertain = postingLinksFromDocuments('paycom', paycom, [{ url: paycom, text: '', html: `<a href="${job}"><h2 data-testid="typography">Sales Manager…</h2></a>` }]);
    assert.equal(previewBrowserAtsListingTitle({ title: uncertain[0].title, titleComplete: uncertain[0].titleVerified }).wouldSkip, false);
});

test('a Taleo redirect retains the job for verified routing instead of waiting on a foreign detail page', async () => {
    const link = links(42, 42)[0], foreign = 'https://careers.example.com/job/42';
    const page = { goto: async () => ({ status: () => 200 }), url: () => foreign, frames: () => [{ url: () => foreign, content: async () => '<main>New career site</main>', locator: () => ({ innerText: async () => 'New career site' }) }], close: async () => {}, waitForTimeout: async () => { throw Error('No detail polling after an unverified redirect'); } };
    const reader = new BrowserAtsReader({ newPage: async () => page } as never, async () => {});
    await assert.rejects(reader.detail('taleo', board, link), /different career site; retaining it/);
    await reader.close();
});
