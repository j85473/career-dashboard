import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlQueueOrder, crawlProviderWeight, CRAWL_TURN_CYCLE, CRAWL_PROVIDER_MAX_WAIT_MS, nextCrawlBoard, nextCrawlRefreshAt, selectFairCrawlBoard, type CrawlProviderHead } from '../../src/lib/atsCrawlingSchedule';
import type { PrismaClient } from '../../src/lib/prismaClient';
import { parseBrowserPosting, phenomPublishedJob, browserPostingLink } from '../../src/lib/browserAtsPosting';
import { postingLinksFromDocuments, verifiedEmptyBoard, brassringResultsReady } from '../../src/lib/browserAtsReader';
import { BrowserSweepDeferred, browserTurnYieldAt } from '../../src/lib/browserAtsWorker';

test('a budget-limited board yields behind other due boards while safety deferrals preserve eligibility', () => {
  const now = new Date('2026-10-18T03:15:00Z');
  const budget = new BrowserSweepDeferred('bounded turn', true);
  const yielded = browserTurnYieldAt(budget, false, now)!;
  assert.equal(yielded.toISOString(), '2026-10-18T03:15:01.000Z');
  const otherDueBoard = new Date('2026-10-17T00:00:00Z');
  assert.ok(otherDueBoard < yielded);
  assert.equal(browserTurnYieldAt(budget, true, now), null);
  for (const error of [new Error('failure'), new BrowserSweepDeferred('pause or capacity'), new BrowserSweepDeferred('retired'), new BrowserSweepDeferred('lease lost')])
    assert.equal(browserTurnYieldAt(error, false, now), null);
});

