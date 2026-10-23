import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import sharp from 'sharp';
import { companyLogoCacheKey, companyLogoPng, createCompanyLogoCache, createCompanyLogoStore,
  type CompanyLogoAsset, type CompanyLogoStore } from '../companyLogoCache';

const subject = { company: 'Example Brand', url: 'https://jobs.ashbyhq.com/example-brand/one' };
const makePng = () => sharp({ create: { width: 32, height: 32, channels: 4, background: '#2468ac' } }).png().toBuffer();
const sources = async function* () { yield 'https://cdn.example.org/logo.png'; };
function memoryStore(): CompanyLogoStore {
  const saved = new Map<string, CompanyLogoAsset>();
  return { read: async key => saved.get(key) || null, write: async asset => { saved.set(asset.key, asset); } };
}

test('saved image bytes survive a fresh cache instance while all remote sources are offline', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'company-logo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const png = await makePng();
  const first = createCompanyLogoCache({ store: createCompanyLogoStore(directory), sources, fetchImage: async () => new Response(png) });
  const saved = await first.get(subject);
  assert.ok(saved);
  const second = createCompanyLogoCache({ store: createCompanyLogoStore(directory),
    sources: async function* () { assert.fail('a saved logo must not need the network'); } });
  const restored = await second.get({ ...subject, url: 'https://jobs.ashbyhq.com/example-brand/another-posting' });
  assert.deepEqual(restored?.png, saved.png);
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('image decoding accepts mislabeled PNG and SVG while rejecting HTML, empty and broken images', async () => {
  const png = await makePng();
  const image = await companyLogoPng(new Response(png, { headers: { 'Content-Type': 'text/plain' } }));
  assert.equal((await sharp(image!).metadata()).format, 'png');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>';
  assert.ok(await companyLogoPng(new Response(svg)));
  for (const body of ['', '<html>Access denied</html>', png.subarray(0, 20)]) {
    assert.equal(await companyLogoPng(new Response(body, { headers: { 'Content-Type': 'image/png' } })), null);
  }
  assert.equal(await companyLogoPng(new Response(png, { status: 403 })), null);
  assert.equal(await companyLogoPng(new Response(png, { headers: { 'Content-Length': '9999999' } })), null);
  for (const background of ['#ffffff', '#00000000']) {
    const blank = await sharp({ create: { width: 32, height: 32, channels: 4, background } }).png().toBuffer();
    assert.equal(await companyLogoPng(new Response(blank)), null);
  }
});

test('a candidate that returns a successful HTML response cannot prevent the next image source from winning', async () => {
  const urls: string[] = [], png = await makePng();
  const cache = createCompanyLogoCache({ store: memoryStore(),
    sources: async function* () { yield 'https://cdn.example.org/broken'; yield 'https://cdn.example.org/valid'; },
    fetchImage: async url => { urls.push(url); return new Response(url.endsWith('/valid') ? png : '<html>Sign in</html>'); } });
  assert.equal((await cache.get(subject))?.sourceUrl, 'https://cdn.example.org/valid');
  assert.equal(urls.length, 2);
});

test('simultaneous cards for different postings at the same employer share one successful lookup', async () => {
  let requests = 0;
  const png = await makePng();
  const cache = createCompanyLogoCache({ store: memoryStore(), sources, fetchImage: async () => {
    requests++; await setTimeout(10); return new Response(png);
  } });
  const images = await Promise.all(Array.from({ length: 8 }, (_, i) => cache.get({ ...subject,
    url: `https://jobs.ashbyhq.com/example-brand/${i}` })));
  assert.equal(requests, 1);
  assert.ok(images.every(image => image?.png.equals(images[0]!.png)));
});

test('display reads finish while external recovery is still blocked, then see the saved image', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const png = await makePng();
  const cache = createCompanyLogoCache({ store: memoryStore(), sources, fetchImage: async () => {
    started.resolve(); await release.promise; return new Response(png);
  } });
  const recovery = cache.get(subject);
  await started.promise;
  try {
    assert.equal(await Promise.race([
      cache.readSaved(subject),
      setTimeout(250).then(() => { throw new Error('display waited for external recovery'); }),
    ]), null);
  } finally { release.resolve(); }
  await recovery;
  assert.deepEqual((await cache.readSaved(subject))?.png, png);
});

