import { prisma } from './prisma';
import { safeExternalFetch } from './safeExternalFetch';
import type { Prisma } from '@prisma/client';

export async function verifyInboxJobsAlive(onProgress?: (msg: string) => void) {
  onProgress?.('Verifying liveliness of jobs in the inbox...');
  
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const inboxJobs = await prisma.job.findMany({
    where: {
      OR: [
        { status: 'inbox' },
        { luckyStatus: 'inbox' }
      ],
      AND: [
        {
          OR: [
            { lastVerifiedAt: null },
            { lastVerifiedAt: { lt: yesterday } }
          ]
        }
      ]
    }
  });

  if (inboxJobs.length === 0) {
    onProgress?.('No inbox jobs need verification at this time.');
    return;
  }

  onProgress?.(`Found ${inboxJobs.length} jobs to verify. Checking URLs...`);

  let expiredCount = 0;

  for (const job of inboxJobs) {
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
        lowerText.includes('job not found') ||
        lowerText.includes('job has expired');

      const updateData: Prisma.JobUpdateInput = { lastVerifiedAt: new Date() };

      if (isDead) {
        expiredCount++;
        if (job.luckyStatus === 'inbox') {
          updateData.luckyStatus = 'dismissed';
          updateData.luckyPassReason = 'Expired (URL dead)';
        }
        if (job.status === 'inbox') {
          updateData.status = 'expired';
          updateData.passReason = 'Expired (URL dead)';
        }
        await prisma.job.update({ where: { id: job.id }, data: updateData });
        onProgress?.(`Job ${job.id} marked as expired (URL dead).`);
      } else {
        await prisma.job.update({ where: { id: job.id }, data: updateData });
      }
    } catch {
      // Fallback: If we can't validate (timeout, block, etc.), just update the lastVerifiedAt so we don't spam it.
      await prisma.job.update({ where: { id: job.id }, data: { lastVerifiedAt: new Date() } });
    }
    
    // Slight delay to avoid hammering servers too hard during batch checks
    await new Promise(r => setTimeout(r, 500));
  }

  onProgress?.(`Verification complete. Marked ${expiredCount} jobs as expired out of ${inboxJobs.length} checked.`);
}
