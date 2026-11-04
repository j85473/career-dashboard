// Real job-card controls, with a fixture API so no saved jobs are changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('interview cards add and reschedule multiple rounds, survive reload, and fit on mobile', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  let interviews = [];
  const writes = [];
  const fixture = { id: 'job-a', title: 'Channel Business Manager', company: 'Example',
    status: 'interviewing', scoreAuthorityState: 'current', aimFitScore: 85, reqFitScore: 91 };
  const bundle = await build({ stdin: { contents: `
    import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
    import JobCard from './src/components/JobCard';
    import {compareInterviewJobs} from './src/lib/jobInterviewSchedule';
    const now=Date.parse('2026-11-04T15:00:00Z');
    function App(){const [jobs,setJobs]=useState([]);useEffect(()=>{fetch('/fixture').then(r=>r.json()).then(setJobs)},[]);
      return <div className="job-grid">{[...jobs].sort((a,b)=>compareInterviewJobs(a,b,now)).map(job=><JobCard key={job.id}
      job={job} onSelect={()=>{window.unexpectedOpen=true}} onJobUpdate={(id,updates)=>setJobs(prev=>prev.map(j=>j.id===id?{...j,...updates}:j))}/>)}</div>
    }createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'ats-label', setup(builder) {
      builder.onResolve({ filter: /\/atsUtils$/ }, () => ({ path: 'ats', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const ATS_OPTIONS=["UKG"];export const identifyAts=()=>"UKG";' }));
    } }],
  });
  const css = await readFile(`${root}/src/app/globals.css`, 'utf8');
  const server = createServer((req,res)=>{
    if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].contents)}
    if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');return res.end(css)}
    if(req.url==='/fixture'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify([
      {...fixture,interviews},
      {...fixture,id:'job-b',title:'Regional Manager',interviews:[{id:'fixed',label:'Panel',scheduledAt:'2026-11-06T16:00:00Z'}]},
    ]))}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root" style="padding:20px"><script src="/app.js"></script></div>');
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL});
    const page=await browser.newPage({viewport:{width:1400,height:1000},timezoneId:'America/Chicago'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin)return route.abort();
      if(!url.pathname.startsWith('/api/'))return route.continue();
      if(url.pathname!=='/api/jobs/job-a/interviews')return route.abort();
      const method=route.request().method();const body=route.request().postDataJSON();writes.push({method,body});
      if(method==='POST')interviews.push({id:`round-${writes.length}`,scheduledAt:body.scheduledAt,label:body.label});
      else if(method==='PATCH')interviews=interviews.map(item=>item.id===body.id?{...item,...body}:item);
      else if(method==='DELETE')interviews=interviews.filter(item=>item.id!==body.id);
      else assert.fail(`Unexpected request: ${method}`);
      return route.fulfill({json:{interviews}});
    });
    await page.goto(origin);
    const card=page.locator('.job-card').filter({has:page.getByRole('button',{name:'Open Channel Business Manager at Example'})});
    await card.getByText('No interview date set',{exact:true}).waitFor();
    assert.match(await page.locator('.job-card').first().innerText(),/Regional Manager/);
    await card.getByRole('button',{name:'+ Add interview date',exact:true}).click();
    await card.getByLabel('Round or interviewer (optional)').fill('Recruiter');
    await card.getByLabel('Interview date and time').fill('2026-11-05T09:30');
    await card.getByRole('button',{name:'Save interview',exact:true}).click();
    await card.locator('.interview-schedule-form').waitFor({state:'hidden'});
    await card.getByRole('button',{name:'Edit Recruiter date'}).waitFor();
    assert.equal(interviews[0].scheduledAt,'2026-11-05T15:30:00.000Z');
    assert.match(await page.locator('.job-card').first().innerText(),/Channel Business Manager/);
    await card.getByRole('button',{name:'+ Add interview date',exact:true}).click();
    await card.getByLabel('Round or interviewer (optional)').fill('Hiring manager');
    await card.getByLabel('Interview date and time').fill('2026-11-09T14:00');
    await card.getByRole('button',{name:'Save interview',exact:true}).click();
    await card.locator('.interview-schedule-form').waitFor({state:'hidden'});
    await card.getByRole('button',{name:'Edit Hiring manager date'}).waitFor();
    assert.equal(interviews.length,2);
    await card.getByRole('button',{name:'Edit Recruiter date'}).click();
    await card.getByLabel('Interview date and time').fill('2026-11-07T10:00');
    await card.getByRole('button',{name:'Save interview',exact:true}).click();
    await card.locator('.interview-schedule-form').waitFor({state:'hidden'});
    await card.getByRole('button',{name:'Edit Recruiter date'}).waitFor();
    assert.equal(writes.at(-1).method,'PATCH');
    assert.match(await page.locator('.job-card').first().innerText(),/Regional Manager/);
    await page.reload();
    await card.getByRole('button',{name:'Edit Hiring manager date'}).waitFor();
    assert.match(await card.innerText(),/10:00 AM CST/);
    assert.equal(await page.evaluate(()=>Boolean(window.unexpectedOpen)),false,'editing dates must not open the job details');
    await page.screenshot({path:'/tmp/career-interview-schedule-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await card.getByRole('button',{name:'Edit Hiring manager date'}).click();
    const dimensions=await card.locator('.interview-schedule').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}));
    assert.ok(dimensions.scrollWidth<=dimensions.width+1,'interview controls fit the mobile card');
    await page.screenshot({path:'/tmp/career-interview-schedule-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
});
