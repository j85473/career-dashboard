import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { assignedRotationDay, nextAtsBoardCheckDateForDay } from '../atsRotation';
import { atsRotationReviewWasIncomplete, reserveNewAtsRotationDay, reviewAtsRotationWorkload } from '../atsRotationBalancing';
import {
  ATS_ROTATION_BALANCE_POLICY, buildAtsWorkloadProfiles, estimateAtsBoardWorkload,
  lightestAtsWorkloadDay, planAtsRotationWorkload, type AtsWorkloadBoard, type AtsWorkloadDay,
} from '../atsRotationWorkload';

const now = new Date('2026-10-07T17:00:00Z');
const completed = new Date('2026-10-05T05:01:00Z');
function catalog(length = 98): AtsWorkloadBoard[] {
  return Array.from({ length }, (_, index) => ({
    slug: `board-${index}`, platform: 'workday', checkDay: index % 7, jobsFound: 10,
    failCount: 0, retryCount: 0, nextCheckDate: nextAtsBoardCheckDateForDay(index % 7, now),
    lastProcessedAt: completed, rotationMovedAt: null, hasOpenWork: false,
    sampleJobs: 10, workerMs: index === 1 || index === 8 ? 100_000 : 1_000, sampleAt: completed,
  }));
}

test('equal board counts with unequal work produce bounded, useful moves without postponing coverage', () => {
  const boards = catalog();
  const plan = planAtsRotationWorkload(boards, now);
  assert.equal(plan.moves.length, 1); // 2% of 98, rounded down.
  assert.ok(plan.varianceImprovement > 0.4);
  assert.equal(plan.moves[0].fromDay, 1);
  assert.ok(plan.moves[0].nextCheckDate <= plan.moves[0].fromNextCheckDate);
  assert.ok(plan.moves[0].nextCheckDate.valueOf() >= completed.valueOf() + ATS_ROTATION_BALANCE_POLICY.minimumCycleGapMs);
  assert.deepEqual(boards.map((board) => board.checkDay), Array.from({ length: 98 }, (_, i) => i % 7));
});

test('unfinished, retrying, overdue, recently moved and unmeasured boards cannot move', () => {
  const protections: Array<(board: AtsWorkloadBoard) => void> = [
    (board) => { board.hasOpenWork = true; },
    (board) => { board.failCount = 1; },
    (board) => { board.retryCount = 1; },
    (board) => { board.nextCheckDate = new Date(now.valueOf() - 1); },
    (board) => { board.nextCheckDate = new Date(now.valueOf() + 3_600_000); },
    (board) => { board.nextCheckDate = new Date(now.valueOf() + 30 * 86_400_000); },
    (board) => { board.lastProcessedAt = board.sampleAt = new Date(now.valueOf() - 10 * 86_400_000); },
    (board) => { board.rotationMovedAt = new Date(now.valueOf() - 86_400_000); },
    (board) => { board.sampleAt = null; board.workerMs = null; },
    (board) => { board.lastProcessedAt = new Date(completed.valueOf() + 1); },
  ];
  for (const protect of protections) {
    const boards = catalog();
    protect(boards[1]); protect(boards[8]);
    const plan = planAtsRotationWorkload(boards, now);
    assert.ok(!plan.moves.some((move) => move.slug === 'board-1' || move.slug === 'board-8'));
  }
});

test('a balanced week stays stable, and the browser-only lane does not influence API balance', () => {
  const boards = catalog().map((board) => ({ ...board, workerMs: 1_000 }));
  boards.push({ ...boards[0], slug: 'browser', platform: 'gusto', workerMs: 100_000_000 });
  const plan = planAtsRotationWorkload(boards, now);
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.measuredBoards, 98);
  assert.ok(plan.before.every((day) => day.workerMs === 14_000));
});

test('unknown boards reserve provider-estimated work and expired measurements are not treated as current', () => {
  const boards = catalog();
  const profiles = buildAtsWorkloadProfiles(boards, now);
  const unknown = { ...boards[0], sampleAt: null, workerMs: null, jobsFound: 10_000 };
  assert.equal(estimateAtsBoardWorkload(unknown, profiles, now).workerMs, 1_000_000);
  const stale = { ...boards[0], sampleAt: new Date('2026-08-01T00:00:00Z') };
  assert.equal(estimateAtsBoardWorkload(stale, profiles, now).measured, false);
});

test('new assignments choose workload over board count and keep deterministic ties', () => {
  const days: AtsWorkloadDay[] = Array.from({ length: 7 }, (_, day) => ({
    day, dayName: String(day), boards: day === 4 ? 100 : 1, workerMs: day === 4 ? 1 : 10_000,
  }));
  assert.equal(lightestAtsWorkloadDay('new', 'workday', days), 4);
  const equal = days.map((day) => ({ ...day, boards: 1, workerMs: 1 }));
  assert.equal(lightestAtsWorkloadDay('new', 'workday', equal), assignedRotationDay('new', 'workday'));
});

