/**
 * Combining cards that are the same job found through different sources.
 *
 * The test for "same job" lives in `sameJobMatch.ts`. This module decides
 * which card keeps the job, folds the others into it, and undoes a fold when
 * Joseph says two cards were different jobs.
 *
 * ## What folding does
 *
 * The folded card is dismissed with the consolidated reason every duplicate
 * reader already skips. It keeps its own description, scores and score
 * history; nothing is deleted. Its source observations (and attachments) move
 * to the surviving card, so a later sighting from either source lands on the
 * survivor. When the survivor came from an aggregator and the folded card is
 * the employer's own posting, the survivor's link becomes the employer's.
 *
 * ## Who survives
 *
 * - A card Joseph acted on (applied, interviewing, bookmarked, passed, staged
 *   tailoring, submitted résumé, his own lifecycle click, a Manual Import) is
 *   never folded and always survives over machine-placed copies. When two such
 *   cards are the same job, both stay: those are his records to reconcile.
 * - Among machine-placed cards (Inbox, waiting to be scored, Cooldown) the one
 *   with more scores survives, then the more advanced status, then the
 *   employer's own posting, then the older card.
 *
 * Scores are never averaged, carried or cleared. Because a scored card always
 * outranks an unscored one, the survivor's own scores are the ones shown.
 *
 * ## When it runs
 *
 * Every few minutes from the pipeline and immediately after a scoring import,
 * over every card that can be seen or that holds one of Joseph's decisions.
 * A card in the middle of a scoring or JD export is left for the next pass.
 */

import type { Job, Prisma, PrismaClient } from '@prisma/client';

import { jobsWithOwnLifecycleDecision } from './appliedDuplicateStore';
import { recordJobPipelineEvent } from './ingestionControl';
import { humanLifecycleEvent } from './jobLifecycleEvents';
import { normalizeUrl } from './jobIngestion';
import { assertJobLifecycleInvariants } from './jobLifecycleInvariant';
import { CONSOLIDATED_REASON_PREFIX, lockJobUrlEdits, urlPostingIdentity } from './jobUrlReconciliation';
import { conflictingLinkedInObservation } from './linkedinIdentity';
import { isManualImportSource } from './manualImportPolicy';
import { prisma } from './prisma';
import {
  employerFeedFamily,
  judgeSameJob,
  maySameJob,
  sameJobAnchorCity,
  sameJobTextAgrees,
  sameJobTitleKey,
  type SameJobEvidence,
  type SameJobSubject,
} from './sameJobMatch';

/** How often the pipeline runs a combine pass. */
export const SAME_JOB_CONSOLIDATION_INTERVAL_MS = 5 * 60 * 1000;

export const SAME_JOB_ROUTE = 'same_job_consolidation';
export const SAME_JOB_SEPARATE_ROUTE = 'same_job_separate';
export const SAME_JOB_EXCEPTION_EVENT = 'same_job_exception';
export const SAME_JOB_SURVIVOR_EVENT = 'same_job_consolidated';

/** Machine-placed cards: these may be folded into another card. */
export const SAME_JOB_FOLDABLE_STATUSES = ['inbox', 'pending_af', 'cooldown'] as const;
/** Every card that can keep a job: visible cards plus Joseph's decisions. */
export const SAME_JOB_CARD_STATUSES = [
  ...SAME_JOB_FOLDABLE_STATUSES, 'bookmarked', 'applied', 'interviewing', 'passed',
] as const;
const USER_STATUSES = new Set(['bookmarked', 'applied', 'interviewing', 'passed']);

const notConsolidated: Prisma.JobWhereInput = {
  OR: [{ passReason: null }, { passReason: { not: { startsWith: CONSOLIDATED_REASON_PREFIX } } }],
};

export function isConsolidatedReason(passReason: string | null | undefined): boolean {
  return Boolean(passReason?.startsWith(CONSOLIDATED_REASON_PREFIX));
}

// ---------------------------------------------------------------------------
// Planning (pure)

