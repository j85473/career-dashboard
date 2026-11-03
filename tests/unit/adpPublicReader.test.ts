import assert from 'node:assert/strict';
import test from 'node:test';
import { AdpPublicReader, adpEmployerWebsite } from '../../src/lib/adpPublicReader';
import { browserPostingLink } from '../../src/lib/browserAtsPosting';
import { advanceBrowserSweep, loadBrowserSweepPage, newBrowserSweep } from '../../src/lib/browserAtsProgress';
import { listingSignature } from '../../src/lib/browserAtsReader';

const board = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=9a5ec45e-a62c-458e-8186-85ca84bee0b2&ccId=19000101_000001&lang=en_US';
const site = 'https://www.employer.example/';
const description = 'Manage partner training and operating reviews. '.repeat(20);
const job = (id: string) => ({ requisitionTitle: 'Partner Manager', requisitionDescription: description,
    customFieldGroup: { stringFields: [{ nameCode: { codeValue: 'ExternalJobID' }, stringValue: id }] } });
const link = (id = '42') => browserPostingLink('adp', board, board + '&jobId=' + id, 'Partner Manager')!;
const center = (sites = [site], published = true) => ({
    contentLinks: sites.map(href => ({ linkTypeCode: { codeValue: 'LINKS-BRND' }, contentBody: { links: [{ href: encodeURIComponent(href) }] } })),
    meta: { customFieldGroup: { indicatorFields: [{ nameCode: { codeValue: 'PublishedIndicator' }, indicatorValue: published }] } },
});
const client = { meta: { customFieldGroup: { stringFields: [
    { nameCode: { codeValue: 'CLIENT_NAME' }, stringValue: '' },
    { nameCode: { codeValue: 'CLIENT_ID' }, stringValue: 'opaque-infrastructure-token' },
] } } };

function harness(options: { total?: number; jobs?: unknown[]; center?: unknown; company?: string; siteHtml?: string; siteLanded?: string; redirectJson?: boolean; description?: string } = {}) {
    const calls: string[] = [];
    const reader = new AdpPublicReader(board, async () => {}, async target => {
        calls.push(target);
        const url = new URL(target);
        if (url.origin === new URL(site).origin) {
            const response = new Response(options.siteHtml ?? '<meta property="og:site_name" content="Verified Employer">');
            Object.defineProperty(response, 'url', { value: options.siteLanded || site });
            return response;
        }
        assert.equal(url.origin, new URL(board).origin);
        assert.equal(url.searchParams.get('cid'), new URL(board).searchParams.get('cid'));
        assert.equal(url.searchParams.get('ccId'), '19000101_000001');
        let body: unknown;
        if (url.pathname.endsWith('client-features')) {
            assert.equal(url.searchParams.get('jobId'), '42');
            body = options.company ? { meta: { customFieldGroup: { stringFields: [
                { nameCode: { codeValue: 'ClientName' }, stringValue: options.company },
            ] } } } : client;
        } else if (url.pathname.endsWith('career-center')) body = options.center ?? center();
        else if (url.pathname.endsWith('/job-requisitions')) body = { jobRequisitions: options.jobs ?? [], meta: { totalNumber: options.total ?? 0 } };
        else body = { ...job(url.pathname.split('/').at(-1)!), ...(options.description ? { requisitionDescription: options.description } : {}) };
        const response = Response.json(body);
        Object.defineProperty(response, 'url', { value: options.redirectJson ? 'https://other.example/metadata' : target });
        return response;
    });
    return { reader, calls };
}

test('ADP recovers a named employer from its published corporate website and shares the lookup across a turn', async () => {
    const { reader, calls } = harness();
    for (const id of ['42', '43']) {
        const result = await reader.detail(link(id));
        assert.equal(result.company, 'Verified Employer');
        assert.equal(result.description, description.trim());
        assert.equal(result.id, id);
    }
    assert.equal(calls.filter(url => url.includes('client-features')).length, 1);
    assert.equal(calls.filter(url => url.includes('career-center')).length, 1);
    assert.equal(calls.filter(url => url === site).length, 1);
});

test('ADP explicit configuration names take precedence and avoid a corporate lookup', async () => {
    const { reader, calls } = harness({ company: 'Configured Employer' });
    assert.equal((await reader.detail(link())).company, 'Configured Employer');
    assert.equal(calls.length, 2);
});

test('ADP retains unnamed exact postings and completes the saved catalogue', async () => {
    const { reader } = harness({ total: 2, jobs: [job('42'), job('43')], center: center([]) });
    const progress = loadBrowserSweepPage(newBrowserSweep(board), await reader.listing(1));
    for (const postingLink of progress.queue) {
        const posting = await reader.detail(postingLink);
        assert.equal(posting.company, 'Unknown Company');
        assert.equal(posting.description, description.trim());
        assert.equal(posting.id, postingLink.id);
        progress.seen.push(posting.id);
        progress.offset++;
    }
    assert.equal(advanceBrowserSweep(progress), null);
});

