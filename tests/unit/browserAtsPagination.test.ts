import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAtsReader, listingSignature, verifiedBrowserPageEnd } from '../../src/lib/browserAtsReader';
import { browserPostingLink } from '../../src/lib/browserAtsPosting';
import { advanceBrowserSweep, newBrowserSweep, readBrowserSweep, recoverBrowserSweepContinuation } from '../../src/lib/browserAtsProgress';

const brassring='https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=12345&siteid=6789';
const links=['42','43'].map(id=>browserPostingLink('brassring',brassring,brassring+'#jobDetails='+id+'_6789','Account Manager')!);
const signature=listingSignature(links);
const finalDoc={url:brassring,html:'<div id="gateway" class="searchResults"><button aria-label="Go to next page" aria-disabled="true"></button></div>',text:'4 results\nRefine 2 results\nPage 2 of 2'};

test('a changing advertised total can finish only after all saved pages and an explicit final-page receipt',()=>{
  const terminal=verifiedBrowserPageEnd('brassring',brassring,[finalDoc],2,links,false)!;
  assert.ok(terminal);
  const p={...newBrowserSweep(brassring),page:2,loaded:true,offset:2,queue:links,seen:['40','42','43'],total:4,signatures:['earlier-page',signature]};
  assert.throws(()=>advanceBrowserSweep(p),/3 of 4/);
  const recovered=recoverBrowserSweepContinuation(p,{links,signature,total:4,next:null,terminal});
  assert.equal(recovered.seen,p.seen);
  assert.equal(recovered.queue,p.queue);
  assert.equal(recovered.total,4); // The published count remains evidence, not rewritten to fit.
  assert.equal(advanceBrowserSweep(readBrowserSweep(JSON.parse(JSON.stringify(recovered)),'brassring',brassring)),null);
  assert.equal('terminal' in p,false);
  assert.throws(()=>advanceBrowserSweep({...recovered,offset:1}),/every posting/);
  assert.throws(()=>advanceBrowserSweep({...recovered,signatures:[signature]}),/3 of 4/);
  assert.throws(()=>readBrowserSweep({...recovered,terminal:{...terminal,signature:'wrong'}},'brassring',brassring),/final-page evidence/);
  assert.throws(()=>recoverBrowserSweepContinuation(p,{links,signature,total:4,next:null,terminal:{...terminal,page:3}}),/final-page evidence/);
});
test('missing, enabled, foreign, incomplete or wrong-page controls cannot certify a final page',()=>{
  const variants=[
    {...finalDoc,html:finalDoc.html.replace('aria-disabled="true"','aria-disabled="false"')},
    {...finalDoc,html:'<div id="gateway" class="searchResults"></div>'},
    {...finalDoc,url:brassring.replace('12345','99999')},
    {...finalDoc,text:finalDoc.text.replace('Page 2 of 2','Page 1 of 2')},
    {...finalDoc,text:'104 results\nRefine 50 results\nPage 2 of 3'},
  ];
  for(const doc of variants) assert.equal(verifiedBrowserPageEnd('brassring',brassring,[doc],2,links,false),undefined);
  assert.equal(verifiedBrowserPageEnd('brassring',brassring,[finalDoc],2,links,true),undefined);
});

