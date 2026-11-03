import assert from 'node:assert/strict';
import test from 'node:test';
import { retryFailedJob } from '../failedJobRecovery';
import { aimSourceJdHash, aimTrustedMetadataHash, normalizeAimTrustedMetadata } from '../aimIdentity';
import type { Prisma } from '../prismaClient';
import { POST } from '../../app/api/jobs/[id]/retry-failure/route';

const job = { id: 'test-job', title: 'Account Manager', company: 'Example Inc', location: 'Remote',
  description: 'Manage accounts and support partners.', source: 'ATS-greenhouse',
  scoringStatus: 'failed', scoreError: 'Experience Fit could not score this job: stream disconnected',
  scoreAttempts: 0, passReason: null, aimFitScore: 82, reqFitScore: null, updatedAt: new Date('2026-10-30T12:00:00Z') };
const sourceJdHash = aimSourceJdHash(job.description);
const extraction = { id: 'extraction', scope: 'stage1', sourceJdHash, staleAt: null,
  trustedMetadataHash: aimTrustedMetadataHash(normalizeAimTrustedMetadata(job)) };
const aim = { id: 'aim', evaluationType: 'aim_fit', passed: true, schemaVersion: 'career-dashboard-aim-result-v2',
  aimFitScore: 82, aimFactualExtractionId: 'extraction', semanticResultHash: 'semantic', staleAt: null,
  inputBindingsCurrent: false, inputBindings: { source: { sourceJdHash } } };

function harness(options: { missing?: boolean; changed?: boolean; badAnchor?: boolean; completed?: boolean; jd?: boolean } = {}) {
  const writes: Array<{ kind: string; input: Record<string, unknown> }> = [];
  let scope: unknown;
  const tx = {
    $executeRaw: async () => 1,
    job: {
      findFirst: async (query: { where: unknown }) => { scope = query.where; return options.missing ? null
        : options.jd ? { ...job, aimFitScore: null, scoreAttempts: 3, scoreError: 'JD recovery rejected: no usable role duties.' } : job; },
      updateMany: async (input: Record<string, unknown>) => { writes.push({ kind: 'job', input }); return { count: options.changed ? 0 : 1 }; },
    },
    aimFactualExtraction: { findUnique: async () => ({ ...extraction, ...(options.badAnchor ? { sourceJdHash: 'changed' } : {}) }) },
    jobPipelineEvent: { create: async (input: Record<string, unknown>) => { writes.push({ kind: 'event', input }); } },
  };
  const client = { $transaction: async (action: (tx: unknown) => unknown, settings: { isolationLevel: string }) => {
    assert.equal(settings.isolationLevel, 'Serializable'); return action(tx);
  } } as unknown as Parameters<typeof retryFailedJob>[0];
  const deps = {
    latestJobScoreEvents: async () => new Map([[job.id, { legacy: null, aim, experience: options.completed ? {
      id: 'experience', evaluationType: 'experience_fit', schemaVersion: 'career-dashboard-experience-result-v2',
      sourceAimEventId: 'aim', aimFactualExtractionId: 'extraction', staleAt: null,
      inputBindings: { aimSemanticResultHash: 'semantic', sourceJdHash },
    } : null, cleanedArtifact: null, aimExtraction: { id: 'extraction', sourceJdHash, staleAt: null } }]]),
    assertJobLifecycleInvariants: async () => [],
  } as unknown as NonNullable<Parameters<typeof retryFailedJob>[3]>;
  return { client, deps, writes, scope: () => scope };
}

test('an explicit Experience retry preserves Aim despite informational policy drift and queues only the missing stage', async () => {
  const h = harness();
  assert.equal((await retryFailedJob(h.client, job.id, 'experience', h.deps)).queue, 'experience_fit');
  assert.deepEqual(h.writes[0].input.data, { scoringStatus: 'scored', experienceStatus: 'queued', scoreError: null });
  const scope = h.scope() as { AND: Prisma.JobWhereInput[] };
  assert.deepEqual(scope.AND[1].scoringBatchItems, { none: { status: 'leased' } });
  assert.equal(scope.AND[1].reqFitScore, null);
  assert.equal(scope.AND[1].status, 'pending_af');
  assert.equal(scope.AND[1].tailoringStaged, false);
  assert.equal(h.writes[1].kind, 'event');
  assert.equal((h.writes[1].input.data as { eventType: string }).eventType, 'user_failure_retry');
});

test('JD retries reset only the bounded recovery budget and preserve card inputs, scores and lifecycle', async () => {
  const h = harness({ jd: true });
  await retryFailedJob(h.client, job.id, 'jd', h.deps);
  assert.deepEqual(h.writes[0].input.data, { scoringStatus: 'needs_jd', scoreAttempts: 0,
    scoreError: null, passReason: null, jdDeferrals: 0, jdDeferredUntil: null });
  const scope = h.scope() as { AND: Prisma.JobWhereInput[] };
  assert.deepEqual(scope.AND[1].scoreEvents, { none: {} });
  assert.equal(scope.AND[1].aimFitScore, null);
  assert.equal(scope.AND[1].fitScore, null);
});

test('completed Experience work and changed Aim inputs cannot be turned into a retry', async () => {
  for (const option of [{ badAnchor: true }, { completed: true }, { missing: true }]) {
    const h = harness(option);
    await assert.rejects(retryFailedJob(h.client, job.id, 'experience', h.deps), /completed|inputs no longer match|no longer retryable/);
    assert.equal(h.writes.length, 0);
  }
});

test('a concurrently changed job does not receive a retry event', async () => {
  const h = harness({ changed: true });
  await assert.rejects(retryFailedJob(h.client, job.id, 'experience', h.deps), /changed during recovery/);
  assert.deepEqual(h.writes.map(write => write.kind), ['job']);
  const where = h.writes[0].input.where as { AND: Prisma.JobWhereInput[] };
  assert.equal(where.AND[1].updatedAt, job.updatedAt);
  assert.equal(where.AND[1].aimFitScore, 82);
});

test('failure recovery rejects cross-origin mutations and ambiguous stages before any database access', async () => {
  const context = { params: Promise.resolve({ id: job.id }) };
  const foreign = await POST(new Request('http://dashboard/api/jobs/test-job/retry-failure', {
    method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: '{"stage":"jd"}',
  }), context);
  assert.equal(foreign.status, 403);
  for (const body of [{ stage: 'aim' }, { stage: 'jd', resetScores: true }, null]) {
    const response = await POST(new Request('http://dashboard/api/jobs/test-job/retry-failure', {
      method: 'POST', headers: { origin: 'http://dashboard', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), context);
    assert.equal(response.status, 400);
  }
});
