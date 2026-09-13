import type { Prisma } from '@prisma/client';

import { prisma } from './prisma';
import {
  judgeAppliedRepeat,
  mayRepeat,
  repeatTitleKey,
  selectAppliedRepeat,
  type AppliedRepeatEvidence,
  type RepeatSubject,
} from './appliedRepeatMatch';
import {
  ALREADY_APPLIED_REASON,
  buildAppliedDuplicateReason,
  APPLIED_DUPLICATE_AUTHORITY_STATUSES,
  isAppliedDuplicateAuthorityEvidence,
  isUnreliableLocation,
  planAppliedDuplicateSuppression,
  V4_FINGERPRINT_PREFIX,
  type AppliedDuplicateAuthorityJob,
  type DuplicateCandidate,
} from './appliedDuplicatePolicy';
import type { ProtectedAppliedIdentityCandidate } from './appliedDuplicateIdentity';
import { isManualImportSource, nonManualImportSourceWhere } from './manualImportPolicy';
import { recordJobPipelineEvent } from './ingestionControl';
import { latestUserLifecycleIntent, USER_LIFECYCLE_INTENT_EVENT_TYPES } from './userLifecycleAuthority';

type JobStore = Pick<Prisma.TransactionClient, 'job'>;
type DuplicateSuppressionStore = Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

const evidenceWhere = {
  OR: [
    { status: { in: [...APPLIED_DUPLICATE_AUTHORITY_STATUSES] } },
    { passReason: ALREADY_APPLIED_REASON },
  ],
};

/**
 * Matches one identity in either column. The incoming value is always a freshly
 * generated v4 hash, so the legacy arm can only ever match a row that stored
 * that exact v4 string — a retired `v3:` or md5 value cannot collide with it.
 */
const identityWhere = (identityFingerprint: string) => ({
  OR: [{ identityFingerprint }, { fingerprint: identityFingerprint }],
});

/** Rows able to act as authority at all: an identity in either column. */
const anyIdentityWhere = {
  OR: [
    { identityFingerprint: { not: null } },
    { fingerprint: { startsWith: V4_FINGERPRINT_PREFIX } },
  ],
};

const authoritySelect = {
  id: true,
  identityFingerprint: true,
  fingerprint: true,
  status: true,
  company: true,
  title: true,
  location: true,
  passReason: true,
} as const;

export async function listAppliedDuplicateEvidence(
  store: JobStore = prisma,
): Promise<AppliedDuplicateAuthorityJob[]> {
  return store.job.findMany({
    where: { AND: [anyIdentityWhere, evidenceWhere] },
    select: authoritySelect,
  });
}

export async function listUncoveredProtectedAppliedEvidence(
  store: JobStore = prisma,
): Promise<ProtectedAppliedIdentityCandidate[]> {
  return store.job.findMany({
    where: {
      identityFingerprint: null,
      OR: [
        { status: { in: [...APPLIED_DUPLICATE_AUTHORITY_STATUSES] } },
        { passReason: ALREADY_APPLIED_REASON },
      ],
    },
    select: {
      ...authoritySelect,
      updatedAt: true,
    },
  });
}

/**
 * Finds all-time affirmative application authority for the same display
 * identity. Stable source, requisition, URL, and exact-description matches are
 * handled earlier by the ordinary ingestion deduper; this is the deliberate
 * fallback for postings that reappear under changed source identity. Passed
 * and Cooldown rows are excluded even when they have stored fingerprints.
 */
export async function findAppliedDuplicateEvidence(
  candidate: DuplicateCandidate & { location: string | null },
  store: JobStore = prisma,
): Promise<AppliedDuplicateAuthorityJob | null> {
  if (!candidate.identityFingerprint || isUnreliableLocation(candidate.location)) return null;

  const authorities = await store.job.findMany({
    where: { AND: [identityWhere(candidate.identityFingerprint), evidenceWhere] },
    select: authoritySelect,
  });
  const [plan] = planAppliedDuplicateSuppression([candidate], authorities);
  return plan ? authorities.find((job) => job.id === plan.duplicateOfJobId) || null : null;
}

