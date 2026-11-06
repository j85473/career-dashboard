// Real card/dialog components with fixture APIs; no saved jobs are changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const locations = [
  '9151 E Panorama Cir, Centennial, CO 80112, United States of America',
  ...Array.from({ length: 54 }, (_, i) => `Remote site ${i + 1}, Remote, MN 55344, MN 55344, United States of America`),
];
const fixture = { id: 'many-locations', title: 'Field Sales Manager', company: 'Example Electronics',
  status: 'inbox', location: locations.join('; '), description: 'Manage channel partners. '.repeat(1500),
  scoreAuthorityState: 'current', aimFitScore: 84, reqFitScore: 76 };

test('large location lists preserve every address while cards and dialog actions remain usable', async () => {
  const bundle = await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import JobCard from './src/components/JobCard';import {ExpandOverlay} from './src/components/ExpandOverlay';
    const job=${JSON.stringify(fixture)};
    function App(){const [selected,setSelected]=useState(null);return <>
      <div style={{maxWidth:400,padding:16}}><JobCard job={job} onSelect={setSelected}/></div>
      {selected&&<ExpandOverlay job={selected} onClose={()=>setSelected(null)} onCompanySelect={()=>{}}
        onStatusChange={()=>{throw Error('Unexpected mutation')}}/>}</>}
    createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'ats-label', setup(builder) {
      builder.onResolve({ filter: /\/atsUtils$/ }, () => ({ path: 'ats', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const ATS_OPTIONS=["Workday"];export const identifyAts=()=>"Workday";' }));
    } }],
  });
  const css = await readFile(`${root}/src/app/globals.css`, 'utf8');
  const server = createServer((req,res)=>{
    if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].contents)}
    if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');return res.end(css)}
    res.setHeader('Content-Type','text/html');
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>');
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
    browser=await engine.launch({headless:true,...(engine === chromium ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
    for (const viewport of [{width:1440,height:900},{width:1024,height:600},{width:390,height:844},{width:320,height:568}]) {
      const page=await browser.newPage({viewport});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(()=>{window.open=url=>{window.postingOpened=url;return null}});
      await page.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.origin!==origin)return route.abort();
        if(!url.pathname.startsWith('/api/'))return route.continue();
        assert.equal(route.request().method(),'GET','viewing locations must not change stored jobs');
        if(url.pathname===`/api/jobs/${fixture.id}`)return route.fulfill({json:{job:fixture}});
        if(url.pathname.endsWith('/combined'))return route.fulfill({json:{copies:[]}});
        return route.abort();
      });
      await page.goto(origin);
      assert.equal(await page.locator('.card-location').innerText(),'55 listed locations · includes remote');
      assert.ok((await page.locator('.card-location').boundingBox()).height < 40,'card summary stays compact');
      await page.getByRole('button',{name:'Open Field Sales Manager at Example Electronics'}).click();
      const summary=page.locator('.job-locations summary');
      await summary.waitFor();
      assert.equal(await page.locator('.job-locations').getAttribute('open'),null,'full locations start collapsed');
      await page.getByRole('button',{name:'View Posting',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.postingOpened),`/api/jobs/${fixture.id}/redirect`);
      await summary.click();
      assert.deepEqual(await page.locator('.job-locations-list li').allTextContents(),locations);
      const list=page.getByRole('region',{name:'All listed job locations'});
      const dimensions=await list.evaluate(el=>({height:el.clientHeight,content:el.scrollHeight,width:el.clientWidth,contentWidth:el.scrollWidth}));
      assert.ok(dimensions.height<=184,'full list is bounded');
      assert.ok(dimensions.content>dimensions.height,'full list can scroll');
      assert.ok(dimensions.contentWidth<=dimensions.width+1,'addresses wrap inside the list');
      await list.focus();
      await list.press('End');
      await page.waitForFunction(()=>document.querySelector('.job-locations-list').scrollTop>0);
      await page.getByRole('button',{name:'View Posting',exact:true}).click();
      await page.getByRole('button',{name:'Dismiss',exact:true}).click();
      await page.getByRole('button',{name:'Confirm Dismiss',exact:true}).click({trial:true});
      if (viewport.width < 768) {
        await page.locator('.expand-modal').evaluate(el=>{el.scrollTop=(el.scrollHeight-el.clientHeight)/2});
        const footer=await page.locator('.expand-footer').boundingBox();
        assert.ok(footer.y>=0 && footer.y+footer.height<=viewport.height+1,'actions stay visible while reading a long job description');
      }
      const dialog=await page.getByRole('dialog').evaluate(el=>({width:el.clientWidth,content:el.scrollWidth}));
      assert.ok(dialog.content<=dialog.width+1,'dialog stays inside the viewport');
      if(process.env.LOCATION_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.LOCATION_SCREENSHOT_DIR}/locations-${process.env.PLAYWRIGHT_BROWSER||'chromium'}-${viewport.width}.png`});
      await page.getByRole('button',{name:'Close job details'}).click();
      assert.deepEqual(errors,[]);
      await page.close();
    }
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
});
