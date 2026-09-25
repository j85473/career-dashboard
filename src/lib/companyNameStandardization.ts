import type { Prisma } from '@prisma/client';

import { companyIdentityKey, withoutEntityCode } from './companyIdentity';
import { reviewedCompanyName } from './companyPresentation';
import {
  EMPLOYER_LABEL_RULE,
  EMPLOYER_NAME_RULE,
  MANUAL_RULE_ORIGIN,
  employerAliasKey,
  employerLabelKey,
  presentableEmployerName,
} from './employerIdentity';
import { COMPANY_EMPLOYER_URL_RULE, employerUrlKey } from './employerUrl';

export const COMPANY_ALIAS_RULE = 'alias';
export { COMPANY_EMPLOYER_URL_RULE, employerUrlKey } from './employerUrl';

type CompanyRuleStore = Pick<Prisma.TransactionClient, 'companyNameRule'>;

// Bootstrap rules reviewed from the existing Dashboard. Later explicit edits
// persist through CompanyNameRule; these entries make the already-chosen
// Acosta standard effective immediately without mutating historical Job rows.
export const REVIEWED_EMPLOYER_URL_NAMES: ReadonlyMap<string, string> = new Map<string, string>([
  ['host:acosta.jobs', 'Acosta'],
  ['oracle:eczy.fa.us2.oraclecloud.com:site:cx_1', 'Acosta'],
]);

function cleanCompanyName(value: string | null | undefined): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
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
      // Only Joseph's corrections change the stored company, which is a
      // scoring input. Learned links set `Job.employer` instead.
      where: { OR: keys, origin: MANUAL_RULE_ORIGIN },
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
  // Workday tenants often publish a coded legal entity ("USA-NILIN Nilfisk,
  // Inc."). Store the employer name without the code; other sources keep
  // their label because a leading number there is usually part of the brand.
  const workdayHosted = keys.some(key => key.matchKey.startsWith('workday:'));
  return reviewedCompanyName(incoming) || reviewedUrlName
    || (workdayHosted ? withoutEntityCode(incoming) : incoming);
}

type RuleKey = { matchType: string; matchKey: string };

async function upsertManualRules(store: CompanyRuleStore, keys: readonly RuleKey[], standardName: string, jobId: string) {
  const unique = keys.filter((item, index, all) => item.matchKey && all.findIndex(candidate =>
    candidate.matchType === item.matchType && candidate.matchKey === item.matchKey) === index);
  for (const key of unique) {
    await store.companyNameRule.upsert({
      where: { matchType_matchKey: key },
      update: { standardName, provenanceJobId: jobId, origin: MANUAL_RULE_ORIGIN, evidence: undefined },
      create: { ...key, standardName, provenanceJobId: jobId, origin: MANUAL_RULE_ORIGIN },
    });
  }
}

/**
 * Joseph renamed a card's employer. Every spelling of that employer takes the
 * new name: the card's own spelling, the name it showed until now
 * (`priorEmployer`), and any employer-owned URL on the card. No Job is
 * rewritten here; the employer pass applies the name to every card.
 */
export async function recordCompanyNameCorrection(
  store: CompanyRuleStore,
  input: {
    priorName: string;
    standardName: string;
    jobId: string;
    url?: string | null;
    canonicalUrl?: string | null;
    priorEmployer?: string | null;
  },
): Promise<void> {
  const standardName = cleanCompanyName(input.standardName);
  if (!standardName) return;
  await upsertManualRules(store, [
    ...ruleKeys({ company: input.priorName, url: input.url, canonicalUrl: input.canonicalUrl }),
    ...ruleKeys({ company: standardName, url: input.url, canonicalUrl: input.canonicalUrl }),
    { matchType: EMPLOYER_LABEL_RULE, matchKey: employerLabelKey(input.priorName) },
    { matchType: EMPLOYER_LABEL_RULE, matchKey: employerLabelKey(standardName) },
    { matchType: EMPLOYER_NAME_RULE, matchKey: employerAliasKey(input.priorName) },
    { matchType: EMPLOYER_NAME_RULE, matchKey: employerAliasKey(standardName) },
    ...(input.priorEmployer ? [{ matchType: EMPLOYER_NAME_RULE, matchKey: employerAliasKey(input.priorEmployer) }] : []),
  ], standardName, input.jobId);
}

/**
 * Joseph says this card's spelling is a different employer from the one it
 * was grouped under. The spelling keeps its own name, and the group keeps its
 * name, so no learned link can join them again.
 */
export async function recordEmployerSplit(
  store: CompanyRuleStore,
  input: { company: string; groupEmployer: string; jobId: string },
): Promise<string> {
  const ownName = presentableEmployerName(input.company) || cleanCompanyName(input.company);
  const ownKey = employerAliasKey(input.company);
  const groupKey = employerAliasKey(input.groupEmployer);
  await upsertManualRules(store, [
    { matchType: EMPLOYER_LABEL_RULE, matchKey: employerLabelKey(input.company) },
    // Two businesses whose names clean up alike ("Flex" / "The Flex Company")
    // share a key; then only the exact spelling can be pinned.
    ...(ownKey && ownKey !== groupKey ? [{ matchType: EMPLOYER_NAME_RULE, matchKey: ownKey }] : []),
  ], ownName, input.jobId);
  if (groupKey && groupKey !== ownKey) {
    await upsertManualRules(store, [{ matchType: EMPLOYER_NAME_RULE, matchKey: groupKey }], input.groupEmployer, input.jobId);
  }
  return ownName;
}
