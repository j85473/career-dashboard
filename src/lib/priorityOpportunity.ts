export const PROMPT_HEALTH_PRIORITY_BANNER = 'PROMPT HEALTH — REAPPLY IMMEDIATELY';
export const PROMPT_HEALTH_PRIORITY_REASON = '[Prompt Health priority override]';

type JobIdentity = {
  title?: string | null;
  company?: string | null;
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

