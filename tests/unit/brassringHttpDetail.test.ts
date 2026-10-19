import test from 'node:test';
import assert from 'node:assert/strict';
import { BrassringHttpDetailReader, parseBrassringHttpDetail } from '../../src/lib/brassringHttpDetail';
import { BrowserAtsHttpReader, canUseBrowserAtsHttp, canUseBrowserAtsHttpDetail } from '../../src/lib/browserAtsHttp';
import { browserPostingLink, browserPostingSourceId } from '../../src/lib/browserAtsPosting';
const board = 'https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=12345&siteid=6789';
const preload = 'https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=12345&siteid=6789&PageType=JobDetails&jobid=42';
const endpoint = 'https://sjobs.brassring.com/TgNewUI/Search/Ajax/JobDetails';
const link = (id = '42') => browserPostingLink('brassring', board, board + '#jobDetails=' + id + '_6789', '100BR')!;
const description = 'Lead distributor onboarding, enablement, operating reviews and account growth. '.repeat(8);
const question = (zone: string, value: string, label = '', cls: string | null = null) => ({ VerityZone: zone, AnswerValue: value, QuestionName: label, ClassName: cls });
function response(id = '42') {
    return { ServiceResponse: { SolarErrorOccurred: false, partnername: 'Example Inc', JobFieldsToDisplay: { Summary: 'formtext5' }, Jobdetails: {
        isActive: true, Title: 'Channel Sales Manager', JobSiteId: null,
        Link: `https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=12345&siteid=6789&PageType=JobDetails&jobid=${id}`,
        JobDetailQuestions: [question('autoreq', '100BR', '', 'jobtitleInJobDetails'), question('jobtitle', 'Channel Sales Manager'),
            question('reqid', id), question('siteid', '6789'), question('formtext5', '<p>' + description + '</p>', 'Job Description', 'jobdescriptionInJobDetails'),
            question('formtext3', 'Minneapolis', 'City', 'section2LeftfieldsInJobDetails'), question('formtext4', 'MN', 'State', 'section2RightfieldsInJobDetails'),
            question('formtext6', 'United States; Canada', 'Country', 'section2RightfieldsInJobDetails'), question('formtext7', 'Medical coverage and 401(k)', 'Benefits', 'section2LeftfieldsInJobDetails'),
            question('latitude', '45.0')] } } };
}
const bootstrap = () => `<input id="partnerId" value="12345"><input id="siteId" value="6789"><input id="preLoadJSON" value='${JSON.stringify({ ClientSettings: { PartnerName: 'Example Inc' } })}'>`;
function fake(options: { html?: string; status?: number; redirect?: string; data?: unknown; oversized?: boolean; onBootstrap?: () => void } = {}) {
    const calls: { url: string; init: RequestInit; redirects?: number }[] = [];
    return { calls, fetcher: async (url: string, init: RequestInit, redirects?: number) => {
        calls.push({ url, init, redirects });
        const isBootstrap = url.includes('/HomeWithPreLoad?'), body = isBootstrap ? options.html ?? bootstrap() : JSON.stringify(options.data ?? response(JSON.parse(String(init.body)).jobid));
        const r = new Response(options.oversized ? ' '.repeat(5 * 1024 * 1024 + 1) : body, { status: options.status || 200, headers: isBootstrap ? { 'Set-Cookie': 'tg_session_public=fresh-session; Secure; HttpOnly' } : {} });
        Object.defineProperty(r, 'url', { value: options.redirect || url });
        if (isBootstrap) options.onBootstrap?.();
        return r;
    } };
}
test('BrassRing public details preserve exact source IDs, the real title, labeled locations and every published field', () => {
    const posting = parseBrassringHttpDetail(board, link(), 'Example Inc', response())!;
    assert.ok(posting);
    assert.equal(posting.id, '42');
    assert.equal(posting.url, link().url);
    assert.equal(browserPostingSourceId(board, posting.id), browserPostingSourceId(board, '42'));
    assert.equal(posting.title, 'Channel Sales Manager'); // The UI heading is a requisition number.
    assert.equal(posting.company, 'Example Inc');
    assert.equal(posting.location, 'Minneapolis; MN; United States; Canada');
    assert.ok(posting.description.includes(description.trim()));
    assert.ok(posting.description.includes('Medical coverage and 401(k)'));
    assert.ok(posting.description.includes('100BR'));
    assert.equal(posting.description.includes('45.0'), false); // An internal field is not published job content.
    assert.equal(posting.location.includes('distributor onboarding'), false);
});
test('BrassRing refuses wrong jobs, sites, employer branding, inactive jobs, conflicting titles and description previews', () => {
    const wrong: unknown[] = [response('43'), null, { ServiceResponse: null }];
    const mutate = (change: (r: ReturnType<typeof response>) => void) => { const r = response(); change(r); wrong.push(r); };
    mutate(r => { r.ServiceResponse.partnername = 'Other Employer'; });
    mutate(r => { r.ServiceResponse.SolarErrorOccurred = true; });
    mutate(r => { r.ServiceResponse.Jobdetails.isActive = false; });
    mutate(r => { r.ServiceResponse.Jobdetails.Link = r.ServiceResponse.Jobdetails.Link.replace('12345', '99999'); });
    mutate(r => { r.ServiceResponse.Jobdetails.Link = 'https://other.example/job/42'; });
    mutate(r => { r.ServiceResponse.Jobdetails.JobDetailQuestions.find(q => q.VerityZone === 'siteid')!.AnswerValue = '9999'; });
    mutate(r => { r.ServiceResponse.Jobdetails.JobDetailQuestions.find(q => q.VerityZone === 'jobtitle')!.AnswerValue = 'Other Title'; });
    mutate(r => { r.ServiceResponse.Jobdetails.JobDetailQuestions.push(question('reqid', '42')); });
    mutate(r => { r.ServiceResponse.Jobdetails.JobDetailQuestions.find(q => q.VerityZone === 'formtext5')!.AnswerValue = 'Short preview'; });
    mutate(r => { r.ServiceResponse.JobFieldsToDisplay.Summary = 'missing-field'; });
    for (const r of wrong) assert.equal(parseBrassringHttpDetail(board, link(), 'Example Inc', r), null);
});
test('an anonymous board session is reused for exact detail POSTs without changing listing transport', async () => {
    const f = fake(), reader = new BrowserAtsHttpReader(async () => {}, f.fetcher);
    assert.equal(canUseBrowserAtsHttp('brassring'), false);
    assert.equal(canUseBrowserAtsHttpDetail('brassring'), true);
    assert.equal(await reader.page('brassring', board, 1), null);
    assert.equal(f.calls.length, 0);
    assert.ok(await reader.detail('brassring', board, link('42')));
    assert.ok(await reader.detail('brassring', board, link('43')));
    assert.deepEqual(f.calls.map(call => call.url), [preload, endpoint, endpoint]);
    assert.equal(f.calls.every(call => call.redirects === 0), true);
    const request = f.calls[1];
    assert.equal(new Headers(request.init.headers).get('cookie'), 'tg_session_public=fresh-session');
    assert.equal(new Headers(request.init.headers).has('authorization'), false);
    assert.equal(JSON.parse(String(request.init.body)).jobid, '42');
});
test('bad public sessions and refused, redirected or oversized bodies fall back without trusting their content', async () => {
    for (const options of [{ html: bootstrap().replace('12345', '99999') }, { html: bootstrap().replace('Example Inc', 'Unknown Company') },
        { html: '<h1>Loading</h1>' }, { status: 403 }, { redirect: 'https://other.example/' }, { oversized: true }]) {
        const f = fake(options);
        assert.equal(await new BrassringHttpDetailReader(async () => {}, f.fetcher).detail(board, link()), null);
        assert.equal(f.calls.length, 1);
    }
    const f = fake({ data: { error: 'Session expired' } });
    assert.equal(await new BrassringHttpDetailReader(async () => {}, f.fetcher).detail(board, link()), null);
});
test('invalid board and posting identities make no requests, and operator pause between bootstrap and POST propagates', async () => {
    const f = fake(), reader = new BrassringHttpDetailReader(async () => {}, f.fetcher);
    assert.equal(await reader.detail(board.replace('12345', '99999'), link()), null);
    assert.equal(await reader.detail(board, { ...link(), id: '43' }), null);
    assert.equal(f.calls.length, 0);
    let paused = false;
    const p = fake({ onBootstrap: () => { paused = true; } });
    const stopped = new BrassringHttpDetailReader(async () => { if (paused) throw Error('Collection paused'); }, p.fetcher);
    await assert.rejects(stopped.detail(board, link()), /Collection paused/);
    assert.equal(p.calls.length, 1);
});
