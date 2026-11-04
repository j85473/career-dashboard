import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '../../src/lib/prismaClient';

const calls: Array<{ method: string; args: unknown }> = [];
let exists = true;
let changeCount = 1;
const tx = {
  job: { findUnique: async () => exists ? { id: 'job-a' } : null },
  jobInterview: {
    create: async (args: unknown) => { calls.push({ method: 'create', args }); },
    updateMany: async (args: unknown) => { calls.push({ method: 'update', args }); return { count: changeCount }; },
    deleteMany: async (args: unknown) => { calls.push({ method: 'delete', args }); return { count: changeCount }; },
    findMany: async () => [{ id: 'round-a', scheduledAt: new Date('2026-11-05T15:00:00Z'), label: 'Recruiter' }],
  },
};
(globalThis as unknown as { prisma: PrismaClient }).prisma = {
  $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
} as unknown as PrismaClient;
const route = import('../../src/app/api/jobs/[id]/interviews/route');
const context = { params: Promise.resolve({ id: 'job-a' }) };
const request = (method: string, body: unknown) => new Request('http://localhost/api/jobs/job-a/interviews', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('schedule writes are scoped to the job and do not require lifecycle or score mutations', async () => {
  const api = await route;
  let response = await api.POST(request('POST', { scheduledAt: '2026-11-05T09:00:00-06:00', label: 'Recruiter' }), context);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.pop(), { method: 'create', args: { data: {
    jobId: 'job-a', scheduledAt: new Date('2026-11-05T15:00:00Z'), label: 'Recruiter',
  } } });
  response = await api.PATCH(request('PATCH', { id: 'round-a', scheduledAt: '2026-11-06T15:00:00Z' }), context);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.pop(), { method: 'update', args: {
    where: { id: 'round-a', jobId: 'job-a' }, data: { scheduledAt: new Date('2026-11-06T15:00:00Z'), label: '' },
  } });
  response = await api.DELETE(request('DELETE', { id: 'round-a' }), context);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.pop(), { method: 'delete', args: { where: { id: 'round-a', jobId: 'job-a' } } });
  assert.equal((await response.json()).interviews.length, 1);
});

test('missing jobs, foreign interview IDs, and malformed dates cannot mutate a different job', async () => {
  const api = await route;
  assert.equal((await api.POST(request('POST', {}), context)).status, 400);
  assert.equal((await api.PATCH(request('PATCH', { scheduledAt: '2026-11-05T15:00:00Z' }), context)).status, 400);
  exists = false;
  assert.equal((await api.POST(request('POST', { scheduledAt: '2026-11-05T15:00:00Z' }), context)).status, 404);
  exists = true;
  assert.equal(calls.length, 0);
  changeCount = 0;
  assert.equal((await api.DELETE(request('DELETE', { id: 'another-jobs-round' }), context)).status, 404);
  assert.deepEqual(calls.pop(), { method: 'delete', args: { where: { id: 'another-jobs-round', jobId: 'job-a' } } });
});
