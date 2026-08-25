import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const routeSource = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'stats', 'route.ts'),
  'utf8',
);
const statsUiSource = readFileSync(
  path.join(process.cwd(), 'src', 'components', 'StatsTab.tsx'),
  'utf8',
);
const scopeSource = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'statsScoringScope.ts'),
  'utf8',
);

test('entered-inbox metric requires a genuine A/E admission or human promotion', () => {
  assert.match(routeSource, /"eventType" = 'ae_pass'[\s\S]*details @> '\{"enteredInbox": true\}'::jsonb/);
  assert.match(routeSource, /"eventType" = 'user_promote'/);
  assert.doesNotMatch(routeSource, /FROM "JobStatusHistory"/);
});

test('latest stale score suppresses the job instead of resurrecting an older score', () => {
  // The ranking CTEs moved into the shared scope helper so every calibration
  // metric draws from one definition. Staleness must be applied AFTER ranking:
  // filtering it inside the window function would promote a superseded score.
  const rankingCtes = scopeSource.match(/ranked_(?:aim|experience) AS \([\s\S]*?\)\s*,/g) || [];
  assert.equal(rankingCtes.length, 2);
  for (const cte of rankingCtes) {
    assert.doesNotMatch(cte, /"staleAt" IS NULL/);
    assert.match(cte, /ROW_NUMBER\(\) OVER/);
  }
  for (const scoped of ['current_aim', 'current_experience']) {
    const block = scopeSource.slice(scopeSource.indexOf(`${scoped} AS (`));
    assert.match(block, /rank = 1[\s\S]{0,200}"staleAt" IS NULL/);
  }
});

test('the score scope binds through the v2 extraction, never the retired v1 artifact', () => {
  // Regression guard. The stats page read zero for every calibration metric
  // because it INNER JOINed JobScoringArtifact on cleanedJdArtifactId, which
  // scoringImport has written as null since the Aim/Experience v2 launch.
  // Only the emitted SQL is checked — the file's history comment names the
  // retired identifiers on purpose and must stay readable.
  const emittedSql = scopeSource.slice(scopeSource.indexOf('Prisma.sql`'));
  assert.doesNotMatch(emittedSql, /JobScoringArtifact/);
  assert.doesNotMatch(emittedSql, /cleanedJdArtifactId/);
  assert.doesNotMatch(routeSource, /JobScoringArtifact/);
  assert.doesNotMatch(routeSource, /cleanedJdArtifactId/);
  assert.match(scopeSource, /JOIN "AimFactualExtraction" extraction/);
  assert.match(scopeSource, /extraction\."staleAt" IS NULL/);
  // v2 inputBindings carry no sourceJdHash on Aim events; comparing it silently
  // matched nothing and reintroduced the same class of bug.
  assert.doesNotMatch(scopeSource, /extraction\."sourceJdHash" =/);
  assert.match(scopeSource, /experience\."inputBindings"->>'aimSemanticResultHash' = aim\."semanticResultHash"/);
});

test('metrics with no backing data are reported as unavailable rather than zero', () => {
  assert.match(routeSource, /unavailable\('no_matching_evaluations'\)/);
  assert.match(routeSource, /stageMetric\(0, lifetimeEventCount\('local_pass', 'local_reject'\)\)/);
  assert.match(statsUiSource, /ops-metric-unavailable/);
  assert.match(statsUiSource, /not_instrumented: 'not instrumented'/);
});

test('the ATS catalog reports every status, not just the active slice', () => {
  assert.match(routeSource, /blacklisted: atsByStatus\.blacklisted \|\| 0/);
  assert.match(routeSource, /dueForCheck: atsDueNow/);
  assert.match(statsUiSource, /Total endpoints/);
  assert.match(statsUiSource, /Blacklisted/);
});

