import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  EXPERIENCE_RERUN_COHORT,
  experienceRerunGuardHash,
  planExperienceRerun,
  type ExperienceRerunEvidence,
} from '../experienceRerunCohort';

const SPEC = EXPERIENCE_RERUN_COHORT[1];

function evidence(overrides: Partial<ExperienceRerunEvidence> = {}): ExperienceRerunEvidence {
  return {
    current: {
      id: SPEC.id,
      status: 'dismissed',
      scoringStatus: 'scored',
      experienceStatus: 'queued',
      tailoringStaged: false,
      source: 'Adzuna',
      aimFitScore: 78,
      reqFitScore: 0,
      reqFitRationale: 'hard requirement mismatch',
      batchJobId: null,
      jdBatchId: null,
      afBatchId: null,
      updatedAt: '2026-08-23T18:00:00.000Z',
    },
    userEvents: [],
    leasedBatchItemIds: [],
    currentExperienceEvent: {
      id: 'experience-1', experienceFitScore: 0, lifecycleApplied: true,
      createdAt: '2026-08-23T17:00:00.000Z',
    },
    currentAimEvent: { id: 'aim-1', aimFitScore: 78, passed: true },
    ...overrides,
  };
}

test('every cohort entry names a well-formed job and an excluded reason', () => {
  assert.equal(EXPERIENCE_RERUN_COHORT.length, 4);
  for (const spec of EXPERIENCE_RERUN_COHORT) {
    assert.match(spec.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(spec.excludedReason.length > 0);
  }
  const adjudicate = EXPERIENCE_RERUN_COHORT.filter((spec) => spec.disposition === 'adjudicate');
  assert.equal(adjudicate.length, 1, 'only the mixed Deepgram case needs adjudication');
  assert.match(adjudicate[0].label, /Deepgram/);
});

test('a confirmed excluded-requirement dismissal is returned to the Experience queue', () => {
  const plan = planExperienceRerun(SPEC, evidence());
  assert.equal(plan.outcome, 'ready');
  assert.equal(plan.staleEventId, 'experience-1');
  assert.deepEqual(plan.target, {
    status: 'pending_af',
    reqFitScore: null,
    reqFitRationale: null,
    experienceStatus: 'queued',
  });
  // The Aim result is evidence the audit did not dispute; it must survive.
  assert.equal(Object.keys(plan.target || {}).includes('aimFitScore'), false);
});

test('a job already back in the queue is a noop, not a second requeue', () => {
  const plan = planExperienceRerun(SPEC, evidence({
    current: { ...evidence().current, status: 'pending_af', reqFitScore: null },
  }));
  assert.equal(plan.outcome, 'noop');
  assert.equal(plan.target, null);
});

test('an explicit user decision vetoes the repair', () => {
  const plan = planExperienceRerun(SPEC, evidence({
    userEvents: [{
      id: 'reject-1', eventType: 'user_reject', occurredAt: '2026-08-24T09:00:00.000Z',
      details: { nextStatus: 'dismissed' },
    }],
  }));
  assert.equal(plan.outcome, 'blocked');
  assert.ok(plan.blockers.includes('explicit_user_event_veto'));
  assert.equal(plan.target, null);
});

test('a lease or a batch marker blocks the repair', () => {
  assert.ok(planExperienceRerun(SPEC, evidence({ leasedBatchItemIds: ['item-1'] }))
    .blockers.includes('active_or_ambiguous_lease'));
  assert.ok(planExperienceRerun(SPEC, evidence({
    current: { ...evidence().current, afBatchId: 'af-1' },
  })).blockers.includes('active_or_ambiguous_lease'));
});

test('a score that is no longer the reviewed zero is not touched', () => {
  const plan = planExperienceRerun(SPEC, evidence({
    currentExperienceEvent: {
      id: 'experience-2', experienceFitScore: 72, lifecycleApplied: true,
      createdAt: '2026-08-24T17:00:00.000Z',
    },
  }));
  assert.equal(plan.outcome, 'blocked');
  assert.ok(plan.blockers.includes('current_experience_event_is_not_the_reviewed_zero'));
});

test('without surviving Aim authority the job has nothing to return to', () => {
  const plan = planExperienceRerun(SPEC, evidence({ currentAimEvent: null }));
  assert.equal(plan.outcome, 'blocked');
  assert.ok(plan.blockers.includes('no_surviving_aim_authority'));
});

test('a missing job is reported rather than silently skipped', () => {
  const plan = planExperienceRerun(SPEC, null);
  assert.equal(plan.outcome, 'missing');
  assert.deepEqual(plan.blockers, ['job_not_found']);
});

test('the guard hash covers state, events, and leases', () => {
  const baseline = experienceRerunGuardHash(evidence());
  assert.notEqual(baseline, experienceRerunGuardHash(evidence({
    current: { ...evidence().current, updatedAt: '2026-08-24T18:00:00.000Z' },
  })));
  assert.notEqual(baseline, experienceRerunGuardHash(evidence({ leasedBatchItemIds: ['item-1'] })));
  assert.equal(baseline, experienceRerunGuardHash(evidence()));
});

test('the apply path preserves the bad event instead of deleting it', () => {
  const script = readFileSync(
    path.join(process.cwd(), 'scripts/requeue_experience_reruns.ts'),
    'utf8',
  );
  assert.match(script, /jobScoreEvent\.updateMany/);
  assert.doesNotMatch(script, /jobScoreEvent\.delete/);
  assert.match(script, /assertJobLifecycleInvariants\(tx, \[initial\.id\]\)/);
});
