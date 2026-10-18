import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAtsHttpReader, canUseBrowserAtsHttp } from '../../src/lib/browserAtsHttp';
import { browserPostingLink, browserPostingSourceId } from '../../src/lib/browserAtsPosting';
import { listingSignature } from '../../src/lib/browserAtsReader';

const paylocity = 'https://recruiting.paylocity.com/recruiting/jobs/All/e1e0b11b-1e4a-4390-8ed5-be5ffdff3a33';
const icims = 'https://careers-example.icims.com/jobs/search?in_iframe=1';
const description = 'Manage distributor onboarding, enablement and operating reviews. '.repeat(10);
const paylocityJobs = (count = 2) => Array.from({ length: count }, (_, i) => ({ JobId: 42 + i, JobTitle: 'Account Manager ' + i, IsInternal: false, Description: 'Only a short preview' }));
function catalogue(jobs: unknown[] = paylocityJobs(), options: Record<string, unknown> = {}, branded = true) {
    return `<title>${branded ? 'Example Inc' : 'Other Employer'} - Job Opportunities</title><script>window.pageData = ${JSON.stringify({ ModuleTitle: 'Example Inc', ShowInternal: false, Jobs: jobs, ...options })};</script>`;
}
function detail(url: string, company = 'Example Inc', body = description) {
    return `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Account Manager', hiringOrganization: { name: company }, description: body,
        jobLocation: [{ address: { addressLocality: 'Minneapolis', addressRegion: 'MN', addressCountry: 'US' } }, { address: { addressCountry: 'Canada' } }],
        applicantLocationRequirements: [{ name: 'United States' }] })}</script>`;
}
function httpFake(replies: Record<string, string | { status?: number; url?: string; html: string }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    return { calls, fetcher: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const found = replies[url];
        if (found === undefined) throw Error('Unexpected HTTP request: ' + url);
        const reply = typeof found === 'string' ? { html: found } : found;
        const response = new Response(reply.html, { status: reply.status || 200 });
        Object.defineProperty(response, 'url', { value: reply.url || url });
        return response;
    } };
}
function icimsPage(page: number, count: number, next?: string, ids = [42]) {
    return `<title>Job Listings at Example Inc</title><ul class="iCIMS_JobsTable">${ids.map(id => `<li class="iCIMS_JobCardItem"><a href="/jobs/${id}/account-manager/job"><span>Title</span><h3>Account Manager</h3></a></li>`).join('')}</ul>
        <div class="iCIMS_Paging"><a class="selected">Page ${page} of ${count}, Current Page</a>${next ? `<a href="${next}"><span>Next page of results</span></a>` : '<a class="invisible" href="?pr=2">Next page of results</a>'}</div>`;
}

test('public Paylocity JSON yields existing source identities and full details without using its short previews', async () => {
    const url = 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/42';
    const fake = httpFake({ [paylocity]: catalogue(), [url]: detail(url) });
    const reader = new BrowserAtsHttpReader(async () => {}, fake.fetcher);
    const page = (await reader.page('paylocity', paylocity, 1))!;
    assert.deepEqual(page.links.map(item => item.id), ['42', '43']);
    assert.equal(page.total, 2);
    assert.equal(page.signature, listingSignature(page.links));
    assert.equal(page.next, null);
    assert.equal(page.links[0].titleVerified, true);
    assert.equal(browserPostingSourceId(paylocity, page.links[0].id), browserPostingSourceId(paylocity, '42'));
    const result = (await reader.detail('paylocity', paylocity, page.links[0]))!;
    assert.equal(result.description, description.trim());
    assert.equal(result.company, 'Example Inc');
    assert.equal(result.location, 'Minneapolis, MN, US; Canada; United States');
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls.every(call => !new Headers(call.init.headers).has('authorization')), true);
});

