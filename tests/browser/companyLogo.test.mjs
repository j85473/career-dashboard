// Run: PLAYWRIGHT_CHANNEL=chrome node --test tests/browser/companyLogo.test.mjs
// Mounts the real component; all image requests are fixtures with no external data access.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

let server, browser, origin;
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
before(async () => {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {CompanyLogo} from './src/components/CompanyLogo'; createRoot(document.getElementById('root')).render(<CompanyLogo company="Acosta" jobId="2047e114-ee0e-4c14-ae49-1d44075ad263" url="https://tenant.oraclecloud.com/sites/CX_1/job/32088"/>);`,
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' },
  });
  server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
    if (req.url.startsWith('/api/company-logo')) { res.setHeader('Content-Type', 'image/png'); return res.end(image); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><div id="root" style="position:relative;width:48px;height:48px"></div><script src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

test('an empty first image recovers through the independent corporate-website fallback', async () => {
  const page = await browser.newPage();
  const lookups = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.fulfill({ status: 200, contentType: 'image/png', body: '' });
    if (url.pathname === '/api/company-logo') lookups.push(url);
    return route.continue();
  });
  await page.goto(origin);
  await page.waitForFunction(() => { const img = document.querySelector('img'); return img?.complete && img.naturalWidth > 0; });
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].searchParams.get('fallback'), 'website');
  assert.equal(lookups[0].searchParams.get('jobId'), '2047e114-ee0e-4c14-ae49-1d44075ad263');
  assert.equal(lookups[0].searchParams.get('v'), '2');
  await page.close();
});

test('both unavailable sources leave initials without repeatedly retrying the failed images', async () => {
  const page = await browser.newPage();
  let failures = 0;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname === '/api/company-logo') {
      failures++;
      return route.fulfill({ status: 404, body: '' });
    }
    return route.continue();
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#root span')?.textContent === 'A' && !document.querySelector('img'));
  assert.equal(failures, 2);
  await page.close();
});