// ---------------------------------------------------------------------------
// Same-role repeats (appliedRepeatMatch.ts)

/** Machine-owned states a repeat can be dismissed from. Cooldown stays protected and is checked when it ends. */
export const APPLIED_REPEAT_CANDIDATE_STATUSES = ['inbox', 'pending_af'] as const;
/** Recorded by "Not a repeat" so the same pair is never hidden again. */
export const APPLIED_REPEAT_EXCEPTION_EVENT = 'applied_repeat_exception' as const;

type RepeatStore = Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

export type AppliedRepeatAuthority = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  status: string;
  passReason: string | null;
};

export type AppliedRepeatMatch = {
  authority: AppliedRepeatAuthority;
  evidence: AppliedRepeatEvidence;
  reason: string;
};

const repeatAuthoritySelect = {
  id: true, title: true, company: true, location: true, status: true, passReason: true,
} as const;

export async function listAppliedRepeatAuthorities(store: Pick<Prisma.TransactionClient, 'job'> = prisma): Promise<AppliedRepeatAuthority[]> {
  return store.job.findMany({ where: evidenceWhere, select: repeatAuthoritySelect });
}

const INGESTION_AUTHORITY_TTL_MS = 60_000;
let ingestionAuthorityCache: { loadedAt: number; byTitle: Promise<Map<string, AppliedRepeatAuthority[]>> } | null = null;

/**
 * Ingestion asks once per new posting, thousands of times a run. A minute-old
 * authority list is safe there: a repeat that slips past it is still stopped
 * at the Inbox door, which always reads fresh.
 */
function cachedIngestionAuthoritiesByTitle(): Promise<Map<string, AppliedRepeatAuthority[]>> {
  const now = Date.now();
  if (!ingestionAuthorityCache || now - ingestionAuthorityCache.loadedAt > INGESTION_AUTHORITY_TTL_MS) {
    const byTitle = listAppliedRepeatAuthorities()
      .then((rows) => {
        const index = new Map<string, AppliedRepeatAuthority[]>();
        for (const row of rows) {
          const key = repeatTitleKey(row.title);
          index.set(key, [...(index.get(key) || []), row]);
        }
        return index;
      })
      .catch((error: unknown) => {
        ingestionAuthorityCache = null;
        throw error;
      });
    ingestionAuthorityCache = { loadedAt: now, byTitle };
  }
  return ingestionAuthorityCache.byTitle;
}

export async function repeatExceptionAuthorityIds(store: Pick<Prisma.TransactionClient, 'jobPipelineEvent'>, jobId: string): Promise<Set<string>> {
  const events = await store.jobPipelineEvent.findMany({
    where: { jobId, eventType: APPLIED_REPEAT_EXCEPTION_EVENT },
    select: { details: true },
  });
  return new Set(events.flatMap((event) => {
    const details = event.details as Record<string, unknown> | null;
    return typeof details?.authorityJobId === 'string' ? [details.authorityJobId] : [];
  }));
}

/**
 * True when Joseph's own latest lifecycle action is on this job (promote,
 * restore, pass, …). Events derived from a decision on another job — an
 * earlier repeat dismissal — do not count as his action on this one.
 */
