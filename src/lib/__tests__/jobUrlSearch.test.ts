import assert from 'node:assert/strict';
import test from 'node:test';
import { jobSourceUrlMatchIds, jobUrlSearchWhere } from '../jobUrlSearch';

test('a partial URL searches current, canonical, and retained source links', () => {
  assert.deepEqual(jobUrlSearchWhere('  workforceNow.adp.com  ', ['retained-source-job']), {
    OR: [
      { url: { contains: 'workforceNow.adp.com', mode: 'insensitive' } },
      { canonicalUrl: { contains: 'workforceNow.adp.com', mode: 'insensitive' } },
      { id: { in: ['retained-source-job'] } },
    ],
  });
});

test('a full ADP link also finds the canonical spelling with sorted parameters', () => {
  const query = 'https://workforcenow.adp.com/recruitment.html?cid=employer&jobId=729498&lang=en_US&utm_source=email#details';
  const where = jobUrlSearchWhere(query);
  const arms = where.OR as Array<Record<string, unknown>>;
  assert.equal(arms.length, 4);
  assert.deepEqual(arms[0], { url: { contains: query.replace('_US', '\\_US').replace('utm_source', 'utm\\_source'), mode: 'insensitive' } });
  assert.deepEqual(arms[3], {
    canonicalUrl: {
      contains: 'https://workforcenow.adp.com/recruitment.html?cid=employer&jobId=729498&lang=en\\_US',
      mode: 'insensitive',
    },
  });
});

test('retained source links are resolved once before filtering jobs', async () => {
  const requests: unknown[] = [];
  const db = { jobSourceObservation: { findMany: async (args: unknown) => {
    requests.push(args);
    return [{ jobId: 'original-source-job' }];
  } } };
  const ids = await jobSourceUrlMatchIds('jobs/Account%20Manager_123', db as unknown as Parameters<typeof jobSourceUrlMatchIds>[1]);
  assert.deepEqual(ids, ['original-source-job']);
  assert.deepEqual(requests, [{
    where: { OR: [{ url: { contains: 'jobs/Account\\%20Manager\\_123', mode: 'insensitive' } }] },
    select: { jobId: true },
    distinct: ['jobId'],
    take: 10_001,
  }]);
  const where = jobUrlSearchWhere('jobs/Account%20Manager_123', ids);
  assert.deepEqual(where.OR?.at(-1), { id: { in: ['original-source-job'] } });
});

test('broad source searches keep all matches without exceeding the bind limit', () => {
  const ids = Array.from({ length: 10_001 }, (_, index) => `job-${index}`);
  const where = jobUrlSearchWhere('adp.com', ids);
  assert.deepEqual(where.OR?.at(-1), {
    observations: { some: { OR: [{ url: { contains: 'adp.com', mode: 'insensitive' } }] } },
  });
});

test('encoded spaces, underscores, and backslashes are literal rather than LIKE wildcards', () => {
  const where = jobUrlSearchWhere('jobs/Account%20Manager_123\\details');
  assert.deepEqual(where.OR?.[0], {
    url: { contains: 'jobs/Account\\%20Manager\\_123\\\\details', mode: 'insensitive' },
  });
});
