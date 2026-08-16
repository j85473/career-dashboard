import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PipelineStateClient } from '../../src/lib/pipelineState';

type Row = {
  id: string;
  isRunning: boolean;
  schedulePaused: boolean;
  pausedUntil: Date | null;
  lastUpdated: Date;
  lockToken: string | null;
  lockOwner: string | null;
  lockHeartbeatAt: Date | null;
};

/** Supports only the where shapes the lock actually issues. */
function rowMatches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'id') {
      if (row.id !== condition) return false;
    } else if (key === 'AND') {
      const branches = condition as Record<string, unknown>[];
      if (!branches.every((branch) => rowMatches(row, branch))) return false;
    } else if (key === 'OR') {
      const branches = condition as Record<string, unknown>[];
      if (!branches.some((branch) => rowMatches(row, branch))) return false;
    } else if (key === 'NOT') {
      if (rowMatches(row, condition as Record<string, unknown>)) return false;
    } else {
      const value = row[key as keyof Row];
      if (condition && typeof condition === 'object') {
        const range = condition as { lt?: Date; lte?: Date; gte?: Date };
        if (range.lt !== undefined && !(value instanceof Date && value < range.lt)) return false;
        if (range.lte !== undefined && !(value instanceof Date && value <= range.lte)) return false;
        if (range.gte !== undefined && !(value instanceof Date && value >= range.gte)) return false;
      } else if (value !== condition) {
        return false;
      }
    }
  }
  return true;
}

function fakeClient(initial: Partial<Row> = {}) {
  const state: { row: Row } = {
    row: {
      id: 'global',
      isRunning: false,
      schedulePaused: false,
      pausedUntil: null,
      lastUpdated: new Date(0),
      lockToken: null,
      lockOwner: null,
      lockHeartbeatAt: null,
      ...initial,
    },
  };
  const client = {
    pipelineState: {
      upsert: async () => state.row,
      findUnique: async () => state.row,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        if (!rowMatches(state.row, where)) return { count: 0 };
        state.row = { ...state.row, ...data };
        return { count: 1 };
      },
    },
  } as unknown as PipelineStateClient;
  return { state, client };
}

// The module resolves its state file at import time, so point that at a temp
// directory before the first load. The import stays lazy because the test
// transform emits CJS, which has no top-level await.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-pipeline-state-'));
process.env.PIPELINE_STATE_FILE = path.join(directory, 'state.json');
const loadState = () => import('../../src/lib/pipelineState');

test('a free lock is claimed and recorded against its owner', async () => {
  const state = await loadState();
  const { state: store, client } = fakeClient();
  const release = await state.tryAcquirePipelineLock(client);
  assert.ok(release);
  assert.ok(store.row.lockToken);
  assert.match(store.row.lockOwner || '', /:\d+$/);
});

test('a second host cannot claim a lock that is still heartbeating', async () => {
  const state = await loadState();
  const now = Date.now();
  const { client } = fakeClient({ lockToken: 'held', lockHeartbeatAt: new Date(now - 1_000) });
  assert.equal(await state.tryAcquirePipelineLock(client, now), null);
});

test('a scheduled caller cannot claim a paused pipeline but a manual caller can', async () => {
  const state = await loadState();
  const now = Date.now();
  const { client } = fakeClient({ schedulePaused: true, pausedUntil: new Date(now + 60_000) });
  assert.equal(await state.tryAcquirePipelineLock(client, now, { requireScheduleEnabled: true }), null);
  assert.ok(await state.tryAcquirePipelineLock(client, now));
});

test('an indefinite pause holds the schedule with no expiry to lapse', async () => {
  const state = await loadState();
  const now = Date.now();
  const { client } = fakeClient({ schedulePaused: true, pausedUntil: null });
  assert.equal(await state.tryAcquirePipelineLock(client, now, { requireScheduleEnabled: true }), null);
  // Far in the future is still paused: an indefinite pause never lapses.
  assert.equal(
    await state.tryAcquirePipelineLock(client, now + 30 * 24 * 60 * 60 * 1000, { requireScheduleEnabled: true }),
    null,
  );
});

test('an elapsed pause releases the schedule and settles its own state', async () => {
  const state = await loadState();
  const now = Date.now();
  // The failure this replaces: a Stop nobody resumed kept cron locked out
  // forever, silently, because the pause was a bare boolean.
  const { state: store, client } = fakeClient({
    schedulePaused: true,
    pausedUntil: new Date(now - 1_000),
  });
  assert.ok(await state.tryAcquirePipelineLock(client, now, { requireScheduleEnabled: true }));
  assert.equal(store.row.schedulePaused, false);
  assert.equal(store.row.pausedUntil, null);
});

