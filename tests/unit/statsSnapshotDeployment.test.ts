import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const route = readFileSync('src/app/api/stats/route.ts', 'utf8');

test('Stats cold load keeps full-history control reads off the shared pool queue', () => {
  const basicLoader = route.indexOf('const basicQueries = prisma.$transaction(async (tx) =>');
  const controlLoader = route.indexOf('const loadControlQueries = () => ingestionControlAvailable');
  const basicCompletion = route.indexOf(
    'const [basicResults, legacyRuns] = await Promise.all([basicQueries, legacyRecentRuns]);',
  );
  const controlCompletion = route.indexOf('const controlResults = await loadControlQueries();');

  assert.ok(basicLoader >= 0);
  assert.match(
    route.slice(basicLoader, controlLoader),
    /SET TRANSACTION READ ONLY/,
    'the basic snapshot must stay on one read-only connection',
  );
  assert.ok(controlLoader > basicLoader);
  assert.match(route.slice(controlLoader, basicCompletion), /prisma\.\$transaction\(\[/);
  assert.ok(basicCompletion > controlLoader);
  assert.ok(controlCompletion > basicCompletion);
});
