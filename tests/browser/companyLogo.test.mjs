// Run: PLAYWRIGHT_CHANNEL=chrome node --test tests/browser/companyLogo.test.mjs
// Mounts the real component; all image requests are fixtures with no external data access.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

let server, browser, origin;
let slowRequests = 0, slowActive = 0, slowPeak = 0;
const delayedResponses = new Map();
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
before(async () => {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {CompanyLogo} from './src/components/CompanyLogo'; const root = createRoot(document.getElementById('root')); window.showCompany = (company, jobId = '2047e114-ee0e-4c14-ae49-1d44075ad263') => root.render(<CompanyLogo company={company} jobId={jobId} url="https://tenant.oraclecloud.com/sites/CX_1/job/32088"/>); window.showCompanies = companies => root.render(<>{companies.map((company,i) => <div key={i} style={{position:'relative',width:48,height:48}}><CompanyLogo company={company} jobId={'fixture-'+i}/></div>)}</>); window.showCompany('Acosta');`,
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' },
  });
  server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
    if (req.url.startsWith('/api/company-logo')) {
      if (new URL(req.url, 'http://localhost').searchParams.get('company')?.startsWith('Slow Employer')) {
        slowRequests++; slowActive++; slowPeak = Math.max(slowPeak, slowActive);
        const timer = setTimeout(() => { res.setHeader('Content-Type', 'image/png'); res.end(image); }, 20_000);
        delayedResponses.set(res, timer);
        res.once('close', () => { slowActive--; clearTimeout(timer); delayedResponses.delete(res); });
        return;
      }
      res.setHeader('Content-Type', 'image/png'); return res.end(image);
    }
    if (req.url === '/api/jobs/fixture') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ job: { description: 'Saved job description', aimFitScore: 87, reqFitScore: 83 } }));
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><div id="root" style="position:relative;width:48px;height:48px"></div><script src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
});
after(async () => {
  await browser?.close();
  for (const [response, timer] of delayedResponses) { clearTimeout(timer); response.destroy(); }
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

test('cards load saved images from the Dashboard without contacting external logo providers', async () => {
  const page = await browser.newPage();
  const lookups = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin);
    if (url.pathname === '/api/company-logo') lookups.push(url);
    return route.continue();
  });
  await page.goto(origin);
  await page.waitForFunction(() => { const img = document.querySelector('img'); return img?.complete && img.naturalWidth > 0; });
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].searchParams.get('fallback'), null);
  assert.equal(lookups[0].searchParams.get('jobId'), '2047e114-ee0e-4c14-ae49-1d44075ad263');
  assert.equal(lookups[0].searchParams.get('v'), '4');
  await page.close();
});

test('a pending recovery leaves initials, then displays the saved image, and employer edits reset loading', async () => {
  const page = await browser.newPage();
  let attempts = 0;
  await page.route('**/api/company-logo?**', route => {
    attempts++;
    return attempts === 1 ? route.fulfill({ status: 202, body: '', headers: { 'Retry-After': '1' } }) : route.continue();
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('span')?.textContent === 'A' && !document.querySelector('img'));
  await page.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0);
  assert.equal(attempts, 2);
  await page.route('**/api/company-logo?**', route => route.fulfill({ status: 404, body: '' }));
  await page.evaluate(() => window.showCompany('Unknown Employer'));
  await page.waitForFunction(() => !document.querySelector('img') && document.querySelector('span')?.textContent === 'UE');
  await page.unroute('**/api/company-logo?**');
  await page.evaluate(() => window.showCompany('Catchafire', 'another-job'));
  await page.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0 && document.querySelector('span')?.textContent === 'C');
  await page.close();
});

test('an unavailable logo leaves initials without repeatedly retrying the failed image', async () => {
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
  const miss = page.waitForResponse(response => new URL(response.url()).pathname === '/api/company-logo' && response.status() === 404);
  await page.goto(origin);
  await miss;
  await page.waitForFunction(() => document.querySelector('#root span')?.textContent === 'A' && !document.querySelector('img'));
  assert.equal(failures, 1);
  await page.close();
});

test('twenty-second logo stalls cannot hold up saved job descriptions or scores', async () => {
  const page = await browser.newPage();
  slowRequests = 0; slowPeak = 0;
  try {
    await page.goto(origin);
    await page.evaluate(() => window.showCompanies(Array.from({ length: 12 }, (_, i) => `Slow Employer ${i}`)));
    await assert.doesNotReject(async () => {
      for (let attempt = 0; attempt < 30 && slowRequests === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(slowRequests > 0, 'the browser must encounter a genuinely stalled logo response');
    });
    await page.waitForTimeout(100);
    const started = Date.now();
    const job = await page.evaluate(async () => {
      const response = await fetch('/api/jobs/fixture', { signal: AbortSignal.timeout(1000) });
      return (await response.json()).job;
    });
    assert.ok(Date.now() - started < 1000, 'job data waited behind decorative traffic');
    assert.deepEqual(job, { description: 'Saved job description', aimFitScore: 87, reqFitScore: 83 });
    assert.equal(slowPeak, 1, 'logos filled more than their one allowed browser connection');
    await page.evaluate(() => window.showCompany('Catchafire', 'after-cancel'));
    await page.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0, null, { timeout: 2500 });
  } finally { await page.close(); }
});