test('Travel Watch is fully removed from the stats surface', () => {
  // Aim v2 folded travel into the Aim score and stopped writing travelScore,
  // so every travel surface here was reporting on a column nothing populates.
  assert.doesNotMatch(routeSource, /travelWatch|travelBucket|travelScore/);
  assert.doesNotMatch(statsUiSource, /travelWatch|Travel Watch|travelBuckets/);
  assert.doesNotMatch(scopeSource, /travelScore/);
});

test('provider budgets expose the period keys that scope their counters', () => {
  assert.match(routeSource, /"budgetDay"/);
  assert.match(routeSource, /"budgetMonth"/);
});

test('Stats attributes Indeed task budgets to Indeed12 without merging failure telemetry', () => {
  assert.match(
    routeSource,
    /import \{ INDEED12_BUDGET_PROVIDER \} from '@\/lib\/ingestionControl'/,
  );
  const budgetJoins = routeSource.match(
    /LEFT JOIN "ProviderCircuit" budget_circuit ON budget_circuit\.provider = CASE\s+WHEN task\.source = 'Indeed' THEN \$\{INDEED12_BUDGET_PROVIDER\}\s+ELSE task\.source\s+END/g,
  ) || [];
  assert.equal(budgetJoins.length, 2);
  assert.equal(
    (routeSource.match(/LEFT JOIN "ProviderCircuit" circuit ON circuit\.provider = task\.source/g) || []).length,
    2,
  );
  assert.ok((routeSource.match(/budget_circuit\."dailyUsed" >= budget_circuit\."dailyLimit"/g) || []).length >= 4);
  assert.ok((routeSource.match(/circuit\.state = 'open'/g) || []).length >= 4);
  assert.doesNotMatch(routeSource, /budget_circuit\.state = 'open'/);
});

