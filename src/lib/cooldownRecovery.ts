import { prisma } from './prisma';
import { safeExternalFetch } from './safeExternalFetch';
import type { Prisma } from '@prisma/client';

export async function processCooldownJobs(onProgress?: (msg: string) => void) {
  onProgress?.('Checking for expired cooldown jobs...');
  
  const expiredCooldowns = await prisma.job.findMany({
    where: {
      OR: [
        { status: 'cooldown' },
        { luckyStatus: 'cooldown' }
      ],
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
        const updateData: Prisma.JobUpdateInput = {};
        if (job.luckyStatus === 'cooldown') {
          updateData.luckyStatus = 'dismissed';
          updateData.luckyPassReason = '[Cooldown Validation] Job URL appears dead or closed.';
        }
        if (job.status === 'cooldown') {
          updateData.status = 'expired';
        }
        await prisma.job.update({ where: { id: job.id }, data: updateData });
        onProgress?.(`Job ${job.id} marked as expired/dismissed (URL dead).`);
      } else {
        const updateData: Prisma.JobUpdateInput = { cooldownUntil: null };
        if (job.luckyStatus === 'cooldown') {
          updateData.luckyStatus = 'inbox';
        }
        if (job.status === 'cooldown') {
          updateData.status = 'inbox';
        }
        await prisma.job.update({ where: { id: job.id }, data: updateData });
        onProgress?.(`Job ${job.id} restored to inbox.`);
      }
    } catch {
      // Fallback: If we can't validate (timeout, block, etc.), just send it back to inbox.
      const updateData: Prisma.JobUpdateInput = { cooldownUntil: null };
      if (job.luckyStatus === 'cooldown') {
        updateData.luckyStatus = 'inbox';
      }
      if (job.status === 'cooldown') {
        updateData.status = 'inbox';
      }
      await prisma.job.update({ where: { id: job.id }, data: updateData });
      onProgress?.(`Validation failed for ${job.id}, restoring to inbox as fallback.`);
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
      luckyStatus: { notIn: ['applied', 'interviewing', 'dismissed', 'archived', 'cooldown'] }
    },
    select: { id: true, company: true, status: true, luckyStatus: true }
  });

  const normalIdsToCooldown: string[] = [];
  const luckyIdsToCooldown: string[] = [];

  for (const job of inboxJobs) {
    if (!job.company) continue;
    if (appliedCompanies.includes(job.company.toLowerCase())) {
      if (job.status !== 'cooldown' && job.status !== 'none' && !job.status.includes('applied') && !job.status.includes('interviewing') && !job.status.includes('dismissed') && !job.status.includes('archived')) {
        normalIdsToCooldown.push(job.id);
      }
      if (job.luckyStatus !== 'cooldown' && job.luckyStatus !== 'none' && !job.luckyStatus.includes('applied') && !job.luckyStatus.includes('interviewing') && !job.luckyStatus.includes('dismissed') && !job.luckyStatus.includes('archived')) {
        luckyIdsToCooldown.push(job.id);
      }
    }
  }

  let updatedCount = 0;

  if (normalIdsToCooldown.length > 0) {
    const normal = await prisma.job.updateMany({
      where: { id: { in: normalIdsToCooldown } },
      data: {
        status: 'cooldown',
        cooldownUntil: threeWeeksFromNow
      }
    });
    updatedCount += normal.count;
  }

  if (luckyIdsToCooldown.length > 0) {
    const lucky = await prisma.job.updateMany({
      where: { id: { in: luckyIdsToCooldown } },
      data: {
        luckyStatus: 'cooldown',
        cooldownUntil: threeWeeksFromNow
      }
    });
    updatedCount += lucky.count;
  }

  if (updatedCount > 0) {
    onProgress?.(`Moved ${updatedCount} jobs to cooldown because of existing applications.`);
  }
}
