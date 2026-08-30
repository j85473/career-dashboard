import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const activate = readFileSync('scripts/deployment/activate-release.sh', 'utf8');
const route = readFileSync('src/app/api/stats/route.ts', 'utf8');

test('Stats exposes snapshot state and deployment warms it before cron resumes', () => {
  assert.match(route, /X-Career-Stats-Cache/);
  assert.match(route, /createLatestSuccessfulSnapshot/);
  const warm = activate.indexOf('Stats snapshot warmed and verified.');
  const enableCron = activate.indexOf('install-crontab-remote.sh');
  assert.ok(warm >= 0);
  assert.match(activate, /X-Career-Stats-Cache: hit/);
  assert.ok(warm < activate.lastIndexOf('install-crontab-remote.sh'));
  assert.ok(enableCron >= 0);
});

test('Stats cold load keeps full-history control reads off the shared pool queue', () => {
  const controlLoader = route.indexOf('const loadControlQueries = () => ingestionControlAvailable');
  const basicCompletion = route.indexOf(
    'const [basicResults, legacyRuns] = await Promise.all([basicQueries, legacyRecentRuns]);',
  );
  const controlCompletion = route.indexOf('const controlResults = await loadControlQueries();');

  assert.ok(controlLoader >= 0);
  assert.match(route.slice(controlLoader, basicCompletion), /prisma\.\$transaction\(\[/);
  assert.ok(basicCompletion > controlLoader);
  assert.ok(controlCompletion > basicCompletion);
});
