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
    assert.match(cte, /rank = 1 AND "staleAt" IS NULL/);
  }
});

test('provider budgets expose the period keys that scope their counters', () => {
  assert.match(routeSource, /"budgetDay"/);
  assert.match(routeSource, /"budgetMonth"/);
});

test('inventory score averages use newest nonstale score-event authority', () => {
  assert.doesNotMatch(routeSource, /prisma\.job\.aggregate\(\{ _avg: \{ aimFitScore/);
  assert.match(routeSource, /ROUND\(AVG\("aimFitScore"\), 1\)::float AS "averageAim"/);
  assert.match(routeSource, /ROUND\(AVG\("experienceFitScore"\), 1\)::float AS "averageExperience"/);
  assert.match(routeSource, /WHERE rank = 1 AND "staleAt" IS NULL/);
});
