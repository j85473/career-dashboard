import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CRAWL_PENDING_DISCOVERY_SQL, cleanFirstCrawlBoard, completedCrawlCycleSamples, firstCrawlWeeklySlot, planCrawlingRotation, untouchedPendingCrawl, type CrawlCycleRun, type CrawlRotationBoard } from '../../src/lib/atsCrawlingRotation';
import { nextCrawlBoard, nextCrawlRefreshAt } from '../../src/lib/atsCrawlingSchedule';
import { rotationDayFor } from '../../src/lib/atsRotation';
import { applyCrawlingRotation, crawlingRotationApplySql, decodeCrawlingRotationSnapshot, main } from '../../scripts/balance_ats_crawling';
import type { PrismaClient } from '../../src/lib/prismaClient';

const now = new Date('2026-10-18T16:00:00Z');
function board(slug: string, overrides: Partial<CrawlRotationBoard> = {}): CrawlRotationBoard {
  return { slug, platform: 'paycom', status: 'active', checkDay: 0, jobsFound: 1, failCount: 0, retryCount: 0,
    nextCheckDate: new Date('2026-10-10T00:00:00Z'), discoveredAt: new Date('2026-10-01T00:00:00Z'),
    lastAttemptedAt: null, lastRespondedAt: null, lastCheckedAt: null, lastSynchronizedAt: null, lastProcessedAt: null,
    rotationMovedAt: null, hasSweep: false, hasOpenWork: false, taskLeased: false, ...overrides };
}
function run(slug: string, start: string, durationMs: number, seen: number, processed: number, complete: boolean): CrawlCycleRun {
  const startedAt = new Date(start);
  return { source: 'ATS-paycom', startedAt, finishedAt: new Date(startedAt.valueOf() + durationMs), durationMs,
    seenCount: seen, reconciled: true, checkpoint: { phase: 'finished', crawl: { board: slug, processed, complete } } };
}

test('completed board cost includes every saved turn and rejects truncated or unreconciled measurements', () => {
  const runs = [run('large', '2026-10-17T10:00:00Z', 40_000, 8, 8, false), run('large', '2026-10-17T10:01:00Z', 10_000, 2, 10, true),
    run('truncated', '2026-10-17T10:00:00Z', 5_000, 2, 12, true),
    { ...run('unreconciled', '2026-10-17T10:00:00Z', 5_000, 2, 2, true), reconciled: false },
    { ...run('gusto', '2026-10-17T10:00:00Z', 180_000, 20, 20, true), source: 'Gusto', checkpoint: { crawl: { completedBoards: 8 } } }];
  const samples = completedCrawlCycleSamples(runs, now);
  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0], { slug: 'large', platform: 'paycom', workerMs: 50_000, jobs: 10, turns: 2, completedAt: new Date('2026-10-17T10:01:10Z') });
  const next = completedCrawlCycleSamples([...runs, run('large', '2026-10-18T10:00:00Z', 8_000, 10, 10, true)], now);
  assert.equal(next[0].workerMs, 8_000, 'a later completed cycle does not inherit earlier-cycle time');
  assert.equal(next[0].turns, 1);
});

test('workload balancing is stable by identity and balances work instead of board cardinality', () => {
  const boards = Array.from({ length: 140 }, (_, index) => board(`board-${String(index).padStart(3, '0')}`, { jobsFound: index < 14 ? 100 : 1 }));
  const plan = planCrawlingRotation(boards, [], now);
  const reverse = planCrawlingRotation([...boards].reverse(), [], now);
  assert.deepEqual(plan.assignments, reverse.assignments);
  assert.equal(plan.selectionHash, reverse.selectionHash);
  assert.equal(plan.before[0].boards, 140);
  assert.equal(plan.reservedBoards, 140);
  const loads = plan.after.map(day => day.browserWorkerMs);
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 30_000);
  assert.equal(plan.estimatedBoards, 140);
  assert.equal(plan.cycleSamples, 0);
  assert.ok(plan.limitations.some(text => text.includes('not measured future throughput')));
  assert.ok(plan.capacity.perDay.every(day => day.browserHours > 0));
  assert.ok(plan.maximumDelayFromNowHours <= 7 * 24);
});

test('HTTP ADP and licensed browser reservations balance independently', () => {
  const boards = [...Array.from({ length: 14 }, (_, index) => board(`adp-${index}`, { platform: 'adp' })),
    ...Array.from({ length: 14 }, (_, index) => board(`browser-${index}`))];
  const plan = planCrawlingRotation(boards, [], now);
  assert.ok(plan.after.every(day => day.httpWorkerMs === 6_000));
  assert.ok(plan.after.every(day => day.browserWorkerMs === 60_000));
  assert.equal(plan.capacity.browserHoursPerWeek, 14 * 30_000 / 3_600_000);
  assert.equal(plan.capacity.httpHoursPerWeek, 14 * 3_000 / 3_600_000);
});

