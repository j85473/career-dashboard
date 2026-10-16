import assert from 'node:assert/strict';
import test from 'node:test';
import { jobUrlSearchWhere } from '../jobUrlSearch';

test('a partial URL searches current, canonical, and retained source links', () => {
  assert.deepEqual(jobUrlSearchWhere('  workforceNow.adp.com  '), {
    OR: [
      { url: { contains: 'workforceNow.adp.com', mode: 'insensitive' } },
      { canonicalUrl: { contains: 'workforceNow.adp.com', mode: 'insensitive' } },
      { observations: { some: { url: { contains: 'workforceNow.adp.com', mode: 'insensitive' } } } },
    ],
  });
});

test('a full ADP link also finds the canonical spelling with sorted parameters', () => {
  const query = 'https://workforcenow.adp.com/recruitment.html?cid=employer&jobId=729498&lang=en_US&utm_source=email#details';
  const where = jobUrlSearchWhere(query);
  const arms = where.OR as Array<Record<string, unknown>>;
  assert.equal(arms.length, 6);
  assert.deepEqual(arms[0], { url: { contains: query.replace('_US', '\\_US').replace('utm_source', 'utm\\_source'), mode: 'insensitive' } });
  assert.deepEqual(arms[4], {
    canonicalUrl: {
      contains: 'https://workforcenow.adp.com/recruitment.html?cid=employer&jobId=729498&lang=en\\_US',
      mode: 'insensitive',
    },
  });
});

test('encoded spaces, underscores, and backslashes are literal rather than LIKE wildcards', () => {
  const where = jobUrlSearchWhere('jobs/Account%20Manager_123\\details');
  assert.deepEqual(where.OR?.[0], {
    url: { contains: 'jobs/Account\\%20Manager\\_123\\\\details', mode: 'insensitive' },
  });
});
