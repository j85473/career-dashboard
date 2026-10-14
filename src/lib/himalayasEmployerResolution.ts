import type { Prisma } from '@prisma/client';
import { boardIdentityFromUrl, selectDirectAtsMatch, type BoardPosting } from './atsDirectMatch';

export const HIMALAYAS_REPAIR_STATUSES = ['inbox', 'pending_af', 'needs_jd', 'bookmarked', 'applied', 'interviewing'];

export function himalayasCompanySlug(value: string | null | undefined): string | null {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.hostname.toLowerCase() !== 'himalayas.app') return null;
    return url.pathname.match(/^\/companies\/([a-z0-9][a-z0-9_-]{1,120})\/jobs\/[^/]+\/?$/i)?.[1]?.toLowerCase() || null;
  } catch { return null; }
}

export type HimalayasRepairJob = {
  id: string; title: string; company: string; location: string | null;
  url: string | null; canonicalUrl: string | null; description: string | null;
  source: string | null; status: string; updatedAt: Date;
};

export function selectHimalayasEmployerPosting(job: HimalayasRepairJob, postings: readonly BoardPosting[]): BoardPosting | null {
  if (job.source?.toLowerCase() !== 'himalayas' || !HIMALAYAS_REPAIR_STATUSES.includes(job.status)
    || !himalayasCompanySlug(job.canonicalUrl || job.url)) return null;
  const match = selectDirectAtsMatch(job, postings);
  return match && boardIdentityFromUrl(match.url) ? match : null;
}

/** Link-only compare-and-set; never consolidates cards or writes scoring inputs. */
export async function applyHimalayasLinkRepair(
  job: HimalayasRepairJob,
  postings: readonly BoardPosting[],
  store: Pick<Prisma.TransactionClient, 'job'>,
): Promise<boolean> {
  const match = selectHimalayasEmployerPosting(job, postings);
  if (!match) return false;
  const result = await store.job.updateMany({
    where: { id: job.id, updatedAt: job.updatedAt,
      source: { equals: 'Himalayas', mode: 'insensitive' }, status: { in: HIMALAYAS_REPAIR_STATUSES },
      url: job.url, canonicalUrl: job.canonicalUrl,
    },
    data: { url: match.url, canonicalUrl: match.url },
  });
  return result.count === 1;
}
