import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JobLifecycleInvariantError,
  inspectJobLifecycleInvariant,
  type LifecycleInvariantSnapshot,
  type LifecycleScoreAuthority,
} from '../jobLifecycleInvariant';
import { OPERATIONAL_QUEUE_CATEGORIES, type OperationalQueueCategory } from '../operationalQueue';
import type { LatestUserLifecycleIntent } from '../userLifecycleAuthority';

const noAuthority: LifecycleScoreAuthority = {
  kind: 'none', eventId: null, passed: null, score: null,
};
const noUserIntent: LatestUserLifecycleIntent = {
  kind: 'none', eventId: null, expectedStatus: null, expectedTailoringStaged: null,
};

function snapshot(overrides: Partial<LifecycleInvariantSnapshot> = {}): LifecycleInvariantSnapshot {
  return {
    id: 'job-1',
    status: 'pending_af',
    scoringStatus: 'scored',
    source: 'greenhouse',
    tailoringStaged: false,
    aimFitScore: null,
    reqFitScore: null,
    passReason: null,
    userIntent: noUserIntent,
    rawScoreEventCount: 0,
    inOperationalScope: true,
    operationalCategories: ['aim_fit'],
    authority: noAuthority,
    legacyLocalDecision: false,
    legacyLocalReasonRecognized: false,
    ...overrides,
  };
}

test('each of the five exact operational queue categories is accepted alone', () => {
  for (const category of OPERATIONAL_QUEUE_CATEGORIES) {
    assert.deepEqual(inspectJobLifecycleInvariant(snapshot({
      operationalCategories: [category as OperationalQueueCategory],
    })), []);
  }
});

test('zero-category and multi-category active rows fail closed', () => {
  assert.deepEqual(
    inspectJobLifecycleInvariant(snapshot({ operationalCategories: [] })).map((entry) => entry.invariant),
    ['active_job_has_no_operational_queue'],
  );
  assert.deepEqual(
    inspectJobLifecycleInvariant(snapshot({ operationalCategories: ['aim_fit', 'experience_fit'] }))
      .map((entry) => entry.invariant),
    ['active_job_has_multiple_operational_queues'],
  );
});

test('pending_af rejects skipped state and retained Experience score', () => {
  assert.deepEqual(
    inspectJobLifecycleInvariant(snapshot({ scoringStatus: 'skipped' })).map((entry) => entry.invariant),
    ['pending_af_cannot_be_skipped'],
  );
  assert.deepEqual(
    inspectJobLifecycleInvariant(snapshot({ reqFitScore: 72 })).map((entry) => entry.invariant),
    ['pending_af_cannot_retain_experience_score'],
  );
});

test('fresh Aim and Experience events control automated projections while stale events do not', () => {
  const freshAim: LifecycleScoreAuthority = {
    kind: 'aim', eventId: 'aim-1', passed: true, score: 75,
  };
  assert.deepEqual(inspectJobLifecycleInvariant(snapshot({ authority: freshAim })), []);
  const dismissedAim = inspectJobLifecycleInvariant(snapshot({
    status: 'dismissed',
    scoringStatus: 'skipped',
    inOperationalScope: false,
    operationalCategories: [],
    authority: freshAim,
  }));
  assert.equal(dismissedAim[0]?.invariant, 'current_aim_authority_requires_pending_af');
  assert.equal(dismissedAim[0]?.authorityEventId, 'aim-1');
  assert.deepEqual(inspectJobLifecycleInvariant(snapshot({
    status: 'dismissed',
    scoringStatus: 'skipped',
    inOperationalScope: false,
    operationalCategories: [],
    rawScoreEventCount: 1,
    legacyLocalDecision: true,
    authority: { kind: 'aim', eventId: 'aim-reject', passed: false, score: 35 },
  })), [], 'a valid current rejection outranks the legacy fallback shape');

  const freshExperience: LifecycleScoreAuthority = {
    kind: 'experience', eventId: 'experience-1', passed: true, score: 82,
  };
  assert.deepEqual(inspectJobLifecycleInvariant(snapshot({
    status: 'inbox',
    inOperationalScope: false,
    operationalCategories: [],
    authority: freshExperience,
  })), []);
  assert.equal(inspectJobLifecycleInvariant(snapshot({
    authority: { ...freshExperience, passed: false },
  }))[0]?.invariant, 'current_experience_authority_requires_dismissed');

  assert.deepEqual(inspectJobLifecycleInvariant(snapshot({
    authority: { kind: 'stale', eventId: 'stale-1', passed: null, score: null },
  })), []);
});