test('first reservation preserves attempted, partial, failed, established, held and already reserved work', () => {
  const blockers: Partial<CrawlRotationBoard>[] = [
    { lastAttemptedAt: now }, { lastRespondedAt: now }, { lastCheckedAt: now }, { lastProcessedAt: now },
    { lastSynchronizedAt: now }, { failCount: 1 }, { retryCount: 1 }, { hasSweep: true }, { hasOpenWork: true },
    { taskLeased: true }, { rotationMovedAt: now }, { status: 'excluded' },
    { nextCheckDate: new Date(now.valueOf() + 3 * 86_400_000) },
  ];
  const boards = [board('clean'), ...blockers.map((overrides, index) => board(`preserve-${index}`, overrides))];
  const before = JSON.stringify(boards);
  const plan = planCrawlingRotation(boards, [], now);
  assert.deepEqual(plan.assignments.map(assignment => assignment.slug), ['clean']);
  assert.equal(JSON.stringify(boards), before, 'preview is pure');
  const applied = boards.map(existing => {
    const assignment = plan.assignments.find(item => item.slug === existing.slug);
    return assignment ? { ...existing, checkDay: assignment.toDay, nextCheckDate: assignment.nextCheckDate, rotationMovedAt: now } : existing;
  });
  assert.equal(planCrawlingRotation(applied, [], now).assignments.length, 0, 'repeat application cannot postpone first reservations again');
  assert.equal(cleanFirstCrawlBoard(board('gusto', { platform: 'gusto' })), true);
  assert.equal(cleanFirstCrawlBoard(board('api', { platform: 'greenhouse' })), false);
});

test('slots stay in the assigned Chicago day and within seven days across DST', () => {
  const midnight = firstCrawlWeeklySlot('midnight-proof-3166', 1, new Date('2026-10-18T16:00:00Z'));
  assert.equal(rotationDayFor(midnight), 1, 'the final hashed minute belongs to Monday, not Tuesday midnight');
  for (const clock of ['2026-10-18T16:00:00Z', '2026-11-01T06:30:00Z', '2027-03-14T07:30:00Z']) {
    const at = new Date(clock);
    for (let day = 0; day < 7; day++) {
      for (let index = 0; index < 5; index++) {
        const slot = firstCrawlWeeklySlot(`board-${index}`, day, at);
        assert.equal(rotationDayFor(slot), day);
        assert.ok(slot >= at);
        assert.ok(slot.valueOf() - at.valueOf() <= 7 * 86_400_000);
        assert.deepEqual(firstCrawlWeeklySlot(`board-${index}`, day, at), slot);
      }
      const weekly = nextCrawlRefreshAt('stable-identity', undefined, at, day);
      assert.equal(rotationDayFor(weekly.nextRunAt), day, 'completed weekly refresh honors the persisted assignment');
      assert.deepEqual(nextCrawlRefreshAt('stable-identity', at.toISOString(), at, day), nextCrawlRefreshAt('stable-identity', at.toISOString(), at));
    }
  }
  assert.throws(() => nextCrawlRefreshAt('identity', undefined, now, 7), /Invalid assigned/);
});