const description = 'Coordinate distributor onboarding and enablement with operating reviews. '.repeat(8);
test('providers receive bounded turns across restarts even when one has an older, larger continuation backlog', () => {
  const heads: CrawlProviderHead[] = ['adp','avature','brassring','cats','dzconnex','freshteam','icims','jobvite','paycom','paylocity','phenom','sagehr','talemetry','taleo'].map((platform,i) => ({
    platform,slug:platform+'-oldest-due-board',checkDay:0,queue:i===2?'continuation':'first',failCount:0,lastSynchronizedAt:null,
    providerLastStartedAt:i<3?new Date('2026-10-18T14:00:00Z'):null,
  }));
  const firstRound=new Set<string>();
  for(let i=0;i<42;i++) {
    // Task start timestamps survive both pass boundaries and process restarts.
    const restored=heads.map(h=>({...h,providerLastStartedAt:h.providerLastStartedAt?new Date(h.providerLastStartedAt.toISOString()):null}));
    const selected=selectFairCrawlBoard(restored)!;
    if(i<14) firstRound.add(selected.platform);
    heads.find(h=>h.platform===selected.platform)!.providerLastStartedAt=new Date(Date.parse('2026-10-18T14:01:00Z')+i*60000);
    // This provider always has another continuation, rather than disappearing when served.
    heads.find(h=>h.platform==='brassring')!.slug='another-large-brassring-board';
  }
  assert.equal(firstRound.size,14);
  assert.equal(selectFairCrawlBoard([]),null);
});
test('provider fairness is deterministic on equal starts and never mutates candidates', () => {
  const b: CrawlProviderHead={platform:'paycom',slug:'board',checkDay:0,queue:'retry',failCount:1,lastSynchronizedAt:null,providerLastStartedAt:null};
  const candidates=[b,{...b,platform:'cats'}];
  assert.equal(selectFairCrawlBoard(candidates)?.platform,'cats');
  assert.equal(candidates[0].platform,'paycom');
});
test('large queues receive more capacity while a small or slow provider keeps a bounded opportunity across restarts', () => {
  let now = new Date('2026-10-21T14:00:00Z');
  let heads: CrawlProviderHead[] = [
    { platform: 'paylocity', readyBoards: 14700, averageTurnMs: 4000 },
    { platform: 'icims', readyBoards: 7000, averageTurnMs: 26000 },
    { platform: 'taleo', readyBoards: 3600, averageTurnMs: 60000 },
    { platform: 'sagehr', readyBoards: 1, averageTurnMs: 8000 },
  ].map(sample => ({ ...sample, slug: sample.platform, queue: 'first', checkDay: 0, failCount: 0, lastSynchronizedAt: null, providerLastStartedAt: null }));
  const turns = new Map<string, number>(), longestWait = new Map<string, number>();
  for (let turn = 0; turn < 800; turn++) {
    // Only durable task starts are restored, never an in-process fairness counter.
    heads = heads.map(head => ({ ...head, providerLastStartedAt: head.providerLastStartedAt ? new Date(head.providerLastStartedAt.toISOString()) : null }));
    const selected = selectFairCrawlBoard(heads, now)!;
    turns.set(selected.platform, (turns.get(selected.platform) || 0) + 1);
    const old = selected.providerLastStartedAt;
    if (old) longestWait.set(selected.platform, Math.max(longestWait.get(selected.platform) || 0, now.getTime() - old.getTime()));
    selected.providerLastStartedAt = new Date(now);
    now = new Date(now.getTime() + selected.averageTurnMs!);
  }
  assert.ok(turns.get('paylocity')! > 2 * turns.get('sagehr')!, 'large cheap queues gain turns');
  assert.ok(turns.get('icims')! > turns.get('sagehr')!, 'large slower queues also gain capacity');
  for (const head of heads) {
    assert.ok(turns.get(head.platform)! > 10, head.platform + ' must retain a share');
    assert.ok(longestWait.get(head.platform)! <= CRAWL_PROVIDER_MAX_WAIT_MS + 3 * 60000, head.platform + ' remains within the fairness floor plus in-flight turns');
  }
});
test('observed cost changes a preference but never outranks a provider beyond the maximum wait', () => {
  const now = new Date('2026-10-21T14:00:00Z');
  const base: CrawlProviderHead = { platform: 'a-slow', slug: 'one', queue: 'continuation', checkDay: 0, failCount: 0,
    lastSynchronizedAt: null, providerLastStartedAt: new Date(now.getTime() - 60000), readyBoards: 1000, averageTurnMs: 60000 };
  const fast = { ...base, platform: 'z-fast', averageTurnMs: 1000 };
  assert.equal(selectFairCrawlBoard([base, fast], now)?.platform, 'z-fast');
  const overdue = { ...base, providerLastStartedAt: new Date(now.getTime() - CRAWL_PROVIDER_MAX_WAIT_MS) };
  assert.equal(selectFairCrawlBoard([overdue, fast], now)?.platform, 'a-slow');
  assert.equal(selectFairCrawlBoard([{ ...base, providerLastStartedAt: null }, fast], now)?.platform, 'a-slow');
  for (const head of [base, fast]) assert.ok(crawlProviderWeight(head, [base, fast]) >= 0.5 && crawlProviderWeight(head, [base, fast]) <= 4);
});
test('selection samples bounded recent completed turns and counts only eligible queue and transport work', async () => {
  let sql = '';
  const client = { $queryRaw: async (query: { text: string }) => { sql = query.text; return []; } } as unknown as Pick<PrismaClient, '$queryRaw'>;
  await nextCrawlBoard(['paylocity', 'icims'], 0, false, undefined, undefined, client, 'http');
  assert.match(sql, /COUNT\(\*\) OVER \(PARTITION BY platform\)/);
  assert.match(sql, /candidates AS MATERIALIZED/);
  assert.match(sql, /LIMIT 32/);
  assert.ok(sql.indexOf('LIMIT 32') < sql.indexOf('WHERE recent.lane'), 'lane filtering cannot scan an unbounded HTTP history');
  assert.match(sql, /"finishedAt" IS NOT NULL/);
  assert.match(sql, /INTERVAL '7 days'/);
  assert.match(sql, /browserRequired/);
  assert.match(sql, /"leaseExpiresAt"/);
  assert.doesNotMatch(sql, /UPDATE|DELETE|INSERT/);
});
test('busy HTTP activity on a shared provider cannot starve its waiting browser fallback', async () => {
  const now = new Date();
  const base: CrawlProviderHead = { platform: 'brassring', slug: 'board', queue: 'continuation', checkDay: 0, failCount: 0,
    lastSynchronizedAt: null, readyBoards: 10000, averageTurnMs: 5000, providerLastStartedAt: new Date(now.getTime()-60000) };
  let shared: CrawlProviderHead = { ...base, platform: 'paylocity', readyBoards: 2, providerLastStartedAt: now,
    providerCursor: { crawlLaneStarts: { http: now.toISOString(), browser: new Date(now.getTime()-CRAWL_PROVIDER_MAX_WAIT_MS-1000).toISOString() } } };
  const client = { $queryRaw: async () => [base, shared] } as unknown as Pick<PrismaClient, '$queryRaw'>;
  assert.equal((await nextCrawlBoard(['paycom','paylocity'],0,true,undefined,undefined,client,'browser'))?.platform,'paylocity');
  shared = { ...shared, providerCursor: { crawlLaneStarts: { http: now.toISOString() } } };
  assert.equal((await nextCrawlBoard(['paycom','paylocity'],0,true,undefined,undefined,client,'browser'))?.platform,'paylocity', 'an unserved browser lane gets its initial turn even after HTTP starts');
});
test('crawl turn reservations protect continuations, refreshes and first crawls and cap retries', () => {
  assert.equal(CRAWL_TURN_CYCLE.filter(q => q === 'retry').length, 1);
  for (let i=0;i<10;i++) {
    assert.equal(crawlQueueOrder(i,true)[0],CRAWL_TURN_CYCLE[i]);
    assert.equal(crawlQueueOrder(i,false).includes('retry'),false);
    assert.equal(new Set(crawlQueueOrder(i,true)).size,4);
  }
});
test('productive boards get stable daily slots, other boards get distributed weekly Chicago slots across DST', () => {
  for (const clock of ['2026-10-17T23:00:00Z','2026-11-01T06:30:00Z','2027-03-14T07:30:00Z']) {
    const now = new Date(clock);
    const daily = nextCrawlRefreshAt('paycom:one',now.toISOString(),now);
    const weekly = nextCrawlRefreshAt('paycom:one',undefined,now);
    assert.equal(daily.cadence,'daily'); assert.equal(weekly.cadence,'weekly');
    assert.ok(daily.nextRunAt.getTime()>=now.getTime()+12*3600000);
    assert.ok(daily.nextRunAt.getTime()<=now.getTime()+38*3600000);
    assert.ok(weekly.nextRunAt.getTime()>=now.getTime()+24*3600000);
    assert.ok(weekly.nextRunAt.getTime()<=now.getTime()+9*86400000);
    assert.deepEqual(nextCrawlRefreshAt('paycom:one',undefined,now),weekly);
    assert.equal(nextCrawlRefreshAt('one','2026-01-01',now).cadence,'weekly');
  }
  const slots=new Set(Array.from({length:100},(_,i)=>nextCrawlRefreshAt('board:'+i,undefined,new Date('2026-10-17')).nextRunAt.getUTCDay()));
  assert.equal(slots.size,7);
});
test('Paylocity published branding and description containers work without JSON-LD', () => {
  const board='https://recruiting.paylocity.com/recruiting/jobs/All/4f40472a-4480-44dc-a06f-60eb098fb363';
  const link=browserPostingLink('paylocity',board,'https://recruiting.paylocity.com/Recruiting/Jobs/Details/4577952','Account Manager')!;
  const doc={url:link.url,html:`<header><h2 id="LayoutLogoName">Example Foods LLC</h2></header><div class="job-preview-details">${description}</div>`,text:description};
  assert.equal(parseBrowserPosting('paylocity',board,link,[doc])?.company,'Example Foods LLC');
  assert.equal(parseBrowserPosting('paylocity',board,link,[{...doc,html:doc.html.replace('Example Foods LLC','Company Logo')}]),null);
});
test('Phenom public job data must match the requisition and retains every location without evaluating scripts', () => {
  const job={jobRequisitionId:'R42',companyName:'Example Inc',title:'Account Manager',description,multi_location:[{address:'Minneapolis, MN, US'},{address:'Chicago, IL, US'}]};
  const html=`<script>phApp.ddo = ${JSON.stringify({jobDetail:{data:{job}}})}; throw new Error('must never execute');</script>`;
  assert.equal(phenomPublishedJob(html,'wrong'),null);
  assert.equal(phenomPublishedJob(html,'R42')?.companyName,'Example Inc');
  const board='https://careers.arrow.com/us/en/search-results';
  const link=browserPostingLink('phenom',board,'https://careers.arrow.com/us/en/job/R42/account-manager','Account Manager')!;
  assert.equal(parseBrowserPosting('phenom',board,link,[{url:link.url,html,text:''}])?.location,'Minneapolis, MN, US; Chicago, IL, US');
});
test('Jobvite row navigation only accepts a literal same-tenant posting URL', () => {
  const board='https://jobs.jobvite.com/example/jobs';
  const doc={url:board,text:'',html:`<table><tbody><tr onclick="window.location.href='/example/job/abc42'"><td class="jv-job-list-name">Account Manager</td></tr><tr onclick="window.location.href='https://evil.example/example/job/evil'"></tr><tr onclick="window.location.href=steal()"></tr></tbody></table>`};
  assert.deepEqual(postingLinksFromDocuments('jobvite',board,[doc]).map(j=>j.id),['abc42']);
});
test('an explicit empty result needs published employer branding and cannot match a generic access failure', () => {
  const doc={url:'https://www.paycomonline.net',html:'<h1>Example Inc Career Page</h1>',text:'Currently no jobs available'};
  assert.equal(verifiedEmptyBoard('paycom',[doc]),true);
  assert.equal(verifiedEmptyBoard('paycom',[doc], 'https://www.paycomonline.net/v4/ats/web.php/portal/E499C93DD23D9EBD99DB3FD65752B720/career-page'),false);
  assert.equal(verifiedEmptyBoard('paycom',[{...doc,html:'<h1>Company Career Page</h1>'}]),false);
  assert.equal(verifiedEmptyBoard('paycom',[{...doc,text:'Access denied. No jobs found after logging in.'}]),false);
});