test('a durable Paylocity detail continuation verifies its board membership before fetching the job', async () => {
    const url = 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/42';
    const fake = httpFake({ [paylocity]: catalogue(), [url]: detail(url) });
    const reader = new BrowserAtsHttpReader(async () => {}, fake.fetcher);
    assert.ok(await reader.detail('paylocity', paylocity, browserPostingLink('paylocity', paylocity, url)!));
    assert.deepEqual(fake.calls.map(call => call.url), [paylocity, url]);
    const foreign = browserPostingLink('paylocity', paylocity, url.replace('/42', '/999'))!;
    assert.equal(await reader.detail('paylocity', paylocity, foreign), null);
    assert.equal(fake.calls.length, 2);
});

test('branded public empty Paylocity JSON is verifiable; shells, internal feeds and inconsistent jobs fall back', async () => {
    const empty = httpFake({ [paylocity]: catalogue([]) });
    assert.equal((await new BrowserAtsHttpReader(async () => {}, empty.fetcher).page('paylocity', paylocity, 1))?.emptyVerified, true);
    const bad = [
        '<title>Example Inc</title><main>Loading</main>', catalogue([], {}, false), catalogue([], { ShowInternal: true }),
        catalogue([{ JobId: 42, JobTitle: 'Account Manager', IsInternal: true }]),
        catalogue([paylocityJobs()[0], paylocityJobs()[0]]), catalogue([{ JobId: '42', JobTitle: 'Account Manager', IsInternal: false }]),
        catalogue([{ JobId: 42, IsInternal: false }]),
    ];
    for (const html of bad) {
        const fake = httpFake({ [paylocity]: html });
        assert.equal(await new BrowserAtsHttpReader(async () => {}, fake.fetcher).page('paylocity', paylocity, 1), null);
    }
});

test('large embedded catalogues retain browser fallback without synthetic pages that could skip reordered jobs', async () => {
    const fake = httpFake({ [paylocity]: catalogue(paylocityJobs(251)) });
    const reader = new BrowserAtsHttpReader(async () => {}, fake.fetcher);
    assert.equal(await reader.page('paylocity', paylocity, 1), null);
    assert.equal(await reader.page('paylocity', paylocity, 2), null);
    assert.equal(fake.calls.length, 1);
    const small = httpFake({ [paylocity]: catalogue() });
    assert.equal(await new BrowserAtsHttpReader(async () => {}, small.fetcher).page('paylocity', paylocity, 2), null);
    assert.equal(small.calls.length, 0);
});

test('different posting identity, employer or short detail cannot pass the direct route', async () => {
    const url = 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/42', link = browserPostingLink('paylocity', paylocity, url)!;
    for (const html of [detail(url.replace('/42', '/43')), detail(url, 'Other Employer'), detail(url, 'Example Inc', 'Preview')]) {
        const fake = httpFake({ [paylocity]: catalogue(), [url]: html });
        assert.equal(await new BrowserAtsHttpReader(async () => {}, fake.fetcher).detail('paylocity', paylocity, link), null);
    }
});

test('iCIMS follows the publisher next URL and requires its published final-page position', async () => {
    const start = icims + '&ss=1', next = icims + '&pr=1';
    const fake = httpFake({ [start]: icimsPage(1, 2, next), [next]: icimsPage(2, 2, undefined, [43]) });
    const reader = new BrowserAtsHttpReader(async () => {}, fake.fetcher);
    const first = (await reader.page('icims', icims, 1))!;
    assert.deepEqual(first.next, { kind: 'url', url: next });
    assert.equal(first.links[0].title, 'Account Manager');
    assert.equal(first.links[0].titleVerified, true);
    const last = (await reader.page('icims', icims, 2, first.next!.kind === 'url' ? first.next.url : undefined))!;
    assert.equal(last.links[0].id, '43');
    assert.equal(last.next, null);
    assert.equal(last.total, null);
});

