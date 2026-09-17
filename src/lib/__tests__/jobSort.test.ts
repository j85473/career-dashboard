import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { defaultJobSort, selectedJobSort } from '../jobSort';

test('Inbox and Applied use their fixed operational defaults', () => {
  assert.equal(defaultJobSort('inbox'), 'combined');
  assert.equal(defaultJobSort('log'), 'newest');
  assert.equal(defaultJobSort('tailoring'), 'aim_fit');
  assert.equal(defaultJobSort('applied'), 'newest');
  for (const requested of [undefined, null, '', 'newest', 'oldest', 'aim_fit', 'experience_fit']) {
    assert.equal(selectedJobSort('applied', requested), 'newest');
  }
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

  const searchRoute = readFileSync(
    path.join(process.cwd(), 'src', 'app', 'api', 'jobs', 'search', 'route.ts'),
    'utf8',
  );

  assert.match(dashboard, /selectedJobSort\(dataStatus, tabSorts\[dataStatus\]\)/);
  assert.match(dashboard, /selectedJobSort\(status, options\.sort \|\| tabSorts\[status\]\)/);
  assert.match(jobsRoute, /selectedJobSort\(status, searchParams\.get\('sort'\)\)/);
  assert.match(searchRoute, /selectedJobSort\(status \|\| '', searchParams\.get\('sort'\)\)/);
  assert.doesNotMatch(dashboard, /'bookmarked', 'applied', 'interviewing'/);
});
