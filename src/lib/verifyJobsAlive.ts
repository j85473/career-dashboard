import { prisma } from './prisma';
import { safeExternalFetch } from './safeExternalFetch';
import type { Prisma, PrismaClient } from '@prisma/client';
import { nonManualImportSourceWhere } from './manualImportPolicy';
import { randomUUID } from 'node:crypto';
import { isAggregatorSource, resolveDirectAtsPosting, type DirectAtsMatch } from './atsDirectMatch';
import { verifyJobPosting, readRenderedPosting, type JobPostingLiveness } from './jobPostingVerification';
export { classifyJobPostingLiveness, type JobPostingLiveness } from './jobPostingVerification';

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
  let parts: string[];
  try {
    // URL.pathname is already escaped. Decode each segment before encoding it
    // for the API, or a valid %20 becomes %2520 and can produce a false 404.
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }

  if (hostIs(host, 'myworkdayjobs.com')) {
    if (parts[0] === 'wday' && parts[1] === 'cxs') return null;
    const jobIndex = parts.findIndex((part) => part.toLowerCase() === 'job');
    if (jobIndex >= 1 && parts.length > jobIndex + 1) {
      const tenant = host.split('.')[0];
      const site = parts[jobIndex - 1];
      const jobPath = parts.slice(jobIndex + 1).map(encodeURIComponent).join('/');
      return `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/job/${jobPath}`;
    }
  }

  if (hostIs(host, 'myworkdaysite.com') && parts[0] === 'recruiting' && parts[1] && parts[2]) {
    const jobIndex = parts.findIndex(part => part.toLowerCase() === 'job');
    if (jobIndex >= 3 && parts.length > jobIndex + 1) {
      return `https://${host}/wday/cxs/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}/job/${parts.slice(jobIndex + 1).map(encodeURIComponent).join('/')}`;
    }
  }

  if (hostIs(host, 'greenhouse.io')) {
    const jobsIndex = parts.findIndex((part) => part.toLowerCase() === 'jobs');
    if (jobsIndex === 1 && parts[0] && parts[2]) {
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(parts[0])}/jobs/${encodeURIComponent(parts[2])}`;
    }
  }

  if ((host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') && parts[0] && parts[1]) {
    const apiHost = host === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co';
    return `https://${apiHost}/v0/postings/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
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
export function combineAuthoritativeAndPageLiveness(
  authoritative: JobPostingLiveness,
  page: JobPostingLiveness,
): JobPostingLiveness {
  if (authoritative !== 'inconclusive') return authoritative;
  return page === 'expired' ? 'expired' : 'inconclusive';
}

export async function verifyInboxJobsAlive(
  onProgress?: (msg: string) => void,
  dependencies: {
    fetchPosting?: typeof safeExternalFetch;
    readPosting?: typeof readRenderedPosting;
    resolveCanonical?: typeof resolveDirectAtsPosting;
    delayMs?: number;
    client?: Pick<PrismaClient, 'job'> & Partial<Pick<PrismaClient,
      'companyNameRule' | 'atsCompany' | 'jobPipelineEvent' | '$transaction'>>;
  } = {},
) {
  const { fetchPosting = safeExternalFetch, readPosting = readRenderedPosting,
    resolveCanonical = resolveDirectAtsPosting, client = prisma, delayMs = 500 } = dependencies;
  onProgress?.('Checking whether Inbox postings are still available...');
  
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const inboxJobs = await client.job.findMany({
    where: {
      status: 'inbox',
      tailoringStaged: false,
      scoringStatus: { not: 'scoring' },
      batchJobId: null,
      jdBatchId: null,
      AND: [
        nonManualImportSourceWhere(),
        {
          OR: [
            { lastVerifiedAt: null },
            { lastVerifiedAt: { lt: yesterday } }
          ]
        }
      ]
    },
    orderBy: [{ lastVerifiedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    take: 25,
  });

  if (inboxJobs.length === 0) {
    onProgress?.('No inbox jobs need verification at this time.');
    return;
  }

  onProgress?.(`Found ${inboxJobs.length} jobs to verify. Checking URLs...`);

  let expiredCount = 0;
  let repairedCount = 0;
  let inconclusiveCount = 0;
  const liveCache = new Map();

  for (const job of inboxJobs) {
    const unchangedInboxJob: Prisma.JobWhereInput = {
      id: job.id,
      status: 'inbox',
      tailoringStaged: false,
      scoringStatus: job.scoringStatus,
      batchJobId: null,
      jdBatchId: null,
      url: job.url,
      updatedAt: job.updatedAt,
      AND: [nonManualImportSourceWhere()],
    };
    if (job.batchJobId || job.jdBatchId || job.scoringStatus === 'scoring') continue;
    const result = job.url
      ? await verifyJobPosting({ url: job.url, title: job.title }, authoritativeJobVerificationUrl(job.url), { fetchPosting, readPosting })
      : { liveness: 'inconclusive' as const, probes: [] };
    const sourceLiveness = result.liveness;
    let replacement: DirectAtsMatch | null = null;
    // A removed aggregator copy does not establish that the employer stopped
    // hiring. Resolve and verify the canonical copy before expiring the card.
    if (result.liveness !== 'alive' && isAggregatorSource(job.source)) {
      try {
        const match = await resolveCanonical(job, { store: client, allowLivePing: true, liveCache });
        if (match && match.url !== job.url) {
          const employer = await verifyJobPosting({ url: match.url, title: match.postingTitle },
            authoritativeJobVerificationUrl(match.url), { fetchPosting, readPosting });
          result.probes.push(...employer.probes);
          result.liveness = employer.liveness;
          if (employer.liveness === 'alive') replacement = match;
        }
      } catch {
        // A failed identity lookup cannot justify expiring an aggregator card.
        result.liveness = 'inconclusive';
      }
    }

    const checkedAt = new Date();
    const updateData: Prisma.JobUpdateManyMutationInput = { lastVerifiedAt: checkedAt };
    if (replacement) {
      updateData.url = replacement.url;
      updateData.canonicalUrl = replacement.url;
    } else if (result.liveness === 'expired') {
      updateData.status = 'expired';
      updateData.passReason = 'Expired (URL dead)';
    }
    const persist = async (store: Pick<Prisma.TransactionClient, 'job'>
      & Partial<Pick<Prisma.TransactionClient, 'jobPipelineEvent'>>) => {
      const updated = await store.job.updateMany({ where: unchangedInboxJob, data: updateData });
      if (updated.count && store.jobPipelineEvent) await store.jobPipelineEvent.create({ data: {
        eventKey: `inbox-posting-check:${job.id}:${randomUUID()}`,
        eventType: 'inbox_posting_verified', stage: 'inbox_verification', jobId: job.id,
        source: job.source, sourceId: job.sourceId, occurredAt: checkedAt,
        details: { outcome: result.liveness, sourceOutcome: sourceLiveness, originalUrl: job.url,
          replacementUrl: replacement?.url || null,
          matchEvidence: replacement ? { via: replacement.matchedVia, by: replacement.matchedBy || null,
            title: replacement.postingTitle, location: replacement.postingLocation } : null,
          probes: result.probes },
      } });
      return updated.count;
    };
    // The projection and its evidence commit together. User/lifecycle changes
    // during network requests defeat both the write and the history event.
    const changed = client.$transaction ? await client.$transaction(tx => persist(tx)) : await persist(client);
    if (changed) {
      if (replacement) repairedCount++;
      else if (result.liveness === 'expired') expiredCount++;
      else if (result.liveness === 'inconclusive') inconclusiveCount++;
    }
    
    // Slight delay to avoid hammering servers too hard during batch checks
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }

  onProgress?.(`Checked ${inboxJobs.length} Inbox jobs: ${expiredCount} expired, ${repairedCount} employer links repaired, ${inconclusiveCount} inconclusive.`);
}
