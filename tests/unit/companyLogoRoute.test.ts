import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '../../src/lib/prismaClient';
import { companyLogoCache, CompanyLogoBusyError, type CompanyLogoAsset } from '../../src/lib/companyLogoCache';

const queryClient = { job: { findMany: async (query: unknown): Promise<unknown[]> => { void query; return []; } } };
(globalThis as unknown as { prisma: PrismaClient }).prisma = queryClient as unknown as PrismaClient;
const route = import('../../src/app/api/company-logo/route');
const row = Object.freeze({ company: 'Raw employer label', employer: 'Resolved Employer',
  url: 'https://jobs.ashbyhq.com/employer/42', canonicalUrl: null });
const image: CompanyLogoAsset = { version: 1, key: 'test', sourceUrl: 'https://cdn.example.org/logo.png',
  verifiedAt: Date.now(), png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };

test('the logo route uses saved employer evidence and returns image bytes instead of an external redirect', async t => {
  const before = JSON.stringify(row);
  const query = t.mock.method(queryClient.job, 'findMany', async () => [row]);
  const lookup = t.mock.method(companyLogoCache, 'get', async () => image);
  t.mock.method(companyLogoCache, 'needsRefresh', () => false);
  const response = await (await route).GET(new Request('http://localhost/api/company-logo?jobId=saved-job&company=Forged&posting=http://127.0.0.1/'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.equal(response.headers.get('Location'), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image.png);
  assert.deepEqual(query.mock.calls[0].arguments[0], {
    where: { id: 'saved-job' }, select: { company: true, employer: true, url: true, canonicalUrl: true },
    orderBy: { createdAt: 'desc' }, take: 1,
  });
  assert.deepEqual(lookup.mock.calls[0].arguments[0], { ...row, company: 'Resolved Employer' });
  assert.equal(JSON.stringify(row), before);
});

test('a temporary logo miss is not cached by the browser', async t => {
  t.mock.method(queryClient.job, 'findMany', async () => [row]);
  t.mock.method(companyLogoCache, 'get', async () => null);
  const response = await (await route).GET(new Request('http://localhost/api/company-logo?jobId=saved-job'));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('a busy resolver asks the card to retry without caching a blank', async t => {
  t.mock.method(queryClient.job, 'findMany', async () => [row]);
  t.mock.method(companyLogoCache, 'get', async () => { throw new CompanyLogoBusyError(); });
  const response = await (await route).GET(new Request('http://localhost/api/company-logo?jobId=saved-job'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Retry-After'), '1');
});

test('reviewed outreach companies can use saved branding without requiring a job record', async t => {
  t.mock.method(queryClient.job, 'findMany', async () => []);
  const lookup = t.mock.method(companyLogoCache, 'get', async () => image);
  t.mock.method(companyLogoCache, 'needsRefresh', () => false);
  assert.equal((await (await route).GET(new Request('http://localhost/api/company-logo?company=Catchafire'))).status, 200);
  assert.equal(lookup.mock.calls[0].arguments[0]?.company, 'Catchafire');
  assert.equal((await (await route).GET(new Request('http://localhost/api/company-logo?company=Unverified'))).status, 404);
  assert.equal(lookup.mock.callCount(), 1);
});