export type SameJobCard = SameJobSubject & {
  status: string;
  passReason: string | null;
  createdAt: Date;
  aimFitScore: number | null;
  reqFitScore: number | null;
  /** Joseph acted on this card; it is never folded. */
  userOwned: boolean;
  /** A scoring, JD or context export holds this card right now. */
  inFlight: boolean;
  hasSubmittedResume: boolean;
  tailoringStaged: boolean;
};

export type SameJobFold = { survivorId: string; redundantId: string; evidence: SameJobEvidence };

export type SameJobPlan = {
  folds: SameJobFold[];
  /** Folds waiting for an export to finish; retried on the next pass. */
  deferred: SameJobFold[];
  /** Matching cards left alone because a copy could belong to more than one job. */
  held: Array<{ ids: string[]; reason: 'ambiguous' }>;
};

export function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

const USER_STATUS_RANK: Readonly<Record<string, number>> = {
  interviewing: 90, applied: 85, bookmarked: 60, passed: 30, inbox: 20, cooldown: 15, pending_af: 10,
};
// Cooldown outranks Inbox: a copy is in Cooldown because Joseph recently
// applied at this employer, and the Inbox copy escaped only because its
// employer name was written differently ("Arctic Wolf Networks, Inc." /
// "Arctic Wolf").
const MACHINE_STATUS_RANK: Readonly<Record<string, number>> = { cooldown: 3, inbox: 2, pending_af: 1 };

/**
 * A pass that judges the job itself. "Expired" says only that one copy's
 * posting was gone, and the automated reasons predate Joseph's own passes;
 * neither may take a live copy of the job out of view.
 */
