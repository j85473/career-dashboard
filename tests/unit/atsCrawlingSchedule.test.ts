import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlQueueOrder, CRAWL_TURN_CYCLE, nextCrawlRefreshAt } from '../../src/lib/atsCrawlingSchedule';
import { parseBrowserPosting, phenomPublishedJob, browserPostingLink } from '../../src/lib/browserAtsPosting';
import { postingLinksFromDocuments, verifiedEmptyBoard } from '../../src/lib/browserAtsReader';

const description = 'Coordinate distributor onboarding and enablement with operating reviews. '.repeat(8);
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
