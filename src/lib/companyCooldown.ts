import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { appliedIdentityFingerprint } from './appliedDuplicateIdentity';
import { findAppliedDuplicateEvidence } from './appliedDuplicateStore';
import { buildAppliedDuplicateReason, type AppliedDuplicateAuthorityJob } from './appliedDuplicatePolicy';
import { recordJobPipelineEvent } from './ingestionControl';

import { companyIdentityKey } from './companyIdentity';
import { isManualImportSource, nonManualImportSourceWhere } from './manualImportPolicy';

export const COMPANY_COOLDOWN_DAYS = 21;
const ACTIVE_APPLICATION_STATUSES = ['applied', 'interviewing'] as const;

// Recruiter listings can represent different employers. Applying through
// Jobgether must not put its other listings into a company-wide cooldown.
const COOLDOWN_EXEMPT_COMPANIES = new Set(['jobgether']);

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
  if (COOLDOWN_EXEMPT_COMPANIES.has(key)) return '';
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
  appliedDuplicate?: AppliedDuplicateAuthorityJob;
  passReason?: string;
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
  title: string;
  location: string | null;
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

  // Reposts are an all-time application decision, independent of the employer's
  // temporary cooldown. Evaluate the proposed Inbox state so a Cooldown row
  // cannot bypass this check merely because its current status is protected.
  const appliedDuplicate = await findAppliedDuplicateEvidence({
    id: input.jobId,
    identityFingerprint: appliedIdentityFingerprint({
      title: input.title, company: input.company || '', location: input.location,
    }),
    location: input.location,
    status: 'inbox',
  }, input.store);
  if (appliedDuplicate) {
    return {
      status: 'dismissed',
      cooldownUntil: null,
      authorityJobId: appliedDuplicate.id,
      authorityDecisionAt: null,
      appliedDuplicate,
      passReason: buildAppliedDuplicateReason(appliedDuplicate),
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

/** Record the application decision behind a blocked admission in the same
 * transaction as the lifecycle write. Scores remain valid and untouched.
 */
export async function recordAppliedRepostAdmission(
  input: { jobId: string; source: string | null | undefined; admission: InboxAdmission },
  store: Pick<Prisma.TransactionClient, 'jobPipelineEvent'>,
): Promise<void> {
  const authority = input.admission.appliedDuplicate;
  if (!authority) return;
  await recordJobPipelineEvent({
    eventType: 'user_lifecycle',
    jobId: input.jobId,
    stage: 'human_decision',
    source: input.source || null,
    identityParts: ['applied_repost_admission', authority.id, input.jobId, randomUUID()],
    details: {
      actor: 'user', protected: true, derived: true,
      originDecisionJobId: authority.id,
      originDecisionStatus: authority.status,
      duplicateReason: input.admission.passReason,
      nextStatus: 'dismissed',
    },
  }, store);
}
