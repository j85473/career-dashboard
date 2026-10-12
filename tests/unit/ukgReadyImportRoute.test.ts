import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const dns = require('node:dns/promises');

test('reopening an existing UKG Ready posting preserves scores, application state and tailoring without writes', async t => {
  const { POST } = await import('../../src/app/api/jobs/manual-import/route');
  const { prisma } = await import('../../src/lib/prisma');
  const { generatePostingIdentity } = await import('../../src/lib/jobIngestion');
  const url = 'https://secure7.saashr.com/ta/6205439.careers?ApplyToJob=638037848';
  const existing = Object.freeze({
    id: 'existing-ready-job', title: 'Ahold Sales Manager', company: 'Market Performance Group',
    url, canonicalUrl: url, postingIdentity: generatePostingIdentity({ url }),
    source: 'Manual Import', status: 'applied', scoringStatus: 'scored',
    fitScore: 84, aimFitScore: 87, reqFitScore: 89, tailoringStaged: false,
    passReason: null, updatedAt: new Date('2026-10-12T17:00:00Z'),
  });
  const replace = (target: object, key: string, implementation: unknown) => {
    const prior = Reflect.get(target, key);
    assert.equal(Reflect.set(target, key, implementation), true);
    t.after(() => { Reflect.set(target, key, prior); });
  };
  replace(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  replace(prisma.job, 'findMany', async (query: { where: { OR: Array<{ postingIdentity?: string }> } }) => {
    assert.ok(query.where.OR.some(condition => condition.postingIdentity === existing.postingIdentity));
    return [existing];
  });
  replace(prisma.job, 'findUnique', async () => existing);
  replace(prisma.jobStatusHistory, 'findFirst', async () => null);
  const noWrites = () => assert.fail('Pasting an existing link must preserve all saved work');
  for (const method of ['create', 'update', 'updateMany', 'delete']) replace(prisma.job, method, noWrites);
  replace(prisma, '$transaction', noWrites);
  const response = await POST(new Request('http://localhost/api/jobs/manual-import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  }));
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.match.kind, 'same_link');
  assert.equal(result.job.id, existing.id);
  assert.equal(result.job.status, 'applied');
  assert.equal(result.job.fitScore, 84);
  assert.equal(result.job.aimFitScore, 87);
  assert.equal(result.job.reqFitScore, 89);
  assert.equal(result.job.tailoringStaged, false);
});

test('careers-page refresh and conflicting posting IDs are rejected before any database access', async t => {
  const { POST: importJob } = await import('../../src/app/api/jobs/manual-import/route');
  const { POST: scrapeJob } = await import('../../src/app/api/jobs/[id]/scrape/route');
  const { prisma } = await import('../../src/lib/prisma');
  const replace = (target: object, key: string, implementation: unknown) => {
    const prior = Reflect.get(target, key);
    assert.equal(Reflect.set(target, key, implementation), true);
    t.after(() => { Reflect.set(target, key, prior); });
  };
  replace(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  for (const method of ['findUnique', 'findMany', 'findFirst', 'create', 'update', 'updateMany']) {
    replace(prisma.job, method, () => assert.fail('No posting was selected; the database must not be accessed'));
  }
  replace(prisma, '$transaction', () => assert.fail('No posting was selected'));
  const request = (url: string) => new Request('http://localhost/api/jobs/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, skipRescore: true }),
  });
  const refresh = await scrapeJob(request('https://secure7.saashr.com/ta/6205439.careers?CareersSearch=#'), { params: Promise.resolve({ id: 'saved-card' }) });
  assert.equal(refresh.status, 422);
  assert.match((await refresh.json()).error, /individual opening/);
  const conflict = await importJob(request('https://secure7.saashr.com/ta/6205439.careers?ShowJob=1&jobid=2'));
  assert.equal(conflict.status, 422);
  assert.match((await conflict.json()).error, /conflicting job ID/);
});
