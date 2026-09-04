import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { isAggregatorSource } from './atsDirectMatch';
import {
  findDirectAtsReprint, generatePostingIdentity, isDirectAtsReprint,
  isLikelyDuplicatePosting, normalizeUrl, type DuplicateJobIdentity,
} from './jobIngestion';
import { JobUrlConflict, lockJobUrlEdits, reconcileJobUrlEdit } from './jobUrlReconciliation';
import { AUTHORITATIVE_SCORE_EVENT_TYPES } from './scoreAuthority';

/** A later direct sighting becomes the source of the existing saved card. */
export async function preferIncomingDirectAtsSource(
  tx: Prisma.TransactionClient, jobId: string, incoming: DuplicateJobIdentity,
): Promise<void> {
  if (!/^ATS-/i.test(incoming.source || '') || !incoming.sourceId || !incoming.url) return;
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${jobId} FOR UPDATE`;
  const job = await tx.job.findUnique({ where: { id: jobId } });
  if (!job || /^ATS-/i.test(job.source || '') || !isAggregatorSource(job.source)) return;
  if (job.passReason?.startsWith('Consolidated after URL edit into job ')) return;
  if (!isLikelyDuplicatePosting(job, incoming) && !isDirectAtsReprint(job, incoming)) return;
  const url = normalizeUrl(incoming.canonicalUrl || incoming.url);
  const postingIdentity = generatePostingIdentity({ ...incoming, canonicalUrl: url });
  if (postingIdentity) {
    const owner = await tx.job.findUnique({ where: { postingIdentity }, select: { id: true } });
    if (owner && owner.id !== jobId) return;
  }
  // Source provenance survives even on historical rows without an observation.
  if (job.source && job.sourceId) await tx.jobSourceObservation.upsert({
    where: { source_sourceId: { source: job.source, sourceId: job.sourceId } },
    update: {}, create: { jobId, source: job.source, sourceId: job.sourceId, url: job.url },
  });
  // Retain the saved card ID, human decisions, all score inputs and score events.
  await tx.job.update({ where: { id: jobId }, data: {
    source: incoming.source!, sourceId: incoming.sourceId, url, canonicalUrl: url, postingIdentity,
  } });
}

/** Existing copies are checked again when either source is rediscovered. */
export async function consolidateStoredAtsReprint(jobId: string, apply = true, store: Pick<typeof prisma, 'job' | '$transaction'> = prisma) {
  const job = await store.job.findFirst({ where: { id: jobId, status: { in: ['inbox', 'pending_af', 'applied', 'interviewing'] } } });
  if (!job || job.passReason?.startsWith('Consolidated after URL edit into job ')) return null;
  const match = await findDirectAtsReprint(job, jobId, store);
  if (!match) return null;
  const direct = /^ATS-/i.test(job.source || '') ? job : match;
  const aggregate = direct.id === job.id ? match : job;
  const url = direct.canonicalUrl || direct.url;
  if (!url) return null;
  const plan = { canonicalId: direct.id, redundantId: aggregate.id, url, title: direct.title, company: direct.company };
  if (!apply) return plan;
  try {
    return await store.$transaction(async tx => {
      await lockJobUrlEdits(tx);
      for (const id of [direct.id, aggregate.id].sort()) await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${id} FOR UPDATE`;
      const rows = await tx.job.findMany({ where: { id: { in: [direct.id, aggregate.id] } } });
      const freshDirect = rows.find(row => row.id === direct.id);
      const freshAggregate = rows.find(row => row.id === aggregate.id);
      if (!freshDirect || !freshAggregate || !isDirectAtsReprint(freshDirect, freshAggregate)) return null;
      if (!['inbox', 'pending_af', 'applied', 'interviewing'].includes(freshDirect.status)) return null;
      // A scored reprint must never disappear behind an unscored ATS card.
      if ((freshAggregate.aimFitScore !== null && freshDirect.aimFitScore === null)
        || (freshAggregate.reqFitScore !== null && freshDirect.reqFitScore === null)
        || (freshAggregate.fitScore !== null && freshDirect.fitScore === null)) return null;
      const scoreEvents = await tx.jobScoreEvent.findMany({
        where: { jobId: { in: rows.map(row => row.id) }, staleAt: null,
          evaluationType: { in: [...AUTHORITATIVE_SCORE_EVENT_TYPES] } },
        select: { jobId: true, evaluationType: true },
      });
      if (scoreEvents.some(event => event.jobId === freshAggregate.id
        && !scoreEvents.some(other => other.jobId === freshDirect.id && other.evaluationType === event.evaluationType))) return null;
      // Do not detach an export or race an in-flight score. Rediscovery retries.
      if (rows.some(row => row.jdBatchId || row.afBatchId || row.batchJobId || row.scoringStatus === 'scoring')) return null;
      if (await tx.scoringBatchItem.count({ where: { jobId: { in: rows.map(row => row.id) }, status: 'leased' } })) return null;
      const result = await reconcileJobUrlEdit(tx, {
        id: freshAggregate.id, url: freshDirect.canonicalUrl || freshDirect.url!,
        expectedUpdatedAt: freshAggregate.updatedAt, origin: 'ingestion',
      });
      return result.consolidatedJobId ? plan : null;
    }, { timeout: 15_000 });
  } catch (error) {
    if (error instanceof JobUrlConflict) return null;
    throw error;
  }
}
