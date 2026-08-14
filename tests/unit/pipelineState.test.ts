import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PipelineStateClient } from '../../src/lib/pipelineState';

type Row = {
  id: string;
  isRunning: boolean;
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
    } else if (key === 'OR') {
      const branches = condition as Record<string, unknown>[];
      if (!branches.some((branch) => rowMatches(row, branch))) return false;
    } else if (key === 'NOT') {
      if (rowMatches(row, condition as Record<string, unknown>)) return false;
    } else {
      const value = row[key as keyof Row];
      if (condition && typeof condition === 'object') {
        const range = condition as { lt?: Date; gte?: Date };
        if (range.lt !== undefined && !(value instanceof Date && value < range.lt)) return false;
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
  assert.equal(state.abortActivePipeline('deploy quiescence'), true);
  assert.equal(first.signal.aborted, true);
  assert.match(String(first.signal.reason), /deploy quiescence/);
  assert.equal(state.abortActivePipeline(), false);

  const replacement = new AbortController();
  const clearReplacement = state.registerActivePipelineAbortController(replacement);
  clearFirst();
  assert.equal(state.abortActivePipeline('replacement stop'), true);
  assert.equal(replacement.signal.aborted, true);
  clearReplacement();
  assert.equal(state.abortActivePipeline(), false);
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
