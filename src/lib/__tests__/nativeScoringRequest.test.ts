import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeScoringLeaseExpired, NATIVE_SCORING_STALE_AFTER_MS } from '../nativeScoringLease';
import {
  cancelNativeScoringRequest,
  createNativeScoringRequest,
  NativeScoringRequestClient,
  publicNativeScoringRequest,
  retryNativeScoringRequest,
} from '../nativeScoringRequest';

const requestRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  activeKey: 'global',
  status: 'running',
  phase: 'standard_scoring',
  source: 'dashboard',
  progress: 'Running.',
  error: null as string | null,
  workerId: null as string | null,
  claimedAt: null as Date | null,
  heartbeatAt: null as Date | null,
  completedAt: null as Date | null,
  attempt: 1,
  contextJobs: 2,
  standardJobs: 5,
  contextRuns: 1,
  standardRuns: 1,
  contextBatchId: 'context-batch',
  standardBatchId: 'standard-batch',
  chunksTotal: 20,
  chunksDone: 12,
  quarantineRetries: 3,
  quarantineChunks: 2,
  createdAt: new Date('2026-08-01T12:00:00.000Z'),
  updatedAt: new Date('2026-08-01T12:01:00.000Z'),
};

test('public request exposes only Context and A/E counts and runs', () => {
  const view = publicNativeScoringRequest(requestRecord);
  assert.deepEqual(view?.counts, { context: 2, standard: 5 });
  assert.deepEqual(view?.runs, { context: 1, standard: 1 });
});

test('public request reports chunk progress and ages for the status panel', () => {
  const claimed = { ...requestRecord, claimedAt: new Date('2026-08-01T12:00:00.000Z') };
  const view = publicNativeScoringRequest(claimed, new Date('2026-08-01T12:05:30.000Z').getTime());
  assert.deepEqual(view?.chunks, { total: 20, done: 12, quarantineRetries: 3, quarantineChunks: 2 });
  // Elapsed runs from the claim, not the queue: waiting for a worker is not scoring.
  assert.equal(view?.elapsedMs, 330_000);
  assert.equal(view?.lastUpdateMs, 270_000);
});

test('chunk progress never reports more done than the wave contains', () => {
  const overshoot = { ...requestRecord, chunksTotal: 5, chunksDone: 20 };
  assert.equal(publicNativeScoringRequest(overshoot)?.chunks.done, 5);
});

test('request creation reuses the active single-flight request', async () => {
  let creates = 0;
  const client = {
    nativeScoringRequest: {
      findUnique: async () => requestRecord,
      create: async () => {
        creates += 1;
        return requestRecord;
      },
    },
  } as unknown as NativeScoringRequestClient;

  const result = await createNativeScoringRequest('dashboard', client);
  assert.equal(result.created, false);
  assert.equal(result.resumed, false);
  assert.equal(result.request.id, requestRecord.id);
  assert.equal(creates, 0);
});

test('a unique-key race returns the winning active request', async () => {
  let reads = 0;
  const client = {
    nativeScoringRequest: {
      findUnique: async () => {
        reads += 1;
        return reads === 1 ? null : requestRecord;
      },
      create: async () => { throw { code: 'P2002' }; },
    },
  } as unknown as NativeScoringRequestClient;

  const result = await createNativeScoringRequest('dashboard', client);
  assert.equal(result.created, false);
  assert.equal(result.resumed, false);
  assert.equal(result.request.id, requestRecord.id);
});

test('request creation requeues a failed single-flight request for phrase-based recovery', async () => {
  const failed = { ...requestRecord, status: 'failed', phase: 'standard_scoring', error: 'bad result' };
  let updatedData: Record<string, unknown> | null = null;
  let retried = false;
  const client = {
    nativeScoringRequest: {
      findUnique: async () => (retried ? { ...failed, ...updatedData } : failed),
      updateMany: async (input: { data: Record<string, unknown> }) => {
        updatedData = input.data;
        retried = true;
        return { count: 1 };
      },
    },
  } as unknown as NativeScoringRequestClient;

  const result = await createNativeScoringRequest('agy', client);
  assert.equal(result.created, false);
  assert.equal(result.resumed, true);
  assert.equal(result.request.status, 'queued');
  assert.equal(updatedData && Object.hasOwn(updatedData, 'phase'), false);
});

