import assert from 'node:assert/strict';
import test from 'node:test';
import { planApiRotationTransition, applyApiRotationTransition, type ApiRotationTransitionBoard } from '../atsApiRotationTransition';
import { nextAtsBoardCheckDateForDay, nextApiBoardCheckDateForDay } from '../atsRotation';

const now = new Date('2026-10-20T17:00:00Z');
const board: ApiRotationTransitionBoard = { slug: 'example', platform: 'workday', checkDay: 2, status: 'active',
  acquisitionEngine: 'v2', firstCollectionState: 'established', firstCollectionHoldReason: null,
  failCount: 0, retryCount: 0, lastSynchronizedAt: new Date('2026-10-20T08:00:00Z'),
  nextCheckDate: nextAtsBoardCheckDateForDay(2, now), hasOpenWork: false };

test('transition previews only accelerate proven healthy weekly slots and preserve the original records', () => {
  const original = structuredClone(board);
  const plan = planApiRotationTransition([board], now);
  assert.equal(plan.selected, 1);
  assert.equal(plan.assignments[0].nextCheckDate, nextApiBoardCheckDateForDay(2, now).toISOString());
  assert.ok(new Date(plan.assignments[0].nextCheckDate) < board.nextCheckDate);
  assert.deepEqual(board, original);
  assert.equal(planApiRotationTransition([board], now).selectionHash, plan.selectionHash);
});

test('retry dates, operator holds, new collections, browser boards and all unfinished work retain authority', () => {
  const changes: Partial<ApiRotationTransitionBoard>[] = [
    { failCount: 1 }, { retryCount: 1 }, { status: 'parked' }, { status: 'excluded' },
    { hasOpenWork: true }, { acquisitionEngine: 'legacy' }, { firstCollectionState: 'ready' },
    { firstCollectionHoldReason: 'operator hold' }, { lastSynchronizedAt: null },
    { platform: 'adp' }, { platform: 'gusto' }, { checkDay: -1 }, { checkDay: 7 },
    { nextCheckDate: new Date(now.getTime() - 1) },
    { nextCheckDate: new Date(board.nextCheckDate.getTime() + 3600_000) },
    { nextCheckDate: nextApiBoardCheckDateForDay(2, now) },
    { lastSynchronizedAt: new Date(now.getTime() + 1) },
    { slug: 'eczy.fa.us2.oraclecloud.com::CX', platform: 'oracle' },
  ];
  for (const change of changes) assert.equal(planApiRotationTransition([{ ...board, ...change }], now).selected, 0, JSON.stringify(change));
});

function clientFor(rows = [board], updateCount = 1) {
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const locks: string[] = [];
  const tx = {
    $executeRaw: async (query: { text: string } | TemplateStringsArray) => {
      locks.push('text' in query ? query.text : query.join('')); return 0;
    },
    atsCompany: {
      findMany: async () => rows.map(({ hasOpenWork, ...row }) => ({ ...row, ingestionBatches: hasOpenWork ? [{ id: 'open' }] : [] })),
      updateMany: async (input: typeof writes[number]) => { writes.push(input); return { count: updateCount }; },
    },
  };
  const client = { $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(tx) } as unknown as Parameters<typeof applyApiRotationTransition>[0];
  return { client, writes, locks };
}

test('apply rechecks schedules and admission fences, and changes only the next healthy check date', async () => {
  const { client, writes, locks } = clientFor();
  const result = await applyApiRotationTransition(client, planApiRotationTransition([board], now), now);
  assert.deepEqual(result, { selected: 1, applied: 1, skipped: 0 });
  assert.deepEqual(writes[0].data, { nextCheckDate: nextApiBoardCheckDateForDay(2, now) });
  assert.equal(writes[0].where.failCount, 0);
  assert.equal(writes[0].where.retryCount, 0);
  assert.deepEqual(writes[0].where.nextCheckDate, board.nextCheckDate);
  assert.deepEqual(writes[0].where.lastSynchronizedAt, board.lastSynchronizedAt);
  assert.ok(writes[0].where.ingestionBatches);
  assert.ok(locks.some(lock => lock.includes('ats-v2-board-admission')));
});

test('stale previews, changed boards and concurrent guard failures never overwrite current work', async () => {
  const plan = planApiRotationTransition([board], now);
  const stale = clientFor();
  await assert.rejects(applyApiRotationTransition(stale.client, plan, new Date(now.getTime() + 300_001)), /stale/);
  assert.equal(stale.writes.length, 0);
  const changed = clientFor([{ ...board, failCount: 1 }]);
  await assert.rejects(applyApiRotationTransition(changed.client, plan, now), /schedules changed/);
  assert.equal(changed.writes.length, 0);
  const raced = clientFor([board], 0);
  assert.deepEqual(await applyApiRotationTransition(raced.client, plan, now), { selected: 1, applied: 0, skipped: 1 });
});
