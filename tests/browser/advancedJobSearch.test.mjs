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

test('location and distance combine with titles and queues, persist on load more, and clear independently', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const requests = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/ats-companies') return route.fulfill({ json: { companies: [], platforms: [] } });
    requests.push(url.searchParams);
    const number = Number(url.searchParams.get('page'));
    if (url.searchParams.get('location') === 'Springfield') return route.fulfill({ status: 400, json: { error: 'Add a state or ZIP code to distinguish Springfield.' } });
    return route.fulfill({ json: {
      jobs: [{ id: `job-${number}`, status: 'applied' }],
      location: url.searchParams.has('location') ? { label: 'Within 50 miles of Minneapolis, MN 55405' } : null,
      pagination: { page: number, total: 2, hasMore: number === 1 },
    } });
  });
  await page.goto(origin);
  const location = page.getByLabel('City, state, or ZIP code', { exact: true });
  const distance = page.getByLabel('Distance', { exact: true });
  assert.equal(await distance.isDisabled(), true);
  await page.getByLabel('Search terms', { exact: true }).fill('channel sales manager');
  await page.getByRole('button', { name: 'Job titles', exact: false }).click();
  await page.getByLabel('Applied', { exact: true }).check();
  await location.fill('55405');
  await distance.selectOption('50');
  await page.getByRole('button', { name: 'Search jobs', exact: true }).click();
  await page.getByText('Within 50 miles of Minneapolis, MN 55405', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Load more', exact: false }).click();
  await page.getByText('2 of 2', { exact: true }).waitFor();
  for (const params of requests.slice(0, 2)) {
    assert.equal(params.get('location'), '55405');
    assert.equal(params.get('radius'), '50');
    assert.equal(params.get('statuses'), 'applied');
    assert.equal(params.get('field'), 'title');
    assert.equal(params.get('q'), 'channel sales manager');
  }
  assert.equal(requests[1].get('page'), '2');

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    const bounds = await page.locator('.advanced-location-row').evaluate(element => ({
      right: element.getBoundingClientRect().right, scroll: element.scrollWidth, client: element.clientWidth,
    }));
    assert.ok(bounds.right <= width && bounds.scroll <= bounds.client, `location controls fit at ${width}px`);
  }
  if (process.env.SEARCH_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SEARCH_SCREENSHOT_DIR}/location-search-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: `${process.env.SEARCH_SCREENSHOT_DIR}/location-search-desktop.png`, fullPage: true });
  }

  await location.fill('Springfield');
  await page.getByRole('button', { name: 'Search jobs', exact: true }).click();
  await page.getByRole('alert').getByText('Add a state or ZIP code to distinguish Springfield.').waitFor();
  await page.getByRole('button', { name: 'Clear location', exact: true }).click();
  await page.getByRole('button', { name: 'Search jobs', exact: true }).click();
  await page.getByText('1 of 2', { exact: true }).waitFor();
  assert.equal(requests.at(-1).get('location'), null);
  assert.equal(requests.at(-1).get('radius'), null);
  assert.equal(await page.getByLabel('Applied', { exact: true }).isChecked(), true);

  await page.getByRole('button', { name: 'Clear results', exact: true }).click();
  assert.equal(await distance.inputValue(), '25');
  await location.fill('55405');
  assert.equal(await page.getByRole('button', { name: 'Search jobs', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Search jobs', exact: true }).click();
  await page.getByText('1 of 2', { exact: true }).waitFor();
  assert.equal(requests.at(-1).get('q'), '');
  await page.close();
});
