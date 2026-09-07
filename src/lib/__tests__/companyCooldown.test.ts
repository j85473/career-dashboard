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
    title: 'Account Manager', location: null,
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
    title: 'Account Manager', location: null,
    jobId: 'hp-new', company: 'HP Inc.', source: 'Himalayas', proposedStatus: 'inbox',
    now: new Date('2026-08-27T00:00:00.000Z'), store,
  });
  assert.equal(expired.status, 'inbox');
  assert.equal(expired.cooldownUntil, null);

  const manual = await resolveInboxAdmission({
    title: 'Account Manager', location: null,
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

const zoetisAliases = [
  'Zoetis', '110 - Zoetis US LLC', '6J2 - Zoetis Services LLC',
  'Zoetis US LLC', 'Zoetis Services LLC', 'zoetis.wd5',
];
const zoetisAppliedAt = new Date('2026-09-06T16:43:05.037Z');
const zoetisNow = new Date('2026-09-06T17:00:00.000Z');
const zoetisUntil = '2026-09-27T16:43:05.037Z';

test('Zoetis employer aliases share cooldown in either direction without changing posting identity', async () => {
  for (const appliedCompany of zoetisAliases) {
    const store = { job: { findMany: async () => [{
      id: 'applied-job', company: appliedCompany, updatedAt: zoetisNow,
      statusHistory: [{ status: 'applied', createdAt: zoetisAppliedAt }],
    }] } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
    for (const company of [...zoetisAliases, 'Zoetis Consulting', '110 - Other US LLC']) {
      const admission = await resolveInboxAdmission({
    title: 'Account Manager', location: null,
        jobId: 'inbox-job', company, source: 'ATS-workday',
        proposedStatus: 'inbox', now: zoetisNow, store,
      });
      const matches = zoetisAliases.includes(company);
      assert.equal(admission.status, matches ? 'cooldown' : 'inbox', `${appliedCompany} -> ${company}`);
      assert.equal(admission.cooldownUntil?.toISOString() ?? null, matches ? zoetisUntil : null);
    }
    for (const [source, proposedStatus] of [['Manual Import', 'inbox'], ['ATS-workday', 'bookmarked']]) {
      const admission = await resolveInboxAdmission({
    title: 'Account Manager', location: null,
        jobId: 'protected-job', company: 'Zoetis', source, proposedStatus, now: zoetisNow, store,
      });
      assert.equal(admission.status, proposedStatus);
      assert.equal(admission.cooldownUntil, null);
    }
    const expired = await resolveInboxAdmission({
    title: 'Account Manager', location: null,
      jobId: 'inbox-job', company: 'Zoetis', source: 'ATS-workday',
      proposedStatus: 'inbox', now: new Date(zoetisUntil), store,
    });
    assert.equal(expired.status, 'inbox');
  }
  assert.notEqual(companyIdentityKey('110 - Zoetis US LLC'), companyIdentityKey('6J2 - Zoetis Services LLC'));
});

for (const operation of ['application', 'reconciliation'] as const) {
  test(`${operation} parks the three Zoetis Inbox records while preserving scores and protected jobs`, async () => {
    const rows = [
      { id: 'senior-workday', company: '110 - Zoetis US LLC', status: 'inbox', source: 'ATS-workday' },
      { id: 'senior-himalayas', company: 'Zoetis', status: 'inbox', source: 'Himalayas' },
      { id: 'retail-himalayas', company: 'Zoetis', status: 'inbox', source: null },
      { id: 'other-company', company: 'Zoetis Consulting', status: 'inbox', source: 'ATS-workday' },
      { id: 'manual', company: 'Zoetis', status: 'inbox', source: 'Manual Import' },
      ...['applied', 'interviewing', 'bookmarked', 'passed', 'dismissed'].map(status => ({
        id: status, company: 'Zoetis', status, source: 'ATS-workday',
      })),
    ];
    const queries: unknown[] = [];
    const updates: Array<{ where: { id: string; status: string; AND: unknown }; data: Record<string, unknown> }> = [];
    const store = { job: {
      findMany: async (args: { where: { status: unknown; AND?: unknown } }) => {
        queries.push(args.where);
        if (typeof args.where.status === 'object') return [{
          id: 'applied-job', company: '6J2 - Zoetis Services LLC', updatedAt: zoetisNow,
          statusHistory: [{ status: 'applied', createdAt: zoetisAppliedAt }],
        }];
        assert.equal(args.where.status, 'inbox');
        assert.deepEqual(args.where.AND, [{ OR: [{ source: null }, { source: { not: 'Manual Import' } }] }]);
        return rows.filter(row => row.status === 'inbox' && row.source !== 'Manual Import');
      },
      updateMany: async (args: typeof updates[number]) => {
        updates.push(args);
        assert.equal(args.where.status, 'inbox');
        assert.deepEqual(args.where.AND, [{ OR: [{ source: null }, { source: { not: 'Manual Import' } }] }]);
        assert.deepEqual(Object.keys(args.data).sort(), ['cooldownUntil', 'status'], 'scores, identity and application history must not be rewritten');
        assert.equal(args.data.status, 'cooldown');
        assert.equal((args.data.cooldownUntil as Date).toISOString(), zoetisUntil);
        // Simulate a concurrent human decision after the candidate read.
        return { count: args.where.id === 'retail-himalayas' ? 0 : 1 };
      },
    } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
    const ids = operation === 'application'
      ? await parkSameCompanyInboxJobs({
        authorityJobId: 'applied-job', company: '6J2 - Zoetis Services LLC',
        decisionAt: zoetisAppliedAt, now: zoetisNow, store,
      })
      : await reconcileCompanyCooldowns({ now: zoetisNow, store });
    assert.deepEqual(updates.map(update => update.where.id), ['senior-workday', 'senior-himalayas', 'retail-himalayas']);
    assert.deepEqual(ids, ['senior-workday', 'senior-himalayas'], 'only successfully parked rows are reported');
    assert.equal(queries.length, operation === 'application' ? 1 : 2);
  });
}

test('Jobgether listings bypass company cooldown without changing employer identity', async () => {
  let queries = 0;
  const store = { job: { findMany: async () => { queries += 1; return []; } } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
  for (const company of ['Jobgether', ' JOBGETHER ', 'Jobgether Inc.']) {
    const admission = await resolveInboxAdmission({
      jobId: 'recruiter-listing', title: 'Account Manager', location: null,
      company, source: 'ATS', proposedStatus: 'inbox', now: zoetisNow, store,
    });
    assert.equal(admission.status, 'inbox');
    assert.equal(admission.cooldownUntil, null);
  }
  assert.equal(queries, 0, 'exempt company needs no cooldown authority lookup');
  assert.equal(companyIdentityKey('Jobgether'), 'jobgether', 'exemption does not change dedupe identity');
});

test('marking Jobgether Applied cannot park its other Inbox listings', async () => {
  const store = { job: {
    findMany: async () => { throw new Error('Jobgether must not scan other jobs for cooldown'); },
    updateMany: async () => { throw new Error('Jobgether must not park other jobs'); },
  } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
  const ids = await parkSameCompanyInboxJobs({
    authorityJobId: 'jobgether-applied', company: 'Jobgether',
    decisionAt: zoetisAppliedAt, now: zoetisNow, store,
  });
  assert.deepEqual(ids, []);
});

test('cooldown reconciliation ignores Jobgether applications while retaining other employers', async () => {
  const parkedIds: string[] = [];
  const store = { job: {
    findMany: async ({ where }: { where: { status: unknown } }) => (
      typeof where.status === 'object'
        ? ['Jobgether', 'Acme'].map(company => ({
          id: `${company}-applied`, company, updatedAt: zoetisAppliedAt,
          statusHistory: [{ status: 'applied', createdAt: zoetisAppliedAt }],
        }))
        : ['Jobgether', 'Acme'].map(company => ({ id: `${company}-inbox`, company }))
    ),
    updateMany: async ({ where }: { where: { id: string } }) => {
      parkedIds.push(where.id);
      return { count: 1 };
    },
  } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
  assert.deepEqual(await reconcileCompanyCooldowns({ now: zoetisNow, store }), ['Acme-inbox']);
  assert.deepEqual(parkedIds, ['Acme-inbox']);
});
