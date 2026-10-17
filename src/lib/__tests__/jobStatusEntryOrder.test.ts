import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Prisma } from '../prismaClient';
import { statusEntryOrderedPage } from '../jobStatusEntryOrder';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'jobStatusEntryOrder.ts'),
  'utf8',
);

test('lifecycle logs order by the latest entry into their current status', () => {
  assert.match(source, /FROM "JobStatusHistory" history/);
  assert.match(source, /history\.status = \$\{historyStatus\}/);
  assert.match(source, /SELECT MAX\(history\."createdAt"\)/);
  assert.match(source, /job\.status = 'dismissed' AND job\."aimFitScore" IS NULL/);
  assert.match(source, /job\.status = 'dismissed' AND job\."aimFitScore" IS NOT NULL/);
  assert.match(source, /client\.job\.count\(\{ where \}\)/);
  assert.match(source, /job\."updatedAt"/);
  assert.match(source, /direction === 'asc'/);
  assert.match(source, /job\.id ASC/);
  assert.doesNotMatch(source, /job\."createdAt"/);
});

test('opening the full archive avoids one history lookup per archived job', async () => {
  let query: Prisma.Sql | undefined;
  const where = { status: 'archived' };
  const client = {
    $queryRaw: async (sql: Prisma.Sql) => {
      query = sql;
      return [{ id: 'archived-job' }];
    },
    job: { count: async (args: { where: Prisma.JobWhereInput }) => {
      assert.deepEqual(args.where, where);
      return 1_623_371;
    } },
  } as unknown as Parameters<typeof statusEntryOrderedPage>[5];

  const page = await statusEntryOrderedPage(where, 'archived', 'desc', 48, 96, client);
  assert.deepEqual(page, { ids: ['archived-job'], total: 1_623_371 });
  assert.ok(query);
  assert.match(query.text, /GROUP BY history\."jobId"/);
  assert.doesNotMatch(query.text, /WHERE history\."jobId" = job\.id/);
  assert.deepEqual(query.values, ['archived', 'archived', 48, 96]);
});

test('archive searches keep history lookups limited to the exact matched jobs', async () => {
  let query: Prisma.Sql | undefined;
  const client = {
    $queryRaw: async (sql: Prisma.Sql) => {
      query = sql;
      return [{ id: 'matched-job' }];
    },
    job: { count: async () => { throw new Error('Search totals come from the matched IDs.'); } },
  } as unknown as Parameters<typeof statusEntryOrderedPage>[5];

  const page = await statusEntryOrderedPage({}, 'archived', 'asc', 48, 0, client, ['matched-job']);
  assert.deepEqual(page, { ids: ['matched-job'], total: 1 });
  assert.ok(query);
  assert.match(query.text, /WHERE history\."jobId" = job\.id/);
  assert.doesNotMatch(query.text, /GROUP BY/);
  assert.deepEqual(query.values, ['matched-job', 'archived', 48, 0]);
});
