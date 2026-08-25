import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  LIFECYCLE_RECONCILIATION_COHORT,
  planLifecycleReconciliation,
  type LifecycleReconciliationSpec,
  type ReconciliationEvidence,
  type ReconciliationScoreEvent,
} from '../lifecycleContradictionReconciliation';

const ROOT = process.cwd();

function spec(action: LifecycleReconciliationSpec['action']): LifecycleReconciliationSpec {
  const found = LIFECYCLE_RECONCILIATION_COHORT.find((item) => item.action === action);
  assert.ok(found);
  return found;
}

function scoreEvent(overrides: Partial<ReconciliationScoreEvent> = {}): ReconciliationScoreEvent {
  return {
    id: 'score-event-current',
    evaluationType: 'aim_fit',
    passed: true,
    aimFitScore: 75,
    experienceFitScore: null,
    decisionCode: 'pass',
    lifecycleProjection: null,
    staleAt: null,
    createdAt: '2026-08-23T12:00:00.000Z',
    ...overrides,
  };
}

function evidenceFor(
  selected: LifecycleReconciliationSpec,
  overrides: Partial<ReconciliationEvidence> = {},
): ReconciliationEvidence {
  const base: ReconciliationEvidence = {
    current: {
      id: selected.id,
      title: selected.label,
      company: 'Test Company',
      location: 'Remote',
      source: 'Test Source',
      status: 'inbox',
      scoringStatus: 'scored',
      scoreAttempts: 0,
      scoreError: null,
      fitScore: 72,
      fitCategory: 'good',
      fitRationale: 'Stored local machine assessment.',
      passReason: null,
      tailoringStaged: false,
      aimFitScore: null,
      reqFitScore: null,
      reqFitRationale: null,
      batchJobId: null,
      jdBatchId: null,
      afBatchId: null,
      experienceStatus: 'queued',
      updatedAt: '2026-08-23T12:05:00.000Z',
    },
    inputFingerprint: 'input-fingerprint',
    userEvents: [],
    rawScoreEventIds: [],
    leasedBatchItemIds: [],
    scoreAuthority: {
      mode: 'unscored',
      aimState: 'unscored',
      experienceState: 'unscored',
      currentAim: null,
      currentExperience: null,
      currentLegacy: null,
      staleAim: null,
      staleExperience: null,
      staleReason: null,
    },
    manualImportTarget: null,
  };
  return {
    ...base,
    ...overrides,
    current: { ...base.current, ...overrides.current },
    scoreAuthority: { ...base.scoreAuthority, ...overrides.scoreAuthority },
  };
}

test('a current non-stale Aim event controls over contradictory stored local fields', () => {
  const selected = spec('experience_queue');
  const aim = scoreEvent();
  const evidence = evidenceFor(selected, {
    current: {
      passReason: 'Locally triaged out: legacy stored contradiction.',
      scoringStatus: 'skipped',
    } as ReconciliationEvidence['current'],
    rawScoreEventIds: [aim.id],
    scoreAuthority: {
      mode: 'staged',
      aimState: 'current',
      currentAim: aim,
    } as ReconciliationEvidence['scoreAuthority'],
  });

  const plan = planLifecycleReconciliation(selected, evidence);

  assert.equal(plan.disposition, 'ready');
  assert.deepEqual(plan.authority, {
    kind: 'score_event',
    eventId: aim.id,
    reason: 'Current non-stale Aim event passes the 60-point queue floor.',
  });
  assert.deepEqual(plan.target, {
    status: 'pending_af',
    scoringStatus: 'scored',
    tailoringStaged: false,
    aimFitScore: 75,
    reqFitScore: null,
    reqFitRationale: null,
    experienceStatus: 'queued',
  });
});

test('an explicit user lifecycle event vetoes an otherwise authoritative score transition', () => {
  const selected = spec('experience_queue');
  const aim = scoreEvent();
  const plan = planLifecycleReconciliation(selected, evidenceFor(selected, {
    rawScoreEventIds: [aim.id],
    userEvents: [{
      id: 'user-event-1',
      eventType: 'user_reject',
      occurredAt: '2026-08-23T12:06:00.000Z',
      details: { nextStatus: 'inbox' },
    }],
    scoreAuthority: {
      mode: 'staged',
      aimState: 'current',
      currentAim: aim,
    } as ReconciliationEvidence['scoreAuthority'],
  }));

  assert.equal(plan.disposition, 'blocked');
  assert.deepEqual(plan.blockers, ['explicit_user_event_veto']);
  assert.equal(plan.target, null);
});

test('a later rescore supersedes an older lifecycle veto in reconciliation planning', () => {
  const selected = spec('experience_queue');
  const aim = scoreEvent();
  const plan = planLifecycleReconciliation(selected, evidenceFor(selected, {
    rawScoreEventIds: [aim.id],
    userEvents: [
      {
        id: 'reject', eventType: 'user_reject', occurredAt: '2026-08-23T12:04:00.000Z',
        details: { nextStatus: 'dismissed' },
      },
      { id: 'rescore', eventType: 'user_rescore', occurredAt: '2026-08-23T12:06:00.000Z' },
    ],
    scoreAuthority: {
      mode: 'staged', aimState: 'current', currentAim: aim,
    } as ReconciliationEvidence['scoreAuthority'],
  }));
  assert.equal(plan.disposition, 'ready');
  assert.equal(plan.authority.eventId, aim.id);
});

