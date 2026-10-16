import { Prisma } from './prismaClient';
import { prisma } from './prisma';
import { firstCollectionHealth } from './atsFirstCollectionAdmission';
import type { AtsQueueHold, AtsQueueSnapshot } from './atsQueueSnapshot';

export function summarizeAtsHoldReason(error: string | null, fallback: string): string {
  if (!error) return fallback;
  if (/awaits a verified employer|no authoritative employer/i.test(error)) return 'Employer identity could not be verified';
  if (/ledger page .*changed after it was committed/i.test(error)) return 'Listing page changed after it was saved';
  if (/schema|posting identity|expected payload|no title/i.test(error)) return 'Response format or posting identity is invalid';
  if (/429|rate.limit|platform circuit/i.test(error)) return 'Provider rate limit or cooldown';
  if (/404|410/i.test(error)) return 'Career page or feed is unavailable (404/410)';
  if (/HTTP 40[13]/i.test(error)) return 'Provider refused access (401/403)';
  if (/HTTP 422/i.test(error)) return 'Provider rejected the listing request (422)';
  if (/ECONNRESET|fetch failed|50[0-4]|time.?out/i.test(error)) return 'Connection failed or provider timed out';
  return error.slice(0, 240);
}

type HoldRow = Omit<AtsQueueHold, 'count' | 'items' | 'retryAt' | 'lastRetryAt'> & {
  count: bigint | number; items: bigint | number; retryAt: Date | null; lastRetryAt: Date | null;
};

/** Group repeated failures without dropping any held work from the totals. */
export function groupAtsQueueHolds(rows: HoldRow[]): AtsQueueHold[] {
  const groups = new Map<string, AtsQueueHold>();
  for (const row of rows) {
    const reason = summarizeAtsHoldReason(row.reason, 'Waiting for retry');
    const key = JSON.stringify([row.stage, row.provider, reason, row.unit]);
    const value: AtsQueueHold = { ...row, reason, count: Number(row.count), items: Number(row.items),
      retryAt: row.retryAt?.toISOString() || null, lastRetryAt: row.lastRetryAt?.toISOString() || null };
    const prior = groups.get(key);
    if (!prior) groups.set(key, value);
    else {
      prior.count += value.count; prior.items += value.items;
      if (value.retryAt && (!prior.retryAt || value.retryAt < prior.retryAt)) prior.retryAt = value.retryAt;
      if (value.lastRetryAt && (!prior.lastRetryAt || value.lastRetryAt > prior.lastRetryAt)) prior.lastRetryAt = value.lastRetryAt;
    }
  }
  const stageOrder = ['First collection', 'Validation', 'Size review', 'Persistence', 'Acquisition', 'Provider', 'Common Crawl'];
  return [...groups.values()].sort((a, b) => stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage) || b.count - a.count || a.provider.localeCompare(b.provider));
}

