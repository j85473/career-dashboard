/**
 * Stable employer-owned site identity: the ATS board or careers host a posting
 * came from. Shared by company-name standardization and employer identity.
 */

export const COMPANY_EMPLOYER_URL_RULE = 'employer_url';

const NON_EMPLOYER_HOSTS = [
  'adzuna.com',
  'careerforce.mn.gov',
  'dejobs.org',
  'glassdoor.com',
  'himalayas.app',
  'indeed.com',
  'jobicy.com',
  'jobsyn.org',
  'linkedin.com',
  'rapidapi.com',
  'ziprecruiter.com',
] as const;

// These providers can host many unrelated employers on one hostname. Unless a
// tenant parser above can isolate the board, the hostname is not company proof.
const UNPARSED_SHARED_ATS_HOSTS = [
  'adp.com',
  'applytojob.com',
  'dayforcehcm.com',
  'eightfold.ai',
  'icims.com',
  'jobvite.com',
  'paycomonline.net',
  'paylocity.com',
  'phenompeople.com',
  'successfactors.com',
  'taleo.net',
  'ultipro.com',
] as const;

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function pathSegmentAfter(segments: string[], marker: string): string | null {
  const index = segments.findIndex(segment => segment.toLowerCase() === marker);
  const value = index >= 0 ? segments[index + 1]?.trim().toLowerCase() : '';
  return value || null;
}

/**
 * Stable employer-owned site identity, never a posting identity.
 *
 * Shared ATS hosts retain their tenant/board key. A custom employer domain is
 * accepted only when it is not a known aggregator. This key can standardize a
 * label, but it is deliberately never sufficient to merge two job postings.
 */
export function employerUrlKey(value: string | null | undefined): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!hostname || NON_EMPLOYER_HOSTS.some(domain => hostMatches(hostname, domain))) return null;
  const segments = url.pathname.split('/').filter(Boolean);

  if (hostMatches(hostname, 'oraclecloud.com')) {
    const site = pathSegmentAfter(segments, 'sites');
    return site ? `oracle:${hostname}:site:${site}` : null;
  }
  if (hostMatches(hostname, 'myworkdayjobs.com') || hostMatches(hostname, 'myworkdaysite.com')) {
    return `workday:${hostname}`;
  }
  if (/^(?:job-boards|boards)\.greenhouse\.io$/.test(hostname)) {
    return segments[0] ? `greenhouse:${segments[0].toLowerCase()}` : null;
  }
  if (/^jobs\.(?:eu\.)?lever\.co$/.test(hostname)) {
    return segments[0] ? `lever:${segments[0].toLowerCase()}` : null;
  }
  if (hostname === 'jobs.ashbyhq.com') {
    return segments[0] ? `ashby:${segments[0].toLowerCase()}` : null;
  }
  if (/^(?:jobs|careers)\.smartrecruiters\.com$/.test(hostname)) {
    return segments[0] ? `smartrecruiters:${segments[0].toLowerCase()}` : null;
  }
  if (hostname === 'apply.workable.com') {
    return segments[0] ? `workable:${segments[0].toLowerCase()}` : null;
  }
  for (const [suffix, platform] of [
    ['.recruitee.com', 'recruitee'],
    ['.breezy.hr', 'breezy'],
    ['.teamtailor.com', 'teamtailor'],
    ['.pinpointhq.com', 'pinpoint'],
    ['.bamboohr.com', 'bamboohr'],
  ] as const) {
    if (!hostname.endsWith(suffix)) continue;
    const tenant = hostname.slice(0, -suffix.length).split('.').at(-1);
    return tenant ? `${platform}:${tenant}` : null;
  }
  if (UNPARSED_SHARED_ATS_HOSTS.some(domain => hostMatches(hostname, domain))) return null;
  return `host:${hostname}`;
}