test('an expired posting does not suppress a different posting at the same employer', async () => {
  const png = await makePng();
  const cache = createCompanyLogoCache({ store: memoryStore(),
    sources: async function* (job) { if (job.url?.endsWith('/two')) yield 'https://cdn.example.org/two.png'; },
    fetchImage: async () => new Response(png) });
  assert.equal(await cache.get(subject), null);
  assert.ok(await cache.get({ ...subject, url: 'https://jobs.ashbyhq.com/example-brand/two' }));
});

test('a failed refresh retains the prior working image on disk and backs off independently', async () => {
  let clock = 1, requests = 0;
  const png = await makePng(), store = memoryStore();
  const cache = createCompanyLogoCache({ store, sources, now: () => clock, fetchImage: async () => {
    requests++; return requests === 1 ? new Response(png) : new Response('', { status: 503 });
  } });
  const saved = await cache.get(subject);
  clock += 31 * 86_400_000;
  assert.equal(cache.needsRefresh(saved!), true);
  assert.deepEqual((await cache.get(subject))?.png, saved?.png);
  await cache.refresh(subject);
  assert.equal(cache.needsRefresh(saved!), false);
  const offline = createCompanyLogoCache({ store, sources: async function* () { assert.fail('cached bytes were lost'); } });
  assert.deepEqual((await offline.get(subject))?.png, saved?.png);
  assert.equal(requests, 2);
});

test('misses retry after a short delay and never become durable blank entries', async () => {
  let clock = 1, requests = 0, writes = 0;
  const cache = createCompanyLogoCache({ store: { read: async () => null, write: async () => { writes++; } },
    sources, now: () => clock, fetchImage: async () => { requests++; return new Response('', { status: 404 }); } });
  assert.equal(await cache.get(subject), null);
  assert.equal(await cache.get(subject), null);
  assert.equal(requests, 1);
  clock += 61_000;
  assert.equal(await cache.get(subject), null);
  assert.equal(requests, 2);
  assert.equal(writes, 0);
});

test('unrelated ATS tenants and corrected employer labels cannot reuse each other\'s branding', () => {
  assert.notEqual(companyLogoCacheKey(subject), companyLogoCacheKey({ ...subject, url: 'https://jobs.ashbyhq.com/other/one' }));
  assert.notEqual(companyLogoCacheKey(subject), companyLogoCacheKey({ ...subject, company: 'Other Employer' }));
  assert.equal(companyLogoCacheKey(subject), companyLogoCacheKey({ ...subject, url: 'https://jobs.ashbyhq.com/example-brand/two' }));
});

test('recovery concurrency stays bounded while every queued card can complete', async () => {
  let active = 0, highest = 0;
  const png = await makePng();
  const cache = createCompanyLogoCache({ store: memoryStore(), sources, concurrency: 2, fetchImage: async () => {
    active++; highest = Math.max(highest, active); await setTimeout(5); active--; return new Response(png);
  } });
  const images = await Promise.all(Array.from({ length: 9 }, (_, i) => cache.get({ company: `Employer ${i}` })));
  assert.equal(highest, 2);
  assert.ok(images.every(Boolean));
});

test('a corrupt saved entry is a recoverable miss', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'company-logo-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createCompanyLogoStore(directory), key = companyLogoCacheKey(subject);
  await writeFile(path.join(directory, `${key}.json`), '{broken');
  assert.equal(await store.read(key), null);
  await writeFile(path.join(directory, `${key}.json`), JSON.stringify({ version: 1, key, sourceUrl: 'https://example.org/logo', verifiedAt: 1, png: 'aHRtbA==' }));
  assert.equal(await store.read(key), null);
  const png = await makePng();
  await writeFile(path.join(directory, `${key}.json`), JSON.stringify({ version: 1, key, sourceUrl: 'https://example.org/logo', verifiedAt: 1, png: png.subarray(0, 24).toString('base64') }));
  assert.equal(await store.read(key), null);
});
