import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import { companyIdentityKey, sameCompanyIdentity } from '../companyIdentity';
import {
  activeApplicationDecisionAt,
  companyCooldownUntil,
  parkSameCompanyInboxJobs,
  reconcileCompanyCooldowns,
  resolveInboxAdmission,
} from '../companyCooldown';

test('company identity aligns legal names and compact ATS slugs without fuzzy matching', () => {
  assert.equal(companyIdentityKey('HP, Inc.'), 'hp');
  assert.equal(companyIdentityKey('HP'), 'hp');
  assert.equal(companyIdentityKey('SharkNinja Operating LLC'), 'sharkninja');
  assert.equal(companyIdentityKey('sharkninjaoperatingllc'), 'sharkninja');
  assert.equal(sameCompanyIdentity('SharkNinja', 'sharkninjaoperatingllc'), true);
  assert.equal(sameCompanyIdentity('SharkNinja', 'Shark Robotics'), false);
  assert.equal(companyIdentityKey('3m.wd1'), '3m');
});

test('the cooldown starts at the original application decision, not enforcement time', () => {
  const appliedAt = new Date('2026-08-25T14:00:00.000Z');
  const decisionAt = activeApplicationDecisionAt([
    { status: 'interviewing', createdAt: new Date('2026-08-27T14:00:00.000Z') },
    { status: 'applied', createdAt: appliedAt },
    { status: 'inbox', createdAt: new Date('2026-08-24T14:00:00.000Z') },
  ], new Date('2026-08-27T15:00:00.000Z'));
  assert.equal(decisionAt.toISOString(), appliedAt.toISOString());
  assert.equal(companyCooldownUntil(decisionAt).toISOString(), '2026-09-15T14:00:00.000Z');
});

test('Inbox admission catches a recent application under a legal-name alias', async () => {
  const appliedAt = new Date('2026-08-25T14:00:00.000Z');
  const store = {
    job: {
      findMany: async () => [{
        id: 'applied-job',
        company: 'sharkninjaoperatingllc',
        updatedAt: new Date('2026-08-27T00:00:00.000Z'),
        statusHistory: [
          { status: 'applied', createdAt: appliedAt },
          { status: 'inbox', createdAt: new Date('2026-08-24T00:00:00.000Z') },
        ],
      }],
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const admission = await resolveInboxAdmission({
    jobId: 'new-job',
    company: 'SharkNinja',
    source: 'Himalayas',
    proposedStatus: 'inbox',
    now: new Date('2026-08-27T12:00:00.000Z'),
    store,
  });
  assert.equal(admission.status, 'cooldown');
  assert.equal(admission.authorityJobId, 'applied-job');
  assert.equal(admission.cooldownUntil?.toISOString(), '2026-09-15T14:00:00.000Z');
});

test('expired application windows and Manual Imports do not block Inbox', async () => {
  let queries = 0;
  const oldAppliedAt = new Date('2026-07-01T00:00:00.000Z');
  const store = {
    job: {
      findMany: async () => {
        queries += 1;
        return [{
          id: 'old-application', company: 'HP', updatedAt: oldAppliedAt,
          statusHistory: [{ status: 'applied', createdAt: oldAppliedAt }],
        }];
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const expired = await resolveInboxAdmission({
    jobId: 'hp-new', company: 'HP Inc.', source: 'Himalayas', proposedStatus: 'inbox',
    now: new Date('2026-08-27T00:00:00.000Z'), store,
  });
  assert.equal(expired.status, 'inbox');
  assert.equal(expired.cooldownUntil, null);

  const manual = await resolveInboxAdmission({
    jobId: 'manual', company: 'HP', source: 'Manual Import', proposedStatus: 'inbox',
    now: new Date('2026-08-27T00:00:00.000Z'), store,
  });
  assert.equal(manual.status, 'inbox');
  assert.equal(queries, 1, 'Manual Import protection should bypass application queries');
});

test('marking Applied parks only matching current Inbox rows with a CAS write', async () => {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const store = {
    job: {
      findMany: async () => [
        { id: 'alias-inbox', company: 'SharkNinja Operating LLC' },
        { id: 'other-inbox', company: 'Shark Robotics' },
      ],
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const ids = await parkSameCompanyInboxJobs({
    authorityJobId: 'applied-job',
    company: 'sharkninjaoperatingllc',
    decisionAt: new Date('2026-08-25T00:00:00.000Z'),
    now: new Date('2026-08-27T00:00:00.000Z'),
    store,
  });
  assert.deepEqual(ids, ['alias-inbox']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.status, 'inbox');
  assert.equal((updates[0].data.cooldownUntil as Date).toISOString(), '2026-09-15T00:00:00.000Z');
});

test('reconciliation scans and mutates Inbox only, preserving other decisions', async () => {
  const queries: Array<Record<string, unknown>> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const store = {
    job: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        if ('status' in args.where && typeof args.where.status === 'object') {
          return [{
            id: 'hp-applied', company: 'HP Inc.', updatedAt: new Date('2026-08-21T00:00:00.000Z'),
            statusHistory: [{ status: 'applied', createdAt: new Date('2026-08-21T00:00:00.000Z') }],
          }];
        }
        return [{ id: 'hp-inbox', company: 'HP' }];
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const ids = await reconcileCompanyCooldowns({
    now: new Date('2026-08-27T00:00:00.000Z'), store,
  });
  assert.deepEqual(ids, ['hp-inbox']);
  assert.equal(queries[1].status, 'inbox');
  assert.equal(updates[0].where.status, 'inbox');
  assert.equal((updates[0].data.cooldownUntil as Date).toISOString(), '2026-09-11T00:00:00.000Z');
});