test('an explicit or derived user lifecycle event protects a scored duplicate dismissal', () => {
  assert.deepEqual(inspectJobLifecycleInvariant(snapshot({
    status: 'dismissed',
    scoringStatus: 'skipped',
    inOperationalScope: false,
    operationalCategories: [],
    userIntent: {
      kind: 'final', eventId: 'derived-duplicate-event',
      expectedStatus: 'dismissed', expectedTailoringStaged: null,
    },
    rawScoreEventCount: 1,
    authority: { kind: 'aim', eventId: 'aim-1', passed: true, score: 75 },
  })), []);
});

test('an older final action does not protect after a later rescore', () => {
  const violations = inspectJobLifecycleInvariant(snapshot({
    status: 'dismissed',
    scoringStatus: 'skipped',
    inOperationalScope: false,
    operationalCategories: [],
    rawScoreEventCount: 1,
    authority: { kind: 'aim', eventId: 'aim-1', passed: true, score: 75 },
    userIntent: {
      kind: 'rescore', eventId: 'rescore-1', expectedStatus: null, expectedTailoringStaged: null,
    },
  }));
  assert.equal(violations[0]?.invariant, 'current_aim_authority_requires_pending_af');
});

test('a latest final user event must match current status and tailoring state', () => {
  const violations = inspectJobLifecycleInvariant(snapshot({
    status: 'inbox',
    inOperationalScope: false,
    operationalCategories: [],
    userIntent: {
      kind: 'final', eventId: 'reject-1', expectedStatus: 'dismissed', expectedTailoringStaged: false,
    },
  }));
  assert.equal(violations[0]?.invariant, 'latest_user_lifecycle_intent_does_not_match_state');
  assert.equal(violations[0]?.authorityEventId, 'reject-1');
});

test('an automated lifecycle exit after a user decision is not a contradiction', () => {
  // The fifteen-day Inbox review window expires jobs the user promoted, and
  // writes no user event. That drift is the policy working, not corruption.
  for (const status of ['expired', 'cooldown', 'archived']) {
    const violations = inspectJobLifecycleInvariant(snapshot({
      status,
      inOperationalScope: false,
      operationalCategories: [],
      userIntent: {
        kind: 'final', eventId: 'promote-1', expectedStatus: 'inbox', expectedTailoringStaged: false,
      },
    }));
    assert.deepEqual(violations, [], `${status} should be a superseding exit`);
  }
});

test('a legacy user event with no recorded target state is protection, not a violation', () => {
  const violations = inspectJobLifecycleInvariant(snapshot({
    status: 'bookmarked',
    inOperationalScope: false,
    operationalCategories: [],
    userIntent: {
      kind: 'final', eventId: 'legacy-1', expectedStatus: null, expectedTailoringStaged: null,
    },
  }));
  assert.deepEqual(violations, []);
});

test('legacy local fallback requires no score event and a recognized stored machine reason', () => {
  const legacy = snapshot({
    status: 'dismissed',
    scoringStatus: 'skipped',
    inOperationalScope: false,
    operationalCategories: [],
    legacyLocalDecision: true,
    legacyLocalReasonRecognized: true,
  });
  assert.deepEqual(inspectJobLifecycleInvariant(legacy), []);
  assert.equal(inspectJobLifecycleInvariant({
    ...legacy,
    rawScoreEventCount: 1,
  })[0]?.invariant, 'legacy_local_fallback_requires_no_score_event');
  assert.equal(inspectJobLifecycleInvariant({
    ...legacy,
    legacyLocalReasonRecognized: false,
  })[0]?.invariant, 'legacy_local_fallback_requires_recognized_machine_reason');
});

test('Manual Import, Tailoring, and protected non-scoring lifecycle states remain intact', () => {
  const contradictoryAuthority: LifecycleScoreAuthority = {
    kind: 'experience', eventId: 'experience-1', passed: false, score: 41,
  };
  for (const override of [
    { source: 'Manual Import', status: 'inbox' },
    { tailoringStaged: true, status: 'inbox' },
    { status: 'applied' },
    { status: 'interviewing' },
    { status: 'cooldown' },
    { status: 'archived' },
    { status: 'expired' },
  ]) {
    assert.deepEqual(inspectJobLifecycleInvariant(snapshot({
      ...override,
      inOperationalScope: false,
      operationalCategories: [],
      authority: contradictoryAuthority,
    })), []);
  }
});

test('bounded diagnostics expose no job-description text', () => {
  const violations = Array.from({ length: 25 }, (_, index) => ({
    jobId: `job-${index}`,
    invariant: 'test_invariant',
    authorityEventId: null,
    proposedState: {
      status: 'pending_af', scoringStatus: 'skipped', tailoringStaged: false,
      aimFitScore: null, reqFitScore: null,
    },
  }));
  const error = new JobLifecycleInvariantError(violations);
  assert.equal(error.violations.length, 20);
  assert.doesNotMatch(error.message, /description|responsibilit/i);
});