test('database apply locks task claims then uses optimistic schedule and progress guards in one transaction', async () => {
  const plan = planCrawlingRotation([board("quoted'board")], [], now);
  const sql = crawlingRotationApplySql(plan.assignments, now);
  assert.ok(!sql.text.includes("quoted'board"), 'identities are bound JSON, not interpolated SQL');
  assert.match(sql.text, /"lastAttemptedAt" IS NULL/);
  assert.match(sql.text, /"rotationMovedAt" IS NULL/);
  assert.match(sql.text, /"AtsBrowserSweep"/);
  assert.match(sql.text, /"AtsIngestionBatch"/);
  assert.match(sql.text, /"leaseExpiresAt"/);
  assert.match(sql.text, /board\."nextCheckDate"=selected\."fromNextCheckDate"/);
  assert.doesNotMatch(sql.text, /UPDATE "Job"|score|DELETE|TRUNCATE|SET status/i);
  const calls: string[] = [];
  const result = [{ slug: "quoted'board", platform: 'paycom', checkDay: 3, nextCheckDate: now }];
  const tx = {
    $executeRaw: async () => { calls.push('setting-or-lock'); return 0; },
    $queryRaw: async (query: { text?: string } | TemplateStringsArray) => {
      const text = 'text' in query ? query.text! : [...query as TemplateStringsArray].join('');
      calls.push(text.includes('FOR UPDATE') ? 'task-lock' : 'guarded-update');
      return text.includes('FOR UPDATE') ? [] : result;
    },
  };
  const client = { $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as PrismaClient;
  assert.deepEqual(await applyCrawlingRotation(client, plan, now), result);
  assert.ok(calls.indexOf('task-lock') < calls.indexOf('guarded-update'));
  await assert.rejects(applyCrawlingRotation(client, plan, new Date(now.valueOf() + 6 * 60_000)), /stale/);
});

test('offline preview writes a reviewable selection and zero-write receipt and cannot apply a supplied snapshot', async (context) => {
  context.mock.method(console, 'log', () => {});
  const directory = await mkdtemp(path.join(tmpdir(), 'ats-crawling-rotation-'));
  try {
    const snapshot = path.join(directory, 'input.json'), output = path.join(directory, 'output');
    await writeFile(snapshot, JSON.stringify({ boards: [board('preview')], runs: [] }));
    const decoded = decodeCrawlingRotationSnapshot(JSON.parse(await readFile(snapshot, 'utf8')));
    assert.ok(decoded.boards[0].nextCheckDate instanceof Date);
    const report = await main(['--snapshot', snapshot, '--now', now.toISOString(), '--output', output]);
    const receipt = JSON.parse(await readFile(path.join(output, 'receipt.json'), 'utf8'));
    const savedPlan = JSON.parse(await readFile(path.join(output, 'plan.json'), 'utf8'));
    assert.equal(receipt.mode, 'preview');
    assert.equal(receipt.writesPerformed, 0);
    assert.equal(receipt.selectionHash, report.plan.selectionHash);
    assert.equal(savedPlan.assignments.length, 1);
    await assert.rejects(main(['--apply', '--snapshot', snapshot]), /fresh database snapshot/);
    await assert.rejects(main(['--apply', '--now', now.toISOString()]), /actual current time/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('untouched discovery placeholders receive first turns while real failures and validation holds stay retries', async () => {
  const pending = board('discovery-placeholder', { status: 'parked', failCount: 1, jobsFound: 0, nextCheckDate: new Date('2026-10-01T00:00:01Z') });
  assert.equal(untouchedPendingCrawl(pending), true);
  assert.equal(cleanFirstCrawlBoard(pending), true);
  const planned = { ...pending, rotationMovedAt: now, nextCheckDate: new Date(now.valueOf() + 3 * 86_400_000) };
  assert.equal(untouchedPendingCrawl(planned), true, 'a weekly reservation is still first collection');
  assert.equal(cleanFirstCrawlBoard(planned), false, 'it cannot receive another initial reservation');
  for (const overrides of [{ lastAttemptedAt: now }, { lastRespondedAt: now }, { lastCheckedAt: now }, { lastSynchronizedAt: now }, { lastProcessedAt: now },
    { hasSweep: true }, { hasOpenWork: true }, { retryCount: 1 }, { jobsFound: 1 },
    { nextCheckDate: new Date('2026-10-31T00:00:00Z') }]) {
    assert.equal(untouchedPendingCrawl({ ...pending, ...overrides }), false);
  }
  assert.equal(planCrawlingRotation([pending], [], now).assignments.length, 1);
  let queryText = '';
  const client = { $queryRaw: async (query: { text: string }) => {
    queryText = query.text;
    return [{ slug: pending.slug, platform: pending.platform, checkDay: pending.checkDay, failCount: 1, lastSynchronizedAt: null, queue: 'first', providerLastStartedAt: null }];
  } } as unknown as Pick<PrismaClient, '$queryRaw'>;
  assert.equal((await nextCrawlBoard(['paycom'], 0, false, undefined, undefined, client))?.queue, 'first', 'a disabled retry allocation must still admit untouched first work');
  assert.ok(queryText.includes(CRAWL_PENDING_DISCOVERY_SQL));
  assert.ok(queryText.indexOf(CRAWL_PENDING_DISCOVERY_SQL) < queryText.indexOf(`THEN 'retry'`), 'the narrow discovery exception precedes actual failure classification');
  const apply = crawlingRotationApplySql(planCrawlingRotation([pending], [], now).assignments, now);
  assert.ok(apply.text.includes(CRAWL_PENDING_DISCOVERY_SQL), 'the guarded application uses the same narrow exception');
  const updateFields = apply.text.slice(apply.text.indexOf('UPDATE "AtsCompany"'), apply.text.indexOf('FROM selected'));
  assert.doesNotMatch(updateFields, /"failCount"/, 'reservation never clears placeholder or failure counters');
});

test('PostgreSQL JSON timestamps without a zone remain UTC across the Chicago DST transition', () => {
  for (const timestamp of ['2026-10-18T16:00:00', '2026-11-01T06:30:00', '2027-03-14 07:30:00']) {
    const snapshot = decodeCrawlingRotationSnapshot({ boards: [{ ...board('utc'), nextCheckDate: timestamp }], runs: [] });
    assert.equal(snapshot.boards[0].nextCheckDate.toISOString(), timestamp.replace(' ', 'T') + '.000Z');
  }
});
