import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const route = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'ats-companies', 'route.ts'),
  'utf8',
);
const ui = readFileSync(
  path.join(process.cwd(), 'src', 'components', 'AdvancedSearchTab.tsx'),
  'utf8',
);

test('Advanced Search loads a bounded per-platform overview and paginates on demand', () => {
  assert.match(route, /ROW_NUMBER\(\) OVER \(PARTITION BY platform ORDER BY slug ASC\)/);
  assert.match(route, /WHERE rank <= \$\{limit\}/);
  assert.match(ui, /overview=1&limit=\$\{BOARD_PAGE_SIZE\}/);
  assert.match(ui, /loadMoreCompanies\(platform, visibleCompanies\.length\)/);
  assert.doesNotMatch(ui, /ats-companies\?limit=100000/);
});

test('selecting every company is an explicit identity-only request', () => {
  assert.match(ui, /identitiesOnly: '1'/);
  assert.match(route, /identitiesOnly \? 100000/);
  assert.match(route, /!identitiesOnly \? \{ lastCheckedAt: true \} : \{\}/);
});
