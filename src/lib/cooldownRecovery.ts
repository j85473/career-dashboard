import { prisma } from './prisma';
import { safeExternalFetch } from './safeExternalFetch';
import { latestJobScoreEvents, type LatestJobScoreBundle } from './jobScoreAuthorityQuery';
import { resolveStagedScoreAuthority } from './scoreAuthority';
import { nonManualImportSourceWhere } from './manualImportPolicy';
import { reconcileCompanyCooldowns, resolveInboxAdmission } from './companyCooldown';
import { assertJobLifecycleInvariants } from './jobLifecycleInvariant';

export type CooldownReleasePlan = {
  status: 'pending_af' | 'inbox' | 'dismissed' | 'expired';
  queueLocalScoring: boolean;
};

type ScoredCooldownReleasePlan = CooldownReleasePlan & {
  status: 'pending_af' | 'inbox' | 'dismissed';
};

/**
 * Restore current score authority when it exists. A legacy Cooldown row with
 * no canonical score event must re-enter the pipeline at local scoring instead
 * of appearing immediately in Aim Fit on the strength of retired local fields.
 */
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
    }
  });

  if (expiredCooldowns.length === 0) {
    onProgress?.('No expired cooldown jobs found.');
    return;
  }

  onProgress?.(`Found ${expiredCooldowns.length} jobs to release from cooldown. Validating URLs...`);
  const scoreBundles = await latestJobScoreEvents(expiredCooldowns.map((job) => job.id));

  const applyRelease = async (job: typeof expiredCooldowns[number], plan: CooldownReleasePlan) => {
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const admission = await resolveInboxAdmission({
        jobId: job.id,
        company: job.company,
        source: job.source,
        proposedStatus: plan.status,
        now,
        store: tx,
      });
      const updated = await tx.job.updateMany({
        where: { id: job.id, status: 'cooldown' },
        data: {
          status: admission.status,
          cooldownUntil: admission.cooldownUntil,
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
      if (updated.count === 1) await assertJobLifecycleInvariants(tx, [job.id]);
      return updated.count === 1 ? { status: admission.status, queueLocalScoring: plan.queueLocalScoring } : null;
    });
  };

  for (const job of expiredCooldowns) {
    try {
      if (!job.url) {
        throw new Error("No URL");
      }
      
      const res = await safeExternalFetch(job.url, { method: 'GET', signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      const lowerText = text.toLowerCase();
      
      // Basic text validation to detect obviously closed jobs
      const isDead = 
        res.status === 404 || 
        res.status === 410 ||
        lowerText.includes('this job is no longer available') ||
        lowerText.includes('this position has been filled') ||
        lowerText.includes('job not found');

      if (isDead) {
        const released = await applyRelease(job, { status: 'expired', queueLocalScoring: false });
        if (released) onProgress?.(`Job ${job.id} marked as expired/dismissed (URL dead).`);
      } else {
        const released = await applyRelease(job, cooldownReleasePlan(scoreBundles.get(job.id) || null));
        if (released) onProgress?.(
          released.queueLocalScoring
            ? `Job ${job.id} released to current local scoring.`
            : `Job ${job.id} restored to ${released.status}.`,
        );
      }
    } catch {
      // URL ambiguity must not bypass or strand the staged scoring authority.
      const released = await applyRelease(job, cooldownReleasePlan(scoreBundles.get(job.id) || null));
      if (released) onProgress?.(
        released.queueLocalScoring
          ? `Validation failed for ${job.id}; released to current local scoring.`
          : `Validation failed for ${job.id}, restoring to ${released.status}.`,
      );
    }
  }
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
