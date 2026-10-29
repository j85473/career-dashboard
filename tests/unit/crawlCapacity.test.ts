import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlTimeOrder } from '../../src/lib/crawlTimeBudget';
import { PaycomPublicHttp } from '../../src/lib/paycomPublicHttp';
const board='https://www.paycomonline.net/v4/ats/web.php/portal/74B8425BF3D1B3ACB19CC1353DC5FA0E/career-page';
function reader(patch: Record<string,unknown> = {}, detailPatch: Record<string,unknown> = {}) {
 const calls: string[]=[];
 const token='x.'+Buffer.from(JSON.stringify({sub:'0',isInternalJobBoard:'',clientcode:'EMP'})).toString('base64url')+'.x';
 const fetcher=async(url:string,init:RequestInit)=>{
  calls.push(url);
  if(url===board)return new Response('var configsFromHost = '+JSON.stringify({sessionJWT:token})+';');
  assert.ok(url.startsWith('https://portal-applicant-tracking.us-cent.paycomonline.net/api/ats/'));
  assert.equal(init.redirect,'error');
  if(url.endsWith('company-name'))return Response.json({companyName:'Published Employer'});
  if(url.endsWith('/search')) {
   const body=JSON.parse(String(init.body));assert.equal(body.skip,0);assert.equal(body.filtersForQuery.keywordSearchText,'');
   return Response.json({jobPostingPreviewsCount:1,jobPostingPreviews:[{jobId:42,jobTitle:'Partner Manager'}],...patch});
  }
  return Response.json({jobPosting:{jobId:42,clientCode:'EMP',jobTitle:'Partner Manager',description:'<p>Full published responsibilities and requirements.</p>'.repeat(20),location:'Minneapolis, MN',...detailPatch}});
 };
 return {r:new PaycomPublicHttp(async()=>{},fetcher),calls};
}
test('elapsed allocation gives slow first collections bounded time while refresh and continuation progress',()=>{
 const spent={first:0,refresh:0,continuation:0,retry:0};
 for(let i=0;i<500;i++){const q=crawlTimeOrder(spent)[0];spent[q]+=q==='first'?15000:1000;}
 const total=Object.values(spent).reduce((a,b)=>a+b,0);
 assert.ok(spent.first/total<0.44 && spent.first/total>0.36);
 assert.ok(spent.refresh/total>0.27);assert.ok(spent.continuation/total>0.17);
});
test('Paycom proves a complete catalogue and matching employer details without browser use',async()=>{
 const {r}=reader();const page=await r.page(board,1);assert.equal(page?.total,1);
 const detail=await r.detail(board,page!.links[0]);assert.equal(detail?.company,'Published Employer');
 assert.equal(await r.page(board,2),null);
});
test('Paycom refuses truncated, oversized, duplicate or invalid catalogues',async()=>{
 for(const patch of [{jobPostingPreviewsCount:51},{jobPostingPreviewsCount:2},{jobPostingPreviewsCount:2,jobPostingPreviews:[{jobId:42,jobTitle:'A'},{jobId:42,jobTitle:'B'}]},{jobPostingPreviews:[{jobId:'42',jobTitle:'A'}]}])
  assert.equal(await reader(patch).r.page(board,1),null);
});
test('Paycom refuses wrong-employer, wrong-posting and incomplete details',async()=>{
 for(const patch of [{clientCode:'OTHER'},{jobId:43},{jobTitle:'Other'},{description:'short'}]){
  const {r}=reader({},patch),page=await r.page(board,1);assert.equal(await r.detail(board,page!.links[0]),null);
 }
});

test('time preference borrows absent queues and still rotates providers inside the chosen queue',async()=>{
 const { nextCrawlBoard }=await import('../../src/lib/atsCrawlingSchedule');
 const rows=['first','refresh'].map((queue,i)=>({platform:i?'paycom':'icims',slug:'board',queue,checkDay:0,failCount:0,lastSynchronizedAt:null,providerLastStartedAt:null}));
 let sql='';
 const client={$queryRaw:async(q:{text:string})=>{sql=q.text;return rows;}};
 const result=await nextCrawlBoard(['icims','paycom'],0,true,undefined,undefined,client as never,'all',['continuation','refresh','first','retry']);
 assert.equal(result?.queue,'refresh');
 assert.match(sql,/historical_failures/);assert.match(sql,/s\.cursor->'seen'='\[\]'::jsonb/);
 assert.match(sql,/board\."retryCount"=0/);assert.match(sql,/h\.source=t\.source AND h\.slug=board\.slug/);
 assert.doesNotMatch(sql,/UPDATE|DELETE|INSERT/);
});
