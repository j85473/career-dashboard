// Read-only smoke against the configured database:
// node scripts/with-env.mjs node --import tsx --test tests/integration/advancedLocationSearch.test.ts
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { GET } from '../../src/app/api/jobs/search/route';
import { prisma } from '../../src/lib/prisma';

after(() => prisma.$disconnect());

async function search(params: Record<string, string>) {
  const response = await GET(new Request(`http://localhost/api/jobs/search?${new URLSearchParams(params)}`));
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  return data;
}

test('radius, queues, titles, and server pagination combine on existing jobs', async () => {
  const params = { q: 'channel sales', field: 'title', location: '55405', radius: '50', limit: '2' };
  const first = await search(params);
  const second = await search({ ...params, page: '2' });
  const smaller = await search({ ...params, radius: '5' });
  const applied = await search({ ...params, statuses: 'applied' });
  assert.ok(smaller.pagination.total <= first.pagination.total);
  assert.ok(applied.pagination.total <= first.pagination.total);
  assert.ok(applied.jobs.every((job: { status: string }) => job.status === 'applied'));
  const ids = [...first.jobs, ...second.jobs].map((job: { id: string }) => job.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(first.pagination.total, second.pagination.total);
  assert.match(first.location.label, /Within 50 miles.*55405/);
});

test('description and Everything searches accept geography before limiting results', async () => {
  for (const field of ['description', 'all']) {
    const result = await search({ q: 'channel sales', field, statuses: 'applied', location: 'Minneapolis, MN', radius: '50', limit: '5' });
    assert.ok(result.jobs.every((job: { status: string }) => job.status === 'applied'));
    assert.match(result.location.label, /Within 50 miles of Minneapolis, MN/);
  }
});

test('state-only and location-only searches work and invalid places return a correctable error', async () => {
  const result = await search({ location: 'Minnesota', statuses: 'applied', limit: '5' });
  assert.equal(result.location.label, 'Minnesota (entire state)');
  for (const location of ['Springfield', '00000']) {
    const response = await GET(new Request(`http://localhost/api/jobs/search?location=${location}&radius=25`));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
});
