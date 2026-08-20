import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import {
  findAppliedDuplicateEvidence,
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
    identityFingerprint: 'v4:exact',
    OR: [
      { status: { in: ['applied', 'passed', 'cooldown', 'interviewing'] } },
      { passReason: { equals: 'Already applied', mode: 'insensitive' } },
    ],
  });
});

test('a manual applied decision immediately suppresses matching live rows only', async () => {
  const updates: Array<{ where: unknown; data: unknown }> = [];
  const store = {
    job: {
      findMany: async () => [
        { id: 'live-match', identityFingerprint: 'v4:exact', status: 'inbox' },
      ],
      updateMany: async (args: { where: unknown; data: unknown }) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

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
  });
  assert.deepEqual(updates[0].data, {
    status: 'dismissed',
    scoringStatus: 'skipped',
    passReason: 'Duplicate of a job already applied: Account Manager at Acme — Minneapolis, MN',
    scoreError: null,
  });
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
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

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
