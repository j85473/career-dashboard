import assert from 'node:assert/strict';
import test from 'node:test';

import { TEAMTAILOR_LOCATION_UNAVAILABLE_REASON } from '../teamtailorLocation';
import {
  planTeamtailorLocationRepair,
  planTeamtailorUnavailableLocationHold,
} from '../teamtailorLocationRepair';

const snapshot = {
  title: 'Area Sales Manager - Nord',
  location: 'Unknown Location',
  url: 'https://getfrankly.teamtailor.com/jobs/5598089-area-sales-manager-nord',
  description: 'Lead regional sales and build partner relationships across Northern Romania.',
  status: 'inbox',
  scoringStatus: 'scored',
  passReason: null,
};

test('a recovered foreign Teamtailor location archives the job without a score mutation plan', () => {
  const plan = planTeamtailorLocationRepair(snapshot, 'Cluj-Napoca, RO');
  assert.equal(plan.action, 'archive_out_of_scope');
  assert.equal(plan.status, 'archived');
  assert.equal(plan.scoringStatus, 'skipped');
  assert.match(plan.passReason || '', /outside the searched geographies/i);
  assert.equal(Object.hasOwn(plan, 'aimFitScore'), false);
  assert.equal(Object.hasOwn(plan, 'reqFitScore'), false);
  assert.equal(Object.hasOwn(plan, 'staleAt'), false);
});

test('an in-scope recovery updates metadata without changing active lifecycle state', () => {
  const plan = planTeamtailorLocationRepair(snapshot, 'Minneapolis, MN');
  assert.deepEqual(
    { action: plan.action, status: plan.status, scoringStatus: plan.scoringStatus, passReason: plan.passReason },
    { action: 'metadata_only', status: 'inbox', scoringStatus: 'scored', passReason: null },
  );
});

test('a future fail-closed row is restored only after an in-scope location is recovered', () => {
  const plan = planTeamtailorLocationRepair({
    ...snapshot,
    status: 'archived',
    scoringStatus: 'skipped',
    passReason: TEAMTAILOR_LOCATION_UNAVAILABLE_REASON,
  }, 'Remote, United States');
  assert.equal(plan.action, 'restore_after_recovery');
  assert.equal(plan.status, 'pending_af');
  assert.equal(plan.scoringStatus, 'needs_jd');
  assert.equal(plan.passReason, null);
});

test('a legacy active row is held outside scoring when detail location remains unavailable', () => {
  const plan = planTeamtailorUnavailableLocationHold(snapshot);
  assert.equal(plan.action, 'hold_for_recovery');
  assert.equal(plan.location, 'Unknown Location');
  assert.equal(plan.status, 'archived');
  assert.equal(plan.scoringStatus, 'skipped');
  assert.equal(plan.passReason, TEAMTAILOR_LOCATION_UNAVAILABLE_REASON);
  assert.equal(Object.hasOwn(plan, 'aimFitScore'), false);
  assert.equal(Object.hasOwn(plan, 'reqFitScore'), false);
});
