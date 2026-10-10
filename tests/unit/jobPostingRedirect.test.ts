import assert from 'node:assert/strict';
import test from 'node:test';
import dns from 'node:dns/promises';
import type { PrismaClient } from '@prisma/client';

// Use a plain query stub: Prisma model delegates are proxies, which Node's
// method mock tracker cannot replace reliably.
const queryClient = { job: { findUnique: async (): Promise<unknown> => null } };
(globalThis as unknown as { prisma: PrismaClient }).prisma = queryClient as unknown as PrismaClient;
const route = import('../../src/app/api/jobs/[id]/redirect/route');

const workdayUrl = 'https://solera.wd5.myworkdayjobs.com/en-US/Global_Career_Site/job/Virtual-US/Channel-Account-Manager_JR-020114';
const id = 'de3c567e-83fc-449e-ac64-839c73174be4';
const request = new Request(`http://localhost/api/jobs/${id}/redirect`);
const params = { params: Promise.resolve({ id }) };

test('View Posting opens the saved Workday URL even when server DNS is unavailable', async (t) => {
  const lookup = t.mock.method(dns, 'lookup', async () => { throw new Error('EAI_AGAIN'); });
  t.mock.method(queryClient.job, 'findUnique', async () => ({
    id, title: 'Channel Account Manager', company: 'Solera Holdings LLC',
    url: workdayUrl, canonicalUrl: workdayUrl, source: 'ATS-workday', sourceId: '/job/Virtual-US/Channel-Account-Manager_JR-020114',
  }));
  const response = await (await route).GET(request, params);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), workdayUrl);
  assert.equal(lookup.mock.callCount(), 0);
});

test('View Posting retains canonical, Indeed, source, and search fallback precedence', async (t) => {
  const cases = [
    { canonicalUrl: workdayUrl, url: 'https://www.adzuna.com/details/123', expected: workdayUrl },
    { canonicalUrl: 'https://www.indeed.com/jobs', url: workdayUrl, source: 'Indeed', sourceId: 'abc 123', expected: 'https://www.indeed.com/viewjob?jk=abc%20123' },
    { canonicalUrl: 'javascript:alert(1)', url: workdayUrl, expected: workdayUrl },
    { canonicalUrl: 'http://127.0.0.1', url: 'http://service.local', expected: 'https://www.google.com/search?q=Solera%20Channel%20Account%20Manager%20job%20careers' },
  ];
  for (const { expected, ...fields } of cases) {
    const query = t.mock.method(queryClient.job, 'findUnique', async () => ({
      id, title: 'Channel Account Manager', company: 'Solera', source: 'ATS-workday', sourceId: null, ...fields,
    }));
    const response = await (await route).GET(request, params);
    assert.equal(response.headers.get('location'), expected);
    query.mock.restore();
  }
});

test('View Posting returns 404 for a missing job', async (t) => {
  t.mock.method(queryClient.job, 'findUnique', async () => null);
  assert.equal((await (await route).GET(request, params)).status, 404);
});
