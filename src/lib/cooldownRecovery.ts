import { prisma } from './prisma';
import { safeExternalFetch } from './safeExternalFetch';
import { latestJobScoreEvents, type LatestJobScoreBundle } from './jobScoreAuthorityQuery';
import { resolveStagedScoreAuthority } from './scoreAuthority';
import { nonManualImportSourceWhere } from './manualImportPolicy';
import { reconcileCompanyCooldowns, resolveInboxAdmission } from './companyCooldown';
import { assertJobLifecycleInvariants } from './jobLifecycleInvariant';

export function statusAfterCooldown(bundle: LatestJobScoreBundle | null): 'pending_af' | 'inbox' | 'dismissed' {
  if (!bundle) return 'pending_af';
  const authority = resolveStagedScoreAuthority(bundle);
  if (authority.mode === 'legacy') return authority.currentLegacy?.passed ? 'inbox' : 'dismissed';
  if (!authority.currentAim) return 'pending_af';
  if (!authority.currentAim.passed) return 'dismissed';
  if (!authority.currentExperience) return 'pending_af';
  return authority.currentExperience.passed ? 'inbox' : 'dismissed';
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

  const applyRelease = async (job: typeof expiredCooldowns[number], proposedStatus: string) => {
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const admission = await resolveInboxAdmission({
        jobId: job.id,
        company: job.company,
        source: job.source,
        proposedStatus,
        now,
        store: tx,
      });
      const updated = await tx.job.updateMany({
        where: { id: job.id, status: 'cooldown' },
        data: { status: admission.status, cooldownUntil: admission.cooldownUntil },
      });
      if (updated.count === 1) await assertJobLifecycleInvariants(tx, [job.id]);
      return updated.count === 1 ? admission.status : null;
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
        const releasedTo = await applyRelease(job, 'expired');
        if (releasedTo) onProgress?.(`Job ${job.id} marked as expired/dismissed (URL dead).`);
      } else {
        const releasedTo = await applyRelease(job, statusAfterCooldown(scoreBundles.get(job.id) || null));
        if (releasedTo) onProgress?.(`Job ${job.id} restored to ${releasedTo}.`);
      }
    } catch {
      // URL ambiguity must not bypass or strand the staged scoring authority.
      const releasedTo = await applyRelease(job, statusAfterCooldown(scoreBundles.get(job.id) || null));
      if (releasedTo) onProgress?.(`Validation failed for ${job.id}, restoring to ${releasedTo}.`);
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