test('pipeline creation leaves a failed single-flight request visible without retrying it', async () => {
  const failed = { ...requestRecord, status: 'failed', phase: 'standard_scoring', error: 'hard failure' };
  let updates = 0;
  const client = {
    nativeScoringRequest: {
      findUnique: async () => failed,
      update: async () => { updates++; return failed; },
    },
  } as unknown as NativeScoringRequestClient;

  const result = await createNativeScoringRequest('pipeline', client, { resumeFailed: false });
  assert.equal(result.created, false);
  assert.equal(result.resumed, false);
  assert.equal(result.request.status, 'failed');
  assert.equal(updates, 0);
});

function cancellationClient(record: typeof requestRecord, affected = 1) {
  const calls: { data: Record<string, unknown> | null; where: Record<string, unknown> | null } = { data: null, where: null };
  const client = {
    nativeScoringRequest: {
      findUnique: async () => (calls.data ? { ...record, ...calls.data } : record),
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.where = input.where;
        calls.data = input.data;
        return { count: affected };
      },
    },
  } as unknown as NativeScoringRequestClient;
  return { client, calls };
}

test('a queued request is always cancellable and releases the single-flight slot', async () => {
  const queued = { ...requestRecord, status: 'queued', phase: 'queued' };
  const { client, calls } = cancellationClient(queued);

  const cancelled = await cancelNativeScoringRequest(queued.id, client);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.activeKey, null);
  // Releasing activeKey is what lets the dashboard queue a fresh request.
  assert.equal(calls.data?.activeKey, null);
});

test('cancelling guards on the row it read so a concurrent claim wins', async () => {
  const queued = { ...requestRecord, status: 'queued', phase: 'queued' };
  const { client, calls } = cancellationClient(queued);

  await cancelNativeScoringRequest(queued.id, client);
  assert.equal(calls.where?.status, 'queued');
  assert.equal(calls.where?.updatedAt, queued.updatedAt);
});

test('a lost cancellation race reports the conflict instead of reporting success', async () => {
  const queued = { ...requestRecord, status: 'queued', phase: 'queued' };
  const { client } = cancellationClient(queued, 0);

  await assert.rejects(
    () => cancelNativeScoringRequest(queued.id, client),
    /changed while it was being cancelled/,
  );
});

test('a running request with a live heartbeat is not cancellable', async () => {
  const live = { ...requestRecord, status: 'running', heartbeatAt: new Date() };
  const { client } = cancellationClient(live);

  await assert.rejects(
    () => cancelNativeScoringRequest(live.id, client),
    /still sending heartbeats/,
  );
});

test('a running request whose lease expired can be cancelled', async () => {
  const stranded = {
    ...requestRecord,
    status: 'running',
    heartbeatAt: new Date(Date.now() - NATIVE_SCORING_STALE_AFTER_MS - 1_000),
  };
  const { client } = cancellationClient(stranded);

  const cancelled = await cancelNativeScoringRequest(stranded.id, client);
  assert.equal(cancelled.status, 'cancelled');
});

test('a finished request is not cancellable twice', async () => {
  const done = { ...requestRecord, status: 'completed', phase: 'completed' };
  const { client } = cancellationClient(done);

  await assert.rejects(() => cancelNativeScoringRequest(done.id, client), /already finished/);
});

