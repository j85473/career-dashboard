import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNativeScoringRequest,
  NativeScoringRequestClient,
  retryNativeScoringRequest,
} from '../nativeScoringRequest';

const requestRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  activeKey: 'global',
  status: 'running',
  phase: 'standard_scoring',
  source: 'dashboard',
  progress: 'Running.',
  error: null,
  workerId: null,
  claimedAt: null,
  heartbeatAt: null,
  completedAt: null,
  attempt: 1,
  contextJobs: 2,
  standardJobs: 5,
  wildcardJobs: 0,
  contextRuns: 1,
  standardRuns: 1,
  wildcardRuns: 0,
  contextBatchId: 'context-batch',
  standardBatchId: 'standard-batch',
  wildcardBatchId: null,
  createdAt: new Date('2026-08-01T12:00:00.000Z'),
  updatedAt: new Date('2026-08-01T12:01:00.000Z'),
};

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
  const client = {
    nativeScoringRequest: {
      findUnique: async () => failed,
      update: async (input: { data: Record<string, unknown> }) => {
        updatedData = input.data;
        return { ...failed, ...input.data };
      },
    },
  } as unknown as NativeScoringRequestClient;

  const result = await createNativeScoringRequest('agy', client);
  assert.equal(result.created, false);
  assert.equal(result.resumed, true);
  assert.equal(result.request.status, 'queued');
  assert.equal(updatedData && Object.hasOwn(updatedData, 'phase'), false);
});

test('retry preserves the failed phase so immutable work can resume', async () => {
  const failed = { ...requestRecord, status: 'failed', phase: 'wildcard_scoring', error: 'bad result' };
  let updatedData: Record<string, unknown> | null = null;
  const client = {
    nativeScoringRequest: {
      findUnique: async () => failed,
      update: async (input: { data: Record<string, unknown> }) => {
        updatedData = input.data;
        return { ...failed, ...input.data };
      },
    },
  } as unknown as NativeScoringRequestClient;

  const retried = await retryNativeScoringRequest(failed.id, client);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.phase, 'wildcard_scoring');
  assert.equal(updatedData && Object.hasOwn(updatedData, 'phase'), false);
});
