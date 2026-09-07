// Run: node --test tests/browser/inboxScroll.test.mjs (or PLAYWRIGHT_CHANNEL=chrome)
// Safari engine: PLAYWRIGHT_BROWSER=webkit. INBOX_TEST_APP_ORIGIN optionally
// serves an existing Next build's HTML/assets; browser API calls stay mocked.
// Mounts the real Dashboard, cards, dialog and stylesheet. Every API is mocked;
// the loopback fixture never reads or writes production job data.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
let browser, server, origin;

function configuredTestAppOrigin() {
  const rawOrigin = process.env.INBOX_TEST_APP_ORIGIN;
  if (!rawOrigin) return null;

  const appOrigin = new URL(rawOrigin);
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(appOrigin.hostname);
  if (
    appOrigin.protocol !== 'http:'
    || !isLoopback
    || appOrigin.username
    || appOrigin.password
    || appOrigin.pathname !== '/'
    || appOrigin.search
    || appOrigin.hash
  ) {
    throw new Error('INBOX_TEST_APP_ORIGIN must be an HTTP loopback origin without credentials, a path, a query, or a fragment.');
  }

  return appOrigin.origin;
}

before(async () => {
  const configuredOrigin = configuredTestAppOrigin();
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Dashboard from './src/components/Dashboard'; createRoot(document.getElementById('root')).render(<Dashboard/>);`,
      resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'navigation-fixture', setup(builder) {
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const usePathname=()=>"/"; export const useSearchParams=()=>new URLSearchParams();' }));
    } }],
  });
  const css = await readFile(`${root}/src/app/globals.css`, 'utf8');
  server = createServer(async (req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = configuredOrigin ?? `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  browser = await engine.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function fixture(viewport, { loadMore = true } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('pageerror', error => console.error('Browser error:', error.message));
  const state = { refreshDelay: 0, mutationDelay: 0, failRefresh: false, requests: [], mutations: 0 };
  const jobs = Array.from({ length: 150 }, (_, index) => ({
    id: `fixture-${index + 1}`, title: `Account Manager ${index + 1}`, company: `Company ${index + 1}`,
    status: 'inbox', tailoringStaged: false, source: 'ATS-workday', location: 'Remote, United States',
    createdAt: '2026-09-06T10:00:00Z', updatedAt: '2026-09-06T10:00:00Z', description: 'Manage customer relationships and support retail partners.',
    url: 'https://example.invalid/job', scoreAuthorityState: 'current', aimAuthorityState: 'current', experienceAuthorityState: 'current',
    aimFitScore: 85, reqFitScore: 80,
  }));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    if (url.pathname === '/api/pipeline/status') return json({ isRunning: false });
    if (url.pathname === '/api/jobs') {
      const requestedPage = Number(url.searchParams.get('page'));
      const status = url.searchParams.get('status');
      state.requests.push({ page: requestedPage, status });
      if (state.mutations && state.refreshDelay) await new Promise(resolve => setTimeout(resolve, state.refreshDelay));
      if (state.mutations && state.failRefresh) return route.fulfill({ status: 500, json: { error: 'Fixture refresh failure' } });
      const visible = jobs.filter(job => job.status === status);
      return json({ jobs: visible.slice((requestedPage - 1) * 48, requestedPage * 48), pagination: {
        page: requestedPage, limit: 48, total: visible.length, totalPages: Math.max(1, Math.ceil(visible.length / 48)), hasMore: requestedPage * 48 < visible.length,
      } });
    }
    const job = jobs.find(job => url.pathname === `/api/jobs/${job.id}` || url.pathname === `/api/jobs/${job.id}/pass`);
    if (job) {
      if (['PATCH', 'POST'].includes(route.request().method())) {
        state.mutations++;
        if (state.mutationDelay) await new Promise(resolve => setTimeout(resolve, state.mutationDelay));
        Object.assign(job, route.request().postDataJSON());
        if (url.pathname.endsWith('/pass')) job.status = 'passed';
        // Mimic the backend also cooling two other jobs above the viewport.
        jobs[9].status = 'cooldown'; jobs[10].status = 'cooldown';
      }
      return json({ job });
    }
    throw new Error(`Unexpected API: ${route.request().method()} ${url.pathname}`);
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 48);
  if (loadMore) {
    await page.getByRole('button', { name: /^Load more/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 96);
  }
  return { context, page, state };
}
const position = page => page.evaluate(() => ({ main: document.getElementById('main').scrollTop, window: window.scrollY }));
async function openScrolledJob(page) {
  await page.getByRole('button', { name: 'Open Account Manager 70 at Company 70', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  return position(page);
}

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${name}: Applied preserves the grid, scroll and loaded pages, with no pagination gaps`, async () => {
    const { context, page, state } = await fixture(viewport);
    try {
      const before = await openScrolledJob(page);
      assert.ok(Math.max(before.main, before.window) > 1000);
      await page.evaluate(() => { window.survivingCard = [...document.querySelectorAll('.job-card')].find(card => card.textContent.includes('Account Manager 72')); });
      state.refreshDelay = 350;
      await page.getByRole('button', { name: "I've Applied", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 95);
      assert.equal(await page.evaluate(() => window.survivingCard.isConnected), true, 'grid remains mounted during refresh');
      assert.ok(Math.max(...Object.values(await position(page))) > 1000, 'no jump to the top while refreshing');
      await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 96 && ![...document.querySelectorAll('.job-card')].some(card => /Account Manager 10\b/.test(card.textContent)));
      const after = await position(page);
      // Removing three cards may naturally move one or two grid rows, but must
      // never discard the user's loaded range or reset either scroll container.
      const rowHeight = await page.locator('.job-card').first().evaluate(card => card.getBoundingClientRect().height);
      assert.ok(Math.abs(Math.max(after.main, after.window) - Math.max(before.main, before.window)) < rowHeight * 4);
      assert.equal(await page.getByRole('button', { name: 'Open Account Manager 70 at Company 70', exact: true }).count(), 0);
      assert.deepEqual(state.requests.slice(-2).map(request => request.page).sort(), [1, 2]);
      await page.getByRole('button', { name: /^Load more/ }).click();
      await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 144);
      await page.getByRole('button', { name: /^Load more/ }).click();
      await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 147);
      const numbers = await page.locator('.job-card-open').allTextContents();
      assert.equal(new Set(numbers).size, 147);
      assert.deepEqual(numbers.map(title => Number(title.replace('Account Manager ', ''))), Array.from({ length: 150 }, (_, i) => i + 1).filter(i => ![10, 11, 70].includes(i)));
      console.log(`${name}: scroll before=${JSON.stringify(before)} after=${JSON.stringify(after)}; 147 distinct remaining jobs verified`);
    } finally { await context.close(); }
  });
}

test('a failed background refresh keeps the applied decision and scroll; retry preserves loaded pages', async () => {
  const { context, page, state } = await fixture({ width: 1440, height: 900 });
  try {
    await openScrolledJob(page);
    state.failRefresh = true;
    await page.getByRole('button', { name: "I've Applied", exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('.job-card').count(), 95);
    assert.ok((await position(page)).main > 1000);
    assert.equal(await page.getByRole('button', { name: 'Open Account Manager 70 at Company 70', exact: true }).count(), 0);
    state.failRefresh = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 96);
    assert.deepEqual(state.requests.slice(-2).map(request => request.page).sort(), [1, 2]);
  } finally { await context.close(); }
});

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  for (const action of ['Applied', 'Passed']) {
    test(`${name}: ${action} preserves the visible first-page card through both removal and refresh`, async () => {
      const { context, page, state } = await fixture(viewport, { loadMore: false });
      try {
        const target = page.getByRole('button', { name: 'Open Account Manager 35 at Company 35', exact: true });
        await target.click();
        await page.getByRole('dialog').waitFor();
        const anchor = await page.evaluate(() => {
          const main = document.getElementById('main');
          const top = Math.max(0, main.getBoundingClientRect().top);
          const card = [...main.querySelectorAll('.job-card')].find(card => {
            const rect = card.getBoundingClientRect();
            return rect.top >= top && rect.top < innerHeight && !card.textContent.includes('Account Manager 35');
          });
          window.anchorCard = card;
          return card.getBoundingClientRect().top;
        });
        state.refreshDelay = 300;
        if (action === 'Applied') await page.getByRole('button', { name: "I've Applied", exact: true }).click();
        else {
          await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
          await page.getByRole('button', { name: 'Confirm Dismiss', exact: true }).click();
        }
        await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 47);
        assert.ok(Math.abs(await page.evaluate(() => window.anchorCard.getBoundingClientRect().top) - anchor) < 2, 'optimistic removal preserves the reading position');
        await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 48 && ![...document.querySelectorAll('.job-card')].some(card => /Account Manager 10\b/.test(card.textContent)));
        assert.ok(Math.abs(await page.evaluate(() => window.anchorCard.getBoundingClientRect().top) - anchor) < 2, 'server refresh preserves the reading position');
        assert.equal(state.requests.at(-1).page, 1);
      } finally { await context.close(); }
    });
  }
}

test('a delayed Applied save cannot replace a different tab opened during the request', async () => {
  const { context, page, state } = await fixture({ width: 1440, height: 900 });
  try {
    await openScrolledJob(page);
    state.mutationDelay = 350;
    await page.getByRole('button', { name: "I've Applied", exact: true }).click();
    await page.locator('.nav-tab').filter({ hasText: /^interviewing$/ }).click();
    await page.getByText('No jobs found in interviewing.').waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.job-card').count(), 0);
    assert.equal(state.requests.at(-1).status, 'interviewing');
  } finally { await context.close(); }
});
