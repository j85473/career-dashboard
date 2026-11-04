// Real job cards and details, with fixture storage; no production data is changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('prep packs upload from cards and details, survive reload, and keep existing documents', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const posting = Buffer.from('Original job description');
  const files = new Map([['jd', { fileName: 'Saved JD.txt', mimeType: 'text/plain; charset=utf-8', content: posting }]]);
  const job = { id: 'job-a', title: 'Channel Business Manager', company: 'Example', status: 'interviewing',
    description: 'Employer job description.', scoreAuthorityState: 'current', aimFitScore: 85, reqFitScore: 91, interviews: [] };
  const snapshot = () => ({ ...job, attachments: [...files].map(([id, item]) => ({ id, fileName: item.fileName,
    mimeType: item.mimeType, sizeBytes: item.content.length, uploadedAt: '2026-11-04T15:00:00Z' })) });
  const bundle = await build({ stdin: { contents: `
    import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
    import JobCard from './src/components/JobCard';import {ExpandOverlay} from './src/components/ExpandOverlay';
    function App(){const [job,setJob]=useState(null),[selected,setSelected]=useState(null);
      useEffect(()=>{fetch('/fixture').then(r=>r.json()).then(setJob)},[]);
      const update=(id,u)=>{setJob(j=>({...j,...u}));setSelected(j=>j?{...j,...u}:null)};
      return job&&<><div className="job-grid"><JobCard job={job} onSelect={setSelected} onJobUpdate={update}/></div>
      {selected&&<ExpandOverlay job={selected} onClose={()=>setSelected(null)} onJobUpdate={update}
        onStatusChange={()=>{throw Error('Unexpected lifecycle mutation')}} onCompanySelect={()=>{}}/>}</>}
    createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'ats-label', setup(builder) {
      builder.onResolve({ filter: /\/atsUtils$/ }, () => ({ path: 'ats', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const ATS_OPTIONS=["UKG"];export const identifyAts=()=>"UKG";' }));
    } }],
  });
  const css = await readFile(`${root}/src/app/globals.css`, 'utf8');
  const server = createServer((req,res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].contents); }
    if (req.url === '/style.css') { res.setHeader('Content-Type','text/css');return res.end(css); }
    if (req.url === '/fixture') { res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(snapshot())); }
    if (req.url.startsWith('/api/jobs/job-a/attachments/')) {
      const url = new URL(req.url,'http://localhost');
      const file = files.get(url.pathname.split('/').pop());
      if (!file) { res.statusCode=404;return res.end(); }
      res.setHeader('Content-Type',file.mimeType);
      res.setHeader('Content-Disposition',`${url.searchParams.has('inline')?'inline':'attachment'}; filename="${file.fileName}"`);
      return res.end(file.content);
    }
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root" style="padding:20px"></div><script src="/app.js"></script>');
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
    const page = await browser.newPage({ viewport: { width: 1440,height:1000 } });
    const errors = [];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const method = route.request().method();
      if (url.pathname === '/api/jobs/job-a/attachments' && method === 'POST') {
        const form = await new Request(url,{method:'POST',headers:route.request().headers(),body:route.request().postDataBuffer()}).formData();
        const file = form.get('file');
        if (file.name === 'Rejected.pdf') return route.fulfill({status:400,json:{error:'Only valid PDF, DOCX, and UTF-8 TXT documents are supported.'}});
        const id = `document-${files.size}`;
        files.set(id,{fileName:file.name,mimeType:file.type,content:Buffer.from(await file.arrayBuffer())});
        return route.fulfill({status:201,json:{attachment:snapshot().attachments.find(item=>item.id===id)}});
      }
      assert.equal(method,'GET','document actions must not patch the job');
      if (url.pathname === '/api/jobs/job-a') return route.fulfill({json:{job:snapshot()}});
      if (url.pathname.endsWith('/repeats')) return route.fulfill({json:{repeats:[]}});
      if (url.pathname.endsWith('/combined')) return route.fulfill({json:{copies:[]}});
      const file = files.get(url.pathname.split('/').pop());
      if (file) return route.fulfill({body:file.content,headers:{'Content-Type':file.mimeType,'Content-Disposition':`${url.searchParams.has('inline')?'inline':'attachment'}; filename="${file.fileName}"`}});
      return route.abort();
    });
    await page.goto(origin);
    const card = page.locator('.job-card');
    await card.getByRole('link',{name:'Saved JD.txt',exact:true}).waitFor();
    const chooser = page.waitForEvent('filechooser');
    await card.getByRole('button',{name:'Attach prep pack',exact:true}).click();
    const pdf = Buffer.from('%PDF-1.7\nInterview prep pack fixture\n%%EOF');
    await (await chooser).setFiles({name:'Example Interview Prep Pack.pdf',mimeType:'application/pdf',buffer:pdf});
    const pack = card.getByRole('link',{name:'Example Interview Prep Pack.pdf',exact:true});
    await pack.waitFor();
    assert.match(await pack.getAttribute('href'),/\?inline=1$/);
    assert.equal(await pack.getAttribute('target'),'_blank');
    assert.equal(await page.getByRole('dialog').count(),0,'uploading must not open job details');
    const download = page.waitForEvent('download');
    await card.getByRole('link',{name:'Download Example Interview Prep Pack.pdf',exact:true}).click();
    const saved = await download;
    assert.equal(saved.suggestedFilename(),'Example Interview Prep Pack.pdf');
    assert.deepEqual(await readFile(await saved.path()),pdf);
    await page.reload();
    await card.getByRole('link',{name:'Example Interview Prep Pack.pdf',exact:true}).waitFor();
    await card.getByRole('button',{name:'Open Channel Business Manager at Example'}).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('link',{name:'Example Interview Prep Pack.pdf',exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Attach prep pack',exact:true}).waitFor();
    await dialog.locator('input[type=file]').setInputFiles({name:'Follow-up notes.txt',mimeType:'text/plain',buffer:Buffer.from('Practice the opening.')});
    await dialog.getByRole('link',{name:'Follow-up notes.txt',exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Close job details'}).click();
    await card.getByRole('link',{name:'Follow-up notes.txt',exact:true}).waitFor();
    await card.locator('input[type=file]').setInputFiles({name:'Rejected.pdf',mimeType:'application/pdf',buffer:Buffer.from('bad content')});
    await card.getByRole('alert').waitFor();
    assert.equal(files.size,3,'a rejected upload keeps the existing JD and prep documents');
    await page.screenshot({path:'/tmp/career-prep-pack-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    const size = await card.locator('.job-documents').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}));
    assert.ok(size.scrollWidth<=size.width+1,'document names and actions fit the mobile card');
    await page.screenshot({path:'/tmp/career-prep-pack-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
  } finally { await browser?.close();await new Promise(resolve=>server.close(resolve)); }
});
