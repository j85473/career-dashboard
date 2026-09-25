import type { Prisma } from '@prisma/client';

import {
  buildEmployerRuleIndex,
  resolveEmployer,
  type EmployerRuleIndex,
  type EmployerSubject,
} from './employerIdentity';
import { prisma } from './prisma';

let cachedIndex: { loadedAt: number; index: EmployerRuleIndex } | null = null;
const INDEX_TTL_MS = 5 * 60 * 1000;

export async function loadEmployerRuleIndex(
  store: Pick<Prisma.TransactionClient, 'companyNameRule'> = prisma,
  options: { fresh?: boolean } = {},
): Promise<EmployerRuleIndex> {
  const now = Date.now();
  if (!options.fresh && cachedIndex && now - cachedIndex.loadedAt < INDEX_TTL_MS) return cachedIndex.index;
  const rules = await store.companyNameRule.findMany({
    select: { matchType: true, matchKey: true, standardName: true, origin: true },
  });
  const index = buildEmployerRuleIndex(rules);
  cachedIndex = { loadedAt: now, index };
  return index;
}

/** For writers that create a Job; never fails the write. */
export async function resolveEmployerForNewJob(subject: EmployerSubject): Promise<string | null> {
  try {
    return resolveEmployer(subject, await loadEmployerRuleIndex());
  } catch (error) {
    console.error('[employer] could not resolve a new job\'s employer', error);
    return null;
  }
}