test('iCIMS fetches the published iframe view while preserving canonical source identity', async () => {
    const url = 'https://careers-example.icims.com/jobs/42/account-manager/job';
    const fake = httpFake({ [url + '?in_iframe=1']: detail(url) });
    const reader = new BrowserAtsHttpReader(async () => {}, fake.fetcher);
    const result = (await reader.detail('icims', icims, browserPostingLink('icims', icims, url)!))!;
    assert.equal(result.url, url);
    assert.equal(result.id, '42');
    assert.equal(result.description, description.trim());
    assert.equal(fake.calls[0].url, url + '?in_iframe=1');
});

test('missing or foreign pagination and incomplete iCIMS markup cannot report board completion', async () => {
    const start = icims + '&ss=1';
    const bad = [
        icimsPage(1, 2), icimsPage(1, 2, 'https://careers-foreign.icims.com/jobs/search?pr=1'),
        icimsPage(1, 2, icims + '&pr=4'), icimsPage(1, 2, 'https://['),
        icimsPage(1, 1).replace('class="selected"', 'class=""'),
        icimsPage(1, 1).replace('</ul>', '<li class="iCIMS_JobCardItem">Loading</li></ul>'),
        icimsPage(1, 1).replace('Job Listings at Example Inc', 'Loading'),
    ];
    for (const html of bad) {
        const fake = httpFake({ [start]: html });
        assert.equal(await new BrowserAtsHttpReader(async () => {}, fake.fetcher).page('icims', icims, 1), null);
    }
});

test('unsupported, filtered and off-board continuations fall back without making requests', async () => {
    const fake = httpFake({}), reader = new BrowserAtsHttpReader(async () => {}, fake.fetcher);
    assert.equal(await reader.page('paycom', paylocity, 1), null);
    assert.equal(await reader.page('icims', icims, 2), null);
    assert.equal(await reader.page('icims', icims, 2, icims + '&pr=1&searchKeyword=sales'), null);
    assert.equal(await reader.page('icims', icims, 2, 'https://careers-foreign.icims.com/jobs/search?pr=1'), null);
    assert.equal(fake.calls.length, 0);
    assert.equal(canUseBrowserAtsHttp('adp'), false);
    assert.equal(canUseBrowserAtsHttp('paylocity'), true);
});

test('same-employer redirects cannot introduce filters or change the requested page under plausible results markup', async () => {
    const start = icims + '&ss=1';
    for (const url of [start + '&searchKeyword=sales', start + '&schemaId=42', start + '&pr=1', start + '&pr=0&pr=1', start + '&ss=0', start.replace('/jobs/search', '/jobs/42/account-manager/job')]) {
        const fake = httpFake({ [start]: { url, html: icimsPage(1, 1) } });
        assert.equal(await new BrowserAtsHttpReader(async () => {}, fake.fetcher).page('icims', icims, 1), null);
    }
    const filteredNext = httpFake({ [start]: icimsPage(1, 2, icims + '&pr=1&searchKeyword=sales') });
    assert.equal(await new BrowserAtsHttpReader(async () => {}, filteredNext.fetcher).page('icims', icims, 1), null);
});

test('HTTP refusal, challenge, foreign redirect and overlarge responses retain browser fallback', async () => {
    for (const reply of [
        { status: 403, html: 'Forbidden' }, { html: '<title>Just a moment...</title>' },
        { html: catalogue(), url: paylocity.replace('e1e0b11b-1e4a-4390-8ed5-be5ffdff3a33', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') },
        { html: ' '.repeat(5 * 1024 * 1024 + 1) },
    ]) {
        const fake = httpFake({ [paylocity]: reply });
        assert.equal(await new BrowserAtsHttpReader(async () => {}, fake.fetcher).page('paylocity', paylocity, 1), null);
    }
});

test('operator safety checks propagate instead of being converted into an HTTP fallback', async () => {
    const reader = new BrowserAtsHttpReader(async () => { throw Error('Collection paused'); });
    await assert.rejects(reader.page('paylocity', paylocity, 1), /Collection paused/);
    await assert.rejects(reader.detail('paylocity', paylocity, browserPostingLink('paylocity', paylocity, 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/42')!), /Collection paused/);
});