test('Talemetry dollar escaping is repaired without accepting a different canonical posting', () => {
  const board='https://example.ttcportals.com/search/jobs';
  const link=browserPostingLink('talemetry',board,'https://example.ttcportals.com/jobs/42-account-manager','Account Manager')!;
  const raw=JSON.stringify({'@type':'JobPosting',url:link.url,title:link.title,hiringOrganization:{name:'Example Inc'},description:description+' Pay $100.',jobLocation:[{address:{addressCountry:'US'}}]}).replace('$100','\\$100');
  const doc={url:link.url,html:`<script type="application/ld+json">${raw}</script>`,text:''};
  assert.equal(parseBrowserPosting('talemetry',board,link,[doc])?.company,'Example Inc');
  assert.equal(parseBrowserPosting('talemetry',board,link,[{...doc,html:doc.html.replace('42-account','43-account')}]),null);
});
test('Avature and CATS recover employer branding and preserve separate location fields', () => {
  const cases=[
    {platform:'avature' as const,board:'https://example.avature.net/careers/SearchJobs',url:'https://example.avature.net/careers/JobDetail/Account-Manager/42',html:`<header class="header__logo"><h1>Example Inc</h1></header><div class="article__content">${description}</div><div class="article__content__view__field"><div class="article__content__view__field__label">Location</div><div class="article__content__view__field__value">MN - Minneapolis</div></div>`,location:'MN - Minneapolis'},
    {platform:'cats' as const,board:'https://example.catsone.com/careers/10/',url:'https://example.catsone.com/careers/10/jobs/42-Account-Manager',html:`<header><div id="logo"><img alt="Example Inc"></div></header><div class="job-header"><h1>Account Manager</h1><ul class="job-tags"><li>Minneapolis, MN</li><li>Sales</li></ul></div><div class="job-description">${description}</div>`,location:'Minneapolis, MN'},
  ];
  for(const sample of cases){const link=browserPostingLink(sample.platform,sample.board,sample.url,'Account Manager')!;const result=parseBrowserPosting(sample.platform,sample.board,link,[{url:sample.url,html:sample.html,text:''}]);assert.equal(result?.company,'Example Inc');assert.equal(result?.location,sample.location);}
});
test('Jobvite custom detail templates identify the employer separately from the job title', () => {
  const board='https://jobs.jobvite.com/example/jobs';const link=browserPostingLink('jobvite',board,'https://jobs.jobvite.com/example/job/abc42','Account Manager')!;
  const result=parseBrowserPosting('jobvite',board,link,[{url:link.url,html:`<head><title>Example Inc Careers - Account Manager</title><meta property="og:title" content="Example Inc is looking for Account Manager"></head><div class="jv-job-detail-description">${description}</div>`,text:''}]);assert.equal(result?.company,'Example Inc');
});

