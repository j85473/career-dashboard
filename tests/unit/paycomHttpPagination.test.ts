import test from 'node:test';
import assert from 'node:assert/strict';
import { PaycomPublicHttp, PAYCOM_HTTP_CATALOGUE_LIMIT } from '../../src/lib/paycomPublicHttp';
import { advanceBrowserSweep, loadBrowserSweepPage, newBrowserSweep, readBrowserSweep } from '../../src/lib/browserAtsProgress';
const board = 'https://www.paycomonline.net/v4/ats/web.php/portal/74B8425BF3D1B3ACB19CC1353DC5FA0E/career-page';
type SearchResult = {jobPostingPreviewsCount:number;jobPostingPreviews:{jobId:number;jobTitle:string}[]};
function fake(count = 317, mutate?: (result: SearchResult, skip:number, call:number) => void, check = async () => {}) {
    const calls: number[] = [];
    const token = 'x.' + Buffer.from(JSON.stringify({ sub:'0', isInternalJobBoard:'', clientcode:'EMP' })).toString('base64url') + '.x';
    const rows = Array.from({length:count}, (_, i) => ({ jobId:i + 1, jobTitle:'Manager ' + (i + 1) }));
    const reader = new PaycomPublicHttp(check, async (url, init) => {
        if (url === board) return new Response('var configsFromHost = ' + JSON.stringify({sessionJWT:token}) + ';');
        if (url.endsWith('/company-name')) return Response.json({companyName:'Example Employer'});
        if (url.endsWith('/search')) {
            const body = JSON.parse(String(init.body));
            assert.equal(body.take, 50); assert.equal(body.filtersForQuery.keywordSearchText, '');
            calls.push(body.skip);
            const result = {jobPostingPreviewsCount:count, jobPostingPreviews:rows.slice(body.skip, body.skip + body.take).map(r => ({...r}))};
            mutate?.(result, body.skip, calls.length);
            return Response.json(result);
        }
        const id = Number(url.split('/').at(-1));
        return Response.json({ jobPosting:{ jobId:id, clientCode:'EMP', jobTitle:'Manager ' + id, description:'<p>Published full responsibilities and requirements.</p>'.repeat(20), location:'US' } });
    });
    return { reader, calls, token };
}

test('Paycom enumerates larger catalogues and resumes a durable queue without refetching reordered vendor offsets', async () => {
    const first = fake(), listing = (await first.reader.page(board, 1))!;
    assert.equal(listing.total, 317); assert.equal(listing.links.length, 317);
    assert.deepEqual(first.calls, [0,50,100,150,200,250,300,0]);
    let progress = loadBrowserSweepPage({...newBrowserSweep(board), transport:'http-v1'}, listing);
    progress.offset = 50; progress.seen = progress.queue.slice(0,50).map(l=>l.id);
    const json = JSON.stringify(progress);
    assert.ok(!json.includes(first.token));
    progress = readBrowserSweep(JSON.parse(json), 'paycom', board);
    const restarted = fake(0), link = progress.queue[progress.offset];
    assert.equal((await restarted.reader.detail(board, link, progress.queue))?.id, '51');
    assert.deepEqual(restarted.calls, [], 'resume uses saved membership plus employer-verified details, not new listing offsets');
    assert.throws(()=>advanceBrowserSweep(progress), /every posting/);
    progress.offset = progress.queue.length; progress.seen = progress.queue.map(l=>l.id);
    assert.equal(advanceBrowserSweep(progress), null);
    for (const patch of [{transport:'browser-v1'}, {total:316}, {next:{kind:'click'}}, {page:2}])
        assert.throws(()=>readBrowserSweep({...progress,...patch}, 'paycom',board), /Invalid durable/);
});

test('Paycom refuses count drift, duplicate pages, missing rows, head movement and oversized catalogues', async () => {
    for (const mutate of [
        (r:SearchResult, skip:number)=>{if(skip)r.jobPostingPreviewsCount++;},
        (r:SearchResult, skip:number)=>{if(skip===50)r.jobPostingPreviews[0].jobId=1;},
        (r:SearchResult, skip:number)=>{if(skip===50)r.jobPostingPreviews.pop();},
        (r:SearchResult, skip:number, call:number)=>{if(skip===0&&call>1)r.jobPostingPreviews[0].jobId=9999;},
    ]) assert.equal(await fake(117,mutate).reader.page(board,1),null);
    assert.equal(await fake(PAYCOM_HTTP_CATALOGUE_LIMIT+1).reader.page(board,1),null);
    const maximum = await fake(PAYCOM_HTTP_CATALOGUE_LIMIT).reader.page(board,1);
    assert.equal(maximum?.links.length,PAYCOM_HTTP_CATALOGUE_LIMIT);
});

test('Paycom stop and lease checks propagate even between API pages', async () => {
    let checked=0;
    const {reader} = fake(117,undefined,async()=>{if(++checked===4)throw Error('Lease lost');});
    await assert.rejects(reader.page(board,1), /Lease lost/);
});
