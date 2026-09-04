import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { defaultJobSort } from '../jobSort';

test('Inbox defaults to Combined Sort without changing other board defaults', () => {
  assert.equal(defaultJobSort('inbox'), 'combined');
  assert.equal(defaultJobSort('log'), 'newest');
  assert.equal(defaultJobSort('tailoring'), 'aim_fit');
  assert.equal(defaultJobSort('applied'), 'aim_fit');
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