async function queryAtsQueueTelemetry(): Promise<AtsQueueSnapshot> {
  const now = new Date();
  const nowUtc = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const [policy, counts, rows] = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
    const policy = await tx.atsFirstCollectionPolicy.findUnique({ where: { id: 'new-providers' } });
    const counts = await tx.$queryRaw<Array<Record<string, bigint>>>(Prisma.sql`
      SELECT
        (SELECT COUNT(*) FROM "AtsFirstCollectionCandidate" WHERE state='discovered' AND "nextValidationAt" <= ${nowUtc}) AS "validationDue",
        (SELECT COUNT(*) FROM "AtsFirstCollectionCandidate" WHERE state='discovered' AND "nextValidationAt" > ${nowUtc}) AS "validationHeld",
        (SELECT COUNT(*) FROM "AtsFirstCollectionCandidate" WHERE state='size_review') AS "sizeReview",
        (SELECT COUNT(*) FROM "AtsCompany" WHERE "firstCollectionState"='ready') AS ready,
        (SELECT COUNT(*) FROM "AtsCompany" WHERE "firstCollectionState"='ready' AND "acquisitionEngine"='legacy') AS "awaitingHandoff",
        (SELECT COUNT(*) FROM "AtsCompany" WHERE "firstCollectionState"='admitted') AS collecting,
        (SELECT COALESCE(SUM(GREATEST("itemCount"-"processingOffset",0)),0) FROM "AtsIngestionSegment"
          WHERE status='processing' OR (status='published' AND ("nextProcessAt" IS NULL OR "nextProcessAt" <= ${nowUtc}))) AS "persistenceDue",
        (SELECT COALESCE(SUM(GREATEST("itemCount"-"processingOffset",0)),0) FROM "AtsIngestionSegment"
          WHERE status='published' AND "nextProcessAt" > ${nowUtc}) AS "persistenceHeld",
        (SELECT COALESCE(SUM(GREATEST("jobCount"-"processingOffset",0)),0) FROM "AtsIngestionBatch"
          WHERE "writerMode"='legacy' AND (status='processing' OR (status='queued' AND ("nextProcessAt" IS NULL OR "nextProcessAt" <= ${nowUtc})))) AS "legacyPersistenceDue",
        (SELECT COALESCE(SUM(GREATEST("jobCount"-"processingOffset",0)),0) FROM "AtsIngestionBatch"
          WHERE "writerMode"='legacy' AND status='queued' AND "nextProcessAt">${nowUtc}) AS "legacyPersistenceHeld"
    `);
    const rows = await tx.$queryRaw<HoldRow[]>(Prisma.sql`
      WITH holds AS (
        SELECT CASE WHEN state='size_review' THEN 'Size review' ELSE 'Validation' END AS stage,
          platform AS provider, COALESCE("lastError",'Waiting for validation') AS reason,
          'candidates' AS unit, 0::bigint AS items, CASE WHEN state='size_review' THEN NULL ELSE "nextValidationAt" END AS retry,
          slug AS example
        FROM "AtsFirstCollectionCandidate" WHERE state='size_review' OR (state='discovered' AND "nextValidationAt">${nowUtc})
        UNION ALL
        SELECT 'First collection', platform,
          CASE WHEN "firstCollectionHoldReason" IS NOT NULL THEN "firstCollectionHoldReason"
            WHEN "acquisitionEngine"='legacy' THEN 'Awaiting automatic acquisition handoff (checked every five minutes)'
            ELSE 'Feed pacing or scheduled first collection' END, 'boards', 0::bigint,
          CASE WHEN "firstCollectionHoldReason" IS NOT NULL OR "acquisitionEngine"='legacy' THEN NULL ELSE "nextCheckDate" END, slug
        FROM "AtsCompany" WHERE "firstCollectionState" IN ('waiting','ready','admitted')
          AND ("firstCollectionHoldReason" IS NOT NULL OR "acquisitionEngine"='legacy' OR "nextCheckDate">${nowUtc})
        UNION ALL
        SELECT 'Acquisition', platform, COALESCE("lastError",'Scheduled acquisition retry'), 'batches',
          GREATEST("rawObservationCount"-"compactedOccurrenceCount"-"publishedItemCount",0)::bigint, "nextAcquireAt", slug
        FROM "AtsIngestionBatch" WHERE "writerMode"='v2' AND status IN ('fetching','partial','synchronized','reset_draining')
          AND "acquisitionPhase" IN ('listing','compaction','enrichment','sealing') AND "nextAcquireAt">${nowUtc}
        UNION ALL
        SELECT 'Persistence', b.platform,
          COALESCE(NULLIF(to_jsonb(s)->>'holdReason',''),
            CASE WHEN b.platform IN ('oracle','ukg','zohorecruit') AND
              COALESCE(i."enrichmentOverlay"->'__careerDashboardAtsEnrichment'->>'company', i."rawJson"->>'company','')=''
              THEN 'Downloaded item has no verified employer (older retry reason not recorded)'
              ELSE 'Processing retry (older retry reason not recorded)' END),
          'segments', GREATEST(s."itemCount"-s."processingOffset",0)::bigint, s."nextProcessAt", b.slug
        FROM "AtsIngestionSegment" s JOIN "AtsIngestionBatch" b ON b.id=s."batchId"
        LEFT JOIN "AtsIngestionItem" i ON i."batchId"=s."batchId" AND i."ledgerGeneration"=s."ledgerGeneration"
          AND i."canonicalOrdinal"=s."firstOrdinal"+s."processingOffset"
        WHERE s.status='published' AND s."nextProcessAt">${nowUtc}
        UNION ALL
        SELECT 'Persistence', platform, COALESCE("lastError",'Scheduled legacy processing retry'), 'batches',
          GREATEST("jobCount"-"processingOffset",0)::bigint, "nextProcessAt", slug
        FROM "AtsIngestionBatch" WHERE "writerMode"='legacy' AND status='queued' AND "nextProcessAt">${nowUtc}
        UNION ALL
        SELECT 'Provider', provider, COALESCE("lastError",'Provider cooldown'), 'providers', 0::bigint, "openUntil", NULL
        FROM "ProviderCircuit" WHERE provider LIKE 'ATS-%' AND state='open' AND "openUntil">${nowUtc}
        UNION ALL
        SELECT 'Common Crawl', platform, COALESCE(c."lastError",'Common Crawl page retry'), 'checkpoints', 0::bigint, "nextAttemptAt", pattern
        FROM "AtsDiscoveryAuditCheckpoint" c JOIN "AtsDiscoveryAuditRun" r ON r.id=c."runId"
        WHERE r.status='running' AND c."lastError" IS NOT NULL AND "nextAttemptAt">${nowUtc}
      ) SELECT stage, provider, reason, unit, COUNT(*)::bigint AS count, SUM(items)::bigint AS items,
          MIN(retry) AS "retryAt", MAX(retry) AS "lastRetryAt", MIN(example) AS example
        FROM holds GROUP BY stage,provider,reason,unit
    `);
    return [policy, counts[0], rows] as const;
  }, { timeout: 25_000 });
  const health = await firstCollectionHealth(prisma, policy?.maxCatalogueJobs, policy?.maxResponseBytes, now);
  const admissionNote = !policy || policy.mode === 'held' ? 'First collections are paused by policy'
    : !health.healthy ? `First collections await intake capacity: ${health.items.toLocaleString('en-US')} staged items and ${health.persistence.toLocaleString('en-US')} runnable persistence items`
    : policy.mode === 'capacity' ? `Capacity refill enabled · up to ${policy.maxUnfinished} unfinished collections · no daily quota`
    : `${policy.mode} admission · daily limit ${policy.dailyBoardLimit}`;
  const n = (key: string) => Number(counts?.[key] || 0);
  return { observedAt: now.toISOString(), mode: policy?.mode || 'held', admissionNote,
    validationDue: n('validationDue'), validationHeld: n('validationHeld'), sizeReview: n('sizeReview'),
    ready: n('ready'), awaitingHandoff: n('awaitingHandoff'), collecting: n('collecting'),
    persistenceDue: n('persistenceDue') + n('legacyPersistenceDue'), persistenceHeld: n('persistenceHeld') + n('legacyPersistenceHeld'), holds: groupAtsQueueHolds(rows) };
}

// Shared single-flight refresh: the Dashboard polls every three seconds, but
// diagnostics must not multiply expensive reads across browsers.
let cached: AtsQueueSnapshot | null = null;
let inFlight: Promise<AtsQueueSnapshot> | null = null;
export function readAtsQueueTelemetry(): Promise<AtsQueueSnapshot> {
  if (cached && Date.now()-new Date(cached.observedAt).valueOf()<15_000) return Promise.resolve(cached);
  if (!inFlight) inFlight = queryAtsQueueTelemetry().then(value => { cached=value; return value; }).finally(() => { inFlight=null; });
  return inFlight;
}