const paycom='https://www.paycomonline.net/v4/ats/web.php/portal/76BABB9832D3B1C287C15C9DE9564594/career-page';
function publicPage(stale=false) {
  let current=1,typed='1',idsOnly=0;
  const jumps:number[]=[];
  const html=()=>Array.from({length:current===3?1:3},(_,i)=>`<a href="${paycom.replace('career-page','jobs/'+((current-1)*3+i+1+idsOnly))}">Job ${(current-1)*3+i+1+idsOnly}</a>`).join('');
  const text=()=>`${(current-1)*3+1}-${Math.min(current*3,7)} of 7 Results`;
  const empty={count:async()=>0,nth(){return this;},filter(){return this;}};
  const input={count:async()=>1,nth(){return this;},isVisible:async()=>true,isDisabled:async()=>false,getAttribute:async()=>null,inputValue:async()=>typed,fill:async(s:string)=>{typed=s;},press:async()=>{jumps.push(Number(typed));if(stale)idsOnly+=10;else current=Number(typed);}};
  const arrow={count:async()=>current<3?1:0,nth(){return this;},isVisible:async()=>true,isDisabled:async()=>false,getAttribute:async()=>null,click:async()=>{throw Error('Pointer click is intercepted by the published overlay');},press:async()=>{throw Error('Page-number input should avoid arrow replay');}};
  const frame={url:()=>paycom,content:async()=>html(),locator:(selector:string)=>selector==='body'?{innerText:async()=>text()}:selector.includes('forward arrow-icon')?arrow:empty,getByRole:()=>empty};
  const page={goto:async()=>{current=1;typed='1';return {status:()=>200};},url:()=>paycom,frames:()=>[frame],locator:()=>input,waitForTimeout:async()=>{},close:async()=>{}};
  return {context:{newPage:async()=>page},jumps};
}
test('Paycom advances through its public page-number field even when arrow pointer clicks are blocked',async()=>{
  const fake=publicPage(),reader=new BrowserAtsReader(fake.context as never,async()=>{});
  const first=await reader.page('paycom',paycom,1),second=await reader.page('paycom',paycom,2);
  assert.deepEqual(first.links.map(l=>l.id),['1','2','3']);
  assert.deepEqual(second.links.map(l=>l.id),['4','5','6']);
  assert.equal(second.pageNumberJump,true);
  assert.deepEqual(fake.jumps,[2]);
  await reader.close();
});
test('a resumed Paycom board jumps directly to its saved page rather than replaying earlier pages',async()=>{
  const fake=publicPage(),reader=new BrowserAtsReader(fake.context as never,async()=>{});
  const last=await reader.page('paycom',paycom,3);
  assert.deepEqual(fake.jumps,[3]);
  assert.deepEqual(last.links.map(l=>l.id),['7']);
  assert.equal(last.pageNumberJump,true);
  assert.equal(last.next,null);
  await reader.close();
});
test('changed cards without the requested published page range cannot advance saved work',async()=>{
  const fake=publicPage(true),reader=new BrowserAtsReader(fake.context as never,async()=>{});
  await reader.page('paycom',paycom,1);
  await assert.rejects(reader.page('paycom',paycom,2),/requested page/);
  await reader.close();
});

function brassringPage(alreadyResults=false) {
  let searched=alreadyResults,current=1,typed='1',ticks=0,searchClicks=0;
  const jumps:number[]=[];
  const empty={count:async()=>0,nth(){return this;},filter(){return this;}};
  const html=()=>searched?`<div id="gateway" class="searchResults"><input id="gotoPageInput"><button aria-label="Go to next page" aria-disabled="${current===2}"></button>${(current===1?['40','42']:['42','43']).map(id=>`<a href="${brassring}#jobDetails=${id}_6789">Account Manager</a>`).join('')}</div>`:'<main>Search Jobs at Example Inc</main>';
  const text=()=>searched?`4 results\nRefine 2 results\nPage ${current} of 2`:'Search Jobs at Example Inc';
  const search={count:async()=>!searched&&ticks>=2?1:0,nth(){return this;},isVisible:async()=>true,isDisabled:async()=>false,getAttribute:async()=>null,click:async()=>{searchClicks++;searched=true;}};
  const input={count:async()=>searched&&ticks>=3?1:0,nth(){return this;},isVisible:async()=>true,isDisabled:async()=>false,getAttribute:async()=>null,fill:async(s:string)=>{typed=s;},press:async()=>{jumps.push(Number(typed));current=Number(typed);}};
  const arrow={count:async()=>1,nth(){return this;},isVisible:async()=>true,isDisabled:async()=>false,getAttribute:async(n:string)=>n==='aria-disabled'?String(current===2):null,click:async()=>{throw Error('Saved-page replay should not click earlier arrows');}};
  const frame={url:()=>brassring,content:async()=>html(),locator:(s:string)=>s==='body'?{innerText:async()=>text()}:s==='button[aria-label="Go to next page"]'?arrow:empty,getByRole:()=>empty};
  const page={goto:async()=>({status:()=>200}),url:()=>brassring,frames:()=>[frame],locator:()=>input,getByRole:()=>search,getByText:()=>empty,waitForTimeout:async()=>{ticks++;},close:async()=>{}};
  return {context:{newPage:async()=>page},jumps,get searchClicks(){return searchClicks;}};
}
test('BrassRing waits for delayed search controls and directly resumes its requested final page',async()=>{
  const fake=brassringPage(),reader=new BrowserAtsReader(fake.context as never,async()=>{});
  const last=await reader.page('brassring',brassring,2);
  assert.equal(fake.searchClicks,1);
  assert.deepEqual(fake.jumps,[2]);
  assert.deepEqual(last.links.map(l=>l.id),['42','43']);
  assert.equal(last.terminal?.page,2);
  assert.equal(last.pageNumberJump,true);
  await reader.close();
});
test('BrassRing accepts an already rendered complete search page without requiring a home search button',async()=>{
  const fake=brassringPage(true),reader=new BrowserAtsReader(fake.context as never,async()=>{});
  const first=await reader.page('brassring',brassring,1);
  assert.equal(first.links.length,2);
  assert.equal(fake.searchClicks,0);
  await reader.close();
});

