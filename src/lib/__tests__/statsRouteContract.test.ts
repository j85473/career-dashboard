import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const routeSource = readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'stats', 'route.ts'),
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
