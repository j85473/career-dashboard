import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { defaultJobSort, statusEntryHistoryValue, usesStatusEntryTimeSort } from '../jobSort';

test('Inbox, Applied, and Archived lifecycle logs use their intended date defaults', () => {
  assert.equal(defaultJobSort('inbox'), 'combined');
  assert.equal(defaultJobSort('log'), 'newest');
  assert.equal(defaultJobSort('tailoring'), 'aim_fit');
  for (const status of [
    'applied',
    'archived',
    'bookmarked',
    'cooldown',
    'expired',
    'passed',
    'local_dismissed',
    'dismissed',
  ]) {
    assert.equal(defaultJobSort(status), 'newest', status);
  }
  assert.equal(statusEntryHistoryValue('local_dismissed'), 'dismissed');
  assert.equal(statusEntryHistoryValue('dismissed'), 'dismissed');
  assert.equal(usesStatusEntryTimeSort('applied', 'newest'), true);
  assert.equal(usesStatusEntryTimeSort('cooldown', 'oldest'), true);
  assert.equal(usesStatusEntryTimeSort('applied', 'aim_fit'), false);
  assert.equal(usesStatusEntryTimeSort('interviewing', 'newest'), false);
});

test('the Inbox client and jobs API share the default sort policy', () => {
  const dashboard = readFileSync(
    path.join(process.cwd(), 'src', 'components', 'Dashboard.tsx'),
    'utf8',
  );
  const jobsRoute = readFileSync(
    path.join(process.cwd(), 'src', 'app', 'api', 'jobs', 'route.ts'),
    'utf8',
  );

  assert.match(dashboard, /tabSorts\[dataStatus\] \|\| defaultJobSort\(dataStatus\)/);
  assert.match(dashboard, /tabSorts\[status\] \|\| defaultJobSort\(status\)/);
  assert.match(jobsRoute, /searchParams\.get\('sort'\) \|\| defaultJobSort\(status\)/);
});