export function passJudgesJob(passReason: string | null | undefined): boolean {
  const reason = String(passReason || '').trim();
  return !/^(?:expired$|auto-dismissed\b|\[local triage\]|international location rejected$|location rejected \(|promoted by user:)/i.test(reason);
}

function scoreCount(card: SameJobCard): number {
  return [card.aimFitScore, card.reqFitScore].filter((score) => score !== null).length;
}

/** Larger sorts first. */
function compareKeys(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

function chooseSurvivor(cards: readonly SameJobCard[]): SameJobCard {
  const owned = cards.filter((card) => card.userOwned);
  const pool = owned.length ? owned : cards;
  const key = (card: SameJobCard): number[] => owned.length
    ? [
      card.hasSubmittedResume ? 1 : 0,
      USER_STATUS_RANK[card.status] ?? 0,
      card.status === 'passed' && card.passReason === 'Already applied' ? 1 : 0,
      card.tailoringStaged ? 1 : 0,
      scoreCount(card),
      -card.createdAt.getTime(),
    ]
    : [
      scoreCount(card),
      MACHINE_STATUS_RANK[card.status] ?? 0,
      employerFeedFamily(card.source) ? 1 : 0,
      -card.createdAt.getTime(),
    ];
  return [...pool].sort((left, right) => compareKeys(key(left), key(right)) || left.id.localeCompare(right.id))[0];
}

/**
 * Groups cards that are the same job and decides every fold.
 *
 * A group is acted on only when every pair in it passes the test. One card
 * matching two cards that do not match each other (a bare title against two
 * territory postings) is ambiguous and left alone.
 */
export function planSameJobConsolidation(
  cards: readonly SameJobCard[],
  exceptions: ReadonlySet<string> = new Set(),
): SameJobPlan {
  const plan: SameJobPlan = { folds: [], deferred: [], held: [] };
  const byTitle = new Map<string, SameJobCard[]>();
  for (const card of cards) {
    const key = sameJobTitleKey(card.title);
    if (!key) continue;
    const group = byTitle.get(key);
    if (group) group.push(card); else byTitle.set(key, [card]);
  }
  const cache = new Map<string, Set<string>>();
  for (const group of byTitle.values()) {
    if (group.length < 2 || !group.some((card) => !card.userOwned)) continue;
    const evidence = new Map<string, SameJobEvidence>();
    const parent = new Map(group.map((card) => [card.id, card.id]));
    const root = (id: string): string => {
      let current = id;
      while (parent.get(current) !== current) current = parent.get(current)!;
      parent.set(id, current);
      return current;
    };
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const [left, right] = [group[i], group[j]];
        if (left.userOwned && right.userOwned) continue;
        if (exceptions.has(pairKey(left.id, right.id)) || !maySameJob(left, right)) continue;
        const found = judgeSameJob(left, right, cache);
        if (!found) continue;
        evidence.set(pairKey(left.id, right.id), found);
        parent.set(root(left.id), root(right.id));
      }
    }
    const components = new Map<string, SameJobCard[]>();
    for (const card of group) {
      const id = root(card.id);
      const component = components.get(id);
      if (component) component.push(card); else components.set(id, [card]);
    }
    for (const component of components.values()) {
      if (component.length < 2) continue;
      const ids = component.map((card) => card.id);
      const survivor = chooseSurvivor(component);
      const foldable = component.filter((card) => !card.userOwned && card.id !== survivor.id);
      // Every card that would end up on one survivor must be the same job as
      // every other. Two of Joseph's own cards are never compared, since
      // neither is folded. Two copies that the location strings alone could
      // not link ("Minnesota, US" / "Minneapolis, Hennepin County") are
      // accepted when their text agrees and both match a survivor naming one
      // city; that city is where both are.
      const anchored = Boolean(sameJobAnchorCity(survivor.location));
      const coherent = component.every((left, i) => component.slice(i + 1).every((right) => {
        if (left.userOwned && right.userOwned) return true;
        const key = pairKey(left.id, right.id);
        if (evidence.has(key)) return true;
        if (exceptions.has(key)) return false;
        return anchored
          && left.id !== survivor.id && right.id !== survivor.id
          && evidence.has(pairKey(survivor.id, left.id)) && evidence.has(pairKey(survivor.id, right.id))
          && sameJobTextAgrees(left, right, cache);
      }));
      if (!coherent) {
        plan.held.push({ ids, reason: 'ambiguous' });
        continue;
      }
      for (const card of foldable) {
        const fold = { survivorId: survivor.id, redundantId: card.id, evidence: evidence.get(pairKey(survivor.id, card.id))! };
        (card.inFlight || survivor.inFlight ? plan.deferred : plan.folds).push(fold);
      }
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Loading

type CardStore = Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent' | 'scoringBatchItem'>;

function inFlight(job: Pick<Job, 'jdBatchId' | 'afBatchId' | 'batchJobId' | 'contextBatchId' | 'scoringStatus'>): boolean {
  return Boolean(job.jdBatchId || job.afBatchId || job.batchJobId || job.contextBatchId || job.scoringStatus === 'scoring');
}

/** Exception pairs Joseph recorded with "Not the same job". */
export async function sameJobExceptionPairs(
  store: Pick<Prisma.TransactionClient, 'jobPipelineEvent'>,
  jobIds: readonly string[],
): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();
  const events = await store.jobPipelineEvent.findMany({
    where: { eventType: SAME_JOB_EXCEPTION_EVENT, jobId: { in: [...new Set(jobIds)] } },
    select: { jobId: true, details: true },
  });
  const pairs = new Set<string>();
  for (const event of events) {
    const other = (event.details as Record<string, unknown> | null)?.otherJobId;
    if (event.jobId && typeof other === 'string') pairs.add(pairKey(event.jobId, other));
  }
  return pairs;
}

const cardSelect = {
  id: true, title: true, company: true, location: true, source: true, status: true, passReason: true,
  createdAt: true, aimFitScore: true, reqFitScore: true, tailoringStaged: true, scoringStatus: true,
  jdBatchId: true, afBatchId: true, batchJobId: true, contextBatchId: true,
} as const;

/**
 * Reads every card that could take part, loading descriptions only for cards
 * whose title another card shares.
 */
export async function loadSameJobCards(store: CardStore = prisma): Promise<SameJobCard[]> {
  const rows = await store.job.findMany({
    where: { AND: [{ status: { in: [...SAME_JOB_CARD_STATUSES] } }, notConsolidated] },
    select: cardSelect,
  });
  const participants = rows.filter((row) => row.status !== 'passed' || passJudgesJob(row.passReason));
  // Only a title shared with a card that could be folded can lead anywhere.
  const titleCounts = new Map<string, number>();
  const foldableTitles = new Set<string>();
  for (const row of participants) {
    const key = sameJobTitleKey(row.title);
    if (!key) continue;
    titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
    if ((SAME_JOB_FOLDABLE_STATUSES as readonly string[]).includes(row.status)) foldableTitles.add(key);
  }
  const shared = participants.filter((row) => {
    const key = sameJobTitleKey(row.title);
    return (titleCounts.get(key) || 0) > 1 && foldableTitles.has(key);
  });
  if (shared.length === 0) return [];
  const ids = shared.map((row) => row.id);
  const [details, ownDecisions, leased] = await Promise.all([
    store.job.findMany({
      where: { id: { in: ids } },
      select: { id: true, description: true, submittedResume: true },
    }),
    jobsWithOwnLifecycleDecision(store, ids),
    store.scoringBatchItem.findMany({
      where: { jobId: { in: ids }, status: 'leased' },
      select: { jobId: true },
    }),
  ]);
  const detailById = new Map(details.map((row) => [row.id, row]));
  const leasedIds = new Set(leased.map((row) => row.jobId));
  return shared.map((row) => {
    const detail = detailById.get(row.id);
    return {
      id: row.id,
      title: row.title,
      company: row.company,
      location: row.location,
      source: row.source,
      description: detail?.description ?? null,
      status: row.status,
      passReason: row.passReason,
      createdAt: row.createdAt,
      aimFitScore: row.aimFitScore,
      reqFitScore: row.reqFitScore,
      tailoringStaged: row.tailoringStaged,
      hasSubmittedResume: Boolean(detail?.submittedResume),
      userOwned: USER_STATUSES.has(row.status)
        || row.tailoringStaged
        || Boolean(detail?.submittedResume)
        || isManualImportSource(row.source)
        || ownDecisions.has(row.id),
      inFlight: inFlight(row) || leasedIds.has(row.id),
    };
  });
}

// ---------------------------------------------------------------------------
// Folding

export class SameJobFoldSkipped extends Error {
  constructor(message: string) { super(message); this.name = 'SameJobFoldSkipped'; }
}

/**
 * Folds one card into another inside the caller's transaction. Everything is
 * re-read under lock and re-judged, so a card Joseph touched a moment ago, or
 * one that changed since planning, is skipped rather than folded.
 */
export async function foldSameJob(
  tx: Prisma.TransactionClient,
  input: { survivorId: string; redundantId: string; now?: Date },
): Promise<{ survivor: Job; redundant: Job; evidence: SameJobEvidence; linkUpdated: boolean }> {
  const now = input.now || new Date();
  await lockJobUrlEdits(tx);
  for (const id of [input.survivorId, input.redundantId].sort()) {
    await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${id} FOR UPDATE`;
  }
  const rows = await tx.job.findMany({ where: { id: { in: [input.survivorId, input.redundantId] } } });
  const survivor = rows.find((row) => row.id === input.survivorId);
  const redundant = rows.find((row) => row.id === input.redundantId);
  if (!survivor || !redundant) throw new SameJobFoldSkipped('A card no longer exists.');
  if (isConsolidatedReason(survivor.passReason) || isConsolidatedReason(redundant.passReason)) {
    throw new SameJobFoldSkipped('A card was already combined.');
  }
  if (!(SAME_JOB_FOLDABLE_STATUSES as readonly string[]).includes(redundant.status)) {
    throw new SameJobFoldSkipped(`The copy is now ${redundant.status}.`);
  }
  if (!(SAME_JOB_CARD_STATUSES as readonly string[]).includes(survivor.status)
    || (survivor.status === 'passed' && !passJudgesJob(survivor.passReason))) {
    throw new SameJobFoldSkipped(`The surviving card is now ${survivor.status}.`);
  }
  if (redundant.tailoringStaged || redundant.submittedResume || isManualImportSource(redundant.source)
    || (await jobsWithOwnLifecycleDecision(tx, [redundant.id])).has(redundant.id)) {
    throw new SameJobFoldSkipped('Joseph acted on the copy.');
  }
  const leased = await tx.scoringBatchItem.count({ where: { jobId: { in: [survivor.id, redundant.id] }, status: 'leased' } });
  if (leased > 0 || inFlight(survivor) || inFlight(redundant)) throw new SameJobFoldSkipped('An export holds one of the cards.');
  if ((await sameJobExceptionPairs(tx, [redundant.id])).has(pairKey(survivor.id, redundant.id))) {
    throw new SameJobFoldSkipped('Joseph said these are different jobs.');
  }
  const evidence = judgeSameJob(survivor, redundant);
  if (!evidence) throw new SameJobFoldSkipped('The cards no longer match.');

  const reason = `${CONSOLIDATED_REASON_PREFIX}${survivor.id}`;
  const unscored = redundant.aimFitScore === null
    && redundant.reqFitScore === null
    && ['queued', 'needs_jd', 'failed', 'skipped'].includes(redundant.scoringStatus);
  await tx.job.update({
    where: { id: redundant.id },
    data: {
      status: 'dismissed',
      passReason: reason,
      postingIdentity: null,
      ...(unscored ? { scoringStatus: 'skipped', scoreError: null } : {}),
    },
  });
  // The employer's own posting is the better link to open and to check for
  // liveness. The description, and so every score input, stays the survivor's.
  const survivorIsReprint = !employerFeedFamily(survivor.source) && !isManualImportSource(survivor.source);
  const linkUpdated = survivorIsReprint && Boolean(employerFeedFamily(redundant.source)) && Boolean(redundant.url);
  const linkedUrl = linkUpdated ? normalizeUrl(redundant.canonicalUrl || redundant.url!) : null;
  const postingIdentity = linkUpdated
    ? redundant.postingIdentity || urlPostingIdentity(linkedUrl!) || survivor.postingIdentity
    : survivor.postingIdentity || redundant.postingIdentity;
  const survivorLinks = {
    url: linkUpdated ? redundant.url : survivor.url,
    canonicalUrl: linkUpdated ? linkedUrl : survivor.canonicalUrl,
  };

  // Sources move to the survivor so a later sighting from either lands there.
  // A LinkedIn sighting whose posting ID differs from the survivor's own
  // LinkedIn link would be read as a stale link and ingested again as a new
  // card, so that one stays with the copy, where a sighting is a quiet duplicate.
  const observations = await tx.jobSourceObservation.findMany({
    where: { jobId: redundant.id },
    select: { id: true, url: true },
  });
  const movable = observations.filter((observation) => !conflictingLinkedInObservation({ url: observation.url, job: survivorLinks }));
  if (movable.length) {
    await tx.jobSourceObservation.updateMany({ where: { id: { in: movable.map((observation) => observation.id) } }, data: { jobId: survivor.id } });
  }
  if (redundant.source && redundant.sourceId) {
    const stays = Boolean(conflictingLinkedInObservation({ url: redundant.url, job: survivorLinks }));
    await tx.jobSourceObservation.upsert({
      where: { source_sourceId: { source: redundant.source, sourceId: redundant.sourceId } },
      update: {},
      create: { jobId: stays ? redundant.id : survivor.id, source: redundant.source, sourceId: redundant.sourceId, url: redundant.url },
    });
  }
  const attachments = await tx.jobAttachment.findMany({ where: { jobId: redundant.id }, select: { id: true } });
  if (attachments.length) {
    await tx.jobAttachment.updateMany({ where: { jobId: redundant.id }, data: { jobId: survivor.id } });
  }

  const updatedSurvivor = await tx.job.update({
    where: { id: survivor.id },
    data: {
      ...(linkUpdated ? { url: redundant.url, canonicalUrl: linkedUrl } : {}),
      ...(postingIdentity !== survivor.postingIdentity ? { postingIdentity } : {}),
    },
  });
  const updatedRedundant = await tx.job.findUniqueOrThrow({ where: { id: redundant.id } });

  const identityParts = [SAME_JOB_ROUTE, redundant.id, survivor.id, redundant.updatedAt.toISOString()];
  // A derived decision event is what lets a scored card sit in Dismissed; it
  // never counts as Joseph's own action on this card.
  await recordJobPipelineEvent({
    eventType: 'user_lifecycle', jobId: redundant.id, stage: 'consolidation',
    source: redundant.source, sourceId: redundant.sourceId, occurredAt: now, identityParts,
    details: {
      actor: 'system', protected: true, derived: true, route: SAME_JOB_ROUTE,
      priorStatus: redundant.status, nextStatus: 'dismissed', priorScoringStatus: redundant.scoringStatus,
      priorPassReason: redundant.passReason,
      duplicateOfJobId: survivor.id, reason, evidence,
      previousPostingIdentity: redundant.postingIdentity,
      movedAttachmentIds: attachments.map((attachment) => attachment.id),
    },
  }, tx);
  await recordJobPipelineEvent({
    eventType: SAME_JOB_SURVIVOR_EVENT, jobId: survivor.id, stage: 'consolidation',
    source: survivor.source, sourceId: survivor.sourceId, occurredAt: now, identityParts: [...identityParts, 'survivor'],
    details: {
      actor: 'system', route: SAME_JOB_ROUTE, consolidatedJobId: redundant.id, evidence, linkUpdated,
      previousUrl: survivor.url, previousCanonicalUrl: survivor.canonicalUrl,
      previousPostingIdentity: survivor.postingIdentity,
    },
  }, tx);
  // Only the copy's lifecycle changed. The survivor keeps its status, and an
  // old card already out of step with the current rules must not block this.
  await assertJobLifecycleInvariants(tx, [redundant.id]);
  return { survivor: updatedSurvivor, redundant: updatedRedundant, evidence, linkUpdated };
}

export type SameJobRunResult = {
  cards: number;
  folded: Array<SameJobFold & { linkUpdated: boolean }>;
  skipped: Array<SameJobFold & { reason: string }>;
  deferred: number;
  held: SameJobPlan['held'];
};

/**
 * One pass over every card. With `apply: false` nothing is written and the
 * result lists what a pass would fold.
 */
export async function consolidateSameJobs(
  options: { apply?: boolean; client?: PrismaClient; now?: Date } = {},
): Promise<SameJobRunResult> {
  const client = options.client || prisma;
  const cards = await loadSameJobCards(client);
  const exceptions = await sameJobExceptionPairs(client, cards.map((card) => card.id));
  const plan = planSameJobConsolidation(cards, exceptions);
  const result: SameJobRunResult = {
    cards: cards.length, folded: [], skipped: [], deferred: plan.deferred.length, held: plan.held,
  };
  if (!options.apply) {
    result.folded = plan.folds.map((fold) => ({ ...fold, linkUpdated: false }));
    return result;
  }
  for (const fold of plan.folds) {
    try {
      const done = await client.$transaction(
        (tx) => foldSameJob(tx, { ...fold, now: options.now }),
        { timeout: 15_000 },
      );
      result.folded.push({ ...fold, evidence: done.evidence, linkUpdated: done.linkUpdated });
    } catch (error) {
      // One card in a bad state must not stop the rest of the pass.
      if (!(error instanceof SameJobFoldSkipped)) console.error('[same-job] fold failed', fold, error);
      result.skipped.push({ ...fold, reason: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
  return result;
}

/** For callers whose own work must not fail because a combine pass did. */
export async function consolidateSameJobsSafely(label: string): Promise<SameJobRunResult | null> {
  try {
    const result = await consolidateSameJobs({ apply: true });
    if (result.folded.length) console.log(`[same-job] ${label}: combined ${result.folded.length} duplicate card(s).`);
    return result;
  } catch (error) {
    console.error(`[same-job] ${label}: combine pass failed.`, error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading and undoing

export type CombinedCopy = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  source: string | null;
  url: string | null;
  /** The copy's own scores, which stay on it; shown so none leaves view. */
  aimFitScore: number | null;
  reqFitScore: number | null;
  combinedAt: Date;
  automatic: boolean;
};

/**
 * Cards folded into this one, newest first, including cards folded into a
 * card that was itself later folded into this one.
 */
export async function listCombinedCopies(
  store: Pick<Prisma.TransactionClient, '$queryRaw'>,
  survivorId: string,
): Promise<CombinedCopy[]> {
  // Walked through the fold events, which are few and indexed by type; the
  // Job table has no index on passReason.
  return store.$queryRaw<CombinedCopy[]>`
    WITH RECURSIVE folded(id, parent, depth) AS (
      SELECT e."jobId", ${survivorId}::text, 1 FROM "JobPipelineEvent" e
      WHERE e."eventType" = 'user_lifecycle' AND e.details->>'duplicateOfJobId' = ${survivorId}
      UNION
      SELECT e."jobId", f.id, f.depth + 1 FROM "JobPipelineEvent" e
      JOIN folded f ON e.details->>'duplicateOfJobId' = f.id
      WHERE e."eventType" = 'user_lifecycle' AND f.depth < 5
    )
    SELECT j.id, j.title, j.company, j.location, j.source, j.url, j."aimFitScore", j."reqFitScore",
      MAX(e."occurredAt") AS "combinedAt",
      BOOL_OR(e.details->>'route' = ${SAME_JOB_ROUTE}) AS automatic
    FROM folded f
    JOIN "Job" j ON j.id = f.id AND j."passReason" = ${CONSOLIDATED_REASON_PREFIX} || f.parent
    JOIN "JobPipelineEvent" e ON e."jobId" = j.id
      AND e."eventType" = 'user_lifecycle'
      AND e.details->>'duplicateOfJobId' = f.parent
    GROUP BY j.id, j.title, j.company, j.location, j.source, j.url, j."aimFitScore", j."reqFitScore"
    ORDER BY "combinedAt" DESC
  `;
}

/** The card this one was combined into, following later combines to the end. */
async function combinedChain(tx: Prisma.TransactionClient, jobId: string): Promise<string[]> {
  const chain: string[] = [];
  let current = await tx.job.findUnique({ where: { id: jobId }, select: { passReason: true } });
  while (current && isConsolidatedReason(current.passReason) && chain.length < 5) {
    const next = current.passReason!.slice(CONSOLIDATED_REASON_PREFIX.length);
    if (!next || chain.includes(next) || next === jobId) break;
    chain.push(next);
    current = await tx.job.findUnique({ where: { id: next }, select: { passReason: true } });
  }
  return chain;
}

export class SameJobSeparateRefused extends Error {
  constructor(message: string) { super(message); this.name = 'SameJobSeparateRefused'; }
}

/**
 * Joseph says a combined copy is a different job. The fold is undone exactly:
 * the copy returns to the state it was in, its source returns to it, a link
 * the survivor took from it is given back, and the pair is never combined
 * again. Recomputing the copy's place from its scores instead would disagree
 * with the rules for an old score that has since gone stale.
 */
export async function separateSameJob(
  tx: Prisma.TransactionClient,
  copyId: string,
  now = new Date(),
): Promise<{ copy: Job; survivor: Job }> {
  await lockJobUrlEdits(tx);
  const [lockedCopy] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Job" WHERE id = ${copyId} FOR UPDATE`;
  if (!lockedCopy) throw new SameJobSeparateRefused('Job not found.');
  const copy = await tx.job.findUniqueOrThrow({ where: { id: copyId } });
  const foldEvent = await tx.jobPipelineEvent.findFirst({
    where: { jobId: copyId, eventType: 'user_lifecycle', details: { path: ['route'], equals: SAME_JOB_ROUTE } },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
  });
  const foldDetails = (foldEvent?.details || {}) as Record<string, unknown>;
  const survivorId = typeof foldDetails.duplicateOfJobId === 'string' ? foldDetails.duplicateOfJobId : null;
  const priorStatus = typeof foldDetails.priorStatus === 'string' ? foldDetails.priorStatus : null;
  if (copy.status !== 'dismissed' || !survivorId || copy.passReason !== `${CONSOLIDATED_REASON_PREFIX}${survivorId}`
    || !priorStatus || !(SAME_JOB_FOLDABLE_STATUSES as readonly string[]).includes(priorStatus)) {
    throw new SameJobSeparateRefused('This card was not combined automatically, so there is nothing to separate.');
  }
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${survivorId} FOR UPDATE`;
  const survivor = await tx.job.findUnique({ where: { id: survivorId } });
  if (!survivor) throw new SameJobSeparateRefused('The card it was combined into no longer exists.');

  // The survivor may itself have been combined into another card since; the
  // copy is a different job from every card along that chain.
  const others = [survivor.id, ...(await combinedChain(tx, survivor.id)).filter((id) => id !== copy.id)];
  for (const otherId of others) {
    for (const [jobId, otherJobId] of [[copy.id, otherId], [otherId, copy.id]]) {
      await recordJobPipelineEvent({
        eventType: SAME_JOB_EXCEPTION_EVENT, jobId, stage: 'human_decision', occurredAt: now,
        identityParts: [SAME_JOB_SEPARATE_ROUTE, jobId, otherJobId, now.toISOString()],
        details: { actor: 'user', otherJobId },
      }, tx);
    }
  }

  // Give back what the fold took from the copy.
  if (copy.source && copy.sourceId) {
    await tx.jobSourceObservation.updateMany({
      where: { source: copy.source, sourceId: copy.sourceId, jobId: survivor.id },
      data: { jobId: copy.id },
    });
  }
  const movedAttachmentIds = Array.isArray(foldDetails.movedAttachmentIds)
    ? foldDetails.movedAttachmentIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (movedAttachmentIds.length) {
    await tx.jobAttachment.updateMany({ where: { id: { in: movedAttachmentIds }, jobId: survivor.id }, data: { jobId: copy.id } });
  }
  const survivorEvent = await tx.jobPipelineEvent.findFirst({
    where: { jobId: survivor.id, eventType: SAME_JOB_SURVIVOR_EVENT, details: { path: ['consolidatedJobId'], equals: copy.id } },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
  });
  const survivorDetails = (survivorEvent?.details || {}) as Record<string, unknown>;
  let restoredSurvivor = survivor;
  if (survivorDetails.linkUpdated === true && survivor.url === copy.url) {
    restoredSurvivor = await tx.job.update({
      where: { id: survivor.id },
      data: {
        url: typeof survivorDetails.previousUrl === 'string' ? survivorDetails.previousUrl : survivor.url,
        canonicalUrl: typeof survivorDetails.previousCanonicalUrl === 'string' ? survivorDetails.previousCanonicalUrl : survivor.canonicalUrl,
        postingIdentity: typeof survivorDetails.previousPostingIdentity === 'string' ? survivorDetails.previousPostingIdentity : null,
      },
    });
  }
  const previousIdentity = typeof foldDetails.previousPostingIdentity === 'string' ? foldDetails.previousPostingIdentity : null;
  const identityFree = previousIdentity
    && !await tx.job.findUnique({ where: { postingIdentity: previousIdentity }, select: { id: true } });
  const priorScoringStatus = typeof foldDetails.priorScoringStatus === 'string' ? foldDetails.priorScoringStatus : null;
  const restored = await tx.job.update({
    where: { id: copy.id },
    data: {
      status: priorStatus,
      passReason: typeof foldDetails.priorPassReason === 'string' ? foldDetails.priorPassReason : null,
      ...(copy.scoringStatus === 'skipped' && priorScoringStatus ? { scoringStatus: priorScoringStatus } : {}),
      ...(identityFree ? { postingIdentity: previousIdentity } : {}),
    },
  });

  // Joseph's own decision, so the restored state holds against automation.
  const lifecycleEvent = humanLifecycleEvent('dismissed', priorStatus, restored.status);
  if (lifecycleEvent) {
    await recordJobPipelineEvent({
      eventType: lifecycleEvent.eventType,
      jobId: copy.id,
      stage: 'human_decision',
      source: restored.source,
      sourceId: restored.sourceId,
      occurredAt: now,
      identityParts: ['status_transition', lifecycleEvent.priorStatus, lifecycleEvent.nextStatus, now.toISOString()],
      details: {
        priorStatus: lifecycleEvent.priorStatus,
        nextStatus: lifecycleEvent.nextStatus,
        enteredInbox: lifecycleEvent.enteredInbox,
        actor: lifecycleEvent.actor,
        protected: lifecycleEvent.protected,
        route: SAME_JOB_SEPARATE_ROUTE,
        reason: 'Not the same job as the card it was combined into',
        separatedFromJobId: survivor.id,
      },
    }, tx);
  }
  await assertJobLifecycleInvariants(tx, [copy.id]);
  return { copy: restored, survivor: restoredSurvivor };
}
