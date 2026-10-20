// Mount the real cards with fixture data; no Dashboard database is used.
// Run: PLAYWRIGHT_CHANNEL=chrome node --test tests/browser/acostaPriority.test.mjs
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

let server, browser, origin;
before(async () => {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import JobCard from './src/components/JobCard';
      const jobs = [
        {id:'priority', title:'Google Channel Sales Manager',company:'Acosta',status:'inbox',scoringStatus:'skipped',source:'ATS-oracle',
          url:'https://eczy.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/fixture', location:'Minneapolis, MN'},
        {id:'ordinary',title:'Channel Sales Manager',company:'The Mosaic Company',status:'inbox'},
        {id:'other-role',title:'Retail Merchandiser',company:'Acosta',status:'inbox'}
      ];
      createRoot(document.getElementById('root')).render(<main style={{maxWidth:920,margin:'24px auto',padding:16}}>
        <h1>Inbox</h1><div className="jobs-grid">{jobs.map(job=><JobCard key={job.id} job={job} onSelect={()=>{}}/>)}</div>
      </main>);`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx' },
    // The shared ATS utility also exports server-only gzip parsing. Fail if
    // a card ever calls it; its unused implementation is outside this fixture.
    plugins: [{ name: 'server-gzip-guard', setup(build) {
      build.onResolve({ filter: /^node:zlib$/ }, () => ({ path: 'gzip', namespace: 'server-guard', sideEffects: false }));
      build.onLoad({ filter: /.*/, namespace: 'server-guard' }, () => ({ contents: 'export function gunzipSync() { throw new Error("Server gzip called by card"); }' }));
    } }],
    bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' },
  });
  const css = readFileSync(new URL('../../src/app/globals.css', import.meta.url), 'utf8');
  server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
    if (req.url === '/styles.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    if (req.url.startsWith('/api/')) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

for (const width of [1100, 390]) test(`Acosta gold highlight renders clearly at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.fulfill({ status: 404, body: '' }));
  await page.goto(origin);
  const card = page.locator('.acosta-channel-sales-priority-job');
  await card.waitFor();
  assert.equal(await card.count(), 1);
  assert.equal(await card.locator('[role="note"]').innerText(), '★ ACOSTA / MOSAIC — CHANNEL SALES ★');
  assert.equal(await card.locator('[role="status"]').innerText(), 'Priority opportunity · Ready to review');
  const border = () => card.evaluate(el => ({ color: getComputedStyle(el).borderTopColor, width: getComputedStyle(el).borderTopWidth }));
  assert.deepEqual(await border(), { color: 'rgb(250, 204, 21)', width: '2px' });
  await card.hover();
  await page.waitForTimeout(350);
  assert.deepEqual(await border(), { color: 'rgb(253, 224, 71)', width: '2px' });
  assert.equal(await page.locator('article:not(.acosta-channel-sales-priority-job) .priority-opportunity-banner').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  if (process.env.ACOSTA_PREVIEW_DIR) {
    mkdirSync(process.env.ACOSTA_PREVIEW_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.ACOSTA_PREVIEW_DIR}/acosta-priority-${width}.png`, fullPage: true });
  }
  await page.close();
});
