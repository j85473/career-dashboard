import { prisma } from './prisma';
import { safeExternalFetch } from './safeExternalFetch';

export async function reapStuckJobs() {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // 1. Find jobs stuck in pending_af or queued or needs_jd
  const stuckJobs = await prisma.job.findMany({
    where: {
      status: { in: ['pending_af', 'inbox'] },
      scoringStatus: { in: ['queued', 'needs_jd', 'skipped'] },
      updatedAt: { lt: twentyFourHoursAgo }
    },
    take: 100
  });

  let archivedCount = 0;
  let retriedCount = 0;

  for (const job of stuckJobs) {
    // If it's very old (e.g. > 7 days), just archive it
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (job.postedAt < sevenDaysAgo) {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'archived', passReason: 'stuck_timeout' }
      });
      archivedCount++;
      continue;
    }

    // Attempt to verify if it's still alive via a quick HEAD request
    if (!job.url) {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'archived', passReason: 'dead_link_reaper' }
      });
      archivedCount++;
      continue;
    }

    try {
      const res = await safeExternalFetch(job.url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (res.status === 404 || res.status === 410) {
        await prisma.job.update({
          where: { id: job.id },
          data: { status: 'archived', passReason: 'dead_link_reaper' }
        });
        archivedCount++;
      } else {
        // Reset updated at to try again, or leave for the pipeline
        await prisma.job.update({
          where: { id: job.id },
          data: { updatedAt: new Date() }
        });
        retriedCount++;
      }
    } catch {
      // Network error, just retry later
      await prisma.job.update({
        where: { id: job.id },
        data: { updatedAt: new Date() }
      });
      retriedCount++;
    }
  }

  return { archivedCount, retriedCount, totalProcessed: stuckJobs.length };
}
