import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import {
  findAppliedDuplicateEvidence,
  findAppliedRepeatForJob,
  listUncoveredProtectedAppliedEvidence,
  suppressLiveAppliedDuplicates,
} from '../appliedDuplicateStore';

test('ingestion fallback finds all-time Already applied evidence by exact fingerprint', async () => {
  let receivedWhere: unknown = null;
  const historical = {
    id: 'historical',
    identityFingerprint: 'v4:exact',
    status: 'dismissed',
    company: 'Acme',
    title: 'Account Manager',
    location: 'Minneapolis, MN',
    passReason: 'Already applied',
  };
  const store = {
    job: {
      findMany: async (args: { where: unknown }) => {
        receivedWhere = args.where;
        return [historical];
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const match = await findAppliedDuplicateEvidence({
    id: 'incoming',
    identityFingerprint: 'v4:exact',
    status: 'pending_af',
    location: 'Minneapolis, MN',
  }, store);

  assert.equal(match?.id, 'historical');
  assert.deepEqual(receivedWhere, {
    AND: [
      { OR: [{ identityFingerprint: 'v4:exact' }, { fingerprint: 'v4:exact' }] },
      {
        OR: [
          { status: { in: ['applied', 'interviewing'] } },
          { passReason: 'Already applied' },
        ],
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// Same-role repeats at the moment of an application

function descriptionText(seed: string, words = 260): string {
  return Array.from({ length: words }, (_, index) => `${seed}${(index * 7919) % 1009}`).join(' ');
}

type FakeJob = {
  id: string; title: string; company: string; location: string | null; description: string | null;
  status: string; source: string | null; sourceId?: string | null; scoringStatus: string;
  aimFitScore: number | null; reqFitScore: number | null; passReason?: string | null; scoreError?: string | null;
};
type FakeEvent = { id: string; jobId: string; eventType: string; occurredAt: Date; details: Record<string, unknown> };

function fakeRepeatStore(jobs: FakeJob[], events: FakeEvent[] = []) {
  const matchesWhere = (job: FakeJob, where: Record<string, unknown>): boolean => {
    const id = where.id as { not?: string; in?: string[] } | string | undefined;
    if (typeof id === 'string' && job.id !== id) return false;
    if (id && typeof id === 'object' && id.not && job.id === id.not) return false;
    if (id && typeof id === 'object' && id.in && !id.in.includes(job.id)) return false;
    const status = where.status as { in?: string[] } | undefined;
    if (status?.in && !status.in.includes(job.status)) return false;
    if (where.AND && job.source === 'Manual Import') return false;
    return true;
  };
  const store = {
    job: {
      findMany: async (args: { where: Record<string, unknown> }) => jobs.filter((job) => matchesWhere(job, args.where)),
      findUnique: async (args: { where: { id: string } }) => jobs.find((job) => job.id === args.where.id) || null,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const job = jobs.find((row) => matchesWhere(row, args.where));
        if (!job) return { count: 0 };
        Object.assign(job, args.data);
        return { count: 1 };
      },
    },
    jobPipelineEvent: {
      findMany: async (args: { where: { jobId: string | { in: string[] }; eventType: string | { in: string[] } } }) => events
        .filter((event) => typeof args.where.jobId === 'string'
          ? event.jobId === args.where.jobId
          : args.where.jobId.in.includes(event.jobId))
        .filter((event) => typeof args.where.eventType === 'string'
          ? event.eventType === args.where.eventType
          : args.where.eventType.in.includes(event.eventType))
        .sort((left, right) => right.occurredAt.valueOf() - left.occurredAt.valueOf()),
      upsert: async (args: { create: Record<string, unknown> }) => {
        events.push({
          id: `event-${events.length}`, jobId: String(args.create.jobId), eventType: String(args.create.eventType),
          occurredAt: new Date(), details: args.create.details as Record<string, unknown>,
        });
        return args.create;
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;
  return { store, jobs, events };
}

const veeamText = descriptionText('veeam');
const appliedVeeam = {
  id: 'applied-veeam', identityFingerprint: 'v4:greenhouse', status: 'applied', company: 'veeamsoftware',
  title: 'Senior Global Partner Manager (REMOTE US)', location: 'Remote, United States', passReason: null,
  description: veeamText,
};

test('applying hides a scored cross-source repeat without touching its score', async () => {
  const { store, jobs, events } = fakeRepeatStore([{
    id: 'himalayas-veeam', title: 'Senior Global Partner Manager (REMOTE US)', company: 'Veeam Software',
    location: 'United States', description: veeamText, status: 'inbox', source: 'Himalayas',
    scoringStatus: 'scored', aimFitScore: 81, reqFitScore: 77,
  }]);

  const suppressed = await suppressLiveAppliedDuplicates(appliedVeeam, store);

  assert.deepEqual(suppressed, ['himalayas-veeam']);
  assert.equal(jobs[0].status, 'dismissed');
  assert.equal(jobs[0].scoringStatus, 'scored', 'a scored repeat keeps its scoring state');
  assert.equal(jobs[0].aimFitScore, 81);
  assert.equal(jobs[0].reqFitScore, 77);
  assert.equal(jobs[0].passReason, 'Duplicate of a job already applied: Senior Global Partner Manager (REMOTE US) at veeamsoftware — Remote, United States');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'user_lifecycle');
  assert.equal(events[0].details.derived, true);
  assert.equal(events[0].details.originDecisionJobId, 'applied-veeam');
  assert.equal(events[0].details.nextStatus, 'dismissed');
  assert.equal((events[0].details.repeatEvidence as { rule: string }).rule, 'description');
});

test('an unscored repeat waiting to be scored is marked so scoring skips it', async () => {
  const { store, jobs } = fakeRepeatStore([{
    id: 'waiting', title: 'Senior Global Partner Manager', company: 'Veeam Software', location: 'United States',
    description: veeamText, status: 'pending_af', source: 'Glassdoor (RapidAPI)', scoringStatus: 'queued',
    aimFitScore: null, reqFitScore: null, scoreError: 'old',
  }]);
  assert.deepEqual(await suppressLiveAppliedDuplicates(appliedVeeam, store), ['waiting']);
  assert.equal(jobs[0].scoringStatus, 'skipped');
  assert.equal(jobs[0].scoreError, null);
});

test('Manual Imports, jobs Joseph acted on, and "Not a repeat" pairs are never hidden', async () => {
  const base = {
    title: 'Senior Global Partner Manager (REMOTE US)', company: 'Veeam Software', location: 'United States',
    description: veeamText, status: 'inbox', scoringStatus: 'scored', aimFitScore: 80, reqFitScore: 80,
  };
  const { store, jobs } = fakeRepeatStore([
    { ...base, id: 'manual', source: 'Manual Import' },
    { ...base, id: 'promoted', source: 'Himalayas' },
    { ...base, id: 'excepted', source: 'Adzuna' },
  ], [
    { id: 'e1', jobId: 'promoted', eventType: 'user_promote', occurredAt: new Date(), details: { nextStatus: 'inbox' } },
    { id: 'e2', jobId: 'excepted', eventType: 'applied_repeat_exception', occurredAt: new Date(), details: { authorityJobId: 'applied-veeam' } },
  ]);
  assert.deepEqual(await suppressLiveAppliedDuplicates(appliedVeeam, store), []);
  assert.deepEqual(jobs.map((job) => job.status), ['inbox', 'inbox', 'inbox']);
});

test('the same template in another territory is not hidden', async () => {
  const { store } = fakeRepeatStore([{
    id: 'michigan', title: 'Account Manager', company: 'formerra', location: 'Michigan, United States',
    description: descriptionText('formerra'), status: 'inbox', source: 'ATS-greenhouse',
    scoringStatus: 'scored', aimFitScore: 70, reqFitScore: 70,
  }]);
  const suppressed = await suppressLiveAppliedDuplicates({
    id: 'minnesota', identityFingerprint: 'v4:mn', status: 'applied', company: 'formerra', title: 'Account Manager',
    location: 'Minnesota, United States', passReason: null, description: descriptionText('formerra'),
  }, store);
  assert.deepEqual(suppressed, []);
});

test('Passed and Cooldown decisions never query or suppress live candidates', async () => {
  for (const status of ['passed', 'cooldown']) {
    let queried = false;
    const store = {
      job: {
        findMany: async () => { queried = true; return []; },
        updateMany: async () => ({ count: 1 }),
      },
      jobPipelineEvent: { upsert: async () => ({}), findMany: async () => [] },
    } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

    const suppressed = await suppressLiveAppliedDuplicates({ ...appliedVeeam, status }, store);
    assert.deepEqual(suppressed, []);
    assert.equal(queried, false, `${status} authority must fail before candidate lookup`);
  }
});

test('the Inbox door returns the applied job a waiting posting repeats', async () => {
  const { store } = fakeRepeatStore([
    {
      id: 'applied-sourcegraph', title: 'Customer Success Manager - US [IC2]', company: 'sourcegraph91',
      location: 'Remote', description: descriptionText('sg'), status: 'applied', source: 'ATS-greenhouse',
      scoringStatus: 'scored', aimFitScore: 90, reqFitScore: 90, passReason: null,
    },
    {
      id: 'himalayas-sourcegraph', title: 'Customer Success Manager - US [IC2]', company: 'Sourcegraph',
      location: 'United States', description: descriptionText('sg'), status: 'pending_af', source: 'Himalayas',
      scoringStatus: 'scored', aimFitScore: 88, reqFitScore: null,
    },
  ]);
  const fakeStore = store as unknown as { job: { findMany: (args: { where: Record<string, unknown> }) => Promise<unknown[]> } };
  const originalFindMany = fakeStore.job.findMany;
  fakeStore.job.findMany = async (args) => (args.where.OR
    ? (await originalFindMany({ where: {} })).filter((job) => (job as FakeJob).status === 'applied')
    : originalFindMany(args));

  const match = await findAppliedRepeatForJob('himalayas-sourcegraph', store);
  assert.equal(match?.authority.id, 'applied-sourcegraph');
  assert.equal(match?.evidence.rule, 'description');
});

test('uncovered-evidence audit is limited to approved protected cohorts', async () => {
  let receivedWhere: unknown = null;
  const store = {
    job: {
      findMany: async (args: { where: unknown }) => {
        receivedWhere = args.where;
        return [];
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  await listUncoveredProtectedAppliedEvidence(store);
  assert.deepEqual(receivedWhere, {
    identityFingerprint: null,
    OR: [
      { status: { in: ['applied', 'interviewing'] } },
      { passReason: 'Already applied' },
    ],
  });
});

