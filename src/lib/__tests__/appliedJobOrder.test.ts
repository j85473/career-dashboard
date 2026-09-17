import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'jobStatusEntryOrder.ts'),
  'utf8',
);
const listRoute = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'jobs', 'route.ts'),
  'utf8',
);
const searchRoute = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'jobs', 'search', 'route.ts'),
  'utf8',
);

test('Applied is paged by the most recent explicit application decision', () => {
  assert.match(source, /FROM "JobStatusHistory" history/);
  assert.match(source, /SELECT MAX\(history\."createdAt"\)/);
  assert.match(source, /history\.status = \$\{historyStatus\}/);
  assert.match(source, /direction === 'asc' \? Prisma\.sql`ASC` : Prisma\.sql`DESC`/);
  assert.match(source, /job\."updatedAt"/);
  assert.doesNotMatch(source, /job\."createdAt"/);
});

test('normal and scoped Applied views share the same immutable ordering', () => {
  assert.match(listRoute, /usesStatusEntryTimeSort\(status, sort\)/);
  assert.match(listRoute, /statusEntryOrderedPage\(where, status, sort === 'oldest' \? 'asc' : 'desc', limit, offset\)/);
  assert.match(searchRoute, /statusEntrySearchCandidates/);
  assert.match(searchRoute, /statusEntryOrderedPage\(/);
});
