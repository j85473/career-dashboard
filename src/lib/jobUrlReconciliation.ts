import type { Job, Prisma } from '@prisma/client';
import { locationsCompatibleForDirectMatch, isAggregatorSource } from './atsDirectMatch';
import { sameCompanyIdentity } from './companyIdentity';
import { generatePostingIdentity, normalizeJobLocation, normalizeTitle, normalizeUrl } from './jobIngestion';
import { recordJobPipelineEvent } from './ingestionControl';
import { isDirectAtsApiSource } from './jobSourceProvenance';

export class JobUrlConflict extends Error {
  constructor(message: string) { super(message); this.name = 'JobUrlConflict'; }
}

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
  left: Pick<Job, 'title' | 'company' | 'location'>,
  right: Pick<Job, 'title' | 'company' | 'location'>,
  options: { allowDirectAtsLocationCompatibility?: boolean } = {},
): string | null {
  if (!sameCompanyIdentity(left.company, right.company)) return 'employer';
  if (normalizeTitle(left.title) !== normalizeTitle(right.title)) return 'job title';
  const a = normalizeJobLocation(left.location || '');
  const b = normalizeJobLocation(right.location || '');
  if (a !== b && !(options.allowDirectAtsLocationCompatibility
    && locationsCompatibleForDirectMatch(left.location, right.location))) return 'location';
  return null;
}

type UrlReconciliationMetadata = Partial<Pick<Job, 'title' | 'company' | 'location'>>;

type ReconciliationPair = { canonical: Job; redundant: Job; prefersDirectAts: boolean };

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
    return { canonical: current, redundant: target, prefersDirectAts: true };
  }
  if (targetDirect && currentAggregator) {
    return { canonical: target, redundant: current, prefersDirectAts: true };
  }
  return { canonical: target, redundant: current, prefersDirectAts: false };
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
  if (!redundantDecision) return { transfer: null };
  if (!canonicalDecision) {
    if (!['inbox', 'pending_af'].includes(canonical.status)) {
      throw new JobUrlConflict(`This URL matches a saved job marked ${canonical.status}. Review that record before consolidating. No changes were saved.`);
    }
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
    allowDirectAtsLocationCompatibility: pair.prefersDirectAts,
  });
  if (conflict) throw new JobUrlConflict(`This URL belongs to another saved job, but the ${conflict} differs: “${current[conflict === 'employer' ? 'company' : conflict === 'job title' ? 'title' : 'location']}” versus “${target[conflict === 'employer' ? 'company' : conflict === 'job title' ? 'title' : 'location']}”. Review the job details before consolidating. No changes were saved.`);
  if (input.allowConsolidation === false) throw new JobUrlConflict('This URL matches another saved job. Update the link separately before making other changes. No changes were saved.');
  // A direct API result wins over an aggregate reprint. If the reprint holds
  // an explicit application decision, move that decision to the direct record
  // rather than discarding it. Scores, descriptions, and resumes never move.
  const decisionTransfer = pair.prefersDirectAts
    ? directSurvivorCanAbsorb(pair.redundant, pair.canonical)
    : null;
  if (!pair.prefersDirectAts) {
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
    ...(decisionTransfer?.transfer ? {
      status: decisionTransfer.transfer.status,
      passReason: decisionTransfer.transfer.passReason,
      contextBatched: true,
      contextBatchId: null,
    } : {}),
  } });
  await recordJobPipelineEvent({
    eventType: 'user_lifecycle', jobId: redundant.id, stage: 'human_decision',
    source: redundant.source, sourceId: redundant.sourceId,
    identityParts: ['url_reconciliation', redundant.id, canonical.id, redundant.updatedAt.toISOString()],
    details: { actor: 'user', protected: true, derived: true, route: 'url_reconciliation',
      priorStatus: redundant.status, nextStatus: 'dismissed', duplicateOfJobId: canonical.id,
      previousUrl: redundant.url, nextUrl: url, reason,
      canonicalSource: canonical.source,
      transferredHumanDecision: decisionTransfer?.transfer || null },
  }, tx);
  if (decisionTransfer?.transfer) {
    await recordJobPipelineEvent({
      eventType: 'user_lifecycle', jobId: canonical.id, stage: 'human_decision',
      source: canonical.source, sourceId: canonical.sourceId,
      identityParts: ['url_reconciliation_transfer', redundant.id, canonical.id, redundant.updatedAt.toISOString()],
      details: { actor: 'user', protected: true, derived: true, route: 'url_reconciliation',
        priorStatus: canonical.status, nextStatus: decisionTransfer.transfer.status,
        decisionSourceJobId: redundant.id, sourceJobStatus: redundant.status,
        sourceJobPassReason: redundant.passReason },
    }, tx);
  }
  return { job, consolidatedJobId: redundant.id };
}
