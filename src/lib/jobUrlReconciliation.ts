import { randomUUID } from 'node:crypto';
import { Prisma, type Job } from '@prisma/client';
import { locationsCompatibleForDirectMatch, isAggregatorSource } from './atsDirectMatch';
import { canonicalJsonSha256 } from './scoringCanonicalJson';
import { sameCompanyIdentity } from './companyIdentity';
import { sameEmployer } from './employerIdentity';
import { experienceScorePasses } from './experienceFit';
import {
  generatePostingIdentity,
  isRedirectResolutionAggregatorUrl,
  normalizeJobLocation,
  normalizeTitle,
  normalizeUrl,
} from './jobIngestion';
import { recordJobPipelineEvent } from './ingestionControl';
import { isDirectAtsApiSource } from './jobSourceProvenance';
import { latestJobScoreEvents } from './jobScoreAuthorityQuery';
import { projectJobScoreAuthority } from './scoreAuthority';

export class JobUrlConflict extends Error {
  /**
   * Set only when the refusal is about details written differently (title,
   * employer, location). Joseph may confirm those two cards are the same job
   * and merge them. Refusals about competing decisions or résumés never carry it.
   */
  readonly mergeTargetJobId: string | null;
  constructor(message: string, options: { mergeTargetJobId?: string } = {}) {
    super(message);
    this.name = 'JobUrlConflict';
    this.mergeTargetJobId = options.mergeTargetJobId ?? null;
  }
}

export const CONSOLIDATED_REASON_PREFIX = 'Consolidated after URL edit into job ';

// Only posting-specific identities may cause a lifecycle change. In particular,
// a Lever/Greenhouse board or a generic careers page is never sufficient proof.
export function urlPostingIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const hasIdParameter = [...url.searchParams].some(([key, value]) =>
      /^(jobid|ghjid|requisitionid|reqid|postingid|positionid)$/i.test(key.replace(/[^a-z0-9]/gi, '')) && value.trim());
    const tail = segments.filter(segment => !/^(apply|application)$/i.test(segment)).at(-1) || '';
    const hasIdPath = /\d/.test(tail) && /^[a-z0-9_-]{4,}$/i.test(tail);
    if (!hasIdParameter && !(segments.length >= 2 && hasIdPath)) return null;
    // The ingestion extractor treats the segment after /jobs/ as the key.
    // Refuse navigation paths such as /jobs/view/123 rather than matching
    // every posting under a shared literal 'view' key.
    const marker = segments.findIndex(segment => /^(job|jobs|j|position|positions|requisition|requisitions|opening|openings)$/i.test(segment));
    const workday = /\.myworkdayjobs\.com$|\.myworkdaysite\.com$/i.test(url.hostname);
    if (!hasIdParameter && !workday && marker >= 0 && !/\d/.test(segments[marker + 1] || '')) return null;
    return generatePostingIdentity({ url: normalizeUrl(value) });
  } catch { return null; }
}

export function urlMetadataConflict(
  left: Pick<Job, 'title' | 'company' | 'location'> & { employer?: string | null },
  right: Pick<Job, 'title' | 'company' | 'location'> & { employer?: string | null },
  options: { allowDirectAtsLocationCompatibility?: boolean } = {},
): string | null {
  if (!sameCompanyIdentity(left.company, right.company) && !sameEmployer(left, right)) return 'employer';
  if (normalizeTitle(left.title) !== normalizeTitle(right.title)) return 'job title';
  const a = normalizeJobLocation(left.location || '');
  const b = normalizeJobLocation(right.location || '');
  if (a !== b && !(options.allowDirectAtsLocationCompatibility
    && locationsCompatibleForDirectMatch(left.location, right.location))) return 'location';
  return null;
}

type UrlReconciliationMetadata = Partial<Pick<Job, 'title' | 'company' | 'location'>>;

type ReconciliationPair = {
  canonical: Job;
  redundant: Job;
  prefersDirectAts: boolean;
  directAggregateMatch: boolean;
  preservesEditedRecord: boolean;
};

function hasStoredScore(job: Job): boolean {
  return job.scoringStatus === 'scored'
    && [job.aimFitScore, job.reqFitScore, job.fitScore].some(score => score !== null);
}

