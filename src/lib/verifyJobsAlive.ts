import { prisma } from './prisma';
import { safeExternalFetch } from './safeExternalFetch';
import type { Prisma } from '@prisma/client';
import { nonManualImportSourceWhere } from './manualImportPolicy';
import { isTerminalJobPostingPage } from './jobDescriptionQuality';

export type JobPostingLiveness = 'alive' | 'expired' | 'inconclusive';

function hostIs(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Public job pages for several ATS products are application shells that keep
 * returning HTTP 200 after the requisition disappears. Their public detail
 * endpoints represent the individual requisition and return 404/410 when it
 * is gone, so use those endpoints as the stronger liveness probe.
 */
export function authoritativeJobVerificationUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (hostIs(host, 'myworkdayjobs.com')) {
    const jobIndex = parts.findIndex((part) => part.toLowerCase() === 'job');
    if (jobIndex >= 1 && parts.length > jobIndex + 1) {
      const tenant = host.split('.')[0];
      const site = parts[jobIndex - 1];
      const jobPath = parts.slice(jobIndex + 1).map(encodeURIComponent).join('/');
      return `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/job/${jobPath}`;
    }
  }

  if (hostIs(host, 'greenhouse.io')) {
    const jobsIndex = parts.findIndex((part) => part.toLowerCase() === 'jobs');
    if (jobsIndex === 1 && parts[0] && parts[2]) {
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(parts[0])}/jobs/${encodeURIComponent(parts[2])}`;
    }
  }

  if (hostIs(host, 'lever.co') && parts[0] && parts[1]) {
    return `https://api.lever.co/v0/postings/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
  }

  if (hostIs(host, 'workable.com')) {
    const shortcodeIndex = parts.findIndex((part) => part.toLowerCase() === 'j');
    if (shortcodeIndex === 1 && parts[0] && parts[2]) {
      return `https://apply.workable.com/api/v1/accounts/${encodeURIComponent(parts[0])}/jobs/${encodeURIComponent(parts[2])}`;
    }
  }

  return null;
}

/**
 * Classify only evidence returned by the requested posting URL. A blocked,
 * throttled, or broken upstream is not evidence that the requisition closed.
 */
export function classifyJobPostingLiveness(status: number, body: string): JobPostingLiveness {
  if (status === 404 || status === 410) return 'expired';
  if (status < 200 || status >= 300) return 'inconclusive';
  if (isTerminalJobPostingPage(body)) return 'expired';
  if (!body.trim()) return 'inconclusive';
  return 'alive';
}

export function combineAuthoritativeAndPageLiveness(
  authoritative: JobPostingLiveness,
  page: JobPostingLiveness,
): JobPostingLiveness {
  if (authoritative !== 'inconclusive') return authoritative;
  return page === 'expired' ? 'expired' : 'inconclusive';
}

export async function verifyInboxJobsAlive(onProgress?: (msg: string) => void) {
  onProgress?.('Verifying liveliness of jobs in the inbox...');
  
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const inboxJobs = await prisma.job.findMany({
    where: {
      status: 'inbox',
      AND: [
        nonManualImportSourceWhere(),
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

      const verificationUrl = authoritativeJobVerificationUrl(job.url) || job.url;
      const res = await safeExternalFetch(verificationUrl, {
        method: 'GET',
        headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      let liveness = classifyJobPostingLiveness(res.status, text);

      // A tenant can block its otherwise-public ATS detail endpoint. Preserve
      // the page-level closure check in that case, but do not let a generic
      // HTTP-200 application shell overrule an inconclusive authoritative API.
      if (liveness === 'inconclusive' && verificationUrl !== job.url) {
        try {
          const page = await safeExternalFetch(job.url, {
            method: 'GET',
            headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
            signal: AbortSignal.timeout(10000),
          });
          const pageLiveness = classifyJobPostingLiveness(page.status, await page.text());
          liveness = combineAuthoritativeAndPageLiveness(liveness, pageLiveness);
        } catch {
          // The authoritative response remains inconclusive and will retry on
          // the existing daily clock.
        }
      }

      const updateData: Prisma.JobUpdateInput = { lastVerifiedAt: new Date() };

      if (liveness === 'expired') {
        updateData.status = 'expired';
        updateData.passReason = 'Expired (URL dead)';
        const expired = await prisma.job.updateMany({
          // The request can take ten seconds. Do not expire a job Joseph moved,
          // bookmarked, or applied to while the network check was in flight.
          where: { id: job.id, status: 'inbox', AND: [nonManualImportSourceWhere()] },
          data: updateData,
        });
        expiredCount += expired.count;
        if (expired.count > 0) onProgress?.(`Job ${job.id} marked as expired (URL dead).`);
      } else {
        // `lastVerifiedAt` is the existing retry clock. An inconclusive check
        // still advances it so a blocked site is retried tomorrow rather than
        // hammered every fifteen-minute pipeline loop.
        await prisma.job.updateMany({
          where: { id: job.id, status: 'inbox', AND: [nonManualImportSourceWhere()] },
          data: updateData,
        });
      }
    } catch {
      // Fallback: If we can't validate (timeout, block, etc.), just update the lastVerifiedAt so we don't spam it.
      await prisma.job.updateMany({
        where: { id: job.id, status: 'inbox', AND: [nonManualImportSourceWhere()] },
        data: { lastVerifiedAt: new Date() },
      });
    }
    
    // Slight delay to avoid hammering servers too hard during batch checks
    await new Promise(r => setTimeout(r, 500));
  }

  onProgress?.(`Verification complete. Marked ${expiredCount} jobs as expired out of ${inboxJobs.length} checked.`);
}
