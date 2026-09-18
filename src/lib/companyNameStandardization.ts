import type { Prisma } from '@prisma/client';

import { companyIdentityKey } from './companyIdentity';
import { reviewedCompanyName } from './companyPresentation';

export const COMPANY_ALIAS_RULE = 'alias';
export const COMPANY_EMPLOYER_URL_RULE = 'employer_url';

type CompanyRuleStore = Pick<Prisma.TransactionClient, 'companyNameRule'>;

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

// Bootstrap rules reviewed from the existing Dashboard. Later explicit edits
// persist through CompanyNameRule; these entries make the already-chosen
// Acosta standard effective immediately without mutating historical Job rows.
const REVIEWED_EMPLOYER_URL_NAMES = new Map<string, string>([
  ['host:acosta.jobs', 'Acosta'],
  ['oracle:eczy.fa.us2.oraclecloud.com:site:cx_1', 'Acosta'],
]);

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function cleanCompanyName(value: string | null | undefined): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
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

function ruleKeys(input: {
  company: string;
  url?: string | null;
  canonicalUrl?: string | null;
}): Array<{ matchType: string; matchKey: string }> {
  const keys: Array<{ matchType: string; matchKey: string }> = [];
  const alias = companyIdentityKey(input.company);
  if (alias) keys.push({ matchType: COMPANY_ALIAS_RULE, matchKey: alias });
  for (const value of [input.canonicalUrl, input.url]) {
    const key = employerUrlKey(value);
    if (key && !keys.some(item => item.matchType === COMPANY_EMPLOYER_URL_RULE && item.matchKey === key)) {
      keys.push({ matchType: COMPANY_EMPLOYER_URL_RULE, matchKey: key });
    }
  }
  return keys;
}

/** Resolve a new observation before fingerprints, dedupe, and persistence. */
export async function standardizeIncomingCompany(
  input: { company: string; url?: string | null; canonicalUrl?: string | null },
  store: CompanyRuleStore,
): Promise<string> {
  const incoming = cleanCompanyName(input.company) || 'Unknown Company';
  const keys = ruleKeys({ ...input, company: incoming });
  const rules = keys.length > 0
    ? await store.companyNameRule.findMany({
      where: { OR: keys },
      select: { standardName: true },
      take: keys.length + 1,
    })
    : [];
  const names = [...new Set(rules.map(rule => cleanCompanyName(rule.standardName)).filter(Boolean))];
  // Conflicting explicit rules indicate an identity problem. Preserve the
  // source label instead of silently choosing one company's name over another.
  if (names.length === 1) return names[0];
  if (names.length > 1) return incoming;
  const reviewedUrlName = keys
    .filter(key => key.matchType === COMPANY_EMPLOYER_URL_RULE)
    .map(key => REVIEWED_EMPLOYER_URL_NAMES.get(key.matchKey))
    .find(Boolean);
  return reviewedCompanyName(incoming) || reviewedUrlName || incoming;
}

/**
 * Teach future ingestion from an explicit user correction. Both spellings and
 * any employer-owned URL on the edited card point at the chosen standard name.
 * No existing Job is rewritten here.
 */
export async function recordCompanyNameCorrection(
  store: CompanyRuleStore,
  input: {
    priorName: string;
    standardName: string;
    jobId: string;
    url?: string | null;
    canonicalUrl?: string | null;
  },
): Promise<void> {
  const standardName = cleanCompanyName(input.standardName);
  if (!standardName) return;
  const keys = [
    ...ruleKeys({ company: input.priorName, url: input.url, canonicalUrl: input.canonicalUrl }),
    ...ruleKeys({ company: standardName, url: input.url, canonicalUrl: input.canonicalUrl }),
  ].filter((item, index, all) => all.findIndex(candidate =>
    candidate.matchType === item.matchType && candidate.matchKey === item.matchKey) === index);

  for (const key of keys) {
    await store.companyNameRule.upsert({
      where: { matchType_matchKey: key },
      update: { standardName, provenanceJobId: input.jobId },
      create: { ...key, standardName, provenanceJobId: input.jobId },
    });
  }
}