test('a later lifecycle action vetoes an older rescore', () => {
  const selected = spec('experience_queue');
  const aim = scoreEvent();
  const plan = planLifecycleReconciliation(selected, evidenceFor(selected, {
    current: { status: 'dismissed' } as ReconciliationEvidence['current'],
    rawScoreEventIds: [aim.id],
    userEvents: [
      { id: 'rescore', eventType: 'user_rescore', occurredAt: '2026-08-23T12:04:00.000Z' },
      {
        id: 'reject', eventType: 'user_reject', occurredAt: '2026-08-23T12:06:00.000Z',
        details: { nextStatus: 'dismissed' },
      },
    ],
    scoreAuthority: {
      mode: 'staged', aimState: 'current', currentAim: aim,
    } as ReconciliationEvidence['scoreAuthority'],
  }));
  assert.equal(plan.disposition, 'blocked');
  assert.deepEqual(plan.blockers, ['explicit_user_event_veto']);
});

test('a stale newest Aim family state cannot authorize a queue repair', () => {
  const selected = spec('experience_queue');
  const plan = planLifecycleReconciliation(selected, evidenceFor(selected, {
    rawScoreEventIds: ['stale-aim-event'],
    scoreAuthority: {
      mode: 'staged',
      aimState: 'stale_replay_needed',
      currentAim: null,
      staleReason: 'newest Aim event is stale',
    } as ReconciliationEvidence['scoreAuthority'],
  }));

  assert.equal(plan.disposition, 'blocked');
  assert.deepEqual(plan.blockers, ['no_current_valid_aim_event']);
  assert.equal(plan.target, null);
});

test('stale staged events do not veto a locally passed Aim requeue', () => {
  const selected = spec('aim_queue');
  const staleAim = scoreEvent({
    id: 'stale-aim',
    staleAt: '2026-08-23T12:10:00.000Z',
  });
  const plan = planLifecycleReconciliation(selected, evidenceFor(selected, {
    rawScoreEventIds: [staleAim.id],
    scoreAuthority: {
      mode: 'staged',
      aimState: 'stale_replay_needed',
      currentAim: null,
      staleAim,
      staleReason: 'job-input-edited:description',
    } as ReconciliationEvidence['scoreAuthority'],
  }));

  assert.equal(plan.disposition, 'ready');
  assert.equal(plan.authority.kind, 'legacy_local_machine');
  assert.deepEqual(plan.target, {
    status: 'pending_af',
    scoringStatus: 'scored',
    tailoringStaged: false,
    aimFitScore: null,
    reqFitScore: null,
    reqFitRationale: null,
    experienceStatus: 'queued',
  });
});

test('an unscored row without affirmative stale authority cannot use Aim requeue fallback', () => {
  const selected = spec('aim_queue');
  const plan = planLifecycleReconciliation(selected, evidenceFor(selected));

  assert.equal(plan.disposition, 'blocked');
  assert.deepEqual(plan.blockers, ['stale_score_authority_not_proven']);
  assert.equal(plan.target, null);
});

test('current score authority wins even when stale event evidence also exists', () => {
  const selected = spec('aim_queue');
  const currentAim = scoreEvent({ id: 'current-aim' });
  const staleExperience = scoreEvent({
    id: 'stale-experience',
    evaluationType: 'experience_fit',
    aimFitScore: null,
    experienceFitScore: 55,
    staleAt: '2026-08-23T12:10:00.000Z',
  });
  const plan = planLifecycleReconciliation(selected, evidenceFor(selected, {
    rawScoreEventIds: [currentAim.id, staleExperience.id],
    scoreAuthority: {
      mode: 'staged',
      aimState: 'current',
      experienceState: 'stale_replay_needed',
      currentAim,
      staleExperience,
    } as ReconciliationEvidence['scoreAuthority'],
  }));

  assert.equal(plan.disposition, 'blocked');
  assert.deepEqual(plan.blockers, ['current_score_event_controls']);
});

