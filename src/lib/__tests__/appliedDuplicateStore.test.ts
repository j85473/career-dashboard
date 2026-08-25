import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import {
  findAppliedDuplicateEvidence,
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

test('a manual applied decision suppresses a scored duplicate and records derived user authority', async () => {
  const updates: Array<{ where: unknown; data: unknown }> = [];
  const events: Array<{ create: Record<string, unknown> }> = [];
  const store = {
    job: {
      findMany: async () => [
        {
          id: 'live-match', identityFingerprint: 'v4:exact', status: 'inbox',
          scoringStatus: 'scored', aimFitScore: 75,
        },
      ],
      updateMany: async (args: { where: unknown; data: unknown }) => {
        updates.push(args);
        return { count: 1 };
      },
    },
    jobPipelineEvent: {
      upsert: async (args: { create: Record<string, unknown> }) => {
        events.push(args);
        return args.create;
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

  const suppressed = await suppressLiveAppliedDuplicates({
    id: 'applied-job',
    identityFingerprint: 'v4:exact',
    status: 'applied',
    company: 'Acme',
    title: 'Account Manager',
    location: 'Minneapolis, MN',
    passReason: null,
  }, store);

  assert.deepEqual(suppressed, ['live-match']);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].where, {
    id: 'live-match',
    status: {
      notIn: ['applied', 'passed', 'cooldown', 'interviewing', 'archived', 'dismissed', 'expired'],
    },
    AND: [{
      OR: [
        { source: null },
        { source: { not: 'Manual Import' } },
      ],
    }],
  });
  assert.deepEqual(updates[0].data, {
    status: 'dismissed',
    scoringStatus: 'skipped',
    passReason: 'Duplicate of a job already applied: Account Manager at Acme — Minneapolis, MN',
    scoreError: null,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].create.eventType, 'user_lifecycle');
  assert.equal(events[0].create.jobId, 'live-match');
  assert.deepEqual(events[0].create.details, {
    actor: 'user',
    protected: true,
    derived: true,
    originDecisionJobId: 'applied-job',
    originDecisionStatus: 'applied',
    duplicateReason: 'Duplicate of a job already applied: Account Manager at Acme — Minneapolis, MN',
    nextStatus: 'dismissed',
  });
});

test('Passed and Cooldown decisions never query or suppress live candidates', async () => {
  for (const status of ['passed', 'cooldown']) {
    let queried = false;
    const store = {
      job: {
        findMany: async () => {
          queried = true;
          return [{ id: 'live-match', identityFingerprint: 'v4:exact', status: 'inbox' }];
        },
        updateMany: async () => ({ count: 1 }),
      },
      jobPipelineEvent: { upsert: async () => ({}) },
    } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

    const suppressed = await suppressLiveAppliedDuplicates({
      id: `${status}-job`,
      identityFingerprint: 'v4:exact',
      status,
      company: 'Acme',
      title: 'Account Manager',
      location: 'Minneapolis, MN',
      passReason: null,
    }, store);

    assert.deepEqual(suppressed, []);
    assert.equal(queried, false, `${status} authority must fail before candidate lookup`);
  }
});

test('Passed and Cooldown candidates remain protected from an Applied authority', async () => {
  const updated: string[] = [];
  const candidates = [
    { id: 'passed-candidate', identityFingerprint: 'v4:exact', status: 'passed', source: 'ATS-greenhouse' },
    { id: 'cooldown-candidate', identityFingerprint: 'v4:exact', status: 'cooldown', source: 'ATS-greenhouse' },
  ];
  const store = {
    job: {
      findMany: async (args: { where: { status: { notIn: string[] } } }) => {
        assert.ok(args.where.status.notIn.includes('passed'));
        assert.ok(args.where.status.notIn.includes('cooldown'));
        return [];
      },
      updateMany: async (args: { where: { id: string } }) => {
        updated.push(args.where.id);
        return { count: 1 };
      },
    },
    jobPipelineEvent: { upsert: async () => ({}) },
  } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

  const suppressed = await suppressLiveAppliedDuplicates({
    id: 'applied-job',
    identityFingerprint: 'v4:exact',
    status: 'applied',
    company: 'Acme',
    title: 'Account Manager',
    location: 'Minneapolis, MN',
    passReason: null,
  }, store);

  assert.deepEqual(suppressed, []);
  assert.deepEqual(updated, []);
  assert.equal(candidates.length, 2);
});

test('applied evidence excludes Manual Imports but still suppresses null and ordinary sources', async () => {
  const updated: string[] = [];
  const candidates = [
    { id: 'manual-match', identityFingerprint: 'v4:exact', status: 'inbox', source: 'Manual Import' },
    { id: 'legacy-match', identityFingerprint: 'v4:exact', status: 'inbox', source: null },
    { id: 'ats-match', identityFingerprint: 'v4:exact', status: 'inbox', source: 'ATS-greenhouse' },
  ];
  const store = {
    job: {
      findMany: async (args: { where: { AND?: Array<{ OR?: unknown[] }> } }) => {
        assert.deepEqual(args.where.AND, [
          { OR: [{ identityFingerprint: 'v4:exact' }, { fingerprint: 'v4:exact' }] },
          {
            OR: [
              { source: null },
              { source: { not: 'Manual Import' } },
            ],
          },
        ]);
        return candidates.filter((candidate) => candidate.source !== 'Manual Import');
      },
      updateMany: async (args: { where: { id: string; AND?: unknown[] } }) => {
        assert.ok(args.where.AND, 'guarded write lost the exact source predicate');
        const candidate = candidates.find((item) => item.id === args.where.id);
        if (!candidate || candidate.source === 'Manual Import') return { count: 0 };
        updated.push(candidate.id);
        return { count: 1 };
      },
    },
    jobPipelineEvent: { upsert: async () => ({}) },
  } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

  const suppressed = await suppressLiveAppliedDuplicates({
    id: 'applied-job',
    identityFingerprint: 'v4:exact',
    status: 'applied',
    company: 'Acme',
    title: 'Account Manager',
    location: 'Minneapolis, MN',
    passReason: null,
  }, store);

  assert.deepEqual(suppressed, ['legacy-match', 'ats-match']);
  assert.deepEqual(updated, ['legacy-match', 'ats-match']);
});

test('unreliable multi-location evidence never suppresses or queries live rows', async () => {
  let queried = false;
  const store = {
    job: {
      findMany: async () => {
        queried = true;
        return [];
      },
      updateMany: async () => ({ count: 0 }),
    },
    jobPipelineEvent: { upsert: async () => ({}) },
  } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

  const suppressed = await suppressLiveAppliedDuplicates({
    id: 'applied-job',
    identityFingerprint: 'v4:placeholder',
    status: 'applied',
    company: 'Acme',
    title: 'Account Manager',
    location: 'Minneapolis, MN; 2 Locations',
    passReason: null,
  }, store);

  assert.deepEqual(suppressed, []);
  assert.equal(queried, false);
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

test('marking a pre-migration row Interviewing suppresses its live repeat', async () => {
  // Before the fix this returned [] on its first line: the deciding job's
  // identityFingerprint was null, so moving Altria's Sales Manager to
  // Interviewing could not hide the copy already sitting in the inbox.
  const updated: string[] = [];
  let candidateWhere: unknown = null;
  const store = {
    job: {
      findMany: async (args: { where: unknown }) => {
        candidateWhere = args.where;
        return [{
          id: 'inbox-repeat', identityFingerprint: 'v4:altria', fingerprint: null,
          status: 'inbox', source: 'Adzuna',
        }];
      },
      updateMany: async (args: { where: { id: string } }) => {
        updated.push(args.where.id);
        return { count: 1 };
      },
    },
    jobPipelineEvent: { upsert: async () => ({}) },
  } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

  const suppressed = await suppressLiveAppliedDuplicates({
    id: 'interviewing-row',
    identityFingerprint: null,
    fingerprint: 'v4:altria',
    status: 'interviewing',
    company: 'Altria Client Services LLC',
    title: 'Sales Manager- St. Paul/ Rochester, MN',
    location: 'Saint Paul, Ramsey County',
  }, store);

  assert.deepEqual(suppressed, ['inbox-repeat']);
  assert.deepEqual(updated, ['inbox-repeat']);
  assert.deepEqual(
    (candidateWhere as { AND: unknown[] }).AND[0],
    { OR: [{ identityFingerprint: 'v4:altria' }, { fingerprint: 'v4:altria' }] },
  );
});

test('a decision whose only fingerprint is a location-less legacy scheme suppresses nothing', async () => {
  let queried = false;
  const store = {
    job: {
      findMany: async () => { queried = true; return []; },
      updateMany: async () => ({ count: 1 }),
    },
    jobPipelineEvent: { upsert: async () => ({}) },
  } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

  const suppressed = await suppressLiveAppliedDuplicates({
    id: 'applied-job',
    identityFingerprint: null,
    fingerprint: 'v3:location-less',
    status: 'applied',
    company: 'seeknow',
    title: 'Field Inspector 1099 Contractor',
    location: 'Tacoma, WA',
  }, store);

  assert.deepEqual(suppressed, []);
  assert.equal(queried, false, 'a location-less key must not even reach the database');
});
