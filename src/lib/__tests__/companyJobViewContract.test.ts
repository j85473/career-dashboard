import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const dashboard = readFileSync(
  path.join(process.cwd(), 'src', 'components', 'Dashboard.tsx'),
  'utf8',
);
const overlay = readFileSync(
  path.join(process.cwd(), 'src', 'components', 'ExpandOverlay.tsx'),
  'utf8',
);
const searchRoute = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'jobs', 'search', 'route.ts'),
  'utf8',
);

test('expanded company logo is an accessible company navigation control', () => {
  assert.match(overlay, /onCompanySelect: \(company: string\) => void/);
  assert.match(overlay, /onClick=\{\(\) => onCompanySelect\(job\.company\)\}/);
  assert.match(overlay, /aria-label=\{`Show all jobs at \$\{companyLabel\}`\}/);
  assert.match(overlay, /workdayCompanyDisplayName\(job\.company, job\.source\)/);
});

test('company view is URL-backed, cross-status, paginated, and status-labelled', () => {
  assert.match(dashboard, /searchParams\.get\('company'\)/);
  assert.match(dashboard, /new URLSearchParams\(\{ company, page: String\(page\), limit: '48' \}\)/);
  assert.match(dashboard, /All jobs at \{companyFilter\} across the Dashboard/);
  assert.match(dashboard, /showStatusBadge/);
  assert.match(dashboard, /Load more \(\$\{companyPagination\.total - companyResults\.length\} remaining\)/);
});

test('company search uses exact matching and omits a lifecycle scope by default', () => {
  assert.match(searchRoute, /exactCompanyWhere\(searchParams\.get\('company'\)\)/);
  assert.match(searchRoute, /const statusCondition = status\s+\? jobWhereWithCurrentAimSuppressions\(status, logTab, resolvedSuppressionIds\)\s+: \{\}/);
  assert.match(searchRoute, /const searchCondition: Prisma\.JobWhereInput = companyCondition \|\|/);
});

test('cross-status company results survive ordinary lifecycle and tailoring changes', () => {
  assert.match(dashboard, /const leavesInbox = !companyFilter && dataStatus === 'inbox'/);
  assert.match(dashboard, /!companyFilter && activeTab === 'inbox' && isStaged/);
  assert.match(dashboard, /setCompanyResults\(prev => prev\?\.map/);
});