test('inventory score averages use newest nonstale score-event authority', () => {
  assert.doesNotMatch(routeSource, /prisma\.job\.aggregate\(\{ _avg: \{ aimFitScore/);
  assert.match(routeSource, /ROUND\(AVG\("aimFitScore"\), 1\)::float FROM current_aim/);
  assert.match(routeSource, /ROUND\(AVG\("experienceFitScore"\), 1\)::float FROM current_experience/);
  assert.match(scopeSource, /experience\."sourceAimEventId" = aim\.id/);
});

test('daily aggregates reuse one bound Chicago time zone in grouped expressions', () => {
  assert.match(routeSource, /\$\{CHICAGO_TIME_ZONE\}::text AS "timeZone"/);
  assert.match(
    routeSource,
    /GROUP BY DATE\(source_run\."startedAt" AT TIME ZONE 'UTC' AT TIME ZONE params\."timeZone"\)/,
  );
  assert.match(
    routeSource,
    /GROUP BY DATE\("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE params\."timeZone"\)/,
  );
  assert.doesNotMatch(
    routeSource,
    /GROUP BY DATE\([^\n]+AT TIME ZONE \$\{CHICAGO_TIME_ZONE\}\)/,
  );
});

test('task availability categories exclude retired and orchestration rows from runnable calculations', () => {
  for (const category of [
    'running', 'runnableNow', 'scheduled', 'circuitCooldown', 'budgetBlocked',
    'failedAwaitingRetry', 'staleLease', 'retired', 'orchestration',
  ]) assert.match(routeSource, new RegExp(`'${category}'`));
  assert.match(routeSource, /"taskKind" = 'search' AND "lifecycleStatus" = 'active'/);
  assert.match(routeSource, /MIN\("nextRunAt"\) FILTER \(WHERE category = 'runnableNow'\)/);
  assert.match(routeSource, /MIN\("availableAt"\) FILTER/);
  assert.doesNotMatch(routeSource, /MIN\("nextRunAt"\)[\s\S]{0,80}category = 'orchestration'/);
});

test('task availability uses a UTC wall clock in an America/Chicago PostgreSQL session', () => {
  // Prisma DateTime columns are PostgreSQL TIMESTAMP values containing UTC wall
  // time. At 18:00Z in an America/Chicago session, bare NOW() presents 13:00
  // local wall time, so a UTC-valued 17:30 task looks scheduled instead of due.
  const storedUtcWallClock = '2026-08-23T17:30:00';
  const chicagoSessionWallClock = '2026-08-23T13:00:00';
  const utcWallClock = '2026-08-23T18:00:00';
  assert.equal(storedUtcWallClock <= chicagoSessionWallClock, false);
  assert.equal(storedUtcWallClock <= utcWallClock, true);

  const availabilityUtcParams = routeSource.match(
    /WITH params AS \(\s*(?:--[^\n]*\n\s*)*SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"\s*\),\s*availability AS/g,
  ) || [];
  assert.equal(availabilityUtcParams.length, 2);

  for (const comparison of [
    /task\."nextRunAt" <= params\."utcNow"/g,
    /task\."nextRunAt" > params\."utcNow"/g,
    /task\."leaseExpiresAt" <= params\."utcNow"/g,
    /circuit\."openUntil" > params\."utcNow"/g,
  ]) {
    assert.ok((routeSource.match(comparison) || []).length >= 2);
  }

  assert.doesNotMatch(routeSource, /task\."(?:nextRunAt|leaseExpiresAt)"\s*[<>]=?\s*NOW\(\)/);
  assert.doesNotMatch(routeSource, /circuit\."openUntil"\s*>\s*NOW\(\)/);
});

test('Action Needed count uses current-input Aim receipt authority once per request', () => {
  assert.match(routeSource, /import \{ currentAimSuppressedJobIds \} from '@\/lib\/currentAimFailureSuppression'/);
  assert.match(
    routeSource,
    /actionableQueueWhereWithCurrentAimSuppressions\(resolvedAimSuppressedJobIds\)/,
  );
  assert.equal((routeSource.match(/currentAimSuppressedJobIds\(prisma\)/g) || []).length, 1);
  assert.doesNotMatch(routeSource, /job\.count\(\{ where: actionableQueueWhere\(\) \}\)/);
});

test('operational queue counts use the shared exact partition', () => {
  for (const category of ['local_scoring', 'needs_jd', 'aim_fit', 'experience_fit']) {
    assert.match(
      routeSource,
      new RegExp(`operationalQueueWhere\\('${category}', resolvedAimSuppressedJobIds\\)`),
    );
    assert.doesNotMatch(routeSource, new RegExp(`logWhere\\('${category}'\\)`));
  }
  assert.match(routeSource, /logWhere\('context'\)/);
  assert.match(
    routeSource,
    /actionableQueueWhereWithCurrentAimSuppressions\(resolvedAimSuppressedJobIds\)/,
  );
});

test('budget-blocked SQL counts feed the public summary and reconciliation under one internal key', () => {
  assert.match(routeSource, /category = 'budgetBlocked'\)::int AS "budgetBlocked"/);
  assert.match(routeSource, /activeTaskCategoryTotal = \[[^\]]*'budgetBlocked'/);
  assert.match(routeSource, /blockedBudget: numberFromDatabase\(taskSummary\.budgetBlocked\)/);
  assert.doesNotMatch(routeSource, /taskSummary\.blockedBudget/);
});

test('Stats UI presents availability sections, running progress, and truncation disclosure', () => {
  assert.match(statsUiSource, /Runnable backlog/);
  assert.match(statsUiSource, /Running now/);
  assert.match(statsUiSource, /Blocked &amp; retrying/);
  assert.match(statsUiSource, /Recent checkpoints/);
  assert.match(statsUiSource, /eligible for/);
  assert.match(statsUiSource, /blocked until/);
  assert.match(statsUiSource, /Showing \{visible\.length\} of \{total\} tasks/);
  assert.match(statsUiSource, /showRetiredTasks/);
  assert.doesNotMatch(statsUiSource, /20679d ago|Due backlog & checkpoints|Next due/);
});
