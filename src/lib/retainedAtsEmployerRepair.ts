import { resolveAtsItemRaw } from './atsRawEvidence';
import { readPublishedAtsBoardEmployer, readPublishedAtsPostingEvidence, type AtsPostingEmployerEvidence } from './atsEmployerRecovery';
import { VERIFIED_ATS_EMPLOYER_ORIGIN, VERIFIED_ATS_EMPLOYER_RULE, VERIFIED_ATS_POSTING_EMPLOYER_RULE, atsPostingEmployerKey } from './atsEmployerRegistry';
import { canonicalJsonSha256 } from './scoringCanonicalJson';
import type { PrismaClient } from './prismaClient';
import { atsV2PersistenceCapacityBacklog } from './atsAcquisitionLedger';
import { atsPersistenceAllocation } from './atsPersistenceAllocation';
import { ATS_ACQUISITION_JOB_HIGH_WATERMARK, ATS_ACQUISITION_JOB_LOW_WATERMARK } from './atsAcquisition';
import { withProviderTransactionRetry } from './ingestionControl';

export type RetainedEmployerProof = {
  requestedUrl: string; responseUrl: string; status: number; body: string; hash: string;
};
export type RetainedEmployerBoard = {
  platform: string; slug: string; company: string; checkedAt: string | null; error: string | null;
  sources: RetainedEmployerProof[];
  job?: Record<string, unknown>;
  evidence?: AtsPostingEmployerEvidence | null;
  segments: Array<{ id: string; processingOffset: number; itemCount: number; manifestHash: string }>;
};
export type RetainedEmployerPlan = {
  version: 1; createdAt: string; complete: boolean; boards: RetainedEmployerBoard[];
};
export const retainedEmployerPlanHash = (plan: RetainedEmployerPlan) => canonicalJsonSha256(plan);

/** Re-run the existing source parser against recorded responses. A plan cannot
 * substitute a guessed employer, an unrecorded redirect, or a different site. */
export async function verifyRetainedEmployerProof(board: RetainedEmployerBoard): Promise<void> {
  if (!board.company || !['oracle', 'ukg'].includes(board.platform)) throw new Error('Unsupported or unresolved employer proof.');
  const sources = new Map(board.sources.map(source => [source.requestedUrl, source]));
  if (sources.size !== board.sources.length) throw new Error('Ambiguous repeated evidence URLs.');
  for (const source of sources.values()) {
    if (canonicalJsonSha256(source.body) !== source.hash) throw new Error('Employer evidence bytes changed.');
  }
  const dependencies = {
    registry: async () => '',
    useWebsiteCache: false,
    fetchPage: async (url: string) => {
      const source = sources.get(url);
      if (!source) throw new Error('Employer evidence requests an unrecorded source.');
      const response = new Response(source.status === 204 ? null : source.body, { status: source.status });
      Object.defineProperty(response, 'url', { value: source.responseUrl });
      return response;
    },
  };
  const posting = board.job ? await readPublishedAtsPostingEvidence(board.platform, board.slug, board.job, dependencies) : null;
  const company = board.job ? posting?.company : await readPublishedAtsBoardEmployer(board.platform, board.slug, dependencies);
  if (company !== board.company) throw new Error('The saved source does not verify the selected employer.');
  if (board.job && canonicalJsonSha256(posting) !== canonicalJsonSha256(board.evidence)) throw new Error('Posting evidence changed.');
}

/** Explicit repair only. Keep raw items, manifests, offsets, future retry dates,
 * cards and scores untouched. Release due, proven work within current capacity. */