test('a pause that has not yet elapsed still blocks the scheduler', async () => {
  const state = await loadState();
  const now = Date.now();
  const { client } = fakeClient({
    schedulePaused: true,
    pausedUntil: new Date(now + state.PIPELINE_PAUSE_DEFAULT_MS),
  });
  assert.equal(await state.tryAcquirePipelineLock(client, now, { requireScheduleEnabled: true }), null);
  assert.ok(await state.tryAcquirePipelineLock(
    client,
    now + state.PIPELINE_PAUSE_DEFAULT_MS + 1,
    { requireScheduleEnabled: true },
  ));
});

test('the default pause window is six hours', async () => {
  const state = await loadState();
  assert.equal(state.PIPELINE_PAUSE_DEFAULT_MS, 6 * 60 * 60 * 1000);
});

test('releasing an expired lock cannot delete the replacement', async () => {
  const state = await loadState();
  const now = Date.now();
  const { state: store, client } = fakeClient();

  const release = await state.tryAcquirePipelineLock(client, now);
  assert.ok(release);
  const original = store.row.lockToken;

  // The original owner stops heartbeating and another host takes over.
  store.row.lockHeartbeatAt = new Date(now - state.PIPELINE_LOCK_STALE_MS - 1_000);
  const replacement = await state.tryAcquirePipelineLock(client, now);
  assert.ok(replacement);
  assert.notEqual(store.row.lockToken, original);
  const replacementToken = store.row.lockToken;

  // The original's release is token-guarded, so it is a no-op here.
  await release();
  assert.equal(store.row.lockToken, replacementToken);

  await replacement();
  assert.equal(store.row.lockToken, null);
});

test('a host reporting fresh progress holds the pipeline even with no lock token', async () => {
  const state = await loadState();
  // A host still running the previous file-lock build writes no token but keeps
  // mirroring progress. Claiming over it would run two pipelines at once.
  const now = Date.now();
  const { client } = fakeClient({ isRunning: true, lastUpdated: new Date(now - 5_000), lockToken: null });
  assert.equal(await state.tryAcquirePipelineLock(client, now), null);
});

test('a run that stopped reporting long ago no longer blocks a claim', async () => {
  const state = await loadState();
  const now = Date.now();
  const { client } = fakeClient({
    isRunning: true,
    lastUpdated: new Date(now - state.PIPELINE_ACTIVITY_FRESH_MS - 1_000),
    lockToken: null,
  });
  assert.ok(await state.tryAcquirePipelineLock(client, now));
});

test('a stop recorded by either host is visible to the host running the loop', async () => {
  const state = await loadState();
  const now = Date.now();
  const running = fakeClient({ isRunning: true });
  assert.equal(await state.pipelineStopRequested(running.client, now), false);

  const stopped = fakeClient({ isRunning: false });
  assert.equal(await state.pipelineStopRequested(stopped.client, now + 10_000), true);
});

test('a database blip does not read as a stop request', async () => {
  const state = await loadState();
  const client = {
    pipelineState: { findUnique: async () => { throw new Error('connection lost'); } },
  } as unknown as PipelineStateClient;
  // Aborting a multi-hour ingestion over one failed read would be worse than
  // continuing; a real outage still ends the run when the lock expires.
  assert.equal(await state.pipelineStopRequested(client, Date.now() + 60_000), false);
});

test('the owning process can abort active work immediately and clears only its own controller', async () => {
  const state = await loadState();
  const first = new AbortController();
  const clearFirst = state.registerActivePipelineAbortController(first);
  assert.ok(clearFirst);
  assert.equal(state.abortActivePipeline('deploy quiescence'), true);
  assert.equal(first.signal.aborted, true);
  assert.match(String(first.signal.reason), /deploy quiescence/);
  assert.equal(state.abortActivePipeline(), false);

  // The first controller is aborted, so its slot is free to be taken over.
  const replacement = new AbortController();
  const clearReplacement = state.registerActivePipelineAbortController(replacement);
  assert.ok(clearReplacement);
  clearFirst();
  assert.equal(state.abortActivePipeline('replacement stop'), true);
  assert.equal(replacement.signal.aborted, true);
  clearReplacement();
  assert.equal(state.abortActivePipeline(), false);
});