test('BrassRing waits for all fifty first-page cards and permits the shorter final page', () => {
  const doc={url:'https://sjobs.brassring.com',html:'<div id="gateway" class="searchResults"></div>',text:'1364 results\nRefine 50 results\nPage 1 of 28'};
  assert.equal(brassringResultsReady([doc],10),false);
  assert.equal(brassringResultsReady([doc],50),true);
  assert.equal(brassringResultsReady([{...doc,text:doc.text.replace('Page 1','Page 28')}],14),true);
  assert.equal(brassringResultsReady([{...doc,html:'<div id="gateway" class="home"></div>'}],50),false);
});

test('a reused hash-routed detail tab reloads before it can attach the prior job description to a new job', async () => {
  const { BrowserAtsReader } = await import('../../src/lib/browserAtsReader');
  const board='https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=12345&siteid=6789';
  let currentUrl=board,domUrl=board,reloads=0,pages=0;
  const text=()=>description+' Current requisition '+new URL(domUrl).hash;
  const frame={url:()=>currentUrl,content:async()=>`<head><title>Account Manager | Example Inc</title></head><script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',url:domUrl,title:'Account Manager',hiringOrganization:{name:'Example Inc'},description:text()})}</script>`,locator:()=>({innerText:async()=>text()})};
  const page={goto:async(url:string)=>{currentUrl=url;return null;},reload:async()=>{reloads++;domUrl=currentUrl;return {status:()=>200};},url:()=>currentUrl,frames:()=>[frame],close:async()=>{},waitForTimeout:async()=>{}};
  const reader=new BrowserAtsReader({newPage:async()=>{pages++;return page;}} as never,async()=>{});
  const first=browserPostingLink('brassring',board,board+'#jobDetails=42_6789','Account Manager')!;
  const second=browserPostingLink('brassring',board,board+'#jobDetails=43_6789','Account Manager')!;
  assert.equal((await reader.detail('brassring',board,first))?.id,'42');
  const result=await reader.detail('brassring',board,second);
  assert.equal(result?.id,'43');assert.match(result!.description,/jobDetails=43/);assert.doesNotMatch(result!.description,/jobDetails=42/);
  assert.equal(pages,1);assert.equal(reloads,2);await reader.close();
});
