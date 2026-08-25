import { AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE } from './scoringLifecyclePolicy';
import { canonicalJsonSha256 } from './scoringCanonicalJson';
import {
  finalUserLifecycleIntentMatchesState,
  latestUserLifecycleIntent,
} from './userLifecycleAuthority';

export const LIFECYCLE_RECONCILIATION_COHORT = [
  { id: '378583df-2e3a-48be-bafb-c86c70aac4cc', label: 'Foundation Medical', action: 'experience_queue' },
  { id: 'a9cc7b34-ac3a-422b-a324-409bc66d7f14', label: 'Nidec', action: 'experience_queue' },
  { id: 'db3acf02-17fe-4950-865f-824da8f3f357', label: 'Keenfinity', action: 'experience_queue' },
  { id: '7a8d56fd-c249-4003-b686-f64f2c8bb251', label: 'Stride', action: 'experience_queue' },
  { id: '2762d0c8-6aa9-450e-bafc-e3cab1341fec', label: 'Teledyne', action: 'aim_queue' },
  { id: '70fb8744-920d-441d-a3a6-f72daa40c700', label: 'Merck', action: 'legacy_local_dismissal' },
  { id: '2829360a-4b4f-430a-8b93-31ee0b1282f4', label: 'Acosta', action: 'legacy_local_dismissal' },
  { id: '93a59499-d6be-4536-8ae1-1aa3ef9ee08e', label: 'Honeywell', action: 'legacy_local_dismissal' },
  { id: '947a34bf-1e12-4e3e-ae73-fccaaf1742d9', label: 'Sezzle', action: 'legacy_local_dismissal' },
  { id: 'a279e407-c2d6-40c4-b0be-856fb7fd1aa9', label: 'Thatch', action: 'legacy_local_dismissal' },
  { id: '6b794c5a-c2f3-4d95-995a-c10fc2c67478', label: 'Vetcove', action: 'legacy_local_dismissal' },
  { id: '8a42743d-bee9-42a4-a02e-a294cdf3cb41', label: 'Dandy', action: 'legacy_local_dismissal' },
  { id: '67fa2f6c-2f0b-4c09-8b75-c08a833fc469', label: 'Legrand Manual Import', action: 'manual_import_tailoring' },
  { id: '9d88c17b-f396-402b-a196-e1836b6c8aec', label: 'Sellsig', action: 'aim_floor_dismissal' },
] as const;

/**
 * A cohort entry is a hand-transcribed production job ID. A typo silently
 * degrades to `missing`, which reads as "already reconciled" rather than "never
 * looked at", so the shape is checked once at load instead.
 */
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const malformedCohortIds = LIFECYCLE_RECONCILIATION_COHORT
  .filter((spec) => !JOB_ID_PATTERN.test(spec.id))
  .map((spec) => `${spec.label} (${spec.id})`);
if (malformedCohortIds.length > 0) {
  throw new Error(`Lifecycle reconciliation cohort has malformed job IDs: ${malformedCohortIds.join(', ')}`);
}

const duplicateCohortIds = LIFECYCLE_RECONCILIATION_COHORT
  .map((spec) => spec.id)
  .filter((id, index, ids) => ids.indexOf(id) !== index);
if (duplicateCohortIds.length > 0) {
  throw new Error(`Lifecycle reconciliation cohort repeats job IDs: ${[...new Set(duplicateCohortIds)].join(', ')}`);
}

export type LifecycleReconciliationSpec = typeof LIFECYCLE_RECONCILIATION_COHORT[number];
export type LifecycleReconciliationAction = LifecycleReconciliationSpec['action'];

export type ReconciliationCurrentFields = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  source: string | null;
  status: string;
  scoringStatus: string;
  scoreAttempts: number;
  scoreError: string | null;
  fitScore: number | null;
  fitCategory: string;
  fitRationale: string | null;
  passReason: string | null;
  tailoringStaged: boolean;
  aimFitScore: number | null;
  reqFitScore: number | null;
  reqFitRationale: string | null;
  batchJobId: string | null;
  jdBatchId: string | null;
  afBatchId: string | null;
  experienceStatus: string;
  updatedAt: string;
};

export type ReconciliationScoreEvent = {
  id: string;
  evaluationType: string;
  passed: boolean;
  aimFitScore: number | null;
  experienceFitScore: number | null;
  decisionCode: string | null;
  lifecycleProjection: string | null;
  staleAt: string | null;
  createdAt: string;
};

export type ReconciliationEvidence = {
  current: ReconciliationCurrentFields;
  inputFingerprint: string;
  userEvents: Array<{ id: string; eventType: string; occurredAt: string; details?: unknown }>;
  rawScoreEventIds: string[];
  leasedBatchItemIds: string[];
  scoreAuthority: {
    mode: string;
    aimState: string;
    experienceState: string;
    currentAim: ReconciliationScoreEvent | null;
    currentExperience: ReconciliationScoreEvent | null;
    currentLegacy: ReconciliationScoreEvent | null;
    staleAim: ReconciliationScoreEvent | null;
    staleExperience: ReconciliationScoreEvent | null;
    staleReason: string | null;
  };
  manualImportTarget?: Record<string, string | number | boolean | null> | null;
};