test('ADP accepts a plain corporate homepage title only when the exact JD independently names it', async () => {
    const { reader } = harness({ siteHtml: '<title>Corning Credit Union</title>',
        description: '<p>Corning Credit Union is seeking a bilingual loan officer.</p>' + description });
    assert.equal((await reader.detail(link())).company, 'Corning Credit Union');
    for (const options of [{ description }, { description: 'Other Corning Credit Unions are unrelated. ' + description },
        { description: 'We offer employee discounts at Corning Credit Union. ' + description },
        { description: 'Corning Credit Union is hiring. ' + description, siteLanded: 'https://other.example/' }])
        assert.equal((await harness({ siteHtml: '<title>Corning Credit Union</title>', ...options }).reader.detail(link())).company, 'Unknown Company');
    assert.equal(adpEmployerWebsite(center([site + 'culture/', site, site + 'careers/'])), site);
});

test('ADP never invents a company from a tenant, social link, conflicting websites or a foreign redirect', async () => {
    for (const sites of [[], ['https://linkedin.com/company/example'], [site, 'https://other.example/'],
        ['http://www.employer.example/'], ['https://user:password@employer.example/'], ['https://workforcenow.adp.com/']])
        assert.equal(adpEmployerWebsite(center(sites)), null);
    for (const options of [{ center: center([]) }, { siteHtml: '<title>Welcome to our website</title>' },
        { siteLanded: 'https://other.example/' }]) {
        const { reader, calls } = harness(options);
        assert.equal((await reader.detail(link())).company, 'Unknown Company');
        assert.equal((await reader.detail(link('43'))).company, 'Unknown Company');
        assert.equal(calls.filter(url => url.includes('career-center')).length, 1, 'negative metadata is shared too');
        assert.equal(calls.filter(url => url === site).length, options.center ? 0 : 1);
    }
});

test('a published ADP zero-job catalogue completes without becoming an empty-page failure', async () => {
    const { reader } = harness();
    const listing = await reader.listing(1);
    assert.equal(listing.emptyVerified, true);
    const progress = loadBrowserSweepPage(newBrowserSweep(board), listing);
    assert.equal(advanceBrowserSweep(progress), null);
    for (const configuration of [center([], false), {}, { meta: { customFieldGroup: { indicatorFields: [
        { nameCode: { codeValue: 'PublishedIndicator' }, indicatorValue: true },
        { nameCode: { codeValue: 'PublishedIndicator' }, indicatorValue: false },
    ] } } }])
        await assert.rejects(harness({ center: configuration }).reader.listing(1), /lacks a verified published career center/);
});

test('an empty continuation is never certified as a completed first page', async () => {
    assert.equal((await harness().reader.listing(2)).emptyVerified, false);
    const { reader } = harness({ total: 21 });
    assert.equal((await reader.listing(2)).emptyVerified, false);
});

test('ADP retains its one-based page offsets, exact posting IDs and listing signatures', async () => {
    const { reader, calls } = harness({ total: 21, jobs: [job('42')] });
    const first = await reader.listing(1), second = await reader.listing(2);
    assert.equal(first.links[0].titleVerified, true);
    assert.equal(first.signature, listingSignature(first.links));
    assert.deepEqual(first.next, { kind: 'click' });
    assert.equal(second.next, null);
    assert.equal(new URL(calls[0]).searchParams.has('$skip'), false);
    assert.equal(new URL(calls[1]).searchParams.get('$skip'), '21');
    assert.equal(first.links[0].url, link().url);
    await assert.rejects(harness({ total: 2, jobs: [job('42'), job('42')] }).reader.listing(1), /inconsistent/);
});

test('foreign ADP postings and redirected API responses cannot supply employer authority', async () => {
    const { reader, calls } = harness();
    await assert.rejects(reader.detail({ ...link(), url: link().url.replace('9a5ec45e', 'aaaaaaaa') }), /escaped/);
    assert.equal(calls.length, 0);
    await assert.rejects(harness({ redirectJson: true }).reader.detail(link()), /redirected away/);
});

test('ADP safety checks propagate before any network request', async () => {
    const reader = new AdpPublicReader(board, async () => { throw Error('Collection paused'); }, async () => { throw Error('must not fetch'); });
    await assert.rejects(reader.listing(1), /Collection paused/);
    await assert.rejects(reader.detail(link()), /Collection paused/);
});
