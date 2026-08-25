import { canonicalJsonSha256 } from './scoringCanonicalJson';
import { latestUserLifecycleIntent } from './userLifecycleAuthority';

export const EXPERIENCE_RERUN_VERSION = 'excluded-requirement-rerun-v1';
export const EXPERIENCE_RERUN_STALE_REASON = 'excluded-requirement-policy-regression-2026-08-20';

/**
 * The four August 23 results the audit confirmed against excluded requirement
 * categories. Each was imported as a hard mismatch, scored zero, and dismissed
 * on evidence the Experience policy says can never be a hard mismatch.
 *
 * `adjudicate` marks the mixed case: Deepgram's citizenship assertion is
 * invalid, but its separate federal SI/Prime relationship-tenure requirement
 * may still be a genuine absolute bar, so a fresh score is not automatically
 * the right answer there.
 */
export const EXPERIENCE_RERUN_COHORT = [
  {
    id: '2cb48673-3c85-44b0-aa6e-303dfcc33d3e',
    label: 'Deepgram — Federal Partner Manager',
    excludedReason: 'Citizenship',
    disposition: 'adjudicate',
  },
  {
    id: '68eba5fd-73a2-4705-8824-75bf2ccfcfd7',
    label: 'Altria — Sales Manager, St. Paul/Rochester',
    excludedReason: 'Lifting and physical demands',
    disposition: 'rerun',
  },
  {
    id: '325b862a-4e00-4f0f-968a-bd0dc41038af',
    label: 'Cirtec Medical — Account Manager',
    excludedReason: 'Presentation skills and upper-management comfort',
    disposition: 'rerun',
  },
  {
    id: '16525e2e-c000-49f6-8340-9f5dda033676',
    label: 'TRM Labs — Customer Solutions Engineer',
    excludedReason: 'Citizenship',
    disposition: 'rerun',
  },
] as const;

export type ExperienceRerunSpec = typeof EXPERIENCE_RERUN_COHORT[number];

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const malformed = EXPERIENCE_RERUN_COHORT
  .filter((spec) => !JOB_ID_PATTERN.test(spec.id))
  .map((spec) => `${spec.label} (${spec.id})`);
if (malformed.length > 0) {
  throw new Error(`Experience rerun cohort has malformed job IDs: ${malformed.join(', ')}`);
}

export type ExperienceRerunCurrent = {
  id: string;
  status: string;
  scoringStatus: string;
  experienceStatus: string;
  tailoringStaged: boolean;
  source: string | null;
  aimFitScore: number | null;
  reqFitScore: number | null;
  reqFitRationale: string | null;
  batchJobId: string | null;
  jdBatchId: string | null;
  afBatchId: string | null;
  updatedAt: string;
};

export type ExperienceRerunEvidence = {
  current: ExperienceRerunCurrent;
  userEvents: Array<{ id: string; eventType: string; occurredAt: string; details?: unknown }>;
  leasedBatchItemIds: string[];
  currentExperienceEvent: {
    id: string;
    experienceFitScore: number | null;
    lifecycleApplied: boolean;
    createdAt: string;
  } | null;
  currentAimEvent: { id: string; aimFitScore: number | null; passed: boolean } | null;
};

export type ExperienceRerunPlan = {
  id: string;
  label: string;
  excludedReason: string;
  disposition: ExperienceRerunSpec['disposition'];
  outcome: 'ready' | 'noop' | 'blocked' | 'missing';
  blockers: string[];
  current: ExperienceRerunCurrent | null;
  /** The Experience event to mark stale. Never deleted, never rewritten. */
  staleEventId: string | null;
  target: Record<string, string | number | boolean | null> | null;
  guardHash: string | null;
};

export function experienceRerunGuardHash(evidence: ExperienceRerunEvidence): string {
  return canonicalJsonSha256({
    cohort: EXPERIENCE_RERUN_VERSION,
    current: evidence.current,
    userEvents: evidence.userEvents,
    leasedBatchItemIds: [...evidence.leasedBatchItemIds].sort(),
    currentExperienceEvent: evidence.currentExperienceEvent,
    currentAimEvent: evidence.currentAimEvent,
  });
}

/**
 * Returns the job to the Experience queue without inventing a score.
 *
 * Aim results and every stored event are preserved. The bad Experience event is
 * marked stale so it stops being authority, which is what lets the Aim result
 * project `pending_af` again; deleting it would destroy the record of what went
 * wrong on August 23.
 */
export function planExperienceRerun(
  spec: ExperienceRerunSpec,
  evidence: ExperienceRerunEvidence | null,
): ExperienceRerunPlan {
  const base = {
    id: spec.id,
    label: spec.label,
    excludedReason: spec.excludedReason,
    disposition: spec.disposition,
  };
  if (!evidence) {
    return {
      ...base,
      outcome: 'missing',
      blockers: ['job_not_found'],
      current: null,
      staleEventId: null,
      target: null,
      guardHash: null,
    };
  }

  const { current } = evidence;
  const guardHash = experienceRerunGuardHash(evidence);
  const blockers: string[] = [];

  if (current.id !== spec.id) blockers.push('cohort_identity_mismatch');
  if (latestUserLifecycleIntent(evidence.userEvents).kind === 'final') {
    // A user decision outranks this repair. The bad score is still bad, but
    // reversing a decision Joseph made by hand is not this tool's business.
    blockers.push('explicit_user_event_veto');
  }
  if (evidence.leasedBatchItemIds.length > 0
    || current.batchJobId || current.jdBatchId || current.afBatchId) {
    blockers.push('active_or_ambiguous_lease');
  }
  if (current.tailoringStaged) blockers.push('tailoring_staged');
  if (!evidence.currentExperienceEvent) blockers.push('no_current_experience_event');
  else if (evidence.currentExperienceEvent.experienceFitScore !== 0) {
    // Anything other than the imported zero means this is no longer the result
    // the audit reviewed.
    blockers.push('current_experience_event_is_not_the_reviewed_zero');
  }
  if (!evidence.currentAimEvent || evidence.currentAimEvent.passed !== true) {
    blockers.push('no_surviving_aim_authority');
  }
  if (current.aimFitScore === null) blockers.push('aim_score_missing');

  if (current.status === 'pending_af' && current.reqFitScore === null) {
    return {
      ...base, outcome: 'noop', blockers: [], current, staleEventId: null, target: null, guardHash,
    };
  }

  if (blockers.length > 0) {
    return { ...base, outcome: 'blocked', blockers, current, staleEventId: null, target: null, guardHash };
  }

  return {
    ...base,
    outcome: 'ready',
    blockers: [],
    current,
    staleEventId: evidence.currentExperienceEvent!.id,
    target: {
      status: 'pending_af',
      reqFitScore: null,
      reqFitRationale: null,
      experienceStatus: 'queued',
    },
    guardHash,
  };
}
