// Real card/detail components; fixture-only APIs, with all mutations refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('a combined copy shows the prior application and opens its saved card without promoting it', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const applied = { id: 'original', title: 'Field Sales Representative - Minnesota', company: 'Mark Anthony Group',
    status: 'applied', appliedAt: '2026-09-24T18:33:03.990Z', description: 'Original employer posting.',
    scoreAuthorityState: 'current', aimFitScore: 84, reqFitScore: 93 };
  const copy = { ...applied, id: 'copy', status: 'dismissed', appliedAt: null, aimFitScore: 87, reqFitScore: 92,
    currentScore: { id: 'score', evaluationType: 'standard', passed: true, aimFitScore: 87,
      experienceFitScore: 92, aimReason: 'Strong distributor fit.', experienceReason: 'Direct beverage experience.' },
    passReason: 'Consolidated after URL edit into job original',
    combinedInto: { ...applied, alreadyApplied: true } };
  const bundle = await build({ stdin: { contents: `
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import JobCard from './src/components/JobCard'; import {ExpandOverlay} from './src/components/ExpandOverlay';
    const copy=${JSON.stringify(copy)};
    function App(){const [selected,setSelected]=useState(null);return <>
      <JobCard job={copy} onSelect={setSelected}/>
      {selected&&<ExpandOverlay key={selected.id} job={selected} onClose={()=>setSelected(null)}
        onSelectJob={setSelected} onStatusChange={()=>{throw Error('Unexpected mutation')}} onCompanySelect={()=>{}}/>}
    </>}; createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    // ATS parsing has server-only decompression code; it is unrelated to this interaction.
    plugins: [{ name: 'ats-label', setup(builder) {
      builder.onResolve({ filter: /\/atsUtils$/ }, () => ({ path: 'ats', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const ATS_OPTIONS=["UKG"]; export const identifyAts=()=>"UKG";' }));
    } }],
  });
  const css = await readFile(`${root}/src/app/globals.css`, 'utf8');
  const server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>');
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      assert.equal(route.request().method(), 'GET', 'viewing saved applications cannot mutate cards');
      if (url.pathname === '/api/jobs/copy') return route.fulfill({ json: { job: copy } });
      if (url.pathname === '/api/jobs/original') return route.fulfill({ json: { job: applied } });
      if (url.pathname.endsWith('/combined')) return route.fulfill({ json: { copies: [] } });
      if (url.pathname.endsWith('/repeats')) return route.fulfill({ json: { repeats: [] } });
      return route.abort();
    });
    await page.goto(origin);
    await page.getByText('Already applied · Sep 24, 2026', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open Field Sales Representative - Minnesota at Mark Anthony Group' }).click();
    await page.getByRole('button', { name: 'View application', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Promote to Inbox' }).count(), 0);
    assert.match(await page.locator('.repeat-notice').innerText(), /Your application is saved on the original card/);
    assert.match(await page.locator('.expand-col.left-col').innerText(), /87/);
    assert.match(await page.locator('.expand-col.left-col').innerText(), /92/);
    await page.screenshot({ path: '/tmp/career-combined-application.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const notice = await page.locator('.combined-copy-notice').evaluate(element => ({
      width: element.clientWidth, scrollWidth: element.scrollWidth,
    }));
    assert.ok(notice.scrollWidth <= notice.width + 1, 'the application notice and buttons fit on mobile');
    await page.getByRole('button', { name: 'View application', exact: true }).click();
    await page.getByRole('button', { name: 'Interviewing', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'View application', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
