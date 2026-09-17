import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'appliedJobOrder.ts'),
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
  assert.match(source, /history\.status = 'applied'/);
  assert.match(source, /\) DESC,/);
  assert.match(source, /job\."updatedAt"/);
  assert.doesNotMatch(source, /job\."createdAt"/);
});

test('normal and scoped Applied views share the same immutable ordering', () => {
  assert.match(listRoute, /status === 'applied'/);
  assert.match(listRoute, /appliedJobOrderedPage\(where, limit, offset\)/);
  assert.match(searchRoute, /appliedSearchCandidates/);
  assert.match(searchRoute, /appliedJobOrderedPage\(/);
});