export async function applyRetainedEmployerPlan(client: PrismaClient, plan: RetainedEmployerPlan, selectionHash: string, now = new Date()) {
  if (plan.version !== 1 || !plan.complete || retainedEmployerPlanHash(plan) !== selectionHash) throw new Error('A complete, unchanged recovery plan is required.');
  const verified = plan.boards.filter(board => board.company);
  for (const board of verified) {
    const age = now.getTime() - Date.parse(board.checkedAt || '');
    if (!Number.isFinite(age) || age < 0 || age > 8 * 3600_000) throw new Error('Employer proof expired; collect a fresh plan.');
    await verifyRetainedEmployerProof(board);
  }
  const allocation = atsPersistenceAllocation(ATS_ACQUISITION_JOB_LOW_WATERMARK, ATS_ACQUISITION_JOB_HIGH_WATERMARK);
  let registeredBoards = 0, releasedSegments = 0, releasedItems = 0;
  for (const board of verified) {
    const result = await withProviderTransactionRetry(() => client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(912837465)`;
      const matchKey = board.job ? atsPostingEmployerKey(board.platform, board.slug, board.job) : `${board.platform}:${board.slug}`;
      const matchType = board.job ? VERIFIED_ATS_POSTING_EMPLOYER_RULE : VERIFIED_ATS_EMPLOYER_RULE;
      const existing = await tx.companyNameRule.findUnique({ where: { matchType_matchKey: { matchType, matchKey } } });
      if (existing && (existing.origin !== VERIFIED_ATS_EMPLOYER_ORIGIN || existing.standardName !== board.company)) {
        return { registered: false, conflict: true, segments: 0, items: 0 };
      }
      const evidence = { checkedAt: board.checkedAt, selectionHash,
        ...(board.job ? { postingKey: matchKey, description: board.evidence?.description || null, location: board.evidence?.location || null } : {}),
        sources: board.sources.map(({ requestedUrl, responseUrl, hash }) => ({ requestedUrl, responseUrl, hash })) };
      await tx.companyNameRule.upsert({
        where: { matchType_matchKey: { matchType, matchKey } },
        create: { matchType, matchKey, standardName: board.company, origin: VERIFIED_ATS_EMPLOYER_ORIGIN, evidence },
        update: { evidence },
      });
      const capacity = await atsV2PersistenceCapacityBacklog(tx, now);
      let available = Math.max(0, Math.min(200 - releasedItems, allocation.publicationHigh - capacity));
      let segments = 0, items = 0;
      for (const segment of board.segments) {
        const remaining = segment.itemCount - segment.processingOffset;
        if (remaining <= 0 || remaining > available) continue;
        if (board.job) {
          const current = await tx.atsIngestionSegment.findUnique({ where: { id: segment.id },
            select: { batchId: true, ledgerGeneration: true, firstOrdinal: true, processingOffset: true } });
          if (!current || current.processingOffset !== segment.processingOffset) continue;
          const item = await tx.atsIngestionItem.findUnique({ where: { batchId_ledgerGeneration_canonicalOrdinal: {
            batchId: current.batchId, ledgerGeneration: current.ledgerGeneration,
            canonicalOrdinal: current.firstOrdinal + current.processingOffset,
          } }, include: { representativeObservation: true } });
          if (!item) continue;
          const job = { ...resolveAtsItemRaw(item), ...item.enrichmentOverlay as Record<string, unknown> };
          if (atsPostingEmployerKey(board.platform, board.slug, job) !== matchKey) continue;
        }
        const changed = await tx.atsIngestionSegment.updateMany({
          where: { ...segment, status: 'published', leaseToken: null,
            batch: { platform: board.platform, slug: board.slug, writerMode: 'v2' },
            holdReason: `${board.platform} downloaded work awaits a verified employer`,
            OR: [{ retryCode: null }, { retryCode: 'employer_unverified' }],
            AND: [{ OR: [{ nextProcessAt: null }, { nextProcessAt: { lte: now } }] }],
          },
          data: { holdReason: null, retryCode: null, retryScope: null },
        });
        if (changed.count) { segments++; items += remaining; available -= remaining; }
      }
      return { registered: true, conflict: false, segments, items };
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 }));
    registeredBoards += Number(result.registered); releasedSegments += result.segments; releasedItems += result.items;
  }
  return { selectionHash, registeredBoards, releasedSegments, releasedItems,
    unresolvedBoards: plan.boards.filter(board => !board.company).length,
    conflictingBoards: verified.length - registeredBoards, jobWrites: 0, scoreWrites: 0 };
}
