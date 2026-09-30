import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const route = readFileSync('src/app/api/stats/route.ts', 'utf8');
const activation = readFileSync('scripts/deployment/activate-m70.sh', 'utf8');
const warmService = readFileSync('scripts/deployment/m70/career-dashboard-stats-warm.service', 'utf8');
const warmTimer = readFileSync('scripts/deployment/m70/career-dashboard-stats-warm.timer', 'utf8');

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

test('Stats stays warm without visitors and waits for an invocation to finish before the next one', () => {
  // The cache belongs to Next's web process. A standalone database loader
  // would do the same expensive work without warming what a visitor receives.
  assert.match(warmService, /Requisite=career-dashboard\.service/);
  assert.match(warmService, /ExecStart=\/usr\/bin\/curl .*http:\/\/100\.107\.116\.123:3000\/api\/stats/);
  assert.match(warmService, /--fail .*--max-time 90/);
  assert.match(warmService, /TimeoutStartSec=100s/);
  assert.match(warmTimer, /OnBootSec=30s/);
  assert.match(warmTimer, /OnUnitInactiveSec=60s/);
  assert.doesNotMatch(warmTimer, /OnUnitActiveSec|OnCalendar/);
  assert.match(route, /STATS_SNAPSHOT_MAX_SERVE_MS = 600_000/);
});

test('a release proves the visitor cache works before acquisition resumes and keeps warmup out of maintenance', () => {
  const healthy = activation.indexOf('(( HEALTHY == 1 ))');
  const warm = activation.indexOf('systemctl start career-dashboard-stats-warm.service', healthy);
  const hit = activation.indexOf("grep -i '^x-career-stats-cache: hit'", warm);
  const restart = activation.lastIndexOf('restart_background');
  assert.ok(healthy >= 0 && healthy < warm && warm < hit && hit < restart);
  assert.match(activation, /if \[\[ \$MODE == normal \]\]; then\n systemctl enable --now career-dashboard-stats-warm\.timer/);
  assert.match(activation, /\[\[ \$MODE != maintenance \]\] \|\| STATS_WARM=0/);
  const recovery = activation.slice(activation.indexOf('recover() {'), activation.indexOf('trap recover ERR'));
  assert.match(recovery, /systemctl stop career-dashboard-stats-warm\.timer career-dashboard-stats-warm\.service/);
  assert.match(recovery, /\(\( STATS_WARM != 0 \)\) \|\| systemctl disable career-dashboard-stats-warm\.timer/);
});
