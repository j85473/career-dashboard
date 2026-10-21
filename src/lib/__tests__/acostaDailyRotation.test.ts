import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATS_DAILY_BOARDS, isDailyAtsBoard, isAtsBoardInRotationCohort,
  nextAtsBoardCheckDateForBoard, nextApiBoardCheckDateForDay as nextAtsBoardCheckDateForDay, dailyAtsScheduleOpening, apiRotationCheckDays,
} from '../atsRotation';
import { atsRotationCohortWhere, atsRotationCohortSql } from '../atsRotationCohort';
import { planAtsRotationWorkload, type AtsWorkloadBoard } from '../atsRotationWorkload';

const board = { ...ATS_DAILY_BOARDS[0], checkDay: 6 };

test('the three production Acosta sites belong to all four API cohorts', () => {
  for (const daily of ATS_DAILY_BOARDS) {
    assert.equal(isDailyAtsBoard(daily), true);
    for (let day = 0; day < 4; day++) {
      assert.equal(isAtsBoardInRotationCohort({ ...daily, checkDay: 6 }, day), true);
      assert.deepEqual(atsRotationCohortWhere(day), { OR: [{ checkDay: { in: apiRotationCheckDays(day) } }, ...ATS_DAILY_BOARDS] });
      const sql = atsRotationCohortSql(day);
      assert.equal(sql.values[1], day);
      assert.ok(sql.values.includes(daily.slug));
    }
  }
  for (const slug of ['eczy-test.fa.us2.oraclecloud.com::CX_1', 'eczy-dev3.fa.us2.oraclecloud.com::CX_1', 'mosaic.wd5::mosaic', 'eczy.fa.us2.oraclecloud.com::OTHER']) {
    assert.equal(isDailyAtsBoard({ slug, platform: 'oracle' }), false);
  }
  assert.equal(isAtsBoardInRotationCohort({ slug: 'other', platform: 'oracle', checkDay: 6 }, 3), false);
});

test('daily success reopens next Chicago day with DST-safe calendar arithmetic', () => {
  for (const [now, expected] of [
    ['2026-10-20T16:00:00Z', '2026-10-21T05:01:00.000Z'],
    ['2026-03-08T06:30:00Z', '2026-03-09T05:01:00.000Z'],
    ['2026-11-01T05:30:00Z', '2026-11-02T06:01:00.000Z'],
  ]) {
    assert.equal(nextAtsBoardCheckDateForBoard(board, new Date(now)).toISOString(), expected);
  }
  const now = new Date('2026-10-20T16:00:00Z');
  assert.deepEqual(nextAtsBoardCheckDateForBoard({ ...board, slug: 'other' }, now), nextAtsBoardCheckDateForDay(6, now));
});

test('conversion only advances an ordinary weekly slot with no failures or same-day sweep', () => {
  const now = new Date('2026-10-20T16:00:00Z');
  const candidate = { ...board, status: 'active', failCount: 0, retryCount: 0,
    lastSynchronizedAt: new Date('2026-10-17T06:59:09Z'), nextCheckDate: new Date('2026-10-24T05:01:00Z') };
  assert.equal(dailyAtsScheduleOpening(candidate, now)?.toISOString(), '2026-10-20T05:01:00.000Z');
  for (const change of [
    { failCount: 1 }, { retryCount: 1 }, { status: 'excluded' },
    { nextCheckDate: new Date('2026-10-24T12:00:00Z') },
    { lastSynchronizedAt: now }, { lastSynchronizedAt: null },
  ]) assert.equal(dailyAtsScheduleOpening({ ...candidate, ...change }, now), null);
});

test('workload planning counts daily boards on every day without moving their weekday', () => {
  const row: AtsWorkloadBoard = { ...board, jobsFound: 10, failCount: 0, retryCount: 0,
    nextCheckDate: new Date('2026-10-21T05:01:00Z'), lastProcessedAt: new Date('2026-10-20T12:00:00Z'),
    rotationMovedAt: null, hasOpenWork: false, sampleJobs: 10, workerMs: 1000, sampleAt: new Date('2026-10-20T12:00:00Z') };
  const plan = planAtsRotationWorkload([row], new Date('2026-10-20T16:00:00Z'));
  assert.deepEqual(plan.before.map((day) => day.boards), [1, 1, 1, 1]);
  assert.equal(plan.moves.length, 0);
});

import { prisma } from '../prisma';
import { repairStaggeredAtsRotationSchedule } from '../atsAcquisitionDispatcherV2';

test('startup conversion rechecks the old schedule and refuses to overwrite in-flight work', async () => {
  const now = new Date('2026-10-20T16:00:00Z');
  const nextCheckDate = new Date('2026-10-24T05:01:00Z');
  const lastSynchronizedAt = new Date('2026-10-17T06:59:09Z');
  const findMany = prisma.atsCompany.findMany;
  const updateMany = prisma.atsCompany.updateMany;
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  prisma.atsCompany.findMany = (async () => [{ ...board, status: 'active', failCount: 0,
    retryCount: 0, nextCheckDate, lastSynchronizedAt }]) as typeof findMany;
  prisma.atsCompany.updateMany = (async (args: unknown) => {
    writes.push(args as typeof writes[number]);
    return { count: writes.length === 1 ? 1 : 0 };
  }) as typeof updateMany;
  try {
    assert.equal((await repairStaggeredAtsRotationSchedule(now)).repaired, 1);
    assert.equal(writes[0].where.nextCheckDate, nextCheckDate);
    assert.equal(writes[0].where.lastSynchronizedAt, lastSynchronizedAt);
    assert.deepEqual(writes[0].where.ingestionBatches, { none: { status: { in: ['fetching', 'partial', 'synchronized'] } } });
    assert.deepEqual(writes[0].data, { nextCheckDate: new Date('2026-10-20T05:01:00Z') });
  } finally {
    prisma.atsCompany.findMany = findMany;
    prisma.atsCompany.updateMany = updateMany;
  }
});
