import type { Prisma } from '@prisma/client';
import { companyDisplayAliases, companyDisplayGroupKey } from './companyPresentation';

/** Resolve saved spellings before pagination; a common prefix is never proof. */
export async function companyJobsWhere(
  company: string | null,
  store: Pick<Prisma.TransactionClient, 'job'>,
): Promise<Prisma.JobWhereInput | null> {
  const value = company?.trim();
  if (!value) return null;
  const aliases = companyDisplayAliases(value);
  const prefixes = [...new Set(aliases.map(alias => alias.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .match(/[a-zA-Z]{2,}/)?.[0].slice(0, 3)).filter((prefix): prefix is string => Boolean(prefix)))];
  const names = await store.job.groupBy({
    where: { OR: [
      ...aliases.map(alias => ({ company: { equals: alias, mode: 'insensitive' as const } })),
      ...prefixes.map(prefix => ({ company: { contains: prefix, mode: 'insensitive' as const } })),
    ] },
    by: ['company'],
  });
  const key = companyDisplayGroupKey(value);
  const matched = names.filter(row => companyDisplayGroupKey(row.company) === key).map(row => row.company);
  return { company: { in: matched } };
}
