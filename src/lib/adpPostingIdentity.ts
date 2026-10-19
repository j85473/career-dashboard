/** ADP requisition numbers are local to an employer's career center. */
export function isAdpPostingHost(value: string | null | undefined): boolean {
  try { return new URL(value || '').hostname === 'workforcenow.adp.com'; }
  catch { return false; }
}

/** Navigation appends jobId; its last value is the selected opening. */
export function adpPostingIdentity(value: string): { cid: string; ccId: string; jobId: string; origin: string } | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !isAdpPostingHost(value)
      || url.pathname !== '/mascsr/default/mdf/recruitment/recruitment.html') return null;
    const clients = url.searchParams.getAll('cid');
    const centers = url.searchParams.getAll('ccId');
    if (clients.length !== 1 || centers.length > 1) return null;
    const cid = clients[0].toLowerCase();
    const ccId = (centers[0] ?? '19000101_000001').toLowerCase();
    const jobId = url.searchParams.getAll('jobId').at(-1) || '';
    return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(cid) && /^\d+$/.test(jobId) && /^[\w-]+$/.test(ccId)
      ? { cid, ccId, jobId, origin: url.origin } : null;
  } catch { return null; }
}

export function adpPostingKey(value: string | null | undefined): string | null {
  const identity = adpPostingIdentity(value || '');
  return identity ? `adp:${identity.cid}:${identity.ccId}|${identity.jobId}` : null;
}

/** Stored legacy hashes never override the actual employer and selected job. */
export function matchesAdpPosting(job: { url?: string | null; canonicalUrl?: string | null }, url: string): boolean {
  const key = adpPostingKey(url);
  const stored = new Set([job.url, job.canonicalUrl].map(adpPostingKey).filter(Boolean));
  return Boolean(key) && stored.size === 1 && stored.has(key);
}

export function adpPostingsConflict(left: string | null | undefined, right: string | null | undefined): boolean {
  return isAdpPostingHost(left) && isAdpPostingHost(right)
    && (!adpPostingKey(left) || adpPostingKey(left) !== adpPostingKey(right));
}
