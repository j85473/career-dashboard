import type { Prisma } from '@prisma/client';

import { companyDisplayAliases } from './companyPresentation';
import { EMPLOYER_NAME_RULE, employerAliasKey, employerIdentityKey } from './employerIdentity';

/**
 * Every card of one employer. Cards carry their canonical employer; rows the
 * employer pass never resolves (triaged and archived history) are matched by
 * any spelling the registry knows for that employer. A common prefix is only
 * retrieval, never proof.
 */
export async function companyJobsWhere(
  company: string | null,
  store: Pick<Prisma.TransactionClient, 'job' | 'companyNameRule'>,
): Promise<Prisma.JobWhereInput | null> {
  const value = company?.trim();
  if (!value) return null;
  const rules = await store.companyNameRule.findMany({
    where: { standardName: value },
    select: { matchType: true, matchKey: true, evidence: true },
  });
  const keys = new Set([
    employerAliasKey(value),
    employerIdentityKey({ company: value }),
    ...rules.filter((rule) => rule.matchType === EMPLOYER_NAME_RULE).map((rule) => rule.matchKey),
  ].filter(Boolean));
  const learnedLabels = rules.flatMap((rule) => {
    const labels = (rule.evidence as { labels?: unknown } | null)?.labels;
    return Array.isArray(labels) ? labels.filter((label): label is string => typeof label === 'string') : [];
  });
  const aliases = [...new Set([...companyDisplayAliases(value), ...learnedLabels])];
  const prefixes = [...new Set(aliases.map(alias => alias.normalize('NFKD').replace(/\p{M}/gu, '')
    .match(/[a-zA-Z]{2,}/)?.[0].slice(0, 3)).filter((prefix): prefix is string => Boolean(prefix)))];
  const names = await store.job.groupBy({
    where: {
      employer: null,
      OR: [
        ...aliases.map(alias => ({ company: { equals: alias, mode: 'insensitive' as const } })),
        ...prefixes.map(prefix => ({ company: { contains: prefix, mode: 'insensitive' as const } })),
      ],
    },
    by: ['company'],
  });
  const unresolved = names
    .filter(row => keys.has(employerAliasKey(row.company)) || keys.has(employerIdentityKey({ company: row.company })))
    .map(row => row.company);
  return { OR: [{ employer: value }, ...(unresolved.length ? [{ employer: null, company: { in: unresolved } }] : [])] };
}
