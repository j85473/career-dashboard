import type { Job } from '@prisma/client';

import { prisma } from './prisma';
import { safeExternalFetch } from './safeExternalFetch';
import { latestJobScoreEvents, type LatestJobScoreBundle } from './jobScoreAuthorityQuery';
import { resolveStagedScoreAuthority } from './scoreAuthority';
import { nonManualImportSourceWhere } from './manualImportPolicy';
import { reconcileCompanyCooldowns, resolveInboxAdmission } from './companyCooldown';
import { appliedRepeatDismissalData, findAppliedRepeatForJob, recordAppliedRepeatDismissal } from './appliedDuplicateStore';
import { assertJobLifecycleInvariants, JobLifecycleInvariantError } from './jobLifecycleInvariant';
import { AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE } from './scoringLifecyclePolicy';
import { evaluateAuthoritativeMetadata, hasAuthoritativeMetadata } from './authoritativeMetadataGate';
import { USER_LIFECYCLE_INTENT_EVENT_TYPES } from './userLifecycleAuthority';

export type CooldownReleasePlan = {
  status: 'pending_af' | 'inbox' | 'dismissed' | 'expired';
  queueLocalScoring: boolean;
};

type ScoredCooldownReleasePlan = CooldownReleasePlan & {
  status: 'pending_af' | 'inbox' | 'dismissed';
};

// URL checks can take up to ten seconds each. Keep one pipeline turn bounded
// while allowing a contradictory row to stay put without blocking later jobs.
export const MAX_COOLDOWN_RELEASES_PER_PASS = 50;
const LEGACY_LOCAL_CAP = /\b(?:score capped|capped the score) below triage\b/i;

export class CooldownReleaseHoldError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CooldownReleaseHoldError';
  }
}

export async function processCooldownCandidates<T>(
  candidates: readonly T[],
  release: (candidate: T) => Promise<boolean>,
  onHeld: (candidate: T, error: JobLifecycleInvariantError | CooldownReleaseHoldError) => void,
  limit = MAX_COOLDOWN_RELEASES_PER_PASS,
): Promise<{ released: number; held: number }> {
  let released = 0;
  let held = 0;
  for (const candidate of candidates) {
    if (released >= limit) break;
    try {
      if (await release(candidate)) released++;
    } catch (error) {
      if (!(error instanceof JobLifecycleInvariantError || error instanceof CooldownReleaseHoldError)) throw error;
      held++;
      onHeld(candidate, error);
    }
  }
  return { released, held };
}

/** Score-event projection; the cooldown worker also checks persisted local state. */
export function cooldownReleasePlan(bundle: LatestJobScoreBundle | null): ScoredCooldownReleasePlan {
  if (!bundle) return { status: 'pending_af', queueLocalScoring: true };
  const authority = resolveStagedScoreAuthority(bundle);
  if (authority.mode === 'unscored') return { status: 'pending_af', queueLocalScoring: true };
  if (authority.mode === 'legacy') {
    return {
      status: authority.currentLegacy?.passed ? 'inbox' : 'dismissed',
      queueLocalScoring: false,
    };
  }
  if (!authority.currentAim) return { status: 'pending_af', queueLocalScoring: false };
  if (!authority.currentAim.passed) return { status: 'dismissed', queueLocalScoring: false };
  if (!authority.currentExperience) return { status: 'pending_af', queueLocalScoring: false };
  return {
    status: authority.currentExperience.passed ? 'inbox' : 'dismissed',
    queueLocalScoring: false,
  };
}

/** Preserve a job's existing local stage; unresolved old score authority stays held. */
export function cooldownReleasePlanForJob(
  job: Pick<Job, 'scoringStatus' | 'fitScore' | 'aimFitScore' | 'reqFitScore'>,
  bundle: LatestJobScoreBundle | null,
): ScoredCooldownReleasePlan | null {
  if (!bundle) {
    if (job.aimFitScore !== null || job.reqFitScore !== null) return null;
    if (job.scoringStatus === 'scored' && job.fitScore !== null) {
      return { status: 'pending_af', queueLocalScoring: false };
    }
    if (job.scoringStatus === 'needs_jd') {
      return { status: 'pending_af', queueLocalScoring: false };
    }
    if (job.scoringStatus === 'queued' || job.scoringStatus === 'scoring') {
      return { status: 'pending_af', queueLocalScoring: true };
    }
    return null;
  }
  const authority = resolveStagedScoreAuthority(bundle);
  if (authority.mode === 'unscored') return null;
  if (authority.mode === 'legacy' && !authority.currentLegacy) return null;
  if (authority.mode === 'staged' && (
    authority.aimAuthorityState === 'stale_replay_needed'
    || authority.experienceAuthorityState === 'stale_replay_needed'
  )) return null;
  if (authority.mode === 'staged' && job.aimFitScore !== null && !authority.currentAim) return null;
  if (authority.mode === 'staged' && job.reqFitScore !== null && !authority.currentExperience) return null;
  if (authority.mode === 'staged'
    && authority.currentAim?.passed
    && !authority.currentExperience
    && (authority.currentAim.aimFitScore ?? -1) < AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE) return null;
  return cooldownReleasePlan(bundle);
}

