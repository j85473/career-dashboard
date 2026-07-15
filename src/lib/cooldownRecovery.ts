import { prisma } from './prisma';
import { safeExternalFetch } from './safeExternalFetch';

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
        if (job.luckyStatus === 'cooldown') {
          await prisma.job.update({ where: { id: job.id }, data: { luckyStatus: 'dismissed', luckyPassReason: '[Cooldown Validation] Job URL appears dead or closed.' } });
        } else {
          await prisma.job.update({ where: { id: job.id }, data: { status: 'expired' } });
        }
        onProgress?.(`Job ${job.id} marked as expired/dismissed (URL dead).`);
      } else {
        if (job.luckyStatus === 'cooldown') {
          await prisma.job.update({ where: { id: job.id }, data: { luckyStatus: 'inbox', cooldownUntil: null } });
        } else {
          await prisma.job.update({ where: { id: job.id }, data: { status: 'inbox', cooldownUntil: null } });
        }
        onProgress?.(`Job ${job.id} restored to inbox.`);
      }
    } catch {
      // Fallback: If we can't validate (timeout, block, etc.), just send it back to inbox.
      if (job.luckyStatus === 'cooldown') {
        await prisma.job.update({ where: { id: job.id }, data: { luckyStatus: 'inbox', cooldownUntil: null } });
      } else {
        await prisma.job.update({ where: { id: job.id }, data: { status: 'inbox', cooldownUntil: null } });
      }
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

  const threeWeeksFromNow = new Date();
  threeWeeksFromNow.setDate(threeWeeksFromNow.getDate() + 21);

  let updatedCount = 0;

  for (const app of activeApplications) {
    if (!app.company) continue;

    // Update normal inbox jobs
    const normal = await prisma.job.updateMany({
      where: {
        company: app.company,
        status: 'inbox',
      },
      data: {
        status: 'cooldown',
        cooldownUntil: threeWeeksFromNow
      }
    });

    // Update lucky inbox jobs
    const lucky = await prisma.job.updateMany({
      where: {
        company: app.company,
        luckyStatus: 'inbox',
      },
      data: {
        luckyStatus: 'cooldown',
        cooldownUntil: threeWeeksFromNow
      }
    });

    updatedCount += normal.count + lucky.count;
  }

  if (updatedCount > 0) {
    onProgress?.(`Moved ${updatedCount} jobs to cooldown because of existing applications.`);
  }
}
