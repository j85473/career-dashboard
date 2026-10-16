// Run: node --test tests/browser/advancedJobSearch.test.mjs
// Uses the real search component and stylesheet with fixture-only API responses.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

let server, browser, origin;
before(async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {AdvancedSearchTab} from './src/components/AdvancedSearchTab'; createRoot(document.getElementById('root')).render(<AdvancedSearchTab onSelectJob={()=>{}} onJobUpdate={()=>{}}/>);`,
      resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    // Card rendering is outside this search-form test; avoid its server-only ATS dependencies.
    plugins: [{ name: 'job-card-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/JobCard$/ }, () => ({ path: 'card', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default function JobCard(){return null;}' }));
    } }],
  });
  const css = await readFile(`${root}/src/app/globals.css`, 'utf8');
  server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

test('full URLs are submitted intact in Everything and Job URLs with inclusive queue filters', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const requests = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/ats-companies') return route.fulfill({ json: { companies: [], platforms: [] } });
    if (url.pathname === '/api/jobs/search') {
      requests.push(url.searchParams);
      return route.fulfill({ json: { jobs: [], pagination: { page: 1, total: 0, hasMore: false } } });
    }
    throw new Error(`Unexpected API request: ${url.pathname}`);
  });
  await page.goto(origin);
  const query = `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=87997030-820d-4515-bec9-cf549d124af7&ccId=19000101_000001&jobId=729498&lang=en_US&utm_source=${'x'.repeat(300)}`;
  const input = page.getByLabel('Search terms', { exact: true });
  await input.fill(query);
  await page.getByRole('button', { name: 'Search jobs', exact: true }).click();
  await page.getByText('No jobs match this search and queue combination.', { exact: true }).waitFor();
  assert.equal(requests[0].get('q'), query);
  assert.equal(requests[0].get('field'), 'all');
  assert.equal(requests[0].get('statuses'), null);

  await page.getByRole('button', { name: 'Job URLs', exact: false }).click();
  await page.getByLabel('Applied', { exact: true }).check();
  await page.getByLabel('Cooldown', { exact: true }).check();
  await page.getByRole('button', { name: 'Search jobs', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.advanced-job-results[aria-busy="true"]'));
  assert.equal(requests[1].get('q'), query);
  assert.equal(requests[1].get('field'), 'url');
  assert.equal(requests[1].get('statuses'), 'applied,cooldown');
  assert.equal(await input.getAttribute('placeholder'), 'Paste a job URL or search part of a link…');

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const options = await page.locator('.advanced-field-option').evaluateAll(elements => elements.map(element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, scroll: element.scrollWidth, client: element.clientWidth };
    }));
    assert.equal(options.length, 5);
    assert.ok(options.every(option => option.left >= 0 && option.right <= width && option.scroll <= option.client));
  }
  assert.deepEqual(errors, []);
  await page.close();
});