export type LifecycleReconciliationPlan = {
  id: string;
  label: string;
  requestedAction: LifecycleReconciliationAction;
  disposition: 'ready' | 'noop' | 'blocked' | 'missing';
  authority: {
    kind: 'score_event' | 'legacy_local_machine' | 'manual_import_policy' | 'none';
    eventId: string | null;
    reason: string;
  };
  blockers: string[];
  current: ReconciliationCurrentFields | null;
  target: Record<string, string | number | boolean | null> | null;
  changedFields: string[];
  guardHash: string | null;
  evidence: {
    userEventIds: string[];
    rawScoreEventIds: string[];
    leasedBatchItemIds: string[];
    aimAuthorityState: string;
    experienceAuthorityState: string;
  } | null;
};

const MACHINE_LOCAL_REJECTION_PREFIXES = [
  'Locally triaged out:',
  'Available job information is not in English',
  'Job location is outside',
] as const;

function isMachineLocalRejection(reason: string | null): boolean {
  return Boolean(reason && MACHINE_LOCAL_REJECTION_PREFIXES.some((prefix) => reason.startsWith(prefix)));
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right;
}

function changedFields(
  current: ReconciliationCurrentFields,
  target: Record<string, string | number | boolean | null>,
): string[] {
  return Object.entries(target)
    .filter(([key, value]) => !sameValue(current[key as keyof ReconciliationCurrentFields], value))
    .map(([key]) => key)
    .sort();
}

export function lifecycleReconciliationGuardHash(evidence: ReconciliationEvidence): string {
  return canonicalJsonSha256({
    cohort: 'contradictory-lifecycle-v1',
    current: evidence.current,
    inputFingerprint: evidence.inputFingerprint,
    userEvents: evidence.userEvents,
    rawScoreEventIds: [...evidence.rawScoreEventIds].sort(),
    leasedBatchItemIds: [...evidence.leasedBatchItemIds].sort(),
    scoreAuthority: evidence.scoreAuthority,
    manualImportTarget: evidence.manualImportTarget || null,
  });
}

function basePlan(
  spec: LifecycleReconciliationSpec,
  evidence: ReconciliationEvidence,
): Omit<LifecycleReconciliationPlan, 'disposition' | 'authority' | 'blockers' | 'target' | 'changedFields'> {
  return {
    id: spec.id,
    label: spec.label,
    requestedAction: spec.action,
    current: evidence.current,
    guardHash: lifecycleReconciliationGuardHash(evidence),
    evidence: {
      userEventIds: evidence.userEvents.map((event) => event.id),
      rawScoreEventIds: [...evidence.rawScoreEventIds],
      leasedBatchItemIds: [...evidence.leasedBatchItemIds],
      aimAuthorityState: evidence.scoreAuthority.aimState,
      experienceAuthorityState: evidence.scoreAuthority.experienceState,
    },
  };
}

function blockedPlan(
  spec: LifecycleReconciliationSpec,
  evidence: ReconciliationEvidence,
  blockers: string[],
): LifecycleReconciliationPlan {
  return {
    ...basePlan(spec, evidence),
    disposition: 'blocked',
    authority: { kind: 'none', eventId: null, reason: 'Evidence does not authorize the requested transition.' },
    blockers,
    target: null,
    changedFields: [],
  };
}

function authorizedPlan(
  spec: LifecycleReconciliationSpec,
  evidence: ReconciliationEvidence,
  authority: LifecycleReconciliationPlan['authority'],
  target: Record<string, string | number | boolean | null>,
): LifecycleReconciliationPlan {
  const changes = changedFields(evidence.current, target);
  return {
    ...basePlan(spec, evidence),
    disposition: changes.length === 0 ? 'noop' : 'ready',
    authority,
    blockers: [],
    target,
    changedFields: changes,
  };
}