test('successive discovery reservations include the preceding board before choosing a day', async () => {
  let days = Array.from({ length: 7 }, (_, day) => ({ day, dayName: String(day), boards: 1, workerMs: day * 100 }));
  const client = {
    $executeRaw: async () => 1,
    atsRotationBalanceState: {
      findUnique: async () => ({ days, refreshedAt: now, profiles: { '*': { msPerJob: 1_000, typicalJobs: 10, samples: 1 } } }),
      update: async (args: { data: { days: AtsWorkloadDay[] } }) => { days = args.data.days; },
    },
  } as unknown as Parameters<typeof reserveNewAtsRotationDay>[0];
  assert.equal(await reserveNewAtsRotationDay(client, { slug: 'first', platform: 'workday' }, 100, now), 0);
  assert.equal(await reserveNewAtsRotationDay(client, { slug: 'second', platform: 'workday' }, 100, now), 1);
  assert.equal(days[0].workerMs, 100_000);
});

test('a missing or stale estimate falls back without delaying new-board collection', async () => {
  for (const state of [null, { refreshedAt: new Date(now.valueOf() - 37 * 3_600_000) }]) {
    const client = { $executeRaw: async () => 1,
      atsRotationBalanceState: { findUnique: async () => state,
        update: async () => { throw new Error('Stale estimates cannot be reserved'); } },
    } as unknown as Parameters<typeof reserveNewAtsRotationDay>[0];
    assert.equal(await reserveNewAtsRotationDay(client, { slug: 'new', platform: 'workday' }, 10, now), assignedRotationDay('new', 'workday'));
  }
});

function reviewClient(boards: AtsWorkloadBoard[], lastRebalancedAt: Date | null,
  returnRows: (call: number) => boolean = () => true, currentBoards = boards,
  runs: Array<{ createdAt: Date; report: Record<string, unknown> }> = []) {
  const counters = { boardUpdates: 0, stateWrites: 0, receipts: 0, rolledBack: false };
  const queries = { snapshot: '', snapshotValues: [] as unknown[], updates: [] as string[], updateValues: [] as unknown[][],
    stateUpserts: [] as Array<{ create: { lastRebalancedAt: Date | null }; update: { lastRebalancedAt?: Date | null } }> };
  const transaction = {
    $executeRaw: async () => 0,
    $executeRawUnsafe: async (sql: string) => {
      if (sql.startsWith('ROLLBACK TO')) counters.rolledBack = true;
      return 0;
    },
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      queries.snapshot = sql; queries.snapshotValues = values; return boards;
    },
    $queryRaw: async (sql: Prisma.Sql) => {
      queries.updates.push(sql.text);
      queries.updateValues.push(sql.values);
      return returnRows(counters.boardUpdates++) ? [{ slug: 'matched' }] : [];
    },
    atsCompany: { findMany: async () => currentBoards },
    atsRotationBalanceState: { findUnique: async () => ({ lastRebalancedAt }),
      upsert: async (args: typeof queries.stateUpserts[number]) => { counters.stateWrites += 1; queries.stateUpserts.push(args); } },
    atsRotationBalanceRun: { findFirst: async (args: { where?: { report: { equals: string } } }) =>
      [...runs].filter((run) => !args.where || run.report.observedAt === args.where.report.equals)
        .sort((left, right) => right.createdAt.valueOf() - left.createdAt.valueOf())[0] || null,
      create: async () => { counters.receipts += 1; } },
  };
  const client = { $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction) };
  return { counters, queries, client: client as unknown as Parameters<typeof reviewAtsRotationWorkload>[0] };
}

test('snapshot and final write fence both protect queued or processing work without a live lease', async () => {
  const { client, queries } = reviewClient(catalog(), null);
  const report = await reviewAtsRotationWorkload(client, true, now);
  assert.ok(report.appliedMoves.length > 0, 'exercise the final write guard as well as the snapshot');
  for (const query of [queries.snapshot, ...queries.updates]) {
    const unfinishedPredicate = query.match(/b\.status IN \(([^)]+)\)\s+OR b\."leaseExpiresAt"/);
    assert.ok(unfinishedPredicate, 'unfinished status independently blocks a move when both leases are absent');
    const statuses = [...unfinishedPredicate[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.ok(statuses.includes('queued'), 'downloaded legacy work waiting to process must block the move');
    assert.ok(statuses.includes('processing'), 'an expired processing lease must not expose an unfinished board');
  }
});

test('snapshot, timestamp write guards and assigned dates bind UTC text independently of the database timezone', async () => {
  const { client, queries } = reviewClient(catalog(), null);
  await reviewAtsRotationWorkload(client, true, now);
  assert.deepEqual(queries.snapshotValues, [now.toISOString()]);
  assert.match(queries.snapshot, /\$1::timestamp/);
  assert.ok(queries.updateValues.length > 0);
  for (const [queryIndex, values] of queries.updateValues.entries()) {
    assert.ok(values.every((value) => !(value instanceof Date)), 'Date binds as timestamptz and shifts UTC timestamp columns');
    const timestamps = values.flatMap((value, index) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)
      ? [{ value, index }] : []);
    assert.equal(timestamps.length, 7, 'assignment, prior values, cooldown and both lease guards must stay timestamp-safe');
    for (const { index } of timestamps) {
      assert.ok(queries.updates[queryIndex].includes(`$${index + 1}::timestamp`));
    }
  }
});