/**
 * Some pre-triage local results recorded a cap below triage but still marked
 * the job scored. Only a fresh, independent metadata rejection may complete
 * that old local decision when Cooldown ends. Preserve every stored score and
 * leave score-event authority and explicit user actions alone.
 */
export function legacyCappedCooldownRejection(
  job: Pick<Job, 'title' | 'company' | 'location' | 'url' | 'source' | 'scoringStatus'
    | 'fitScore' | 'fitRationale' | 'aimFitScore' | 'reqFitScore' | 'tailoringStaged'
    | 'batchJobId' | 'jdBatchId' | 'afBatchId'>,
  bundle: LatestJobScoreBundle | null,
  protection: { hasScoreEvent: boolean; hasUserIntent: boolean },
): string | null {
  if (bundle || protection.hasScoreEvent || protection.hasUserIntent || job.tailoringStaged
    || job.scoringStatus !== 'scored' || job.fitScore === null
    || job.aimFitScore !== null || job.reqFitScore !== null
    || job.batchJobId !== null || job.jdBatchId !== null || job.afBatchId !== null
    || !LEGACY_LOCAL_CAP.test(job.fitRationale || '')
    || !hasAuthoritativeMetadata(job.source)) return null;

  const verdict = evaluateAuthoritativeMetadata(job);
  return verdict.passes ? null : verdict.reason;
}

export function statusAfterCooldown(bundle: LatestJobScoreBundle | null): 'pending_af' | 'inbox' | 'dismissed' {
  return cooldownReleasePlan(bundle).status;
}

