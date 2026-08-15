import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ABANDONED_RUN_CUTOFF_MS,
  ABANDONED_RUN_ERROR,
  abandonedRunCutoff,
  reapAbandonedIngestionRuns,
} from '../ingestionRunReaper';
import { SCRAPER_HARD_KILL_MS } from '../jobIngestion';

type Row = { status: string; startedAt: Date };
type UpdateManyArgs = {
  where: { status: string; startedAt: { lt: Date } };
  data: { status: string; error: string; finishedAt: Date };
};

function fakeClient(rows: Row[]) {
  const calls: UpdateManyArgs[] = [];
  const client = {
    ingestionSourceRun: {
      updateMany: async (args: UpdateManyArgs) => {
        calls.push(args);
        const matched = rows.filter((row) =>
          row.status === args.where.status && row.startedAt < args.where.startedAt.lt);
        for (const row of matched) row.status = args.data.status;
        return { count: matched.length };
      },
    },
  };
  return { calls, client: client as unknown as Parameters<typeof reapAbandonedIngestionRuns>[1] };
}

test('a run left open past the cutoff is closed as failed', async () => {
  const now = new Date('2026-08-16T00:00:00.000Z');
  // Production held rows in exactly this state since 12 August, because the
  // stale-lease cleanup only ever covered Job leases.
  const rows: Row[] = [
    { status: 'running', startedAt: new Date('2026-08-12T20:17:00.000Z') },
    { status: 'running', startedAt: new Date('2026-08-13T15:03:00.000Z') },
  ];
  const { client, calls } = fakeClient(rows);
  assert.equal(await reapAbandonedIngestionRuns(now, client), 2);
  assert.equal(calls[0].where.status, 'running');
  assert.equal(calls[0].data.status, 'failed');
  assert.equal(calls[0].data.error, ABANDONED_RUN_ERROR);
  assert.equal(calls[0].data.finishedAt.getTime(), now.getTime());
});

test('a run still inside the cutoff is left alone', async () => {
  const now = new Date('2026-08-16T00:00:00.000Z');
  const rows: Row[] = [{ status: 'running', startedAt: new Date('2026-08-15T23:30:00.000Z') }];
  const { client } = fakeClient(rows);
  assert.equal(await reapAbandonedIngestionRuns(now, client), 0);
  assert.equal(rows[0].status, 'running');
});

test('the cutoff sits above the longest run a scraper is allowed', () => {
  // Reaping a live run would record healthy work as a failure.
  assert.ok(ABANDONED_RUN_CUTOFF_MS > SCRAPER_HARD_KILL_MS);
  const now = new Date('2026-08-16T00:00:00.000Z');
  assert.equal(abandonedRunCutoff(now).getTime(), now.getTime() - ABANDONED_RUN_CUTOFF_MS);
});
