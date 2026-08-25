import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAppliedDuplicateReason,
  effectiveIdentityFingerprint,
  isAppliedDuplicateAuthorityEvidence,
  isAppliedDuplicateReason,
  planAppliedDuplicateSuppression,
  type AppliedDuplicateAuthorityJob,
  type DuplicateCandidate,
} from '../appliedDuplicatePolicy';

function authority(overrides: Partial<AppliedDuplicateAuthorityJob> = {}): AppliedDuplicateAuthorityJob {
  return {
    id: 'decided-1',
    identityFingerprint: 'v4:aaa',
    status: 'applied',
    company: 'Rippling',
    title: 'Customer Success Manager',
    location: 'Remote (United States)',
    ...overrides,
  };
}

function candidate(overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return { id: 'candidate-1', identityFingerprint: 'v4:aaa', status: 'inbox', ...overrides };
}

test('suppresses a live row that repeats an applied job', () => {
  const plans = planAppliedDuplicateSuppression([candidate()], [authority()]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].jobId, 'candidate-1');
  assert.equal(plans[0].duplicateOfJobId, 'decided-1');
  assert.match(plans[0].reason, /Customer Success Manager at Rippling/);
});

test('the reason names the decision, the posting and the place', () => {
  const reason = buildAppliedDuplicateReason(authority({ status: 'interviewing' }));
  assert.equal(
    reason,
    'Duplicate of a job already interviewing: Customer Success Manager at Rippling — Remote (United States)',
  );
  assert.ok(isAppliedDuplicateReason(reason));
  assert.ok(!isAppliedDuplicateReason('Promoted by user: looks strong'));
  assert.ok(!isAppliedDuplicateReason(null));
});

test('Already applied is durable evidence and receives the applied badge', () => {
  const historical = authority({ status: 'dismissed', passReason: 'Already applied' });
  assert.equal(isAppliedDuplicateAuthorityEvidence(historical), true);
  assert.ok(isAppliedDuplicateReason(historical.passReason));
  const plans = planAppliedDuplicateSuppression([candidate()], [historical]);
  assert.equal(plans.length, 1);
  assert.match(plans[0].reason, /already applied:/);
});

test('only the exact explicit Already applied reason is authority', () => {
  for (const passReason of ['already applied', 'Already applied ', 'Already applied elsewhere']) {
    const historical = authority({ status: 'passed', passReason });
    assert.equal(isAppliedDuplicateAuthorityEvidence(historical), false);
    assert.deepEqual(planAppliedDuplicateSuppression([candidate()], [historical]), []);
  }
});

test('an ordinary dismissed job is not duplicate evidence', () => {
  const rejected = authority({ status: 'dismissed', passReason: 'Experience mismatch' });
  assert.equal(isAppliedDuplicateAuthorityEvidence(rejected), false);
  assert.deepEqual(planAppliedDuplicateSuppression([candidate()], [rejected]), []);
});

test('stored Passed and Cooldown fingerprints never authorize suppression', () => {
  for (const status of ['passed', 'cooldown']) {
    const historical = authority({ id: `${status}-authority`, status });
    assert.equal(isAppliedDuplicateAuthorityEvidence(historical), false);
    assert.deepEqual(
      planAppliedDuplicateSuppression([candidate()], [historical]),
      [],
      `${status} must not hide a future listing`,
    );
  }
});

test('Applied, Interviewing, and exact Already applied remain suppression authority', () => {
  const authorities = [
    authority({ id: 'applied-authority', status: 'applied' }),
    authority({ id: 'interviewing-authority', status: 'interviewing' }),
    authority({ id: 'explicit-authority', status: 'dismissed', passReason: 'Already applied' }),
  ];
  for (const evidence of authorities) {
    assert.equal(isAppliedDuplicateAuthorityEvidence(evidence), true);
    assert.equal(planAppliedDuplicateSuppression([candidate()], [evidence]).length, 1);
  }
});

/**
 * The defect this file exists to prevent. Breezy and Rippling post one
 * requisition per city, so a title+company key would hide a Duluth role
 * because the Minneapolis one was applied to. The fingerprint carries the
 * location, so a different city is a different job.
 */
test('a same-role posting in another city is never suppressed', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate({ id: 'duluth', identityFingerprint: 'v4:bbb' })],
    [authority({ id: 'minneapolis', identityFingerprint: 'v4:aaa' })],
  );
  assert.deepEqual(plans, []);
});

test('null fingerprints never match one another', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate({ identityFingerprint: null })],
    [authority({ identityFingerprint: null })],
  );
  assert.deepEqual(plans, []);
});