test('a publisher-declared temporary BrassRing outage retains retry status without waiting for missing controls',async()=>{
  let waits=0;
  const frame={url:()=>brassring,content:async()=>'<main>This site is temporarily unavailable. Please try again later.</main>',locator:()=>({innerText:async()=>'This site is temporarily unavailable. Please try again later.'})};
  const page={goto:async()=>({status:()=>200}),url:()=>brassring,frames:()=>[frame],close:async()=>{},waitForTimeout:async()=>{waits++;}};
  const reader=new BrowserAtsReader({newPage:async()=>page} as never,async()=>{});
  await assert.rejects(reader.page('brassring',brassring,1),/temporarily unavailable; retaining progress for retry/);
  assert.equal(waits,0);
  await reader.close();
});

const icims='https://careers-example.icims.com/jobs/search?in_iframe=1';
function linkedNextPage(initialHref:string|null) {
  let href=initialHref,current=1,clicks=0,navigations=0;
  const empty={count:async()=>0,nth(){return this;},filter(){return this;}};
  const next={count:async()=>1,nth(){return this;},isVisible:async()=>true,isDisabled:async()=>false,
    getAttribute:async(name:string)=>name==='href'?href:null,
    click:async()=>{clicks++;current++;}};
  const frame={url:()=>icims,content:async()=>`<a href="/jobs/${current}/account-manager/job">Account Manager</a>`,
    locator:(selector:string)=>selector==='body'?{innerText:async()=>'Account Manager'}:selector==='a[rel="next"]'?next:empty,
    getByRole:()=>empty};
  const page={goto:async()=>{navigations++;return {status:()=>200};},url:()=>icims,frames:()=>[frame],waitForTimeout:async()=>{},close:async()=>{}};
  return {context:{newPage:async()=>page},setHref(value:string|null){href=value;},get clicks(){return clicks;},get navigations(){return navigations;}};
}

test('pagination retains relative HTTPS links and normalizes JavaScript widget controls',async()=>{
  for(const href of [null,'','#next','javascript:void(0)','  JaVaScRiPt:void(0)  ']) {
    const fake=linkedNextPage(href),reader=new BrowserAtsReader(fake.context as never,async()=>{});
    try {
      assert.deepEqual((await reader.page('icims',icims,1)).next,{kind:'click'});
      assert.deepEqual((await reader.page('icims',icims,2)).links.map(link=>link.id),['2']);
      assert.equal(fake.clicks,1);
    }
    finally { await reader.close(); }
  }
  const fake=linkedNextPage('?in_iframe=1&pr=1'),reader=new BrowserAtsReader(fake.context as never,async()=>{});
  try { assert.deepEqual((await reader.page('icims',icims,1)).next,{kind:'url',url:icims+'&pr=1'}); }
  finally { await reader.close(); }
});

test('pagination rejects non-HTTPS and foreign destinations before saving a continuation',async()=>{
  for(const href of ['data:text/html,<script>alert(1)</script>','  DaTa:text/html,content',
    'vbscript:msgbox(1)','file:///tmp/private','mailto:someone@example.com',
    icims.replace('https:','http:'),icims.replace('careers-example','careers-other')]) {
    const fake=linkedNextPage(href),reader=new BrowserAtsReader(fake.context as never,async()=>{});
    try { await assert.rejects(reader.page('icims',icims,1)); assert.equal(fake.clicks,0); }
    finally { await reader.close(); }
  }
});

test('a reused pagination control cannot change to an unsafe destination before its click',async()=>{
  for(const href of ['data:text/html,content','vbscript:msgbox(1)','file:///tmp/private',
    icims.replace('https:','http:'),icims.replace('careers-example','careers-other')]) {
    const fake=linkedNextPage('#next'),reader=new BrowserAtsReader(fake.context as never,async()=>{});
    try {
      assert.deepEqual((await reader.page('icims',icims,1)).next,{kind:'click'});
      fake.setHref(href);
      await assert.rejects(reader.page('icims',icims,2));
      assert.equal(fake.clicks,0,'an unsafe live control must be rejected before it executes');
    } finally { await reader.close(); }
  }
});

test('saved pagination URLs cannot bypass the HTTPS navigation requirement',async()=>{
  const fake=linkedNextPage('#next'),reader=new BrowserAtsReader(fake.context as never,async()=>{});
  try {
    await assert.rejects(reader.page('icims',icims,2,icims.replace('https:','http:')));
    assert.equal(fake.navigations,0);
  } finally { await reader.close(); }
});