function protectsEditedRecordFromDiscardedDirectMatch(current: Job, target: Job): boolean {
  if (!['dismissed', 'expired', 'archived'].includes(target.status)) return false;
  if (target.tailoringStaged || target.submittedResume) return false;
  if (['applied', 'interviewing'].includes(current.status)) return true;
  if (current.status === 'passed' && current.passReason === 'Already applied') return true;
  return ['inbox', 'pending_af'].includes(current.status)
    && hasStoredScore(current)
    && target.scoringStatus === 'failed';
}

/**
 * An exact posting may arrive both through a reprint and through a direct ATS
 * or DEjobs/CareerForce API response. The direct source is the canonical
 * record; ties deliberately retain the previous target-as-survivor behavior.
 */
export function chooseUrlReconciliationPair(current: Job, target: Job): ReconciliationPair {
  const currentDirect = isDirectAtsApiSource(current.source);
  const targetDirect = isDirectAtsApiSource(target.source);
  const currentAggregator = isAggregatorSource(current.source);
  const targetAggregator = isAggregatorSource(target.source);
  if (currentDirect && targetAggregator) {
    return {
      canonical: current, redundant: target, prefersDirectAts: true,
      directAggregateMatch: true, preservesEditedRecord: false,
    };
  }
  if (targetDirect && currentAggregator) {
    // Source quality cannot overrule completed user work. In particular, a
    // discarded ATS row may carry an old invalid score while the reprint is
    // the active, scored record the user is reviewing. Keep that edited row
    // and attach the direct source observation to it during consolidation.
    if (protectsEditedRecordFromDiscardedDirectMatch(current, target)) {
      return {
        canonical: current, redundant: target, prefersDirectAts: false,
        directAggregateMatch: true, preservesEditedRecord: true,
      };
    }
    return {
      canonical: target, redundant: current, prefersDirectAts: true,
      directAggregateMatch: true, preservesEditedRecord: false,
    };
  }
  return {
    canonical: target, redundant: current, prefersDirectAts: false,
    directAggregateMatch: false, preservesEditedRecord: false,
  };
}

function comparisonMetadata(job: Job, metadata?: UrlReconciliationMetadata): Job {
  return {
    ...job,
    ...(metadata?.title?.trim() ? { title: metadata.title.trim() } : {}),
    ...(metadata?.company?.trim() ? { company: metadata.company.trim() } : {}),
    ...(metadata?.location?.trim() ? { location: metadata.location.trim() } : {}),
  };
}

type PortableHumanLifecycle = { status: 'applied' | 'interviewing' | 'passed'; passReason: string | null };

function portableHumanLifecycle(job: Job): PortableHumanLifecycle | null {
  if (job.status === 'applied' || job.status === 'interviewing') {
    return { status: job.status, passReason: job.passReason || null };
  }
  if (job.status === 'passed' && job.passReason === 'Already applied') {
    return { status: 'passed', passReason: 'Already applied' };
  }
  return null;
}

function directSurvivorCanAbsorb(redundant: Job, canonical: Job): { transfer: PortableHumanLifecycle | null } {
  if (redundant.tailoringStaged || redundant.submittedResume) {
    throw new JobUrlConflict('This URL matches another saved job, but the duplicate has a staged or submitted resume. Review both records before consolidating. No changes were saved.');
  }
  const redundantDecision = portableHumanLifecycle(redundant);
  if (!redundantDecision && !['inbox', 'pending_af'].includes(redundant.status)) {
    throw new JobUrlConflict('This URL matches another saved job, but the duplicate has a saved decision. Review both records before consolidating. No changes were saved.');
  }
  const canonicalDecision = portableHumanLifecycle(canonical);
  if (!canonicalDecision && !['inbox', 'pending_af'].includes(canonical.status)) {
    throw new JobUrlConflict(`This URL matches a saved job marked ${canonical.status}. Review that record before consolidating. No changes were saved.`);
  }
  if (!redundantDecision) return { transfer: null };
  if (!canonicalDecision) {
    if (canonical.tailoringStaged || canonical.submittedResume) {
      throw new JobUrlConflict('This URL matches another saved job, but the direct record has a staged or submitted resume. Review both records before consolidating. No changes were saved.');
    }
    return { transfer: redundantDecision };
  }
  // An existing application/interview on the canonical record is at least as
  // authoritative as the aggregate copy's state. Two other human decisions
  // are competing facts and require review rather than one being erased.
  if (['applied', 'interviewing'].includes(canonicalDecision.status)) return { transfer: null };
  if (canonicalDecision.status === redundantDecision.status
    && canonicalDecision.passReason === redundantDecision.passReason) return { transfer: null };
  throw new JobUrlConflict('This URL matches another saved job, but the two records have different saved decisions. Review both records before consolidating. No changes were saved.');
}