export async function hasOwnLifecycleDecision(store: Pick<Prisma.TransactionClient, 'jobPipelineEvent'>, jobId: string): Promise<boolean> {
  const events = await store.jobPipelineEvent.findMany({
    where: { jobId, eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { id: true, eventType: true, occurredAt: true, details: true },
  });
  const intent = latestUserLifecycleIntent(events);
  if (intent.kind !== 'final') return false;
  const details = events[0]?.details as Record<string, unknown> | null;
  return details?.derived !== true;
}

function reasonFor(authority: AppliedRepeatAuthority): string {
  return buildAppliedDuplicateReason({ ...authority, identityFingerprint: null });
}

/**
 * The strongest applied job this posting repeats, or null.
 *
 * Descriptions are read only for authorities whose employer and title already
 * agree, so the common no-match case never loads a job description.
 */
export async function findAppliedRepeat(
  candidate: RepeatSubject & { source?: string | null },
  store: Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'> = prisma,
  options: { authorities?: readonly AppliedRepeatAuthority[]; persisted?: boolean } = {},
): Promise<AppliedRepeatMatch | null> {
  if (isManualImportSource(candidate.source)) return null;
  const authorities = options.authorities ?? await listAppliedRepeatAuthorities(store);
  let pool = authorities.filter((authority) => authority.id !== candidate.id && mayRepeat(candidate, authority));
  if (pool.length === 0) return null;
  if (options.persisted !== false) {
    const excluded = await repeatExceptionAuthorityIds(store, candidate.id);
    pool = pool.filter((authority) => !excluded.has(authority.id));
    if (pool.length === 0) return null;
  }
  const descriptions = await store.job.findMany({
    where: { id: { in: pool.map((authority) => authority.id) } },
    select: { id: true, description: true },
  });
  const descriptionById = new Map(descriptions.map((row) => [row.id, row.description]));
  const best = selectAppliedRepeat(
    candidate,
    pool.map((authority) => ({ ...authority, description: descriptionById.get(authority.id) ?? null })),
  );
  if (!best) return null;
  const { description: _description, ...authority } = best.authority;
  void _description;
  return { authority, evidence: best.evidence, reason: reasonFor(authority) };
}

/** New postings, before the row exists. Uses the short-lived authority cache. */
export async function findAppliedRepeatForIngestion(
  candidate: Omit<RepeatSubject, 'id'> & { source?: string | null },
): Promise<AppliedRepeatMatch | null> {
  const sameTitle = (await cachedIngestionAuthoritiesByTitle()).get(repeatTitleKey(candidate.title)) || [];
  if (sameTitle.length === 0) return null;
  return findAppliedRepeat(
    { ...candidate, id: 'incoming-job' },
    prisma,
    { authorities: sameTitle, persisted: false },
  );
}

/**
 * The Inbox door for machine paths. Manual Imports and jobs Joseph has acted
 * on himself are never dismissed automatically.
 */
export async function findAppliedRepeatForJob(
  jobId: string,
  store: RepeatStore,
  options: { authorities?: readonly AppliedRepeatAuthority[] } = {},
): Promise<AppliedRepeatMatch | null> {
  const job = await store.job.findUnique({
    where: { id: jobId },
    select: { id: true, title: true, company: true, location: true, description: true, source: true },
  });
  if (!job || isManualImportSource(job.source)) return null;
  if (await hasOwnLifecycleDecision(store, jobId)) return null;
  return findAppliedRepeat(job, store, { authorities: options.authorities });
}

/**
 * Dismissal fields for a repeat. Scores are never touched: a job that already
 * has a score keeps its scoring state, and only a job with no score is marked
 * so scoring skips it.
 */
export function appliedRepeatDismissalData(
  job: { scoringStatus: string; aimFitScore: number | null; reqFitScore: number | null },
  reason: string,
): Prisma.JobUpdateManyMutationInput {
  const unscored = job.aimFitScore === null
    && job.reqFitScore === null
    && ['queued', 'needs_jd', 'failed', 'skipped'].includes(job.scoringStatus);
  return {
    status: 'dismissed',
    passReason: reason,
    ...(unscored ? { scoringStatus: 'skipped', scoreError: null } : {}),
  };
}

/**
 * Records the dismissal as derived from Joseph's application. The derived
 * user event is what lets the lifecycle invariant accept a scored job sitting
 * in Dismissed, and it carries the evidence so a wrong call can be traced.
 */
export async function recordAppliedRepeatDismissal(
  store: Pick<Prisma.TransactionClient, 'jobPipelineEvent'>,
  input: {
    jobId: string;
    source: string | null;
    sourceId?: string | null;
    priorStatus: string;
    match: AppliedRepeatMatch;
    route: string;
  },
): Promise<void> {
  await recordJobPipelineEvent({
    eventType: 'user_lifecycle',
    jobId: input.jobId,
    stage: 'human_decision',
    source: input.source,
    sourceId: input.sourceId || null,
    identityParts: ['applied_duplicate_suppression', input.match.authority.id, input.jobId],
    details: {
      actor: 'user',
      protected: true,
      derived: true,
      originDecisionJobId: input.match.authority.id,
      originDecisionStatus: input.match.authority.status,
      duplicateReason: input.match.reason,
      priorStatus: input.priorStatus,
      nextStatus: 'dismissed',
      route: input.route,
      repeatEvidence: input.match.evidence,
    },
  }, store);
}

/**
 * Hides copies already in the Inbox or waiting to be scored at the moment
 * Joseph marks a job Applied, Interviewing, or passes it as Already applied.
 * Each write re-checks the status, so a concurrent human action wins.
 */
export async function suppressLiveAppliedDuplicates(
  decision: AppliedDuplicateAuthorityJob & { description?: string | null },
  store: DuplicateSuppressionStore = prisma,
): Promise<string[]> {
  if (!isAppliedDuplicateAuthorityEvidence(decision)) return [];
  const authority: AppliedRepeatAuthority = {
    id: decision.id,
    title: String(decision.title || ''),
    company: String(decision.company || ''),
    location: decision.location,
    status: decision.status,
    passReason: decision.passReason ?? null,
  };
  const live = await store.job.findMany({
    where: {
      id: { not: decision.id },
      status: { in: [...APPLIED_REPEAT_CANDIDATE_STATUSES] },
      AND: [nonManualImportSourceWhere()],
    },
    select: { id: true, title: true, company: true },
  });
  const plausible = live.filter((candidate) => mayRepeat(candidate, authority));
  if (plausible.length === 0) return [];

  const decisionDescription = decision.description !== undefined
    ? decision.description
    : (await store.job.findUnique({ where: { id: decision.id }, select: { description: true } }))?.description ?? null;
  const candidates = await store.job.findMany({
    where: { id: { in: plausible.map((candidate) => candidate.id) } },
    select: {
      id: true, title: true, company: true, location: true, description: true, status: true,
      source: true, sourceId: true, scoringStatus: true, aimFitScore: true, reqFitScore: true,
    },
  });
  const cache = new Map<string, Set<string>>();
  const suppressedIds: string[] = [];
  for (const candidate of candidates) {
    if (await hasOwnLifecycleDecision(store, candidate.id)) continue;
    if ((await repeatExceptionAuthorityIds(store, candidate.id)).has(decision.id)) continue;
    const evidence = judgeAppliedRepeat(candidate, { ...authority, description: decisionDescription }, cache);
    if (!evidence) continue;
    const match: AppliedRepeatMatch = { authority, evidence, reason: reasonFor(authority) };
    const result = await store.job.updateMany({
      where: {
        id: candidate.id,
        status: { in: [...APPLIED_REPEAT_CANDIDATE_STATUSES] },
        AND: [nonManualImportSourceWhere()],
      },
      data: appliedRepeatDismissalData(candidate, match.reason),
    });
    if (result.count !== 1) continue;
    await recordAppliedRepeatDismissal(store, {
      jobId: candidate.id,
      source: candidate.source,
      sourceId: candidate.sourceId,
      priorStatus: candidate.status,
      match,
      route: 'applied_decision',
    });
    suppressedIds.push(candidate.id);
  }
  return suppressedIds;
}
