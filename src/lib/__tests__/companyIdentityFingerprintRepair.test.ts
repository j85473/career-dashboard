import assert from 'node:assert/strict';
import test from 'node:test';

import { planIdentityFingerprintRepairs, preCleanupV4Fingerprint } from '../companyIdentityFingerprintRepair';
import { generateV4Fingerprint } from '../jobIngestion';

const coded = { title: 'Robotics Business Development Manager', company: 'USA-NILIN Nilfisk, Inc.', location: 'Plymouth, MN' };

test('a coded row stored under the pre-cleanup key is re-hashed to match the plain brand', () => {
  const stale = preCleanupV4Fingerprint(coded.title, coded.company, coded.location);
  const [repair] = planIdentityFingerprintRepairs([{ id: 'a', ...coded, identityFingerprint: stale }]);
  assert.equal(repair.from, stale);
  assert.equal(repair.to, generateV4Fingerprint(coded.title, 'Nilfisk', coded.location));
});

test('rows without identity, already current, or hashed from other labels are left alone', () => {
  assert.deepEqual(planIdentityFingerprintRepairs([
    { id: 'none', ...coded, identityFingerprint: null },
    { id: 'current', ...coded, identityFingerprint: generateV4Fingerprint(coded.title, coded.company, coded.location) },
    { id: 'other', ...coded, identityFingerprint: preCleanupV4Fingerprint('Different Title', coded.company, coded.location) },
    { id: 'plain', ...coded, company: 'Nilfisk', identityFingerprint: preCleanupV4Fingerprint(coded.title, 'Nilfisk', coded.location) },
  ]), []);
});
