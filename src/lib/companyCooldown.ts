import type { Prisma } from '@prisma/client';

import { companyIdentityKey } from './companyIdentity';
import { isManualImportSource, nonManualImportSourceWhere } from './manualImportPolicy';

export const COMPANY_COOLDOWN_DAYS = 21;
const ACTIVE_APPLICATION_STATUSES = ['applied', 'interviewing'] as const;

// Employer groups reviewed for the application cooldown. Keep this policy
// separate from display aliases: a presentation change must not silently park
// jobs, and shared cooldowns must not change posting identity or stored scores.
const COOLDOWN_EMPLOYER_GROUPS = [
  {
    employer: 'Zoetis',
    aliases: ['110 - Zoetis US LLC', '6J2 - Zoetis Services LLC', 'Zoetis US LLC', 'Zoetis Services LLC'],
  },
] as const;
const cooldownEmployerByAlias = new Map(COOLDOWN_EMPLOYER_GROUPS.flatMap(({ employer, aliases }) => (
  [employer, ...aliases].map(alias => [companyIdentityKey(alias), companyIdentityKey(employer)] as const)
)));

function cooldownCompanyKey(value: string | null | undefined): string {
  const key = companyIdentityKey(value);
  return cooldownEmployerByAlias.get(key) ?? key;
}

type CompanyCooldownStore = Pick<Prisma.TransactionClient, 'job'>;

type ApplicationAuthority = {
  id: string;
  company: string;
  decisionAt: Date;
  cooldownUntil: Date;
};

export type InboxAdmission = {
  status: string;
  cooldownUntil: Date | null;
  authorityJobId: string | null;
  authorityDecisionAt: Date | null;
};

export function companyCooldownUntil(decisionAt: Date): Date {
  return new Date(decisionAt.valueOf() + COMPANY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
}

/** The first transition in the current contiguous Applied/Interviewing run. */
export function activeApplicationDecisionAt(
  historiesNewestFirst: readonly { status: string; createdAt: Date }[],
  fallback: Date,
): Date {
  let decisionAt: Date | null = null;
  for (const history of historiesNewestFirst) {
    if ((ACTIVE_APPLICATION_STATUSES as readonly string[]).includes(history.status)) {
      decisionAt = history.createdAt;
      continue;
    }
    if (decisionAt) break;
  }
  return decisionAt || fallback;
}

async function activeApplicationAuthorities(
  store: CompanyCooldownStore,
  now: Date,
  excludeJobId?: string,
): Promise<ApplicationAuthority[]> {
  const jobs = await store.job.findMany({
    where: {
      status: { in: [...ACTIVE_APPLICATION_STATUSES] },
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
    },
    select: {
      id: true,
      company: true,
      updatedAt: true,
      statusHistory: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: { status: true, createdAt: true },
      },
    },
  });

  return jobs.flatMap((job) => {
    const company = cooldownCompanyKey(job.company);
    if (!company) return [];
    const decisionAt = activeApplicationDecisionAt(job.statusHistory, job.updatedAt);
    const cooldownUntil = companyCooldownUntil(decisionAt);
    return cooldownUntil > now ? [{ id: job.id, company, decisionAt, cooldownUntil }] : [];
  });
}

function latestAuthority(authorities: readonly ApplicationAuthority[]): ApplicationAuthority | null {
  return authorities.reduce<ApplicationAuthority | null>((latest, authority) => (
    !latest || authority.cooldownUntil > latest.cooldownUntil ? authority : latest
  ), null);
}

/**
 * Applies the same admission decision to every path that wants to enter Inbox.
 * Manual Imports remain user-controlled and bypass automated lifecycle policy.
 */
export async function resolveInboxAdmission(input: {
  jobId: string;
  company: string | null | undefined;
  source: string | null | undefined;
  proposedStatus: string;
  now: Date;
  store: CompanyCooldownStore;
}): Promise<InboxAdmission> {
  if (input.proposedStatus !== 'inbox' || isManualImportSource(input.source)) {
    return {
      status: input.proposedStatus,
      cooldownUntil: null,
      authorityJobId: null,
      authorityDecisionAt: null,
    };
  }

  const company = cooldownCompanyKey(input.company);
  if (!company) {
    return { status: 'inbox', cooldownUntil: null, authorityJobId: null, authorityDecisionAt: null };
  }
  const authorities = await activeApplicationAuthorities(input.store, input.now, input.jobId);
  const authority = latestAuthority(authorities.filter((candidate) => candidate.company === company));
  if (!authority) {
    return { status: 'inbox', cooldownUntil: null, authorityJobId: null, authorityDecisionAt: null };
  }
  return {
    status: 'cooldown',
    cooldownUntil: authority.cooldownUntil,
    authorityJobId: authority.id,
    authorityDecisionAt: authority.decisionAt,
  };
}

/** Park current Inbox rows after a user marks one employer job as active. */
export async function parkSameCompanyInboxJobs(input: {
  authorityJobId: string;
  company: string | null | undefined;
  decisionAt: Date;
  now: Date;
  store: CompanyCooldownStore;
}): Promise<string[]> {
  const company = cooldownCompanyKey(input.company);
  const cooldownUntil = companyCooldownUntil(input.decisionAt);
  if (!company || cooldownUntil <= input.now) return [];

  const candidates = await input.store.job.findMany({
    where: {
      id: { not: input.authorityJobId },
      status: 'inbox',
      AND: [nonManualImportSourceWhere()],
    },
    select: { id: true, company: true },
  });
  const cooledIds: string[] = [];
  for (const candidate of candidates) {
    if (cooldownCompanyKey(candidate.company) !== company) continue;
    const cooled = await input.store.job.updateMany({
      where: {
        id: candidate.id,
        status: 'inbox',
        AND: [nonManualImportSourceWhere()],
      },
      data: { status: 'cooldown', cooldownUntil },
    });
    if (cooled.count === 1) cooledIds.push(candidate.id);
  }
  return cooledIds;
}

/** Repair only current Inbox rows; prior decisions and scores are untouched. */
export async function reconcileCompanyCooldowns(input: {
  now: Date;
  store: CompanyCooldownStore;
}): Promise<string[]> {
  const authorities = await activeApplicationAuthorities(input.store, input.now);
  if (authorities.length === 0) return [];
  const authorityByCompany = new Map<string, ApplicationAuthority>();
  for (const authority of authorities) {
    const current = authorityByCompany.get(authority.company);
    if (!current || authority.cooldownUntil > current.cooldownUntil) {
      authorityByCompany.set(authority.company, authority);
    }
  }

  const candidates = await input.store.job.findMany({
    where: { status: 'inbox', AND: [nonManualImportSourceWhere()] },
    select: { id: true, company: true },
  });
  const cooledIds: string[] = [];
  for (const candidate of candidates) {
    const authority = authorityByCompany.get(cooldownCompanyKey(candidate.company));
    if (!authority || authority.id === candidate.id) continue;
    const cooled = await input.store.job.updateMany({
      where: {
        id: candidate.id,
        status: 'inbox',
        AND: [nonManualImportSourceWhere()],
      },
      data: { status: 'cooldown', cooldownUntil: authority.cooldownUntil },
    });
    if (cooled.count === 1) cooledIds.push(candidate.id);
  }
  return cooledIds;
}
