import type { Prisma } from '@prisma/client';

export const DEFAULT_JOB_PAGE_SIZE = 48;
export const MAX_JOB_PAGE_SIZE = 100;

const ACTIVE_SCORING_STATUSES = ['pending_af', 'inbox'] as const;

export function positiveInteger(value: string | null, fallback: number, maximum?: number) {
  const parsed = Number.parseInt(value || '', 10);
  const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return maximum ? Math.min(safe, maximum) : safe;
}

export function logWhere(logTab: string): Prisma.JobWhereInput {
  const activeJob = { status: { in: [...ACTIVE_SCORING_STATUSES] } };
  switch (logTab) {
    case 'needs_jd':
      return { ...activeJob, OR: [{ scoringStatus: 'needs_jd' }, { jdBatchId: { not: null } }] };
    case 'context':
      return { status: { in: ['passed', 'applied'] }, contextBatched: false };
    case 'aim_fit':
      return {
        status: { in: ['pending_af', 'inbox'] },
        scoringStatus: 'scored',
        afBatchId: null,
        aimFitScore: null,
      };
    case 'graveyard':
      return { ...activeJob, scoringStatus: { in: ['failed', 'skipped'] } };
    case 'review':
    default:
      return { ...activeJob, fitCategory: 'review' };
  }
}

export function jobWhere(status: string, logTab: string): Prisma.JobWhereInput {
  if (status === 'log') return logWhere(logTab);
  if (status === 'dismissed') return { status: 'dismissed' };
  if (status === 'lucky_inbox') {
    return {
      luckyStatus: 'inbox',
      status: { in: ['pending_af', 'inbox', 'bookmarked', 'dismissed'] },
    };
  }
  if (status === 'lucky_dismissed') return { luckyStatus: 'dismissed' };
  if (status === 'tailoring') return { tailoringStaged: true };
  if (status === 'cooldown') return { OR: [{ status: 'cooldown' }, { luckyStatus: 'cooldown' }] };
  if (status === 'inbox') {
    return {
      status: 'inbox',
      tailoringStaged: false,
      luckyStatus: { not: 'inbox' },
      aimFitScore: { not: null },
    };
  }
  return { status };
}

export function jobOrder(status: string, sort: string): Prisma.JobOrderByWithRelationInput[] {
  const stableOrder: Prisma.JobOrderByWithRelationInput = { id: 'asc' };
  const dateField = status === 'applied' ? 'updatedAt' : 'createdAt';
  switch (sort) {
    case 'newest':
      return [{ [dateField]: 'desc' }, stableOrder];
    case 'oldest':
      return [{ [dateField]: 'asc' }, stableOrder];
    case 'experience_fit':
      return [{ reqFitScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, stableOrder];
    case 'travel_fit':
      return [{ travelScore: { sort: 'asc', nulls: 'last' } }, { aimFitScore: { sort: 'desc', nulls: 'last' } }, stableOrder];
    case 'aim_fit':
    default:
      if (status === 'lucky_inbox' || status === 'lucky_dismissed') {
        return [{ luckyAimFitScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, stableOrder];
      }
      return [{ aimFitScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, stableOrder];
  }
}