test('Aim-floor dismissal requires a current non-stale Aim event below the floor', () => {
  const selected = spec('aim_floor_dismissal');
  const aim = scoreEvent({ id: 'current-low-aim', aimFitScore: 59 });
  const ready = planLifecycleReconciliation(selected, evidenceFor(selected, {
    rawScoreEventIds: [aim.id],
    scoreAuthority: {
      mode: 'staged',
      aimState: 'current',
      currentAim: aim,
    } as ReconciliationEvidence['scoreAuthority'],
  }));
  assert.equal(ready.disposition, 'ready');
  assert.deepEqual(ready.target, { status: 'dismissed' });
  assert.equal(ready.authority.eventId, aim.id);

  const staleAim = { ...aim, staleAt: '2026-08-23T12:10:00.000Z' };
  const blocked = planLifecycleReconciliation(selected, evidenceFor(selected, {
    rawScoreEventIds: [aim.id],
    scoreAuthority: {
      mode: 'staged',
      aimState: 'stale_replay_needed',
      currentAim: null,
      staleAim,
    } as ReconciliationEvidence['scoreAuthority'],
  }));
  assert.equal(blocked.disposition, 'blocked');
  assert.deepEqual(blocked.blockers, ['no_current_valid_aim_event']);
});

test('Manual Import restoration requires normalization and queues protected Tailoring work', () => {
  const selected = spec('manual_import_tailoring');
  const manualTarget = {
    title: 'Regional Sales Manager',
    company: 'Legrand',
    location: 'Remote / Minneapolis',
    status: 'inbox',
    tailoringStaged: true,
    scoringStatus: 'queued',
    fitScore: null,
    fitCategory: 'unscored',
    fitRationale: null,
    passReason: null,
  };
  const base = evidenceFor(selected, {
    current: { source: 'Manual Import' } as ReconciliationEvidence['current'],
  });
  const blocked = planLifecycleReconciliation(selected, base);
  assert.equal(blocked.disposition, 'blocked');
  assert.deepEqual(blocked.blockers, ['manual_import_normalization_unresolved']);

  const ready = planLifecycleReconciliation(selected, { ...base, manualImportTarget: manualTarget });
  assert.equal(ready.disposition, 'ready');
  assert.equal(ready.target?.status, 'inbox');
  assert.equal(ready.target?.tailoringStaged, true);
  assert.equal(ready.target?.scoringStatus, 'queued');
  assert.notEqual(ready.target?.scoringStatus, 'scored');
});

test('legacy local dismissal requires no score event and a recognized machine reason', () => {
  const selected = spec('legacy_local_dismissal');
  const legacy = evidenceFor(selected, {
    current: {
      scoringStatus: 'skipped',
      passReason: 'Locally triaged out: score below the local threshold.',
    } as ReconciliationEvidence['current'],
  });

  const ready = planLifecycleReconciliation(selected, legacy);
  assert.equal(ready.disposition, 'ready');
  assert.equal(ready.authority.kind, 'legacy_local_machine');
  assert.deepEqual(ready.target, { status: 'dismissed' });

  const eventControlled = planLifecycleReconciliation(selected, {
    ...legacy,
    rawScoreEventIds: ['newer-score-event'],
  });
  assert.equal(eventControlled.disposition, 'blocked');
  assert.deepEqual(eventControlled.blockers, ['score_event_controls_instead_of_legacy_local_state']);
});

test('leased or changed work fails closed before any target is produced', () => {
  const selected = spec('aim_queue');
  const plan = planLifecycleReconciliation(selected, evidenceFor(selected, {
    leasedBatchItemIds: ['leased-item'],
  }));

  assert.equal(plan.disposition, 'blocked');
  assert.deepEqual(plan.blockers, ['active_or_ambiguous_lease']);
  assert.equal(plan.target, null);
});

test('standalone runner is deterministic, dry-run by default, and never blanket-updates the cohort', () => {
  const source = readFileSync(path.join(ROOT, 'scripts/reconcile_lifecycle_contradictions.ts'), 'utf8');

  assert.equal(LIFECYCLE_RECONCILIATION_COHORT.length, 14);
  assert.equal(new Set(LIFECYCLE_RECONCILIATION_COHORT.map((item) => item.id)).size, 14);
  assert.match(source, /if \(!apply\) return;/);
  assert.match(source, /--apply --selection-hash <reviewed-dry-run-hash>/);
  assert.match(source, /preview\.selectionHash !== approvedSelectionHash/);
  assert.match(source, /SELECT id FROM "Job" WHERE id = \$\{initial\.id\} FOR UPDATE/);
  assert.match(source, /where: exactCurrentWhere\(initial\.current!\)/);
  assert.match(source, /updated\.count !== 1/);
  assert.match(source, /lifecycleReconciliationGuardHash\(freshEvidence\) !== initial\.guardHash/);
  assert.match(source, /operationalQueueWhere\('experience_fit', \[\]\)/);
  assert.match(source, /eventType = 'lifecycle_reconciled'/);
  assert.match(source, /USER_LIFECYCLE_INTENT_EVENT_TYPES/);
  assert.match(source, /select: \{ id: true, eventType: true, occurredAt: true, details: true \}/);
  assert.doesNotMatch(source, /eventType = 'prefilter_rejected'/);
  assert.match(source, /scoringStatus: 'queued',[\s\S]*?fitCategory: 'unscored'/);
  assert.doesNotMatch(source, /manualImportInformationalScoringUpdate/);
  assert.doesNotMatch(source, /job\.updateMany\(\{[\s\S]*?id:\s*\{\s*in:/);
});
