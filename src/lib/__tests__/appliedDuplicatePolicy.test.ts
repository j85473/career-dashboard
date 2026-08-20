import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAppliedDuplicateReason,
  isAppliedDuplicateEvidence,
  isAppliedDuplicateReason,
  planAppliedDuplicateSuppression,
  type DecidedJob,
  type DuplicateCandidate,
} from '../appliedDuplicatePolicy';

function decided(overrides: Partial<DecidedJob> = {}): DecidedJob {
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
  const plans = planAppliedDuplicateSuppression([candidate()], [decided()]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].jobId, 'candidate-1');
  assert.equal(plans[0].duplicateOfJobId, 'decided-1');
  assert.match(plans[0].reason, /Customer Success Manager at Rippling/);
});

test('the reason names the decision, the posting and the place', () => {
  const reason = buildAppliedDuplicateReason(decided({ status: 'passed' }));
  assert.equal(
    reason,
    'Duplicate of a job already passed: Customer Success Manager at Rippling — Remote (United States)',
  );
  assert.ok(isAppliedDuplicateReason(reason));
  assert.ok(!isAppliedDuplicateReason('Promoted by user: looks strong'));
  assert.ok(!isAppliedDuplicateReason(null));
});

test('Already applied is durable evidence and receives the applied badge', () => {
  const historical = decided({ status: 'dismissed', passReason: 'Already applied' });
  assert.equal(isAppliedDuplicateEvidence(historical), true);
  assert.ok(isAppliedDuplicateReason(historical.passReason));
  const plans = planAppliedDuplicateSuppression([candidate()], [historical]);
  assert.equal(plans.length, 1);
  assert.match(plans[0].reason, /already applied:/);
});

test('an ordinary dismissed job is not duplicate evidence', () => {
  const rejected = decided({ status: 'dismissed', passReason: 'Experience mismatch' });
  assert.equal(isAppliedDuplicateEvidence(rejected), false);
  assert.deepEqual(planAppliedDuplicateSuppression([candidate()], [rejected]), []);
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
    [decided({ id: 'minneapolis', identityFingerprint: 'v4:aaa' })],
  );
  assert.deepEqual(plans, []);
});

test('null fingerprints never match one another', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate({ identityFingerprint: null })],
    [decided({ identityFingerprint: null })],
  );
  assert.deepEqual(plans, []);
});

test('rows that are themselves decided or already invisible are left alone', () => {
  const statuses = ['applied', 'passed', 'cooldown', 'interviewing', 'archived', 'dismissed', 'expired'];
  for (const status of statuses) {
    const plans = planAppliedDuplicateSuppression([candidate({ status })], [decided()]);
    assert.deepEqual(plans, [], `status ${status} should not be suppressed`);
  }
});

test('a job never suppresses itself', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate({ id: 'same', status: 'inbox' })],
    [decided({ id: 'same' })],
  );
  assert.deepEqual(plans, []);
});

test('an undecided status is not a decision', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate()],
    [decided({ status: 'pending_af' })],
  );
  assert.deepEqual(plans, []);
});

test('applied outranks passed when both share a fingerprint', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate()],
    [
      decided({ id: 'passed-row', status: 'passed' }),
      decided({ id: 'applied-row', status: 'applied' }),
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
      [decided({ location, company: 'graco.wd501', title: 'Senior Account Manager' })],
    );
    assert.deepEqual(plans, [], `location ${JSON.stringify(location)} should not suppress`);
  }
});

test('a real location still suppresses', () => {
  const plans = planAppliedDuplicateSuppression(
    [candidate()],
    [decided({ location: 'Minneapolis, MN' })],
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
    [decided({ location: 'Youngstown, Ohio; 2 Locations', company: 'gfs.wd501', title: 'Outside Sales Representative' })],
  );
  assert.deepEqual(plans, []);
});
