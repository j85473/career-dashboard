import type { Job, Prisma } from '@prisma/client';
import { generatePostingIdentity, normalizeCompany, normalizeJobLocation, normalizeTitle, normalizeUrl } from './jobIngestion';
import { recordJobPipelineEvent } from './ingestionControl';

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

export function urlMetadataConflict(left: Pick<Job, 'title' | 'company' | 'location'>, right: Pick<Job, 'title' | 'company' | 'location'>): string | null {
  if (normalizeCompany(left.company).replace(/\s/g, '') !== normalizeCompany(right.company).replace(/\s/g, '')) return 'employer';
  if (normalizeTitle(left.title) !== normalizeTitle(right.title)) return 'job title';
  const a = normalizeJobLocation(left.location || '');
  const b = normalizeJobLocation(right.location || '');
  if (a !== b) return 'location';
  return null;
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
  const conflict = urlMetadataConflict(current, target);
  if (conflict) throw new JobUrlConflict(`This URL belongs to another saved job, but the ${conflict} differs: “${current[conflict === 'employer' ? 'company' : conflict === 'job title' ? 'title' : 'location']}” versus “${target[conflict === 'employer' ? 'company' : conflict === 'job title' ? 'title' : 'location']}”. Review the job details before consolidating. No changes were saved.`);
  if (input.allowConsolidation === false) throw new JobUrlConflict('This URL matches another saved job. Update the link separately before making other changes. No changes were saved.');
  // A URL edit may remove the redundant active copy, but cannot overwrite any
  // application or other explicit human decision on either record.
  if (!['inbox', 'pending_af'].includes(current.status) || current.tailoringStaged || current.passReason === 'Already applied') {
    throw new JobUrlConflict('This URL matches another saved job, but the edited record has a saved decision or staged resume. Review both records before consolidating. No changes were saved.');
  }
  if (!['applied', 'interviewing', 'inbox', 'pending_af'].includes(target.status)) {
    throw new JobUrlConflict(`This URL matches a saved job marked ${target.status}. Review that record before consolidating. No changes were saved.`);
  }
  const reason = `Consolidated after URL edit into job ${target.id}`;
  await tx.job.update({ where: { id: current.id }, data: {
    url, canonicalUrl: url, postingIdentity: null,
    status: 'dismissed', passReason: reason, tailoringStaged: false,
    jdBatchId: null, batchJobId: null, afBatchId: null,
    contextBatched: true, contextBatchId: null,
  } });
  await tx.jobSourceObservation.updateMany({ where: { jobId: current.id }, data: { jobId: target.id } });
  if (current.source && current.sourceId) {
    await tx.jobSourceObservation.upsert({
      where: { source_sourceId: { source: current.source, sourceId: current.sourceId } },
      update: {},
      create: { jobId: target.id, source: current.source, sourceId: current.sourceId, url: current.url },
    });
  }
  // Store the stable key on the survivor for subsequent ingestion. Never copy
  // scores, descriptions, application history, or decisions between records.
  const job = await tx.job.update({ where: { id: target.id }, data: { postingIdentity } });
  await recordJobPipelineEvent({
    eventType: 'user_lifecycle', jobId: current.id, stage: 'human_decision',
    source: current.source, sourceId: current.sourceId,
    identityParts: ['url_reconciliation', current.id, target.id, current.updatedAt.toISOString()],
    details: { actor: 'user', protected: true, derived: true, route: 'url_reconciliation',
      priorStatus: current.status, nextStatus: 'dismissed', duplicateOfJobId: target.id,
      previousUrl: current.url, nextUrl: url, reason },
  }, tx);
  return { job, consolidatedJobId: current.id };
}