test('a read-only preview cannot reserve capacity, move a board, or create a review receipt', async () => {
  const { client, counters } = reviewClient(catalog(), null);
  const report = await reviewAtsRotationWorkload(client, false, now);
  assert.equal(report.mode, 'preview');
  assert.equal(report.writesPerformed, 0);
  assert.ok(report.moves.length > 0);
  assert.deepEqual(counters, { boardUpdates: 0, stateWrites: 0, receipts: 0, rolledBack: false });
});

test('daily refresh keeps estimates current without moving boards twice in a week', async () => {
  const { client, counters } = reviewClient(catalog(), new Date(now.valueOf() - 86_400_000));
  const report = await reviewAtsRotationWorkload(client, true, now);
  assert.equal(report.appliedMoves.length, 0);
  assert.equal(counters.boardUpdates, 0);
  assert.equal(counters.stateWrites, 1);
  assert.equal(counters.receipts, 1);
  assert.deepEqual(report.after, report.before);
});

test('concurrent guard failures cannot leave immaterial weekday changes behind', async () => {
  const boards = catalog(196);
  const arrival = { ...boards[0], slug: 'arrived-during-scan', jobsFound: 500 };
  const { client, counters } = reviewClient(boards, null, (call) => call > 0, [...boards, arrival]);
  const report = await reviewAtsRotationWorkload(client, true, now);
  assert.ok(report.moves.length > 1);
  assert.equal(counters.rolledBack, true);
  assert.equal(report.appliedMoves.length, 0);
  assert.deepEqual(report.after, report.before);
  assert.equal(counters.stateWrites, 1);
  assert.ok('reviewOutcome' in report && report.reviewOutcome === 'deferred');
  assert.ok('rolledBackMoves' in report && report.rolledBackMoves > 0);
});

test('all rejected move guards retain retry eligibility instead of consuming the weekly interval', async () => {
  const { client, queries } = reviewClient(catalog(), null, () => false);
  const report = await reviewAtsRotationWorkload(client, true, now);
  assert.ok('reviewOutcome' in report && report.reviewOutcome === 'deferred');
  assert.ok('guardedOutMoves' in report && report.guardedOutMoves === report.moves.length);
  assert.equal(queries.stateUpserts[0].create.lastRebalancedAt, null);
  assert.equal(queries.stateUpserts[0].update.lastRebalancedAt, undefined);
});

test('a valid zero-plan review still consumes the weekly interval', async () => {
  const boards = catalog().map((board) => ({ ...board, workerMs: 1_000 }));
  const { client, queries } = reviewClient(boards, null);
  const report = await reviewAtsRotationWorkload(client, true, now);
  assert.equal(report.moves.length, 0);
  assert.ok('reviewOutcome' in report && report.reviewOutcome === 'complete');
  assert.equal(queries.stateUpserts[0].update.lastRebalancedAt, now);
});

test('an older incomplete review remains retryable after newer daily refresh receipts', async () => {
  const priorAt = new Date(now.valueOf() - 86_400_000);
  const incomplete = { mode: 'apply', observedAt: priorAt.toISOString(), reviewDue: true,
    moves: [{ slug: 'planned' }], appliedMoves: [], appliedVarianceImprovement: 0, writesPerformed: 2 };
  const runs = [
    { createdAt: priorAt, report: incomplete },
    { createdAt: new Date(now.valueOf() - 3_600_000), report: { ...incomplete,
      observedAt: new Date(now.valueOf() - 3_600_000).toISOString(), reviewDue: false } },
  ];
  const { client, queries } = reviewClient(catalog(), priorAt, () => true, catalog(), runs);
  const report = await reviewAtsRotationWorkload(client, true, now);
  assert.ok('priorReviewIncomplete' in report && report.priorReviewIncomplete);
  assert.ok(report.appliedMoves.length > 0);
  assert.ok('reviewOutcome' in report && report.reviewOutcome === 'complete');
  assert.equal(queries.stateUpserts[0].update.lastRebalancedAt, now);

  for (const changed of [
    { observedAt: now.toISOString() }, { mode: 'preview' }, { reviewDue: false },
    { moves: [] }, { appliedMoves: [{}] }, { appliedVarianceImprovement: 0.1 },
    { writesPerformed: 3 }, { reviewOutcome: 'complete' },
  ]) assert.equal(atsRotationReviewWasIncomplete({ ...incomplete, ...changed }, priorAt), false);
});

test('a refresh includes boards discovered during the receipt scan', async () => {
  const boards = catalog();
  const arrival = { ...boards[0], slug: 'just-discovered', checkDay: 2, jobsFound: 100 };
  const { client } = reviewClient(boards, now, () => true, [...boards, arrival]);
  const report = await reviewAtsRotationWorkload(client, true, now);
  assert.equal(report.before.reduce((sum, day) => sum + day.boards, 0), 99);
  assert.equal(report.after[2].boards, 15);
  assert.equal(report.after[2].workerMs, 24_000);
});
