// Read-only regression against the configured database:
// node scripts/with-env.mjs node --import tsx --test tests/integration/jobIdSearch.test.ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { GET } from '../../src/app/api/jobs/search/route';
import { prisma } from '../../src/lib/prisma';

let job: { id: string; status: string; location: string | null };
const queryRaw = prisma.$queryRaw.bind(prisma);
const sourceFindMany = prisma.jobSourceObservation.findMany;

before(async () => {
  const existing = await prisma.job.findFirst({
    where: { status: 'applied' },
    select: { id: true, status: true, location: true },
  });
  assert.ok(existing, 'requires an existing applied job; never creates or edits jobs');
  job = existing;

  // Fail if an ID lookup touches either of the expensive broad search paths.
  // Keep the ordinary score-event read intact so score display is tested too.
  prisma.$queryRaw = ((...args: Parameters<typeof queryRaw>) => {
    const sql = args[0];
    const text = 'strings' in sql ? sql.strings.join('') : String(sql);
    assert.doesNotMatch(text, /to_tsvector/);
    return queryRaw(...args);
  }) as typeof prisma.$queryRaw;
  prisma.jobSourceObservation.findMany = (() => {
    assert.fail('complete job IDs must not scan saved source URLs');
  }) as typeof sourceFindMany;
});

after(async () => {
  prisma.$queryRaw = queryRaw;
  prisma.jobSourceObservation.findMany = sourceFindMany;
  await prisma.$disconnect();
});

async function search(params: Record<string, string>) {
  const response = await GET(new Request(`http://localhost/api/jobs/search?${new URLSearchParams(params)}`));
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  return data;
}

test('the top search bar retrieves a complete ID without broad searches', async () => {
  const data = await search({ q: job.id });
  assert.deepEqual(data.jobs.map((row: { id: string }) => row.id), [job.id]);
  assert.equal(data.pagination.total, 1);
  assert.equal(data.jobs[0].status, 'applied');
});

test('Everything accepts surrounding spaces and uppercase IDs', async () => {
  const data = await search({ q: `  ${job.id.toUpperCase()}  `, field: 'all' });
  assert.deepEqual(data.jobs.map((row: { id: string }) => row.id), [job.id]);
});

test('an absent ID returns no results without falling back to broad searches', async () => {
  const data = await search({ q: '00000000-0000-0000-0000-000000000000' });
  assert.deepEqual(data.jobs, []);
  assert.equal(data.pagination.total, 0);
});

test('ID searches still honor queue filters and pagination', async () => {
  const applied = await search({ q: job.id, status: 'applied' });
  assert.equal(applied.pagination.total, 1);
  const inbox = await search({ q: job.id, statuses: 'inbox' });
  assert.equal(inbox.pagination.total, 0);
  const secondPage = await search({ q: job.id, page: '2', limit: '1' });
  assert.deepEqual(secondPage.jobs, []);
  assert.equal(secondPage.pagination.total, 1);
});

test('ID searches still honor location filters', async () => {
  // An exact ID scopes location resolution as well as the final card query.
  const data = await search({ q: job.id, location: 'Minnesota' });
  assert.ok(data.pagination.total <= 1);
  assert.ok(data.jobs.every((row: { id: string }) => row.id === job.id));
});