test('a second pipeline cannot register while a live one owns the process', async () => {
  const state = await loadState();
  const live = new AbortController();
  const clearLive = state.registerActivePipelineAbortController(live);
  assert.ok(clearLive);

  // Overwriting here used to orphan the running pipeline: Stop would reach only
  // the newcomer while the original kept running and holding leases.
  const second = new AbortController();
  assert.equal(state.registerActivePipelineAbortController(second), null);

  // Stop still reaches the pipeline that actually owns the process.
  assert.equal(state.abortActivePipeline('stop'), true);
  assert.equal(live.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  clearLive();
});

test('the lock heartbeat refreshes on its own clock, not on progress messages', async () => {
  const state = await loadState();
  const now = Date.now();
  const { state: store, client } = fakeClient();
  const release = await state.tryAcquirePipelineLock(client, now);
  assert.ok(release);
  store.row.lockHeartbeatAt = new Date(now - state.PIPELINE_LOCK_STALE_MS - 1_000);

  // A quiet stretch — a long ATS turn or scraper spawn — emits no progress, so
  // a ticker-driven heartbeat let the lock go stale and a second pipeline start.
  const stop = state.startPipelineLockHeartbeat(client, 10);
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  assert.ok((store.row.lockHeartbeatAt?.getTime() || 0) > now - state.PIPELINE_LOCK_STALE_MS);
  await release();
});

test('the heartbeat only refreshes a lock this process still owns', async () => {
  const state = await loadState();
  const now = Date.now();
  const { state: store, client } = fakeClient();
  const release = await state.tryAcquirePipelineLock(client, now);
  assert.ok(release);
  await release();

  // Another host has taken the lock over.
  store.row.lockToken = 'someone-else';
  store.row.lockHeartbeatAt = new Date(now - state.PIPELINE_LOCK_STALE_MS - 1_000);
  const stop = state.startPipelineLockHeartbeat(client, 10);
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  assert.equal(store.row.lockToken, 'someone-else');
  assert.equal(store.row.lockHeartbeatAt.getTime(), now - state.PIPELINE_LOCK_STALE_MS - 1_000);
});

test('pipeline delays resolve immediately when their owner is aborted', async () => {
  const state = await loadState();
  const controller = new AbortController();
  const startedAt = Date.now();
  const waiting = state.waitForPipelineDelay(60_000, controller.signal);
  controller.abort();
  await waiting;
  assert.ok(Date.now() - startedAt < 1_000);
});

test.after(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.PIPELINE_STATE_FILE;
});

test('only transitions are recorded, not every ticker update', async () => {
  const state = await loadState();
  const rows: Array<Record<string, unknown>> = [];
  const client = { pipelineStateEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); return data; } } };
  const base = { isRunning: true, currentStep: 'Pipeline Active (Concurrent)', client } as unknown as Record<string, unknown>;

  // The progress ticker fires every few seconds with a new stepProgress but the
  // same step; recording each one would bury the signal it exists to expose.
  assert.equal(await state.recordPipelineStateEvent({ ...base, stepProgress: 'ATS-ashby 1/25' } as never), true);
  assert.equal(await state.recordPipelineStateEvent({ ...base, stepProgress: 'ATS-ashby 2/25' } as never), false);
  assert.equal(await state.recordPipelineStateEvent({ ...base, stepProgress: 'ATS-ashby 3/25' } as never), false);
  assert.equal(rows.length, 1);

  // A real transition is recorded.
  assert.equal(await state.recordPipelineStateEvent({
    isRunning: false, currentStep: 'Paused', schedulePaused: true, client,
  } as never), true);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].eventType, 'paused');
});

test('transitions are classified so a stall can be found later', async () => {
  const state = await loadState();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ isRunning: true, currentStep: 'Starting...' }, 'started'],
    [{ isRunning: true, currentStep: 'Pipeline Active (Concurrent)' }, 'step'],
    [{ isRunning: false, currentStep: 'Idle' }, 'stopped'],
    [{ isRunning: false, currentStep: 'Paused', schedulePaused: true }, 'paused'],
    [{ isRunning: false, currentStep: 'Warning' }, 'warning'],
    [{ isRunning: false, currentStep: 'Error' }, 'error'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(state.classifyPipelineTransition(input as never), expected, expected);
  }
});