export function planLifecycleReconciliation(
  spec: LifecycleReconciliationSpec,
  evidence: ReconciliationEvidence | null,
): LifecycleReconciliationPlan {
  if (!evidence) {
    return {
      id: spec.id,
      label: spec.label,
      requestedAction: spec.action,
      disposition: 'missing',
      authority: { kind: 'none', eventId: null, reason: 'The deterministic cohort ID was not found.' },
      blockers: ['job_not_found'],
      current: null,
      target: null,
      changedFields: [],
      guardHash: null,
      evidence: null,
    };
  }

  const blockers: string[] = [];
  if (evidence.current.id !== spec.id) blockers.push('cohort_identity_mismatch');
  const latestUserIntent = latestUserLifecycleIntent(evidence.userEvents);
  if (latestUserIntent.kind === 'final') {
    blockers.push(finalUserLifecycleIntentMatchesState(latestUserIntent, evidence.current)
      ? 'explicit_user_event_veto'
      : 'explicit_user_event_state_mismatch');
  }
  if (evidence.leasedBatchItemIds.length > 0
    || evidence.current.batchJobId
    || evidence.current.jdBatchId
    || evidence.current.afBatchId) {
    blockers.push('active_or_ambiguous_lease');
  }
  if (blockers.length > 0) return blockedPlan(spec, evidence, blockers);

  if (spec.action === 'experience_queue') {
    const aim = evidence.scoreAuthority.currentAim;
    if (!aim) blockers.push('no_current_valid_aim_event');
    if (aim && (!aim.passed || aim.aimFitScore === null
      || aim.aimFitScore < AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE)) {
      blockers.push('aim_event_does_not_authorize_experience_queue');
    }
    if (evidence.scoreAuthority.currentExperience) blockers.push('current_experience_event_controls');
    if (blockers.length > 0) return blockedPlan(spec, evidence, blockers);
    return authorizedPlan(spec, evidence, {
      kind: 'score_event',
      eventId: aim!.id,
      reason: `Current non-stale Aim event passes the ${AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE}-point queue floor.`,
    }, {
      status: 'pending_af',
      scoringStatus: 'scored',
      tailoringStaged: false,
      aimFitScore: aim!.aimFitScore,
      reqFitScore: null,
      reqFitRationale: null,
      experienceStatus: 'queued',
    });
  }

  if (spec.action === 'aim_queue') {
    const hasCurrentScoreAuthority = Boolean(
      evidence.scoreAuthority.currentAim
      || evidence.scoreAuthority.currentExperience
      || evidence.scoreAuthority.currentLegacy,
    );
    const hasAffirmativeStaleAuthority = Boolean(
      evidence.scoreAuthority.staleAim || evidence.scoreAuthority.staleExperience,
    );
    if (hasCurrentScoreAuthority) blockers.push('current_score_event_controls');
    if (!hasAffirmativeStaleAuthority) blockers.push('stale_score_authority_not_proven');
    if (evidence.current.scoringStatus !== 'scored'
      || evidence.current.fitScore === null
      || !evidence.current.fitRationale
      || evidence.current.fitCategory === 'unscored'
      || evidence.current.passReason !== null) {
      blockers.push('legacy_local_pass_not_proven');
    }
    if (blockers.length > 0) return blockedPlan(spec, evidence, blockers);
    return authorizedPlan(spec, evidence, {
      kind: 'legacy_local_machine',
      eventId: null,
      reason: 'No current valid score event exists; stale score authority plus stored local score and rationale prove the machine passed local triage.',
    }, {
      status: 'pending_af',
      scoringStatus: 'scored',
      tailoringStaged: false,
      aimFitScore: null,
      reqFitScore: null,
      reqFitRationale: null,
      experienceStatus: 'queued',
    });
  }

  if (spec.action === 'legacy_local_dismissal') {
    if (evidence.rawScoreEventIds.length > 0) blockers.push('score_event_controls_instead_of_legacy_local_state');
    if (evidence.current.scoringStatus !== 'skipped'
      || !isMachineLocalRejection(evidence.current.passReason)) {
      blockers.push('legacy_local_rejection_not_proven');
    }
    if (blockers.length > 0) return blockedPlan(spec, evidence, blockers);
    return authorizedPlan(spec, evidence, {
      kind: 'legacy_local_machine',
      eventId: null,
      reason: 'No score or user event exists; skipped state plus a recognized stored machine reason proves rejection.',
    }, { status: 'dismissed' });
  }

  if (spec.action === 'manual_import_tailoring') {
    if (evidence.current.source !== 'Manual Import') blockers.push('not_manual_import');
    if (!evidence.manualImportTarget) blockers.push('manual_import_normalization_unresolved');
    if (blockers.length > 0) return blockedPlan(spec, evidence, blockers);
    return authorizedPlan(spec, evidence, {
      kind: 'manual_import_policy',
      eventId: null,
      reason: 'Manual Import is user-selected work; current policy protects Inbox and Tailoring lifecycle.',
    }, evidence.manualImportTarget!);
  }

  const aim = evidence.scoreAuthority.currentAim;
  if (!aim) blockers.push('no_current_valid_aim_event');
  if (aim && (!aim.passed || aim.aimFitScore === null
    || aim.aimFitScore >= AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE)) {
    blockers.push('aim_event_does_not_prove_floor_dismissal');
  }
  if (evidence.scoreAuthority.currentExperience) blockers.push('current_experience_event_controls');
  if (blockers.length > 0) return blockedPlan(spec, evidence, blockers);
  return authorizedPlan(spec, evidence, {
    kind: 'score_event',
    eventId: aim!.id,
    reason: `Current non-stale Aim event is below the ${AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE}-point Experience-queue floor.`,
  }, { status: 'dismissed' });
}
