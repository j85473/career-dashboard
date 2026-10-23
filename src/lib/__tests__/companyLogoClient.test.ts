import assert from 'node:assert/strict';
import test from 'node:test';
import { requestCompanyLogo } from '../companyLogoClient';

test('slow decorative requests use one connection and skip a cancelled queued card', async t => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0, peak = 0;
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    urls.push(url); active++; peak = Math.max(peak, active);
    assert.equal(options.priority, 'low');
    if (url === '/first') { started.resolve(); await release.promise; }
    active--;
    return new Response('saved image', { headers: { 'Content-Type': 'image/png' } });
  });
  const first = requestCompanyLogo('/first', new AbortController().signal);
  await started.promise;
  const cancelled = new AbortController();
  const skipped = requestCompanyLogo('/cancelled', cancelled.signal);
  const skippedCheck = assert.rejects(skipped, { name: 'AbortError' });
  const last = requestCompanyLogo('/last', new AbortController().signal);
  cancelled.abort();
  assert.deepEqual(urls, ['/first']);
  release.resolve();
  assert.equal(await (await first).image?.text(), 'saved image');
  assert.equal(await (await last).image?.text(), 'saved image');
  await skippedCheck;
  assert.equal(peak, 1);
  assert.deepEqual(urls, ['/first', '/last']);
});

test('pending recovery releases the connection and honors the retry delay while a real miss stops', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => url === '/pending'
    ? new Response(null, { status: 202, headers: { 'Retry-After': '3' } })
    : new Response(null, { status: 404 }));
  assert.deepEqual(await requestCompanyLogo('/pending', new AbortController().signal), { image: null, retryAfterMs: 3000 });
  assert.deepEqual(await requestCompanyLogo('/missing', new AbortController().signal), { image: null, retryAfterMs: null });
});
