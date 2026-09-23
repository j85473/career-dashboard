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

test('applied-today counts immutable human transitions in the Chicago calendar day', () => {
  assert.match(routeSource, /COUNT\(DISTINCT "jobId"\) FILTER/);
  assert.match(routeSource, /"eventType" = 'user_lifecycle'/);
  assert.match(routeSource, /details->>'nextStatus' = 'applied'/);
  assert.match(routeSource, /details->>'actor' = 'user'/);
  assert.match(routeSource, /details->>'derived' IS DISTINCT FROM 'true'/);
  assert.match(
    routeSource,
    /\("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE params\."timeZone"\)::time >= TIME '00:01:00'/,
  );
  assert.match(statsUiSource, /label="Applied today"/);
  assert.match(statsUiSource, /today\?\.appliedToday/);
  assert.match(statsUiSource, /since 12:01 a\.m\. Minneapolis time/);
});

test('the simplified Stats surface keeps results first and only three diagnostic groups', () => {
  const results = statsUiSource.indexOf('eyebrow="Results"');
  const attention = statsUiSource.indexOf('eyebrow="Attention"');
  const progress = statsUiSource.indexOf('eyebrow="Progress"');
  const coverage = statsUiSource.indexOf('eyebrow="Coverage"');
  assert.ok(results >= 0 && results < attention && attention < progress && progress < coverage);
  for (const summary of [
    'Source and provider diagnostics',
    'Scoring and outcome audit',
    'ATS and scheduler diagnostics',
  ]) assert.match(statsUiSource, new RegExp(summary));
  for (const removed of [
    'Lifetime totals and window comparison',
    'Employer board detail, by platform and by lifecycle stage',
    'Job inventory ·',
  ]) assert.doesNotMatch(statsUiSource, new RegExp(removed));
  assert.match(statsUiSource, /providerFaults = new Map/);
  assert.match(statsUiSource, /incident\.status === 'open'/);
  assert.doesNotMatch(statsUiSource, /incident\.lastSeenAt[\s\S]{0,200}24 \* 60 \* 60_000/);
  assert.match(statsUiSource, /Provider-blocked tasks/);
  assert.match(routeSource, /const snapshotNow = new Date\(\)/);
  assert.equal((routeSource.match(/nextCheckDate: \{ (?:lte|gt): snapshotNow \}/g) || []).length, 3);
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
  assert.match(statsUiSource, /Active boards/);
  assert.match(statsUiSource, /Blacklisted/);
  // The headline used to be the raw catalog total, which counts tens of
  // thousands of retired boards nothing sweeps. Active leads; retired is its
  // own reading.
  assert.doesNotMatch(statsUiSource, /Total endpoints/);
  assert.match(statsUiSource, /Retired/);
  assert.match(routeSource, /attempt\."contactedAt" >= params\."dayStartUtc"/);
  assert.match(routeSource, /attempt\."contactedAt" < params\."dayEndUtc"/);
  assert.match(routeSource, /COUNT\(DISTINCT \(event\.slug, event\.platform\)\) FILTER/);
  assert.match(routeSource, /"respondedToday"/);
  assert.match(routeSource, /"synchronizedToday"/);
  assert.match(routeSource, /requiredAtsBoardChecksPerDay\(atsCoverageInputs\[0\]\)/);
  assert.match(routeSource, /enabled: ATS_SPLIT_INGESTION_ENABLED/);
  assert.match(routeSource, /lastAttemptedAt: true/);
  assert.match(routeSource, /status: \{ in: \['fetching', 'partial', 'queued', 'processing', 'failed'\] \}/);
  assert.equal((routeSource.match(/>= params\."dayStartUtc"/g) || []).length, 5);
  assert.equal((routeSource.match(/< params\."dayEndUtc"/g) || []).length, 5);
  assert.doesNotMatch(routeSource, /DATE\(attempt\."(?:contactedAt|respondedAt|synchronizedAt|processedAt|finishedAt)"/);
  assert.doesNotMatch(routeSource, /attempt\."requestCount" > 0/);
  assert.match(statsUiSource, /Awaiting first sweep/);
  assert.match(statsUiSource, /ATS and scheduler diagnostics/);
  /*
   * These tiles are gone and must not come back. Each read a source no writer
   * fills: the first five queried the per-board attempt log the v2 engine
   * retired on 2026-08-31, and the rest summed a batch job counter that engine
   * leaves at zero. All of them displayed a confident zero forever, which is
   * how a 97%-complete rotation read as a dead pipeline.
   */
  for (const retired of [
    'Legacy claim contacts today',
    'Responded today',
    'Synchronized today',
    'Processed today',
    'Empty deferrals, last hour',
    'Jobs remaining',
    'Backpressure gate',
    'Processed, last hour',
    'Prequeue dupes, last hour',
    'Oldest synchronized',
    'Due for a check',
  ]) {
    // Matched as a rendered tile label, so the comment explaining the removal
    // does not itself trip the check.
    assert.ok(
      !statsUiSource.includes(`<span>${retired}</span>`),
      `retired stats tile is back: ${retired}`,
    );
  }
  assert.match(routeSource, /"prequeueDuplicatesLastHour"/);
  assert.match(routeSource, /__careerDashboardAtsPrequeueCompaction/);
  assert.match(
    routeSource,
    /"ingestionMode" IS DISTINCT FROM 'ats_prequeue_compaction'[\s\S]*?checkpoint #>> '\{queuedJobCount\}' = '0'/,
    'mixed-board compaction preserves job counters without double-counting a successful run',
  );
  assert.match(routeSource, /"deferredWithoutContactLastHour"/);
  assert.match(routeSource, /"remainingJobs"/);
  assert.match(statsUiSource, /ATS and scheduler diagnostics/);
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

test('attention uses recent incidents and clean duplicate activity rather than stale fault labels', () => {
  assert.match(routeSource, /WHERE "lastSeenAt" >= \(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\) - INTERVAL '7 days'/);
  assert.doesNotMatch(routeSource, /WHERE status = 'open' OR "lastSeenAt"/);
  assert.match(routeSource, /hasCleanDuplicateOnlyActivity\(/);
  assert.match(routeSource, /"recentSeenCount"/);
  assert.match(routeSource, /"recentDuplicateCount"/);
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

test('failure queue counts use current-input Aim receipt authority once per request', () => {
  assert.match(routeSource, /import \{ currentAimSuppressedJobIds \} from '@\/lib\/currentAimFailureSuppression'/);
  assert.match(
    routeSource,
    /operationalQueueWhere\('scoring_failed', resolvedAimSuppressedJobIds\)/,
  );
  assert.equal((routeSource.match(/currentAimSuppressedJobIds\(prisma\)/g) || []).length, 1);
});

test('operational queue counts use the shared exact partition', () => {
  for (const category of ['local_scoring', 'needs_jd', 'jd_failed', 'scoring_failed', 'aim_fit', 'experience_fit']) {
    assert.match(
      routeSource,
      new RegExp(`operationalQueueWhere\\('${category}', resolvedAimSuppressedJobIds\\)`),
    );
    assert.doesNotMatch(routeSource, new RegExp(`logWhere\\('${category}'\\)`));
  }
  assert.match(routeSource, /logWhere\('context'\)/);
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