export async function processCooldownJobs(onProgress?: (msg: string) => void) {
  onProgress?.('Checking for expired cooldown jobs...');
  
  const expiredCooldowns = await prisma.job.findMany({
    where: {
      status: 'cooldown',
      AND: [nonManualImportSourceWhere()],
      cooldownUntil: {
        lt: new Date()
      }
    },
    orderBy: [{ cooldownUntil: 'asc' }, { id: 'asc' }],
  });

  if (expiredCooldowns.length === 0) {
    onProgress?.('No expired cooldown jobs found.');
    return;
  }

  onProgress?.(`Found ${expiredCooldowns.length} jobs to release from cooldown. Validating URLs...`);
  const scoreBundles = await latestJobScoreEvents(expiredCooldowns.map((job) => job.id));
  const legacyCandidateIds = expiredCooldowns
    .filter((job) => LEGACY_LOCAL_CAP.test(job.fitRationale || ''))
    .map((job) => job.id);
  const [scoreEventRows, userIntentRows] = legacyCandidateIds.length > 0
    ? await Promise.all([
      prisma.jobScoreEvent.findMany({
        where: { jobId: { in: legacyCandidateIds } },
        distinct: ['jobId'],
        select: { jobId: true },
      }),
      prisma.jobPipelineEvent.findMany({
        where: { jobId: { in: legacyCandidateIds }, eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
        distinct: ['jobId'],
        select: { jobId: true },
      }),
    ])
    : [[], []];
  const scoreEventIds = new Set(scoreEventRows.map((row) => row.jobId));
  const userIntentIds = new Set(userIntentRows.map((row) => row.jobId));

  const applyRelease = async (
    job: typeof expiredCooldowns[number],
    plan: CooldownReleasePlan,
    localRejectionReason: string | null = null,
  ) => {
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const admission = await resolveInboxAdmission({
        jobId: job.id,
        title: job.title,
        location: job.location,
        company: job.company,
        employer: job.employer,
        source: job.source,
        proposedStatus: plan.status,
        now,
        store: tx,
        actor: 'machine',
      });
      // A job that repeats an application goes to Dismissed instead of the
      // Inbox, keeping any score it has, and is not queued for scoring. A job
      // headed back to scoring is checked too, so no scoring is spent on it.
      const repeat = admission.repeat
        ?? (plan.status === 'pending_af' ? await findAppliedRepeatForJob(job.id, tx) : null);
      const updated = await tx.job.updateMany({
        where: {
          id: job.id,
          status: 'cooldown',
          ...(localRejectionReason ? {
            updatedAt: job.updatedAt,
            scoringStatus: 'scored',
            fitScore: job.fitScore,
            fitRationale: job.fitRationale,
            aimFitScore: null,
            reqFitScore: null,
            tailoringStaged: false,
            batchJobId: null,
            jdBatchId: null,
            afBatchId: null,
            scoreEvents: { none: {} },
            scoringBatchItems: { none: { status: 'leased' } },
            pipelineEvents: { none: { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } } },
          } : {}),
        },
        data: repeat ? {
          ...appliedRepeatDismissalData(job, repeat.reason),
          cooldownUntil: null,
        } : {
          status: admission.status,
          cooldownUntil: admission.cooldownUntil,
          ...(localRejectionReason ? {
            passReason: localRejectionReason,
          } : {}),
          ...(plan.queueLocalScoring ? {
            scoringStatus: 'queued',
            batchJobId: null,
            jdBatchId: null,
            afBatchId: null,
            scoreAttempts: 0,
            scoreError: null,
          } : {}),
        },
      });
      if (updated.count === 1 && repeat) {
        await recordAppliedRepeatDismissal(tx, {
          jobId: job.id,
          source: job.source,
          sourceId: job.sourceId,
          priorStatus: 'cooldown',
          match: repeat,
          route: 'cooldown_release',
        });
      }
      if (updated.count === 1) await assertJobLifecycleInvariants(tx, [job.id]);
      if (updated.count !== 1) return null;
      return repeat
        ? { status: 'dismissed', queueLocalScoring: false }
        : { status: admission.status, queueLocalScoring: plan.queueLocalScoring };
    });
  };

  const outcome = await processCooldownCandidates(expiredCooldowns, async (job) => {
    const bundle = scoreBundles.get(job.id) || null;
    const plan = cooldownReleasePlanForJob(job, bundle);
    if (!plan) throw new CooldownReleaseHoldError('Existing scoring state has no safe automatic release plan.');
    const localRejectionReason = legacyCappedCooldownRejection(job, bundle, {
      hasScoreEvent: scoreEventIds.has(job.id),
      hasUserIntent: userIntentIds.has(job.id),
    });
    let isDead = false;
    let validationFailed = false;
    try {
      if (!job.url) {
        throw new Error("No URL");
      }
      
      const res = await safeExternalFetch(job.url, { method: 'GET', signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      const lowerText = text.toLowerCase();
      
      // Basic text validation to detect obviously closed jobs
      isDead =
        res.status === 404 || 
        res.status === 410 ||
        lowerText.includes('this job is no longer available') ||
        lowerText.includes('this position has been filled') ||
        lowerText.includes('job not found');
    } catch {
      // A URL failure is ambiguous; only the URL check may use this fallback.
      // Transaction and database failures must reach the pipeline warning.
      validationFailed = true;
    }
    if (isDead) {
      const released = await applyRelease(job, { status: 'expired', queueLocalScoring: false });
      if (released) onProgress?.(`Job ${job.id} marked as expired/dismissed (URL dead).`);
      return released !== null;
    }
    const released = localRejectionReason
      ? await applyRelease(job, { status: 'dismissed', queueLocalScoring: false }, localRejectionReason)
      : await applyRelease(job, plan);
    if (released) onProgress?.(
      localRejectionReason
        ? `Job ${job.id} locally rejected on Cooldown release: ${localRejectionReason}`
        : validationFailed
        ? `Validation failed for ${job.id}; restored to ${released.status}.`
        : released.queueLocalScoring
          ? `Job ${job.id} released to current local scoring.`
          : `Job ${job.id} restored to ${released.status}.`,
    );
    return released !== null;
  }, (job, error) => {
    const reason = error instanceof JobLifecycleInvariantError
      ? error.violations.map((item) => item.invariant).join(', ')
      : error.message;
    console.warn(`Cooldown release held ${job.id}: ${reason}`);
  });
  onProgress?.(`Released ${outcome.released} expired cooldown jobs; held ${outcome.held} with unresolved lifecycle states. Remaining jobs will be checked on later turns.`);
}

export async function enforceRetroactiveCooldowns(onProgress?: (msg: string) => void) {
  onProgress?.('Enforcing cooldowns for newly scraped jobs from applied companies...');
  const cooledIds = await prisma.$transaction(async (tx) => {
    const ids = await reconcileCompanyCooldowns({ now: new Date(), store: tx });
    await assertJobLifecycleInvariants(tx, ids);
    return ids;
  });
  if (cooledIds.length > 0) {
    onProgress?.(`Moved ${cooledIds.length} Inbox jobs to cooldown because of recent applications.`);
  }
}
