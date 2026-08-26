import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ATS_COVERAGE_OBJECTIVE, evaluateAtsCoverageSlo } from '../atsCoverageSlo';
import { ATS_ROTATION_DAYS, atsRotationCycleCutoff, nextAtsBoardCheckDate } from '../atsRotation';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.valueOf() - days * 86_400_000);

test('the rotation rule is one sweep per board per week', () => {
  assert.equal(ATS_ROTATION_DAYS, 7);
  assert.equal(
    nextAtsBoardCheckDate(NOW).toISOString(),
    new Date(NOW.valueOf() + 7 * 86_400_000).toISOString(),
  );
  assert.equal(atsRotationCycleCutoff(NOW).toISOString(), daysAgo(7).toISOString());
});

test('uneven cohorts breach even when coverage looks fine', () => {
  // The state right after the migration and before the backfill: every board
  // sitting on Sunday. Coverage alone would not notice.
  const slo = evaluateAtsCoverageSlo({
    activeBoards: 43_461,
    boardsCheckedWithinCycle: 43_461,
    boardsNeverChecked: 0,
    oldestCheckedAt: daysAgo(1),
    now: NOW,
    boardsByRotationDay: { 0: 43_461, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
  });
  assert.equal(slo.status, 'breached');
  assert.match(slo.breachReasons[0], /cohorts are uneven: Sunday carries 43,461/);
  assert.ok(slo.cohortImbalance > 0.1);
});

test('an evenly assigned catalog reports balanced cohorts', () => {
  const even = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((day) => [day, 6_209]));
  const slo = evaluateAtsCoverageSlo({
    activeBoards: 43_463,
    boardsCheckedWithinCycle: 43_463,
    boardsNeverChecked: 0,
    oldestCheckedAt: daysAgo(3),
    now: NOW,
    boardsByRotationDay: even,
  });
  assert.equal(slo.status, 'healthy');
  assert.equal(slo.cohorts.length, 7);
  assert.ok(slo.cohortImbalance < 0.01);
});

test('a fully rotated inventory is healthy', () => {
  const slo = evaluateAtsCoverageSlo({
    activeBoards: 43_461,
    boardsCheckedWithinCycle: 43_461,
    boardsNeverChecked: 0,
    oldestCheckedAt: daysAgo(6),
    now: NOW,
  });
  assert.equal(slo.status, 'healthy');
  assert.deepEqual(slo.breachReasons, []);
  assert.equal(slo.coverageRatio, 1);
});

test('the August 25 production shape reports a breach naming both causes', () => {
  // 43,461 active, ~20,600 checked in the last 14 days, 24,247 never checked.
  const slo = evaluateAtsCoverageSlo({
    activeBoards: 43_461,
    boardsCheckedWithinCycle: 8_457,
    boardsNeverChecked: 24_247,
    oldestCheckedAt: daysAgo(20),
    now: NOW,
  });
  assert.equal(slo.status, 'breached');
  assert.equal(slo.breachReasons.length, 2);
  assert.match(slo.breachReasons[0], /were not swept in the last 7 days/);
  assert.match(slo.breachReasons[1], /never been swept/);
  assert.equal(slo.boardsOutsideCycle, 43_461 - 8_457);
});

test('the SLO states the throughput the rule requires', () => {
  const slo = evaluateAtsCoverageSlo({
    activeBoards: 43_461,
    boardsCheckedWithinCycle: 43_461,
    boardsNeverChecked: 0,
    oldestCheckedAt: daysAgo(1),
    now: NOW,
  });
  // 43,461 / 7 — the number that has to be met for a weekly rotation to be real.
  assert.equal(slo.requiredChecksPerDay, 6_209);
});

test('a small shortfall is at risk before it breaches', () => {
  const slo = evaluateAtsCoverageSlo({
    activeBoards: 1000,
    boardsCheckedWithinCycle: 999,
    boardsNeverChecked: 0,
    oldestCheckedAt: daysAgo(7),
    now: NOW,
  });
  assert.equal(slo.coverageRatio >= ATS_COVERAGE_OBJECTIVE, true);
  assert.equal(slo.status, 'at_risk');
  assert.deepEqual(slo.breachReasons, []);
});

test('never-checked boards always breach, even at full nominal coverage', () => {
  const slo = evaluateAtsCoverageSlo({
    activeBoards: 1000,
    boardsCheckedWithinCycle: 1000,
    boardsNeverChecked: 12,
    oldestCheckedAt: daysAgo(2),
    now: NOW,
  });
  assert.equal(slo.status, 'breached');
  assert.match(slo.breachReasons[0], /never been swept/);
});

test('an empty inventory does not divide by zero or report a false breach', () => {
  const slo = evaluateAtsCoverageSlo({
    activeBoards: 0, boardsCheckedWithinCycle: 0, boardsNeverChecked: 0,
    oldestCheckedAt: null, now: NOW,
  });
  assert.equal(slo.coverageRatio, 1);
  assert.equal(slo.status, 'healthy');
  assert.equal(slo.oldestCheckedAgeDays, null);
});

test('ingestion schedules the next sweep one rotation out, not tomorrow', () => {
  const ingestion = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');
  assert.match(ingestion, /nextCheckDate: nextAtsBoardCheckDateForDay\(board\.checkDay\)/);
  assert.match(ingestion, /const nextCheck = nextAtsBoardCheckDateForDay\(board\.checkDay\)/);
  // The old fixed one-day recheck is what made every board permanently overdue.
  assert.doesNotMatch(ingestion, /nextCheckDate: new Date\(Date\.now\(\) \+ 24 \* 60 \* 60 \* 1000\)/);
});

test('Stats measures coverage from last-checked time, not from due depth', () => {
  const route = readFileSync(path.join(process.cwd(), 'src/app/api/stats/route.ts'), 'utf8');
  assert.match(route, /coverageSlo: evaluateAtsCoverageSlo\(/);
  assert.match(route, /lastCheckedAt: \{ gte: atsRotationCycleCutoff\(new Date\(\)\) \}/);
  assert.match(route, /boardsNeverChecked: atsCoverageInputs\[2\]/);
  assert.match(route, /boardsByRotationDay: Object\.fromEntries/);
});
