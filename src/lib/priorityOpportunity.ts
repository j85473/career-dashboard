export const PROMPT_HEALTH_PRIORITY_BANNER = 'PROMPT HEALTH — REAPPLY IMMEDIATELY';
export const PROMPT_HEALTH_PRIORITY_REASON = '[Prompt Health priority override]';

export type JobIdentity = {
  title?: string | null;
  company?: string | null;
  employer?: string | null;
  url?: string | null;
  canonicalUrl?: string | null;
};

function normalizedCompany(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+(?:incorporated|inc|llc|ltd|corporation|corp)$/i, '')
    .trim();
}

export function isPromptHealthCompany(company?: string | null): boolean {
  if (!company?.trim()) return false;
  return new Set([
    'prompt',
    'prompt health',
    'prompt therapy solutions',
  ]).has(normalizedCompany(company));
}

export function isPromptHealthPriorityRole(job: JobIdentity): boolean {
  if (!isPromptHealthCompany(job.company) || !job.title?.trim()) return false;
  return /\baccount\s+(?:executive|manager)\b/i.test(job.title)
    || /\bAE\b/.test(job.title);
}


export const ACOSTA_CHANNEL_SALES_PRIORITY_BANNER = 'ACOSTA / MOSAIC — CHANNEL SALES';
export const ACOSTA_CHANNEL_SALES_PRIORITY_REASON = 'Priority opportunity: Acosta / Mosaic channel sales';

// The production Oracle tenant is shared by Acosta's CX, CX_1 and CX_2 sites.
// Exact identities keep unrelated Mosaic businesses and Oracle test tenants out.
export function isAcostaPostingUrl(value?: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'eczy.fa.us2.oraclecloud.com'
      && /^\/hcmUI\/CandidateExperience\/[^/]+\/sites\/CX(?:_[12])?(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

export function isAcostaChannelSalesPriorityRole(job: JobIdentity): boolean {
  if (!/\bchannel\s+sales\b/i.test(job.title || '')) return false;
  const aliases = new Set([
    'acosta', 'acosta group', 'jobs at acosta', 'acosta sales and marketing',
    'mosaic north america', 'mosaic sales solutions',
  ]);
  return [job.company, job.employer].some((name) => name && aliases.has(normalizedCompany(name)))
    || isAcostaPostingUrl(job.canonicalUrl) || isAcostaPostingUrl(job.url);
}

/** New arrivals only: no existing decision or score is rewritten. */
export function acostaPriorityInitialLifecycle(job: JobIdentity, closed = false, appliedRepeat = false) {
  return !closed && !appliedRepeat && isAcostaChannelSalesPriorityRole(job)
    ? { status: 'inbox' as const, scoringStatus: 'skipped' as const, passReason: ACOSTA_CHANNEL_SALES_PRIORITY_REASON }
    : null;
}
