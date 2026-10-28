// Read-only SQL regression: fixtures shadow the real tables with CTEs.
// node scripts/with-env.mjs node --import tsx --test tests/integration/appliedJobOrder.test.ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import type { Prisma } from '../../src/lib/prismaClient';
import { statusEntryOrderedPage } from '../../src/lib/jobStatusEntryOrder';
import { applicationDateFromHistory } from '../../src/lib/jobApplicationDate';

const database = new pg.Client({ connectionString: process.env.DATABASE_URL });
before(async () => {
  await database.connect();
  await database.query('BEGIN READ ONLY');
});
after(async () => {
  await database.query('ROLLBACK');
  await database.end();
});

const jobs = ['recent', 'returned', 'reapplied', 'repeated', 'legacy', 'tie-before', 'tie-after']
  .map(id => ({ id, status: 'applied', updatedAt: '2026-10-28T12:00:00Z' }));
const histories: Array<{ id: string; jobId: string; status: string; createdAt: string }> = [];
function event(jobId: string, status: string, day: number, id = String(histories.length).padStart(3, '0')) {
  histories.push({ id, jobId, status, createdAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z` });
}
event('recent', 'applied', 26);
event('returned', 'applied', 1);
event('returned', 'interviewing', 27);
event('returned', 'applied', 28);
event('reapplied', 'applied', 1);
event('reapplied', 'inbox', 25);
event('reapplied', 'applied', 27);
event('repeated', 'applied', 20);
event('repeated', 'applied', 28);
event('tie-before', 'applied', 24, 'a');
event('tie-before', 'inbox', 24, 'b');
event('tie-before', 'interviewing', 28);
event('tie-after', 'inbox', 24, 'a');
event('tie-after', 'applied', 24, 'b');

const client = {
  $queryRaw: async (sql: Prisma.Sql) => {
    const result = await database.query(`
      WITH "Job" AS (
        SELECT * FROM jsonb_to_recordset($${sql.values.length + 1}::jsonb)
          AS fixture(id text, status text, "updatedAt" timestamp)
      ), "JobStatusHistory" AS (
        SELECT * FROM jsonb_to_recordset($${sql.values.length + 2}::jsonb)
          AS fixture(id text, "jobId" text, status text, "createdAt" timestamp)
      ) ${sql.text}
    `, [...sql.values, JSON.stringify(jobs), JSON.stringify(histories)]);
    return result.rows;
  },
  job: { count: async () => jobs.length },
} as unknown as Parameters<typeof statusEntryOrderedPage>[5];

function expectedOrder(direction: 'asc' | 'desc', candidates = jobs.map(job => job.id)) {
  const dates = new Map(jobs.map(job => [job.id, applicationDateFromHistory(histories
    .filter(history => history.jobId === job.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .map(history => ({ ...history, createdAt: new Date(history.createdAt) })))?.getTime() ?? null]));
  return [...candidates].sort((a, b) => {
    const left = dates.get(a)!;
    const right = dates.get(b)!;
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    return (left !== null && right !== null ? (left - right) * (direction === 'asc' ? 1 : -1) : 0)
      || a.localeCompare(b);
  });
}

test('SQL matches displayed dates across interview returns, reapplications, repeats and timestamp ties', async () => {
  const page = await statusEntryOrderedPage({ status: 'applied' }, 'applied', 'desc', 48, 0, client);
  assert.deepEqual(page.ids, ['reapplied', 'recent', 'tie-after', 'repeated', 'returned', 'legacy', 'tie-before']);
  assert.deepEqual(page.ids, expectedOrder('desc'));
  assert.equal(page.total, jobs.length);
});

test('pagination applies application-date ordering before slicing and keeps every job once', async () => {
  const pages = [];
  for (const offset of [0, 3, 6]) {
    pages.push(await statusEntryOrderedPage({ status: 'applied' }, 'applied', 'desc', 3, offset, client));
  }
  const ids = pages.flatMap(page => page.ids);
  assert.deepEqual(ids, expectedOrder('desc'));
  assert.equal(new Set(ids).size, jobs.length);
});

test('scoped searches use the same dates and put unknown dates last in both directions', async () => {
  const candidates = ['returned', 'recent', 'legacy', 'reapplied'];
  for (const direction of ['asc', 'desc'] as const) {
    const page = await statusEntryOrderedPage({}, 'applied', direction, 48, 0, client, candidates);
    assert.deepEqual(page.ids, expectedOrder(direction, candidates));
    assert.equal(page.total, candidates.length);
  }
});
