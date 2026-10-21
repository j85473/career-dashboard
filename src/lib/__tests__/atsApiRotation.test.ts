import assert from 'node:assert/strict';
import test from 'node:test';
import { apiRotationDayFor, apiRotationCheckDays, assignedApiRotationDay, atsApiRotationCycleCutoff,
  nextApiBoardCheckDateForDay, nextAtsBoardCheckDateForBoard, nextAtsRecoveryCheckDateForBoard,
  nextAtsBoardCheckDateForDay, rotationDayFor, requiredAtsBoardChecksPerDay } from '../atsRotation';
import { atsRotationCohortWhere, atsRotationCohortSql } from '../atsRotationCohort';
import { parseAtsAcquisitionDetail, atsWeekHealth } from '../pipelineTelemetry';

test('API cycles repeat every four local dates without resetting at a week boundary', () => {
  for (let offset = 0; offset < 28; offset++) {
    const now = new Date(Date.UTC(2026, 9, 20 + offset, 16));
    const tomorrow = new Date(Date.UTC(2026, 9, 21 + offset, 16));
    assert.equal(apiRotationDayFor(tomorrow), (apiRotationDayFor(now) + 1) % 4);
    for (let persistedDay = 0; persistedDay < 7; persistedDay++) {
      const slot = nextApiBoardCheckDateForDay(persistedDay, now);
      assert.equal(apiRotationDayFor(slot), persistedDay % 4);
      assert.ok(slot > now && slot.getTime() - now.getTime() < 4 * 86_400_000);
      assert.ok(apiRotationCheckDays(persistedDay % 4).includes(persistedDay));
    }
  }
});

test('four local dates stay four dates through both DST changes', () => {
  for (const [clock, expected] of [
    ['2026-03-07T18:00:00Z', '2026-03-11T05:01:00.000Z'],
    ['2026-10-30T18:00:00Z', '2026-11-03T06:01:00.000Z'],
  ]) {
    const now = new Date(clock);
    assert.equal(nextApiBoardCheckDateForDay(apiRotationDayFor(now), now).toISOString(), expected);
  }
  const beforeLocalMidnight = new Date('2026-10-21T04:59:00Z');
  assert.notEqual(apiRotationDayFor(beforeLocalMidnight), apiRotationDayFor(beforeLocalMidnight, 'UTC'));
});

test('all legacy assignments stay selectable while new API assignments use four cohorts', () => {
  for (let day = 0; day < 4; day++) {
    assert.deepEqual(atsRotationCohortWhere(day).OR?.[0], { checkDay: { in: apiRotationCheckDays(day) } });
    const sql = atsRotationCohortSql(day);
    assert.match(sql.text, /MOD\(board\."checkDay"/);
    assert.deepEqual(sql.values.slice(0, 2), [4, day]);
  }
  const counts = [0, 0, 0, 0];
  for (let index = 0; index < 10_000; index++) counts[assignedApiRotationDay(`company-${index}`, 'workday')]++;
  assert.ok(counts.every(count => count > 2300 && count < 2700));
  assert.throws(() => apiRotationCheckDays(4), /Invalid API rotation day/);
});

test('successful API boards use four days while browser and failure recovery retain weekdays', () => {
  const now = new Date('2026-10-20T17:00:00Z');
  const api = { slug: 'example', platform: 'workday', checkDay: 6 };
  assert.deepEqual(nextAtsBoardCheckDateForBoard(api, now), nextApiBoardCheckDateForDay(6, now));
  assert.deepEqual(nextAtsRecoveryCheckDateForBoard(api, now), nextAtsBoardCheckDateForDay(6, now));
  for (const platform of ['adp', 'gusto', 'paycom']) {
    const next = nextAtsBoardCheckDateForBoard({ ...api, platform }, now);
    assert.deepEqual(next, nextAtsBoardCheckDateForDay(6, now));
    assert.equal(rotationDayFor(next), 6);
  }
  assert.equal(atsApiRotationCycleCutoff(now).getTime(), now.getTime() - 4 * 86_400_000);
  assert.equal(requiredAtsBoardChecksPerDay(82_400), 21_000);
  assert.equal(requiredAtsBoardChecksPerDay(100_000), 25_000);
});

test('the operator panel labels four-day coverage and still understands older weekly telemetry', () => {
  const detail = parseAtsAcquisitionDetail('State working · Rotation Day 2 · Period 4 · Boards 8/10 · Lanes 8/8 · Cycle 99/100');
  assert.equal(detail?.kind, 'ats-acquisition');
  if (detail?.kind !== 'ats-acquisition') return;
  assert.equal(detail.rotationDays, 4);
  assert.equal(detail.weekCovered, 99);
  assert.equal(atsWeekHealth(detail.weekCovered, detail.weekActive, detail.rotationDays).label, '4-day cycle on track (99%)');
  const older = parseAtsAcquisitionDetail('State working · Rotation Tuesday · Boards 8/10 · Lanes 8/8 · Week 99/100');
  assert.equal(older?.kind === 'ats-acquisition' && older.weekCovered, 99);
});
