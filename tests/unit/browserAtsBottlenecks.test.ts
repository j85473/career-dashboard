import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAtsReader, postingLinksFromDocuments } from '../../src/lib/browserAtsReader';
import { advanceBrowserSweep, loadBrowserSweepPage, newBrowserSweep, readBrowserSweep } from '../../src/lib/browserAtsProgress';
import { browserPostingLink, parseBrowserPosting } from '../../src/lib/browserAtsPosting';

const dz = 'https://ir-jobs.dzconnex.com/';
function dzPage(stale = false) {
    let target = 1, current = 1, waits = 0;
    const visits: string[] = [];
    const empty = { count: async () => 0, nth() { return this; }, filter() { return this; } };
    const control = { count: async () => 1, nth() { return this; }, isVisible: async () => true, isDisabled: async () => false,
        getAttribute: async () => null, click: async () => { throw Error('Resume must not replay earlier clicks'); } };
    const frame = { url: () => dz, content: async () => `<div class="section-job-results-paging"><a class="active" data-page-number="${current - 1}">${current}</a></div><a href="/job-details/manager-in-sales-jobs-${current}">Manager</a>`,
        locator: (s: string) => s === 'body' ? { innerText: async () => 'Your search resulted in: 700 positions' } : s.includes('paging-select') ? control : empty, getByRole: () => empty };
    const page = { goto: async (url: string) => { visits.push(url); target = Number(/pg-(\d+)/.exec(url)?.[1] || '1'); current = 1; waits = 0; return { status: () => 200 }; },
        url: () => dz, frames: () => [frame], waitForTimeout: async () => { waits++; if (!stale) current = target; }, close: async () => {} };
    return { context: { newPage: async () => page }, visits, get waits() { return waits; } };
}
test('DZConneX resumes page 14 directly, waits for the published active page and retains prior IDs', async () => {
    const fake = dzPage(), reader = new BrowserAtsReader(fake.context as never, async () => {});
    const saved = { ...newBrowserSweep(dz), page: 14, seen: ['1', '2'], signatures: ['old-page'], transport: 'browser-v1' as const };
    const original = JSON.stringify(saved);
    const listing = await reader.page('dzconnex', dz, 14);
    assert.deepEqual(fake.visits, [dz + '#/pg-14']);
    assert.ok(fake.waits > 0);
    assert.deepEqual(listing.links.map(l => l.id), ['14']);
    assert.equal(listing.pageNumberJump, true);
    const loaded = loadBrowserSweepPage(readBrowserSweep(JSON.parse(original), 'dzconnex', dz), listing);
    assert.deepEqual(loaded.seen, ['1', '2']);
    assert.equal(JSON.stringify(saved), original);
    assert.throws(() => advanceBrowserSweep(loaded), /every posting/);
    await reader.page('dzconnex', dz, 15);
    assert.deepEqual(fake.visits, [dz + '#/pg-14', dz + '#/pg-15']);
    await reader.close();
});
test('DZConneX refuses stale cards when the widget ignores the requested hash', async () => {
    const fake = dzPage(true), reader = new BrowserAtsReader(fake.context as never, async () => {});
    await assert.rejects(reader.page('dzconnex', dz, 14), /did not expose verifiable/);
    assert.deepEqual(fake.visits, [dz + '#/pg-14']);
    await reader.close();
});
test('DZConneX keeps the complete posting title when Read More appears later in the card', () => {
    const path = '/job-details/director-in-sales-jobs-42';
    const links = postingLinksFromDocuments('dzconnex', dz, [{ url: dz, text: '', html: `<a class="shmJobtitle" data-rel="link-job-name" href="${path}">Director, AI Product Management</a><a href="${path}">READ MORE</a>` }]);
    assert.equal(links[0].title, 'Director, AI Product Management');
    assert.equal(links[0].titleVerified, true);
});

const taleo = 'https://ansell.taleo.net/careersection/ex/jobsearch.ftl';
// Reduced from the live classic template: the DOM row ID differs from the
// public requisition number and must never become a candidate's identity.
const classic = `<div id="143736"><h3><a id="requisitionListInterface.reqTitleLinkAction.row1" href="#">Sr Manager, Procurement</a></h3>
<span id="requisitionListInterface.reqContestNumberValue.row1">30012334</span></div>
<a id="requisitionListInterface.reqTitleLinkAction.row2" href="#">Unidentified job</a>`;
test('classic Taleo title actions resolve only through the matching published requisition number', () => {
    const links = postingLinksFromDocuments('taleo', taleo, [{ url: taleo, html: classic, text: '' }]);
    assert.deepEqual(links, [{ id: '30012334', title: 'Sr Manager, Procurement', url: taleo.replace('jobsearch.ftl', 'jobdetail.ftl?job=30012334') }]);
    assert.deepEqual(postingLinksFromDocuments('taleo', taleo, [{ url: taleo.replace('/ex/', '/other/'), html: classic, text: '' }]), []);
    for (const html of [classic.replace('30012334', 'javascript:bad'), classic.replace('30012334', ''), classic.replace('reqContestNumberValue.row1', 'reqContestNumberValue.row2')])
        assert.equal(postingLinksFromDocuments('taleo', taleo, [{ url: taleo, html, text: '' }]).some(link => link.title === 'Sr Manager, Procurement'), false);
});

const description = 'Lead partner activation, training and account planning. '.repeat(12);
const detailLink = browserPostingLink('taleo', taleo, taleo.replace('jobsearch.ftl', 'jobdetail.ftl?job=30012334'), 'Sr Manager, Procurement')!;
function taleoDetail(logos: string) {
    return { url: detailLink.url, html: `${logos}<div id="requisitionDescriptionInterface.descRequisition">${description}</div>`, text: `Job Number: 30012334\n${description}` };
}
test('Taleo accepts published employer-theme logos without requiring an absent a.logo class', () => {
    for (const [name, filename] of [['UT Southwestern Medical Center', 'utsw-logo-01.svg'], ['Fox Chase Cancer Center', 'logo.png'], ['Valero Logo', 'logo_Valero.svg']]) {
        const doc = taleoDetail(`<a href="https://employer.example/"><img alt="${name}" src="/careersection/theme/61/en/theme/images/${filename}"></a><img alt="My Job Cart" src="/careersection/images/cart.gif">`);
        const parsed = parseBrowserPosting('taleo', taleo, detailLink, [doc]);
        assert.equal(parsed?.company, name.replace(/ Logo$/, ''));
        assert.ok(parsed!.description.includes(description.trim()));
    }
});
test('Taleo never substitutes social icons, tenant names, conflicting branding or another job', () => {
    for (const logos of ['', '<a><img alt="LinkedIn" src="/careersection/theme/61/images/linkedin.png"></a>', '<a><img alt="Taleo Logo" src="/careersection/theme/61/images/logo.png"></a>', '<a><img alt="Valero Logo" src="/careersection/theme/61/images/logo.png"><img alt="Other Employer Logo" src="/careersection/theme/61/images/otherlogo.png"></a>'])
        assert.equal(parseBrowserPosting('taleo', taleo, detailLink, [taleoDetail(logos)]), null);
    const valid = taleoDetail('<a class="logo"><img alt="Ansell"></a>');
    assert.equal(parseBrowserPosting('taleo', taleo, detailLink, [valid])?.company, 'Ansell');
    assert.equal(parseBrowserPosting('taleo', taleo, detailLink, [{ ...valid, text: valid.text.replace('30012334', 'OTHER') }]), null);
});
