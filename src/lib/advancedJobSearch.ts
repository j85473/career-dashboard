import type { Prisma } from '@prisma/client';

export const ADVANCED_JOB_SEARCH_FIELDS = ['all', 'title', 'company', 'description'] as const;
export type AdvancedJobSearchField = typeof ADVANCED_JOB_SEARCH_FIELDS[number];

export const ADVANCED_JOB_SEARCH_STATUSES = [
  'inbox',
  'tailoring',
  'pending_af',
  'applied',
  'interviewing',
  'cooldown',
  'bookmarked',
  'archived',
  'expired',
  'passed',
  'dismissed',
] as const;
export type AdvancedJobSearchStatus = typeof ADVANCED_JOB_SEARCH_STATUSES[number];

const searchFieldSet = new Set<string>(ADVANCED_JOB_SEARCH_FIELDS);
const searchStatusSet = new Set<string>(ADVANCED_JOB_SEARCH_STATUSES);

export function isAdvancedJobSearchField(value: string | null): value is AdvancedJobSearchField {
  return value !== null && searchFieldSet.has(value);
}

export function parseAdvancedJobSearchStatuses(value: string | null): AdvancedJobSearchStatus[] {
  if (!value) return [];
  return [...new Set(value.split(',').map((status) => status.trim()).filter(
    (status): status is AdvancedJobSearchStatus => searchStatusSet.has(status),
  ))];
}

export function hasOnlyValidAdvancedJobSearchStatuses(value: string | null): boolean {
  if (!value) return true;
  const requested = value.split(',').map((status) => status.trim()).filter(Boolean);
  return requested.length > 0 && requested.every((status) => searchStatusSet.has(status));
}

function statusWhere(status: AdvancedJobSearchStatus): Prisma.JobWhereInput {
  if (status === 'inbox') return { status: 'inbox', tailoringStaged: false };
  if (status === 'tailoring') return { tailoringStaged: true };
  return { status };
}

export function advancedJobStatusWhere(
  statuses: readonly AdvancedJobSearchStatus[],
): Prisma.JobWhereInput {
  if (statuses.length === 0) return {};
  return { OR: statuses.map(statusWhere) };
}

export function jobMatchesAdvancedStatuses(
  job: { status: string; tailoringStaged?: boolean },
  statuses: readonly AdvancedJobSearchStatus[],
): boolean {
  if (statuses.length === 0) return true;
  return statuses.some((status) => {
    if (status === 'inbox') return job.status === 'inbox' && job.tailoringStaged !== true;
    if (status === 'tailoring') return job.tailoringStaged === true;
    return job.status === status;
  });
}