test('only a claimed request holds a lease that can expire', () => {
  const ancient = new Date('2020-01-01T00:00:00.000Z');
  // A queued request has no worker, so age alone must never mark it stranded.
  assert.equal(
    nativeScoringLeaseExpired({ status: 'queued', heartbeatAt: null, claimedAt: null, updatedAt: ancient }),
    false,
  );
  assert.equal(
    nativeScoringLeaseExpired({ status: 'running', heartbeatAt: null, claimedAt: null, updatedAt: ancient }),
    true,
  );
  assert.equal(
    nativeScoringLeaseExpired({ status: 'running', heartbeatAt: new Date(), claimedAt: ancient, updatedAt: ancient }),
    false,
  );
});

test('the public view reports lease staleness so the dashboard avoids clock skew', () => {
  const stranded = { ...requestRecord, status: 'running', heartbeatAt: new Date('2020-01-01T00:00:00.000Z') };
  assert.equal(publicNativeScoringRequest(stranded)?.stalled, true);
  assert.equal(publicNativeScoringRequest({ ...requestRecord, status: 'running', heartbeatAt: new Date() })?.stalled, false);
});

test('retry preserves the failed phase so immutable work can resume', async () => {
  const failed = { ...requestRecord, status: 'failed', phase: 'standard_scoring', error: 'bad result' };
  const calls: { data: Record<string, unknown> | null; where: Record<string, unknown> | null } = { data: null, where: null };
  let applied = false;
  const client = {
    nativeScoringRequest: {
      findUnique: async () => (applied ? { ...failed, ...calls.data } : failed),
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.where = input.where;
        calls.data = input.data;
        applied = true;
        return { count: 1 };
      },
    },
  } as unknown as NativeScoringRequestClient;

  const retried = await retryNativeScoringRequest(failed.id, client);
  assert.equal(retried.id, failed.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.phase, 'standard_scoring');
  assert.equal(calls.data && Object.hasOwn(calls.data, 'phase'), false);
  assert.equal(calls.data?.activeKey, 'global');
  assert.equal(calls.where?.id, failed.id);
  assert.equal(calls.where?.status, 'failed');
  assert.equal(calls.where?.updatedAt, failed.updatedAt);
});

test('retry refuses to displace a different active single-flight request', async () => {
  const failed = { ...requestRecord, activeKey: null, status: 'failed', error: 'runner exited' };
  const otherActive = { ...requestRecord, id: '22222222-2222-4222-8222-222222222222' };
  let updates = 0;
  const client = {
    nativeScoringRequest: {
      findUnique: async (input: { where: Record<string, unknown> }) => (
        input.where.id === failed.id ? failed : otherActive
      ),
      updateMany: async () => {
        updates += 1;
        return { count: 1 };
      },
    },
  } as unknown as NativeScoringRequestClient;

  await assert.rejects(
    () => retryNativeScoringRequest(failed.id, client),
    /Another native scoring request is already active/,
  );
  assert.equal(updates, 0);
});

test('a duplicate retry that loses a concurrent claim cannot reset the newer request lease', async () => {
  const failed = { ...requestRecord, status: 'failed', phase: 'context_preparing', error: 'runner exited' };
  const calls: { data: Record<string, unknown> | null; where: Record<string, unknown> | null } = { data: null, where: null };
  const client = {
    nativeScoringRequest: {
      findUnique: async () => failed,
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.where = input.where;
        calls.data = input.data;
        // The first retry was already claimed, so this failed-row version no
        // longer matches. PostgreSQL applies none of the queued/reset fields.
        return { count: 0 };
      },
    },
  } as unknown as NativeScoringRequestClient;

  await assert.rejects(
    () => retryNativeScoringRequest(failed.id, client),
    /changed while it was being retried/,
  );
  assert.equal(calls.where?.id, failed.id);
  assert.equal(calls.where?.status, 'failed');
  assert.equal(calls.where?.updatedAt, failed.updatedAt);
  assert.equal(calls.data?.status, 'queued');
  assert.equal(calls.data?.workerId, null);
});