export async function lockJobUrlEdits(tx: Prisma.TransactionClient) {
  // Serialize manual URL reconciliation before taking any row locks. Ingestion
  // additionally arbitrates through the unique postingIdentity constraint.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('career-dashboard:job-url-edit', 0))`;
}

export type UrlReconciliation = { job: Job; consolidatedJobId: string | null };

/** Caller owns the transaction and takes lockJobUrlEdits before other locks. */
export async function reconcileJobUrlEdit(tx: Prisma.TransactionClient, input: {
  id: string;
  url: string;
  expectedUpdatedAt: Date;
  allowConsolidation?: boolean;
  /** Metadata returned by the direct ATS/API lookup for this exact URL. */
  directMetadata?: UrlReconciliationMetadata;
  origin?: 'ingestion';
}): Promise<UrlReconciliation> {
  const url = normalizeUrl(input.url);
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error();
  } catch { throw new JobUrlConflict('Enter a valid HTTP or HTTPS job URL.'); }
  const postingIdentity = urlPostingIdentity(url);
  // Include old rows without postingIdentity, tracking URLs, and /apply links.
  // Matching is verified below; a path prefix is retrieval only, never proof.
  const parsed = new URL(url);
  const pathPrefix = `${parsed.origin}${parsed.pathname.replace(/\/(?:apply|application)\/?$/i, '').replace(/\/$/, '')}`;
  const candidates = postingIdentity ? await tx.job.findMany({
    where: { id: { not: input.id }, OR: [
      { postingIdentity },
      { canonicalUrl: { startsWith: pathPrefix, mode: 'insensitive' } },
      { url: { startsWith: pathPrefix, mode: 'insensitive' } },
    ] },
  }) : [];
  const matches = candidates.filter(candidate => [candidate.url, candidate.canonicalUrl]
    .some(value => value && urlPostingIdentity(value) === postingIdentity));
  const ids = [input.id, ...matches.map(row => row.id)].sort();
  // Stable lock order, then re-read rather than deciding from stale snapshots.
  for (const id of ids) await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${id} FOR UPDATE`;
  const current = await tx.job.findUnique({ where: { id: input.id } });
  if (!current || current.updatedAt.valueOf() !== input.expectedUpdatedAt.valueOf()) {
    throw new JobUrlConflict('The job changed before the link could be updated. Please retry.');
  }
  const freshMatches: Job[] = [];
  for (const match of matches) {
    const fresh = await tx.job.findUnique({ where: { id: match.id } });
    if (!fresh || ![fresh.url, fresh.canonicalUrl].some(value => value && urlPostingIdentity(value) === postingIdentity)) {
      throw new JobUrlConflict('A matching job changed while the link was being checked. Please retry.');
    }
    freshMatches.push(fresh);
  }
  // Already-consolidated history must not compete with its surviving record.
  const survivors = freshMatches.filter(row => !row.passReason?.startsWith('Consolidated after URL edit into job '));
  if (survivors.length > 1) throw new JobUrlConflict('This URL matches multiple saved jobs. Review those records before consolidating. No changes were saved.');
  const target = survivors[0];
  if (target && current.passReason === `Consolidated after URL edit into job ${target.id}`) {
    return { job: target, consolidatedJobId: current.id };
  }
  if (!target) {
    const job = await tx.job.update({ where: { id: current.id }, data: {
      url, canonicalUrl: url, postingIdentity,
      jdBatchId: null, batchJobId: null, afBatchId: null,
    } });
    return { job, consolidatedJobId: null };
  }
  const comparisonCurrent = comparisonMetadata(current, input.directMetadata);
  const pair = chooseUrlReconciliationPair(current, target);
  const conflict = urlMetadataConflict(comparisonCurrent, target, {
    allowDirectAtsLocationCompatibility: pair.directAggregateMatch,
  });
  if (conflict) throw new JobUrlConflict(
    `This link already belongs to another saved card, but the ${conflict} is written differently: “${current[conflict === 'employer' ? 'company' : conflict === 'job title' ? 'title' : 'location']}” versus “${target[conflict === 'employer' ? 'company' : conflict === 'job title' ? 'title' : 'location']}”. No changes were saved.`,
    { mergeTargetJobId: target.id },
  );
  if (input.allowConsolidation === false) throw new JobUrlConflict(
    'This link is already assigned to another saved card. Review the two cards and choose whether to merge them. No changes were saved.',
    { mergeTargetJobId: target.id },
  );
  // A direct API result wins over an aggregate reprint. If the reprint holds
  // an explicit application decision, move that decision to the direct record
  // rather than discarding it. Scores, descriptions, and resumes never move.
  const decisionTransfer = pair.prefersDirectAts
    ? directSurvivorCanAbsorb(pair.redundant, pair.canonical)
    : null;
  if (!pair.prefersDirectAts && !pair.preservesEditedRecord) {
    if (!['inbox', 'pending_af'].includes(current.status) || current.tailoringStaged || current.passReason === 'Already applied') {
      throw new JobUrlConflict('This URL matches another saved job, but the edited record has a saved decision or staged resume. Review both records before consolidating. No changes were saved.');
    }
    if (!['applied', 'interviewing', 'inbox', 'pending_af'].includes(target.status)) {
      throw new JobUrlConflict(`This URL matches a saved job marked ${target.status}. Review that record before consolidating. No changes were saved.`);
    }
  }
  const { canonical, redundant } = pair;
  const reason = `Consolidated after URL edit into job ${canonical.id}`;
  await tx.job.update({ where: { id: redundant.id }, data: {
    url, canonicalUrl: url, postingIdentity: null,
    status: 'dismissed', passReason: reason, tailoringStaged: false,
    jdBatchId: null, batchJobId: null, afBatchId: null,
    contextBatched: true, contextBatchId: null,
  } });
  await tx.jobSourceObservation.updateMany({ where: { jobId: redundant.id }, data: { jobId: canonical.id } });
  if (redundant.source && redundant.sourceId) {
    await tx.jobSourceObservation.upsert({
      where: { source_sourceId: { source: redundant.source, sourceId: redundant.sourceId } },
      update: {},
      create: { jobId: canonical.id, source: redundant.source, sourceId: redundant.sourceId, url: redundant.url },
    });
  }
  // Store the stable key on the survivor for subsequent ingestion. Never copy
  // scores, descriptions, or resumes between records. A human lifecycle
  // decision is moved only from an aggregate duplicate to a direct API record.
  const job = await tx.job.update({ where: { id: canonical.id }, data: {
    postingIdentity,
    ...(canonical.id === current.id ? { url, canonicalUrl: url } : {}),
    ...(decisionTransfer?.transfer ? {
      status: decisionTransfer.transfer.status,
      passReason: decisionTransfer.transfer.passReason,
      contextBatched: true,
      contextBatchId: null,
    } : {}),
  } });
  await recordJobPipelineEvent({
    eventType: input.origin ? 'lifecycle_reconciled' : 'user_lifecycle', jobId: redundant.id, stage: input.origin || 'human_decision',
    source: redundant.source, sourceId: redundant.sourceId,
    identityParts: ['url_reconciliation', redundant.id, canonical.id, redundant.updatedAt.toISOString()],
    details: { actor: input.origin ? 'system' : 'user', protected: true, derived: true, route: 'url_reconciliation',
      priorStatus: redundant.status, nextStatus: 'dismissed', duplicateOfJobId: canonical.id,
      previousUrl: redundant.url, nextUrl: url, reason,
      canonicalSource: canonical.source,
      transferredHumanDecision: decisionTransfer?.transfer || null },
  }, tx);
  if (decisionTransfer?.transfer) {
    await recordJobPipelineEvent({
      eventType: input.origin ? 'lifecycle_reconciled' : 'user_lifecycle', jobId: canonical.id, stage: input.origin || 'human_decision',
      source: canonical.source, sourceId: canonical.sourceId,
      identityParts: ['url_reconciliation_transfer', redundant.id, canonical.id, redundant.updatedAt.toISOString()],
      details: { actor: input.origin ? 'system' : 'user', protected: true, derived: true, route: 'url_reconciliation',
        priorStatus: canonical.status, nextStatus: decisionTransfer.transfer.status,
        decisionSourceJobId: redundant.id, sourceJobStatus: redundant.status,
        sourceJobPassReason: redundant.passReason },
    }, tx);
  }
  return { job, consolidatedJobId: redundant.id };
}

export class CardMergeRefused extends Error {
  constructor(message: string) { super(message); this.name = 'CardMergeRefused'; }
}

export type DuplicateMergeScoreSource = {
  jobId: string;
  eventId: string;
  value: number;
};

export type DuplicateMergeScorePlan = {
  value: number | null;
  mode: 'none' | 'preserved' | 'carried' | 'average';
  sources: DuplicateMergeScoreSource[];
  writeDerivedEvent: boolean;
};

export type DuplicateCardMergePlan = {
  survivorId: string;
  redundantId: string;
  survivorStatus: string;
  survivorReason: string;
  blockedReason: string | null;
  aim: DuplicateMergeScorePlan;
  experience: DuplicateMergeScorePlan;
};

export type DuplicateMergeCardInput = {
  id: string;
  status: string;
  passReason: string | null;
  tailoringStaged: boolean;
  submittedResume: string | null;
  aim: DuplicateMergeScoreSource | null;
  experience: DuplicateMergeScoreSource | null;
};

const ACTIVE_MERGE_STATUS_RANK: Readonly<Record<string, number>> = {
  interviewing: 900,
  applied: 850,
  inbox: 700,
  pending_af: 650,
  bookmarked: 600,
  cooldown: 500,
  passed: 300,
  expired: 150,
  archived: 120,
  dismissed: 100,
};

function mergeCardRank(card: DuplicateMergeCardInput): [number, number, number] {
  const protectedWork = card.submittedResume ? 1_100
    : card.status === 'passed' && card.passReason === 'Already applied' ? 820
      : card.tailoringStaged ? 800
        : ACTIVE_MERGE_STATUS_RANK[card.status] ?? 0;
  const positiveScores = [card.aim?.value, card.experience?.value]
    .filter((value): value is number => typeof value === 'number' && value > 0);
  return [protectedWork, positiveScores.length, positiveScores.reduce((sum, value) => sum + value, 0)];
}

function compareMergeCards(left: DuplicateMergeCardInput, right: DuplicateMergeCardInput, preferredId: string): number {
  const leftRank = mergeCardRank(left);
  const rightRank = mergeCardRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
  }
  if (left.id === preferredId) return 1;
  if (right.id === preferredId) return -1;
  return left.id.localeCompare(right.id) <= 0 ? 1 : -1;
}

function mergeScorePlan(
  survivor: DuplicateMergeCardInput,
  redundant: DuplicateMergeCardInput,
  dimension: 'aim' | 'experience',
): DuplicateMergeScorePlan {
  const available = [survivor[dimension], redundant[dimension]]
    .filter((source): source is DuplicateMergeScoreSource => source !== null);
  const positive = available.filter((source) => source.value > 0);
  // A positive score is evidence worth preserving. A hard-gated zero never
  // drags a positive duplicate down; two positive scores are averaged.
  const contributing = positive.length > 0 ? positive : available;
  if (contributing.length === 0) return { value: null, mode: 'none', sources: [], writeDerivedEvent: false };
  const value = Math.round(contributing.reduce((sum, source) => sum + source.value, 0) / contributing.length);
  const survivorOwnsOnlySource = contributing.length === 1 && contributing[0].jobId === survivor.id;
  const mode = contributing.length > 1 ? 'average'
    : survivorOwnsOnlySource ? 'preserved' : 'carried';
  return {
    value,
    mode,
    sources: contributing,
    writeDerivedEvent: !survivorOwnsOnlySource,
  };
}

/** Pure, deterministic plan shared by the review screen and the write path. */
export function chooseDuplicateCardMergePlan(
  cards: readonly [DuplicateMergeCardInput, DuplicateMergeCardInput],
  preferredId: string,
): DuplicateCardMergePlan {
  const [left, right] = cards;
  if (left.submittedResume && right.submittedResume) {
    return {
      survivorId: preferredId,
      redundantId: preferredId === left.id ? right.id : left.id,
      survivorStatus: preferredId === left.id ? left.status : right.status,
      survivorReason: 'Both cards contain submitted résumés.',
      blockedReason: 'Both cards contain submitted résumés. Review those application records before merging.',
      aim: { value: null, mode: 'none', sources: [], writeDerivedEvent: false },
      experience: { value: null, mode: 'none', sources: [], writeDerivedEvent: false },
    };
  }
  const survivor = compareMergeCards(left, right, preferredId) >= 0 ? left : right;
  const redundant = survivor.id === left.id ? right : left;
  const reason = survivor.submittedResume
    ? 'This card contains the submitted résumé and application record.'
    : ['applied', 'interviewing'].includes(survivor.status)
      ? `The ${survivor.status} card keeps the protected application history.`
      : ['inbox', 'pending_af', 'bookmarked'].includes(survivor.status)
        ? `The active ${survivor.status.replaceAll('_', ' ')} card remains visible.`
        : 'This card has the strongest retained lifecycle and score state.';
  const aim = mergeScorePlan(survivor, redundant, 'aim');
  const experience = mergeScorePlan(survivor, redundant, 'experience');
  // A real Experience event is bound to the real Aim event that preceded it.
  // If this merge creates a new derived Aim event, retain an otherwise
  // unchanged Experience score through its own derived event so it does not
  // become stale merely because the two cards were consolidated.
  const boundExperience = aim.writeDerivedEvent && experience.value !== null
    ? { ...experience, writeDerivedEvent: true }
    : experience;
  return {
    survivorId: survivor.id,
    redundantId: redundant.id,
    survivorStatus: survivor.status,
    survivorReason: reason,
    blockedReason: null,
    aim,
    experience: boundExperience,
  };
}

function scoreSource(
  jobId: string,
  event: { id?: string; aimFitScore?: number | null; experienceFitScore?: number | null } | null,
  dimension: 'aim' | 'experience',
): DuplicateMergeScoreSource | null {
  const value = dimension === 'aim' ? event?.aimFitScore : event?.experienceFitScore;
  return event?.id && Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100
    ? { jobId, eventId: event.id, value: Number(value) }
    : null;
}

async function mergeInputsForJobs(tx: Prisma.TransactionClient, jobs: readonly [Job, Job]) {
  const bundles = await latestJobScoreEvents(jobs.map((job) => job.id), tx);
  return jobs.map((job): DuplicateMergeCardInput => {
    const projected = projectJobScoreAuthority(job, bundles.get(job.id) || null);
    return {
      id: job.id,
      status: job.status,
      passReason: job.passReason,
      tailoringStaged: job.tailoringStaged,
      submittedResume: job.submittedResume,
      aim: scoreSource(job.id, projected.currentAim || projected.currentScore, 'aim'),
      experience: scoreSource(job.id, projected.currentExperience || projected.currentScore, 'experience'),
    };
  }) as [DuplicateMergeCardInput, DuplicateMergeCardInput];
}

export type DuplicateMergeReviewCard = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  status: string;
  source: string | null;
  url: string | null;
  tailoringStaged: boolean;
  hasSubmittedResume: boolean;
  aimFitScore: number | null;
  reqFitScore: number | null;
};

export async function previewDuplicateCardMerge(
  tx: Prisma.TransactionClient,
  input: { firstId: string; secondId: string; preferredId: string },
): Promise<{ cards: [DuplicateMergeReviewCard, DuplicateMergeReviewCard]; plan: DuplicateCardMergePlan }> {
  if (input.firstId === input.secondId) throw new CardMergeRefused('A card cannot be merged into itself.');
  const rows = await tx.job.findMany({ where: { id: { in: [input.firstId, input.secondId] } } });
  const first = rows.find((row) => row.id === input.firstId);
  const second = rows.find((row) => row.id === input.secondId);
  if (!first || !second) throw new CardMergeRefused('One of the two cards no longer exists.');
  const jobs: [Job, Job] = [first, second];
  const inputs = await mergeInputsForJobs(tx, jobs);
  const plan = chooseDuplicateCardMergePlan(inputs, input.preferredId);
  const cards = jobs.map((job, index): DuplicateMergeReviewCard => ({
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    status: job.status,
    source: job.source,
    url: job.url,
    tailoringStaged: job.tailoringStaged,
    hasSubmittedResume: Boolean(job.submittedResume),
    aimFitScore: inputs[index].aim?.value ?? null,
    reqFitScore: inputs[index].experience?.value ?? null,
  })) as [DuplicateMergeReviewCard, DuplicateMergeReviewCard];
  return { cards, plan };
}

async function createDuplicateMergeScoreEvent(
  tx: Prisma.TransactionClient,
  input: {
    survivor: Job;
    redundant: Job;
    dimension: 'aim' | 'experience';
    score: DuplicateMergeScorePlan;
  },
) {
  if (!input.score.writeDerivedEvent || input.score.value === null) return;
  const evaluationType = input.dimension === 'aim' ? 'duplicate_merge_aim' : 'duplicate_merge_experience';
  const inputBindings = {
    kind: 'duplicate_card_merge',
    version: 1,
    survivorJobId: input.survivor.id,
    redundantJobId: input.redundant.id,
    scoreMode: input.score.mode,
    sources: input.score.sources,
  };
  const resultHash = canonicalJsonSha256({ evaluationType, score: input.score.value, inputBindings });
  const sourceValues = input.score.sources.map((source) => source.value).join(' and ');
  const reason = input.score.mode === 'average'
    ? `Duplicate cards merged: ${input.score.value}/100 is the rounded average of ${sourceValues}.`
    : `Duplicate cards merged: preserved the positive ${input.score.value}/100 score from the other card.`;
  await tx.jobScoreEvent.create({
    data: {
      id: randomUUID(),
      jobId: input.survivor.id,
      evaluationType,
      model: 'deterministic-card-merge',
      promptVersion: 'duplicate-card-merge-v1',
      policyVersion: 'positive-score-preservation-average-v1',
      idempotencyKey: canonicalJsonSha256({ ...inputBindings, evaluationType }),
      schemaVersion: 'career-dashboard-duplicate-score-merge-v1',
      resultHash,
      inputHash: canonicalJsonSha256(inputBindings),
      decisionCode: 'duplicate_card_merge',
      aimFitScore: input.dimension === 'aim' ? input.score.value : null,
      experienceFitScore: input.dimension === 'experience' ? input.score.value : null,
      passed: input.dimension === 'aim'
        ? input.score.value > 0
        : experienceScorePasses(input.score.value),
      aimReason: input.dimension === 'aim' ? reason : null,
      experienceReason: input.dimension === 'experience' ? reason : null,
      aimAssessments: Prisma.JsonNull,
      mandatoryRequirementAssessments: Prisma.JsonNull,
      travelAssessment: Prisma.JsonNull,
      compensationAssessment: Prisma.JsonNull,
      inputBindings: inputBindings as unknown as Prisma.InputJsonValue,
      workerProvenance: {
        kind: 'deterministic_card_merge',
        sourceEventIds: input.score.sources.map((source) => source.eventId),
      } as unknown as Prisma.InputJsonValue,
      lifecycleProjection: input.survivor.status,
      lifecyclePriorStatus: input.survivor.status,
      lifecycleApplied: false,
    },
  });
}

/**
 * Folds one card into another after Joseph confirms they are the same job.
 *
 * The survivor keeps its own status, scores, description and résumé. The
 * other card is dismissed as consolidated and its sources move over. If the
 * other card holds an application and the survivor holds none, the application
 * moves to the survivor. Two different human decisions, or a submitted résumé
 * on the card being folded away, still refuse: those are facts only Joseph can
 * reconcile, and merging would erase one of them.
 */
export async function mergeDuplicateCards(tx: Prisma.TransactionClient, input: {
  redundantId: string;
  survivorId: string;
  route: 'paste_link' | 'card_merge';
}): Promise<UrlReconciliation & { mergePlan: DuplicateCardMergePlan }> {
  if (input.redundantId === input.survivorId) throw new CardMergeRefused('A card cannot be merged into itself.');
  await lockJobUrlEdits(tx);
  for (const id of [input.redundantId, input.survivorId].sort()) {
    await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${id} FOR UPDATE`;
  }
  const first = await tx.job.findUnique({ where: { id: input.redundantId } });
  const second = await tx.job.findUnique({ where: { id: input.survivorId } });
  if (!first || !second) throw new CardMergeRefused('One of the two cards no longer exists.');
  if (first.passReason?.startsWith(CONSOLIDATED_REASON_PREFIX)) {
    throw new CardMergeRefused('This card was already merged into another card.');
  }
  if (second.passReason?.startsWith(CONSOLIDATED_REASON_PREFIX)) {
    throw new CardMergeRefused('The card you are merging into was itself merged into another card. Open that card instead.');
  }
  const jobs: [Job, Job] = [first, second];
  const mergeInputs = await mergeInputsForJobs(tx, jobs);
  const mergePlan = chooseDuplicateCardMergePlan(mergeInputs, input.redundantId);
  if (mergePlan.blockedReason) throw new CardMergeRefused(mergePlan.blockedReason);
  const survivor = jobs.find((job) => job.id === mergePlan.survivorId)!;
  const redundant = jobs.find((job) => job.id === mergePlan.redundantId)!;

  // Prefer the employer's own posting as the link the card opens.
  const survivorAggregated = isRedirectResolutionAggregatorLink(survivor.url);
  const redundantDirect = Boolean(redundant.url) && !isRedirectResolutionAggregatorLink(redundant.url);
  const linkUpdate = survivorAggregated && redundantDirect
    ? { url: redundant.url, canonicalUrl: normalizeUrl(redundant.canonicalUrl || redundant.url || '') }
    : {};
  const preferredLink = linkUpdate.url || survivor.url;
  const preferredPostingIdentity = preferredLink
    ? urlPostingIdentity(preferredLink) || redundant.postingIdentity || survivor.postingIdentity
    : redundant.postingIdentity || survivor.postingIdentity;
  const survivorOpen = ['inbox', 'pending_af', 'bookmarked'].includes(survivor.status);

  const reason = `${CONSOLIDATED_REASON_PREFIX}${survivor.id}`;
  await tx.job.update({ where: { id: redundant.id }, data: {
    status: 'dismissed', passReason: reason, tailoringStaged: false, postingIdentity: null,
    jdBatchId: null, batchJobId: null, afBatchId: null, contextBatched: true, contextBatchId: null,
  } });
  await tx.jobSourceObservation.updateMany({ where: { jobId: redundant.id }, data: { jobId: survivor.id } });
  await tx.jobAttachment.updateMany({ where: { jobId: redundant.id }, data: { jobId: survivor.id } });
  if (redundant.source && redundant.sourceId) {
    await tx.jobSourceObservation.upsert({
      where: { source_sourceId: { source: redundant.source, sourceId: redundant.sourceId } },
      update: {},
      create: { jobId: survivor.id, source: redundant.source, sourceId: redundant.sourceId, url: redundant.url },
    });
  }
  const job = await tx.job.update({ where: { id: survivor.id }, data: {
    ...linkUpdate,
    ...(preferredPostingIdentity ? { postingIdentity: preferredPostingIdentity } : {}),
    ...(redundant.tailoringStaged && survivorOpen && !survivor.tailoringStaged ? { tailoringStaged: true } : {}),
    ...(mergePlan.aim.value !== null ? { aimFitScore: mergePlan.aim.value, scoringStatus: 'scored' } : {}),
    ...(mergePlan.experience.value !== null ? { reqFitScore: mergePlan.experience.value } : {}),
  } });

  await createDuplicateMergeScoreEvent(tx, { survivor: job, redundant, dimension: 'aim', score: mergePlan.aim });
  await createDuplicateMergeScoreEvent(tx, { survivor: job, redundant, dimension: 'experience', score: mergePlan.experience });

  const identity = ['card_merge', redundant.id, survivor.id, redundant.updatedAt.toISOString()];
  await recordJobPipelineEvent({
    eventType: 'user_lifecycle', jobId: redundant.id, stage: 'human_decision',
    source: redundant.source, sourceId: redundant.sourceId, identityParts: identity,
    details: {
      actor: 'user', protected: true, derived: true, route: input.route,
      priorStatus: redundant.status, nextStatus: 'dismissed', duplicateOfJobId: survivor.id, reason,
      previousUrl: redundant.url, mergePlan,
      nextTailoringStaged: false,
    },
  }, tx);
  await recordJobPipelineEvent({
    eventType: 'user_lifecycle', jobId: survivor.id, stage: 'human_decision',
    source: survivor.source, sourceId: survivor.sourceId, identityParts: [...identity, 'survivor'],
    details: {
      actor: 'user', protected: true, derived: true, route: input.route,
      priorStatus: survivor.status, nextStatus: job.status, decisionSourceJobId: redundant.id,
      previousUrl: survivor.url, nextUrl: job.url, mergePlan,
      nextTailoringStaged: job.tailoringStaged,
    },
  }, tx);
  return { job, consolidatedJobId: redundant.id, mergePlan };
}

function isRedirectResolutionAggregatorLink(url: string | null | undefined): boolean {
  return Boolean(url) && isRedirectResolutionAggregatorUrl(String(url));
}
