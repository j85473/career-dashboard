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

test('entered-inbox metric requires a genuine A/E admission or human promotion', () => {
  assert.match(routeSource, /"eventType" = 'ae_pass'[\s\S]*details @> '\{"enteredInbox": true\}'::jsonb/);
  assert.match(routeSource, /"eventType" = 'user_promote'/);
  assert.doesNotMatch(routeSource, /FROM "JobStatusHistory"/);
});

test('latest stale score suppresses the job instead of resurrecting an older score', () => {
  const rankingCtes = routeSource.match(/WITH ranked AS \([\s\S]*?GROUP BY/g) || [];
  assert.equal(rankingCtes.length >= 2, true);
  for (const cte of rankingCtes.slice(0, 2)) {
    assert.match(cte, /"staleAt"/);
    assert.doesNotMatch(cte, /WHERE "evaluationType"[^\n]*"staleAt" IS NULL/);
    assert.match(cte, /rank = 1[\s\S]{0,120}"staleAt" IS NULL/);
  }
});

test('provider budgets expose the period keys that scope their counters', () => {
  assert.match(routeSource, /"budgetDay"/);
  assert.match(routeSource, /"budgetMonth"/);
});

test('inventory score averages use newest nonstale score-event authority', () => {
  assert.doesNotMatch(routeSource, /prisma\.job\.aggregate\(\{ _avg: \{ aimFitScore/);
  assert.match(routeSource, /ROUND\(AVG\("aimFitScore"\), 1\)::float FROM current_aim/);
  assert.match(routeSource, /ROUND\(AVG\("experienceFitScore"\), 1\)::float FROM current_experience/);
  assert.match(routeSource, /experience\."sourceAimEventId" = aim\.id/);
  assert.match(routeSource, /artifact\."staleAt" IS NULL/);
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

test('budget-blocked SQL counts feed the public summary and reconciliation under one internal key', () => {
  assert.match(routeSource, /category = 'budgetBlocked'\)::int AS "budgetBlocked"/);
  assert.match(routeSource, /activeTaskCategoryTotal = \[[^\]]*'budgetBlocked'/);
  assert.match(routeSource, /blockedBudget: numberFromDatabase\(taskSummary\.budgetBlocked\)/);
  assert.doesNotMatch(routeSource, /taskSummary\.blockedBudget/);
});

test('Stats UI presents availability sections, running progress, and truncation disclosure', () => {
  assert.match(statsUiSource, /Runnable backlog/);
  assert.match(statsUiSource, /Running now/);
  assert.match(statsUiSource, /Provider cooldowns & retries/);
  assert.match(statsUiSource, /Recent checkpoints/);
  assert.match(statsUiSource, /eligible for/);
  assert.match(statsUiSource, /blocked until/);
  assert.match(statsUiSource, /Showing \{visible\.length\} of \{total\} tasks/);
  assert.match(statsUiSource, /showRetiredTasks/);
  assert.doesNotMatch(statsUiSource, /20679d ago|Due backlog & checkpoints|Next due/);
});
