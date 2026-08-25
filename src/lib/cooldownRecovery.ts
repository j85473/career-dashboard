import { prisma } from './prisma';
import { safeExternalFetch } from './safeExternalFetch';
import type { Prisma } from '@prisma/client';
import { latestJobScoreEvents, type LatestJobScoreBundle } from './jobScoreAuthorityQuery';
import { resolveStagedScoreAuthority } from './scoreAuthority';
import { nonManualImportSourceWhere } from './manualImportPolicy';

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
        const updateData: Prisma.JobUpdateInput = { status: 'expired' };
        await prisma.job.update({ where: { id: job.id }, data: updateData });
        onProgress?.(`Job ${job.id} marked as expired/dismissed (URL dead).`);
      } else {
        const updateData: Prisma.JobUpdateInput = { cooldownUntil: null };
        updateData.status = statusAfterCooldown(scoreBundles.get(job.id) || null);
        await prisma.job.update({ where: { id: job.id }, data: updateData });
        onProgress?.(`Job ${job.id} restored to ${String(updateData.status)}.`);
      }
    } catch {
      // URL ambiguity must not bypass or strand the staged scoring authority.
      const updateData: Prisma.JobUpdateInput = { cooldownUntil: null };
      updateData.status = statusAfterCooldown(scoreBundles.get(job.id) || null);
      await prisma.job.update({ where: { id: job.id }, data: updateData });
      onProgress?.(`Validation failed for ${job.id}, restoring to ${String(updateData.status)}.`);
    }
  }
}

export async function enforceRetroactiveCooldowns(onProgress?: (msg: string) => void) {
  onProgress?.('Enforcing cooldowns for newly scraped jobs from applied companies...');

  const activeApplications = await prisma.job.findMany({
    where: { status: { in: ['applied', 'interviewing'] } },
    select: { company: true },
    distinct: ['company']
  });

  if (activeApplications.length === 0) return;

  const appliedCompanies = activeApplications
    .map(app => app.company?.toLowerCase())
    .filter(Boolean) as string[];

  const threeWeeksFromNow = new Date();
  threeWeeksFromNow.setDate(threeWeeksFromNow.getDate() + 21);

  // Fetch all jobs that are not in a terminal state or already in cooldown
  const inboxJobs = await prisma.job.findMany({
    where: {
      status: { notIn: ['applied', 'interviewing', 'dismissed', 'archived', 'cooldown'] },
      AND: [nonManualImportSourceWhere()],
    },
    select: { id: true, title: true, company: true, status: true, source: true }
  });

  const normalIdsToCooldown: string[] = [];

  for (const job of inboxJobs) {
    if (!job.company) continue;
    if (appliedCompanies.includes(job.company.toLowerCase())) {
      if (job.status !== 'cooldown' && job.status !== 'none' && !job.status.includes('applied') && !job.status.includes('interviewing') && !job.status.includes('dismissed') && !job.status.includes('archived')) {
        normalIdsToCooldown.push(job.id);
      }
    }
  }

  let updatedCount = 0;

  if (normalIdsToCooldown.length > 0) {
    const normal = await prisma.job.updateMany({
      where: { id: { in: normalIdsToCooldown }, AND: [nonManualImportSourceWhere()] },
      data: {
        status: 'cooldown',
        cooldownUntil: threeWeeksFromNow
      }
    });
    updatedCount += normal.count;
  }

  if (updatedCount > 0) {
    onProgress?.(`Moved ${updatedCount} jobs to cooldown because of existing applications.`);
  }
}