test('authority, Passed/Cooldown, and invisible candidates are left alone', () => {
  const statuses = ['applied', 'passed', 'cooldown', 'interviewing', 'archived', 'dismissed', 'expired'];
  for (const status of statuses) {
    const plans = planAppliedDuplicateSuppression([candidate({ status })], [authority()]);
    assert.deepEqual(plans, [], `status ${status} should not be suppressed`);
  }
});

test('a job never suppresses itself', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate({ id: 'same', status: 'inbox' })],
    [authority({ id: 'same' })],
  );
  assert.deepEqual(plans, []);
});

test('an undecided status is not a decision', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate()],
    [authority({ status: 'pending_af' })],
  );
  assert.deepEqual(plans, []);
});

test('applied authority ignores a Passed row with the same fingerprint', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate()],
    [
      authority({ id: 'passed-row', status: 'passed' }),
      authority({ id: 'applied-row', status: 'applied' }),
    ],
  );
  assert.equal(plans[0].duplicateOfJobId, 'applied-row');
  assert.match(plans[0].reason, /already applied/);
});

/**
 * Workday stores "2 Locations" for any multi-city requisition — 7,695 rows
 * carry that shape — so the fingerprint's location component identifies
 * nothing and six cities share one key. The first dry run produced exactly
 * this case for a Graco role.
 */
test('a placeholder location can never justify suppression', () => {
  for (const location of ['2 Locations', '51 locations', 'Unknown Location', '', '   ', null]) {
    const plans = planAppliedDuplicateSuppression(
      [candidate()],
      [authority({ location, company: 'graco.wd501', title: 'Senior Account Manager' })],
    );
    assert.deepEqual(plans, [], `location ${JSON.stringify(location)} should not suppress`);
  }
});

test('a real location still suppresses', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate()],
    [authority({ location: 'Minneapolis, MN' })],
  );
  assert.equal(plans.length, 1);
});

/**
 * The backfill composes a recovered primary city with the placeholder rather
 * than replacing it ("Youngstown, Ohio; 2 Locations" — see
 * composeMultiSiteLocation in workdayLocation.ts). The primary makes the
 * fingerprint distinct per city, but the row still names only one of N
 * sites — a second posting could share the same primary and count while
 * being open at a different second site — so it must stay just as unable to
 * justify suppression as the bare placeholder was.
 */
test('a composed multi-site location can never justify suppression', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate()],
    [authority({ location: 'Youngstown, Ohio; 2 Locations', company: 'gfs.wd501', title: 'Outside Sales Representative' })],
  );
  assert.deepEqual(plans, []);
});

test('a pre-migration authority keyed in the legacy column still suppresses its repeat', () => {
  // The Altria "Sales Manager - St. Paul / Rochester, MN" case: the
  // Interviewing row predates the identity migration and carries its v4 hash in
  // `fingerprint`, while Adzuna's re-listing carries the identical hash in
  // `identityFingerprint`. Reading one column found no authority at all.
  const legacyAuthority = authority({
    id: 'interviewing-row',
    identityFingerprint: null,
    fingerprint: 'v4:aaa',
    status: 'interviewing',
  });
  const plans = planAppliedDuplicateSuppression([candidate()], [legacyAuthority]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].duplicateOfJobId, 'interviewing-row');
});

test('a candidate keyed only in the legacy column is reachable too', () => {
  const legacyCandidate = candidate({ identityFingerprint: null, fingerprint: 'v4:aaa' });
  const plans = planAppliedDuplicateSuppression([legacyCandidate], [authority()]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].jobId, 'candidate-1');
});

test('location-less legacy fingerprint schemes are never honored as identity', () => {
  // v3 and the bare md5 hash company+title only. Honoring them would let a
  // Minneapolis application hide the Duluth posting.
  for (const stale of ['v3:aaa', 'd41d8cd98f00b204e9800998ecf8427e', 'v2:aaa']) {
    assert.equal(effectiveIdentityFingerprint({ identityFingerprint: null, fingerprint: stale }), null);
    const plans = planAppliedDuplicateSuppression(
      [candidate({ identityFingerprint: null, fingerprint: stale })],
      [authority({ identityFingerprint: null, fingerprint: stale })],
    );
    assert.deepEqual(plans, [], `${stale} must not identify a posting`);
  }
});

test('the new column wins when a row carries both', () => {
  assert.equal(
    effectiveIdentityFingerprint({ identityFingerprint: 'v4:new', fingerprint: 'v4:old' }),
    'v4:new',
  );
  assert.equal(effectiveIdentityFingerprint({ identityFingerprint: null, fingerprint: null }), null);
});
