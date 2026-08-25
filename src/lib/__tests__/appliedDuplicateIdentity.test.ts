import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import {
  appliedIdentityFingerprint,
  applyProtectedAppliedIdentityBackfill,
  planProtectedAppliedIdentityBackfill,
  shouldMaintainAppliedIdentity,
  type ProtectedAppliedIdentityCandidate,
} from '../appliedDuplicateIdentity';
import { planAppliedDuplicateSuppression } from '../appliedDuplicatePolicy';
import { generatePostingIdentity } from '../jobIngestion';

const UPDATED_AT = new Date('2026-08-24T16:22:38.029Z');

function historical(
  overrides: Partial<ProtectedAppliedIdentityCandidate> = {},
): ProtectedAppliedIdentityCandidate {
  return {
    id: 'historical-applied',
    title: 'Account Manager',
    company: 'Acme',
    location: 'Minneapolis, MN',
    status: 'applied',
    passReason: null,
    identityFingerprint: null,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

test('the confirmed Altria punctuation variants derive the same identity', () => {
  const older = historical({
    title: 'Sales Manager- St. Paul/ Rochester, MN',
    company: 'Altria Client Services LLC',
    location: 'Saint Paul, Ramsey County',
  });
  const incoming = appliedIdentityFingerprint({
    title: 'Sales Manager - St. Paul / Rochester, MN',
    company: 'Altria Client Services LLC',
    location: 'Saint Paul, Ramsey County',
  });
  const preview = planProtectedAppliedIdentityBackfill([older]);

  assert.equal(preview.plans.length, 1);
  assert.equal(preview.plans[0].identityFingerprint, incoming);
  assert.equal(incoming, 'v4:1d92f92a10403a2e8a998f69ad939e6564aa14a1d0e27d80993c27ae27775098');
});

test('a new Spring Health requisition is still suppressed by approved same-role applied history', () => {
  const oldPosting = generatePostingIdentity({
    source: 'ATS-greenhouse',
    sourceId: '4543797005',
    canonicalUrl: 'https://job-boards.greenhouse.io/springhealth66/jobs/4543797005',
  });
  const newPosting = generatePostingIdentity({
    source: 'ATS-greenhouse',
    sourceId: '4723602005',
    canonicalUrl: 'https://job-boards.greenhouse.io/springhealth66/jobs/4723602005',
  });
  assert.notEqual(oldPosting, newPosting, 'the ATS requisitions must remain distinct');

  const fingerprint = appliedIdentityFingerprint({
    title: 'Customer Success Manager',
    company: 'springhealth66',
    location: 'Remote',
  });
  const plans = planAppliedDuplicateSuppression(
    [{ id: 'greenhouse-4723602005', identityFingerprint: fingerprint, status: 'inbox' }],
    [{
      id: 'greenhouse-4543797005',
      identityFingerprint: fingerprint,
      status: 'applied',
      title: 'Customer Success Manager',
      company: 'springhealth66',
      location: 'Remote',
    }],
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].duplicateOfJobId, 'greenhouse-4543797005');
});

test('the Esri Vienna and Minneapolis rows remain separate', () => {
  const decidedFingerprint = appliedIdentityFingerprint({
    title: 'Sr. Partner Manager – System Integrators',
    company: 'esri',
    location: 'Vienna, Virginia, United States',
  });
  const candidateFingerprint = appliedIdentityFingerprint({
    title: 'Sr. Partner Manager – System Integrators',
    company: 'Esri',
    location: 'Minneapolis, Hennepin County',
  });
  assert.notEqual(decidedFingerprint, candidateFingerprint);
  assert.deepEqual(planAppliedDuplicateSuppression(
    [{ id: 'minneapolis', identityFingerprint: candidateFingerprint, status: 'inbox' }],
    [{
      id: 'vienna',
      identityFingerprint: decidedFingerprint,
      status: 'applied',
      title: 'Sr. Partner Manager – System Integrators',
      company: 'esri',
      location: 'Vienna, Virginia, United States',
    }],
  ), []);
});

test('historical activation excludes Passed/Cooldown and fails closed on placeholder locations', () => {
  const preview = planProtectedAppliedIdentityBackfill([
    historical({ id: 'passed', status: 'passed' }),
    historical({ id: 'cooldown', status: 'cooldown' }),
    historical({ id: 'placeholder', location: 'Youngstown, Ohio; 2 Locations' }),
    historical({ id: 'unknown', location: 'Unknown Location' }),
    historical({ id: 'interviewing', status: 'interviewing' }),
    historical({ id: 'explicit', status: 'dismissed', passReason: 'Already applied' }),
  ]);

  assert.deepEqual(preview.plans.map((plan) => plan.id), ['interviewing', 'explicit']);
  assert.deepEqual(preview.skippedUnreliableLocationIds, ['placeholder', 'unknown']);
});

test('identity maintenance covers protected transitions, explicit reason, and identity edits', () => {
  assert.equal(shouldMaintainAppliedIdentity({ status: 'applied', passReason: null, identityInputChanged: false, currentIdentityFingerprint: null }), true);
  assert.equal(shouldMaintainAppliedIdentity({ status: 'interviewing', passReason: null, identityInputChanged: false, currentIdentityFingerprint: null }), true);
  assert.equal(shouldMaintainAppliedIdentity({ status: 'dismissed', passReason: 'Already applied', identityInputChanged: false, currentIdentityFingerprint: null }), true);
  assert.equal(shouldMaintainAppliedIdentity({ status: 'inbox', passReason: null, identityInputChanged: true, currentIdentityFingerprint: 'v4:existing' }), true);
  assert.equal(shouldMaintainAppliedIdentity({ status: 'passed', passReason: 'Not interested', identityInputChanged: true, currentIdentityFingerprint: null }), false);
  assert.equal(shouldMaintainAppliedIdentity({ status: 'cooldown', passReason: null, identityInputChanged: true, currentIdentityFingerprint: null }), false);
  assert.equal(shouldMaintainAppliedIdentity({ status: 'passed', passReason: 'Not interested', identityInputChanged: true, currentIdentityFingerprint: 'v4:existing' }), true);
  assert.equal(shouldMaintainAppliedIdentity({ status: 'cooldown', passReason: null, identityInputChanged: false, currentIdentityFingerprint: 'v4:existing' }), false);
});

test('guarded backfill preserves lifecycle fields and refuses a concurrent change', async () => {
  const [plan] = planProtectedAppliedIdentityBackfill([historical()]).plans;
  const writes: Array<{ where: unknown; data: unknown }> = [];
  let call = 0;
  const store = {
    job: {
      updateMany: async (args: { where: unknown; data: unknown }) => {
        writes.push(args);
        call += 1;
        return { count: call === 1 ? 1 : 0 };
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const result = await applyProtectedAppliedIdentityBackfill([plan, { ...plan, id: 'changed' }], store);
  assert.deepEqual(result, { appliedIds: ['historical-applied'], refusedIds: ['changed'] });
  assert.deepEqual(writes[0].data, { identityFingerprint: plan.identityFingerprint });
  assert.deepEqual(writes[0].where, {
    id: 'historical-applied',
    identityFingerprint: null,
    title: 'Account Manager',
    company: 'Acme',
    location: 'Minneapolis, MN',
    status: 'applied',
    passReason: null,
    updatedAt: UPDATED_AT,
  });
});
