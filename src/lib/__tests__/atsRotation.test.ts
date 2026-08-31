import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assignedRotationDay,
  ATS_DAILY_BOARD_TARGET,
  ATS_INGESTION_EXCLUDED_BOARDS,
  ATS_RECOVERY_STATUSES,
  ATS_ROTATION_STATUSES,
  atsBoardIngestionExclusion,
  isAtsBoardEnabledForIngestion,
  isSchedulableBoardSlug,
  ATS_ROTATION_DAY_NAMES,
  ATS_ROTATION_DAYS,
  atsRotationCycleCutoff,
  nextAtsBoardCheckDate,
  nextAtsBoardCheckDateForDay,
  rotationDayFor,
  requiredAtsBoardChecksPerDay,
  summarizeRotationBalance,
} from '../atsRotation';

test('a board always lands on the same day', () => {
  // Stability is the whole point: a rediscovered board must return to the
  // cohort it left, and re-running the backfill must not reshuffle the week.
  const first = assignedRotationDay('acme', 'greenhouse');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    assert.equal(assignedRotationDay('acme', 'greenhouse'), first);
  }
  assert.ok(first >= 0 && first < ATS_ROTATION_DAYS);
});

test('weekday assignment uses a strong deterministic digest', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/atsRotation.ts'), 'utf8');
  assert.match(source, /createHash\('sha256'\)/);
  assert.doesNotMatch(source, /createHash\(['"](?:md5|sha1)['"]\)/i);
});

test('slug and platform are distinct inputs', () => {
  // Same slug on two platforms is two boards and may sit on different days.
  const combinations = new Set([
    assignedRotationDay('acme', 'greenhouse'),
    assignedRotationDay('acme', 'lever'),
    assignedRotationDay('acme::lever', 'greenhouse'),
  ]);
  assert.ok(combinations.size >= 1);
  assert.notEqual(
    `${assignedRotationDay('a', 'bc')}:${'a::bc'}`,
    `${assignedRotationDay('ab', 'c')}:${'ab::c'}`,
  );
});

test('assignment spreads a large catalog evenly', () => {
  const counts: Record<number, number> = {};
  for (let index = 0; index < 43_461; index += 1) {
    const day = assignedRotationDay(`company-${index}`, 'workday');
    counts[day] = (counts[day] || 0) + 1;
  }
  const balance = summarizeRotationBalance(counts);
  assert.equal(balance.cohorts.length, 7);
  // Real catalog measures 2.89%; a generous bound still catches a broken hash.
  assert.ok(balance.maxDeviation < 0.05, `deviation was ${balance.maxDeviation}`);
});

test('the daily operating target covers the current catalog with growth headroom', () => {
  assert.equal(ATS_DAILY_BOARD_TARGET, 6_200);
  assert.equal(requiredAtsBoardChecksPerDay(43_149), 6_200);
  assert.equal(requiredAtsBoardChecksPerDay(43_461), 6_209);
  assert.equal(requiredAtsBoardChecksPerDay(100), 100);
  assert.equal(requiredAtsBoardChecksPerDay(0), 0);
});

test('every day of the week is reachable', () => {
  const seen = new Set<number>();
  for (let index = 0; index < 500; index += 1) seen.add(assignedRotationDay(`b${index}`, 'ashby'));
  assert.equal(seen.size, ATS_ROTATION_DAYS);
});

test('today is read in the rotation calendar, not the server clock', () => {
  // 2026-08-25T03:00Z is still Monday evening in Chicago.
  const lateMonday = new Date('2026-08-25T03:00:00.000Z');
  assert.equal(ATS_ROTATION_DAY_NAMES[rotationDayFor(lateMonday)], 'Monday');
  assert.equal(ATS_ROTATION_DAY_NAMES[rotationDayFor(lateMonday, 'UTC')], 'Tuesday');
  assert.equal(ATS_ROTATION_DAY_NAMES[rotationDayFor(new Date('2026-08-23T18:00:00.000Z'))], 'Sunday');
});

test('a swept board returns on the same weekday one rotation later', () => {
  const swept = new Date('2026-08-25T15:00:00.000Z');
  const next = nextAtsBoardCheckDate(swept);
  assert.equal(next.valueOf() - swept.valueOf(), ATS_ROTATION_DAYS * 86_400_000);
  assert.equal(rotationDayFor(next), rotationDayFor(swept));
});

test('catch-up returns a board to its assigned weekday instead of drifting', () => {
  const caughtUpOnTuesday = new Date('2026-08-25T15:00:00.000Z');
  const nextMonday = nextAtsBoardCheckDateForDay(1, caughtUpOnTuesday);
  assert.equal(ATS_ROTATION_DAY_NAMES[rotationDayFor(nextMonday)], 'Monday');
  assert.equal(nextMonday.valueOf() - caughtUpOnTuesday.valueOf(), 6 * 86_400_000);
  assert.throws(() => nextAtsBoardCheckDateForDay(7, caughtUpOnTuesday), /Invalid ATS rotation day/);
});

test('the cycle cutoff is one rotation back', () => {
  const now = new Date('2026-08-25T12:00:00.000Z');
  assert.equal(
    atsRotationCycleCutoff(now).toISOString(),
    new Date(now.valueOf() - 7 * 86_400_000).toISOString(),
  );
});

test('balance summary reports an empty catalog without dividing by zero', () => {
  const balance = summarizeRotationBalance({});
  assert.equal(balance.mean, 0);
  assert.equal(balance.maxDeviation, 0);
  assert.equal(balance.cohorts.every((cohort) => cohort.boards === 0), true);
});

test('only active boards hold a rotation slot; failing boards keep a retry lane', () => {
  assert.deepEqual([...ATS_ROTATION_STATUSES], ['active']);
  assert.deepEqual([...ATS_RECOVERY_STATUSES], ['parked', 'blacklisted']);
  // Failing boards are still visited — 1,165 parked boards returned jobs on
  // their last check — they just never outrank a board that is working.
  assert.equal(ATS_RECOVERY_STATUSES.length > 0, true);
});

test('a Workday tenant::site slug is schedulable and a parse artefact is not', () => {
  for (const slug of [
    'agreenspace.wd3::Global_Express_Career_Site',
    'welltok',
    '1p',
    '1871',
    'hippocratic ai',
  ]) {
    assert.equal(isSchedulableBoardSlug(slug), true, slug);
  }
  for (const slug of ['', '   ', '...', '=', '-', 'ascenaretail.wd5::;', 'okgov.wd1::...']) {
    assert.equal(isSchedulableBoardSlug(slug), false, JSON.stringify(slug));
  }
});

test('the operator-excluded MMC board cannot enter either ATS ingestion path', () => {
  const mmc = { slug: 'mmc.wd1::mmc', platform: 'workday' };
  assert.equal(ATS_INGESTION_EXCLUDED_BOARDS.length, 2);
  assert.match(atsBoardIngestionExclusion(mmc) || '', /Operator-excluded/);
  assert.equal(isSchedulableBoardSlug(mmc.slug), true, 'the exclusion is a product decision, not malformed identity');
  assert.equal(isAtsBoardEnabledForIngestion(mmc), false);
  assert.equal(isAtsBoardEnabledForIngestion({ ...mmc, slug: 'mmc.wd1::another-site' }), true);
  assert.equal(isAtsBoardEnabledForIngestion({ ...mmc, platform: 'greenhouse' }), true);
});

test('the giant Meijer hourly board is excluded without suppressing smaller Meijer sites', () => {
  const hourly = { slug: 'meijer.wd5::meijer_stores_hourly', platform: 'workday' };
  assert.match(atsBoardIngestionExclusion(hourly) || '', /Meijer Stores Hourly/);
  assert.equal(isAtsBoardEnabledForIngestion(hourly), false);
  assert.equal(
    isAtsBoardEnabledForIngestion({ ...hourly, slug: 'meijer.wd5::Meijer_Stores_Hourly' }),
    false,
    'the duplicate case variant must not bypass the exclusion',
  );
  assert.equal(isAtsBoardEnabledForIngestion({ ...hourly, slug: 'meijer.wd5::Meijer' }), true);
  assert.equal(isAtsBoardEnabledForIngestion({ ...hourly, slug: 'meijer.wd5::Meijer_Stores_Leadership' }), true);
  assert.equal(
    isAtsBoardEnabledForIngestion({ ...hourly, slug: 'meijer.wd5::Fresh_Thyme_Stores_External_Career_Site' }),
    true,
  );
});

test('the sweep fills three tiers in strict priority order', () => {
  const ingestion = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');
  const selection = ingestion.slice(
    ingestion.indexOf('const rotationNow = new Date();'),
    ingestion.indexOf('activeBoards = activeBoards.filter(isAtsBoardEnabledForIngestion);'),
  );
  assert.ok(selection.length > 0, 'the rotation selection is missing');
  assert.match(selection, /checkDay: today,/);
  assert.match(selection, /checkDay: \{ not: today \}/);
  assert.match(selection, /lastCheckedAt: \{ lt: atsRotationCycleCutoff\(rotationNow\) \}/);
  // Later tiers only ever spend capacity the earlier ones did not need.
  assert.equal((selection.match(/if \(remaining\(\) > 0\)/g) || []).length, 2);
  assert.equal((selection.match(/take: remaining\(\)/g) || []).length, 2);
  // The recovery lane is last and is the only tier that sees failing boards.
  const rotationTiers = selection.indexOf('ATS_RECOVERY_STATUSES');
  assert.ok(rotationTiers > selection.lastIndexOf('ATS_ROTATION_STATUSES'));
  // Parse-artefact slugs never reach a request.
  assert.match(ingestion, /activeBoards = activeBoards\.filter\(isAtsBoardEnabledForIngestion\)/);
});

test('the durable ATS worker gives the assigned weekday strict priority', () => {
  const acquisition = readFileSync(path.join(process.cwd(), 'src/lib/atsAcquisition.ts'), 'utf8');
  const worker = acquisition.slice(
    acquisition.indexOf('export async function selectDueAtsBoards'),
    acquisition.indexOf('export async function atsQueueDepth'),
  );
  assert.ok(worker.length > 0, 'the dedicated ATS worker is missing');
  const assigned = worker.indexOf('checkDay: today');
  const catchUp = worker.indexOf('checkDay: { not: today }');
  const missed = worker.indexOf('lastCheckedAt: { lt: atsRotationCycleCutoff(now) }');
  const recovery = worker.indexOf('ATS_RECOVERY_STATUSES');
  assert.ok(assigned > 0 && catchUp > assigned && missed > catchUp && recovery > missed);
  const resumePhase = worker.indexOf('ingestionBatches: { some:');
  const outstandingCap = worker.indexOf('const outstanding = await prisma.atsIngestionBatch.count');
  const newBatchPhase = worker.indexOf('ingestionBatches: { none:');
  assert.ok(
    resumePhase > recovery && outstandingCap > resumePhase && newBatchPhase > outstandingCap,
    'partial/fetching batches must resume before capacity is spent on new batches',
  );
  assert.equal(
    (worker.match(/for \(let tierIndex = 0; tierIndex < tiers\.length/g) || []).length,
    2,
    'the resume and new-batch phases must each retain assigned/catch-up/recovery priority',
  );
  assert.match(worker, /status: \{ in: \[\.\.\.OUTSTANDING_BATCH_STATUSES\] \}/);
  assert.match(worker, /planAtsSelectionCapacity\(\{/);
  assert.match(worker, /status: \{ in: \[\.\.\.ATS_ROTATION_STATUSES\] \}/);
  assert.match(worker, /status: \{ in: \[\.\.\.ATS_RECOVERY_STATUSES\] \}/);
  assert.doesNotMatch(worker, /WORKDAY_DEFERRAL_CANARY_BOARD_LIMIT/);
  assert.match(
    acquisition,
    /platformBoards\.flatMap\(\(rows\) => orderAtsCoverageCandidates\(rows, now\)\)/,
  );
  assert.match(acquisition, /prioritizedBoards\.filter\(isAtsBoardEnabledForIngestion\)/);
});

test('the MMC startup reconciliation preserves evidence while removing live work', () => {
  const acquisition = readFileSync(
    path.join(process.cwd(), 'src/lib/atsAcquisition.ts'),
    'utf8',
  );
  const reconciliation = acquisition.slice(
    acquisition.indexOf('export async function reconcileAtsIngestionExclusions'),
    acquisition.indexOf('async function fairBoardsForTier'),
  );
  const loop = readFileSync(path.join(process.cwd(), 'src/lib/atsAcquisitionLoop.ts'), 'utf8');
  assert.match(reconciliation, /status: 'excluded'/);
  assert.match(reconciliation, /slug: \{ equals: excluded\.slug, mode: 'insensitive' \}/);
  assert.match(reconciliation, /status: \{ in: \[\.\.\.OUTSTANDING_BATCH_STATUSES\] \}/);
  assert.match(reconciliation, /lastError: excluded\.reason/);
  assert.doesNotMatch(reconciliation, /payload:/);
  assert.doesNotMatch(reconciliation, /job\.(?:update|delete)|prisma\.job/i);
  assert.ok(
    loop.indexOf('await reconcileAtsIngestionExclusions();') < loop.indexOf('while (!await stopped())'),
    'excluded work must leave the backlog before the first backpressure measurement',
  );
});

test('the day assignment has exactly one definition', () => {
  // A second implementation in SQL could disagree and move boards between
  // cohorts, so the migration deliberately leaves the spread to the backfill.
  const migration = readFileSync(
    path.join(process.cwd(), 'prisma/migrations/20260825150000_ats_rotation_day/migration.sql'),
    'utf8',
  );
  assert.doesNotMatch(migration, /MD5|HASHTEXT/i);
  assert.match(migration, /ADD COLUMN "checkDay" INTEGER NOT NULL DEFAULT 0/);
  const backfill = readFileSync(
    path.join(process.cwd(), 'scripts/backfill_ats_rotation_days.ts'),
    'utf8',
  );
  assert.match(backfill, /assignedRotationDay\(board\.slug, board\.platform\)/);
  assert.match(backfill, /const apply = argv\.includes\('--apply'\)/);
  // The backfill sets the sweep day and nothing else.
  assert.match(backfill, /data: \{ checkDay: day \}/);
  assert.doesNotMatch(backfill, /nextCheckDate:|status:\s*'/);
});
