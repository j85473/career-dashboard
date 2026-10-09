import { Prisma } from '@prisma/client';
import { TENANT_ATS_PLATFORMS, AtsFirstCollectionSizeError } from './tenantAtsBoards';

export const FIRST_COLLECTION_PLATFORMS = ['zohorecruit', ...TENANT_ATS_PLATFORMS] as const;
export const isFirstCollectionPlatform = (platform: string): boolean =>
  (FIRST_COLLECTION_PLATFORMS as readonly string[]).includes(platform);
export const FIRST_COLLECTION_POLICY_ID = 'new-providers';
export const FIRST_COLLECTION_HEALTH_WINDOW_MS = 15 * 60_000;
type Client = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | 'atsCompany' | 'atsFirstCollectionPolicy' | 'atsFirstCollectionCandidate'>;

export async function catalogueFirstCollectionCandidate(client: Pick<Client, 'atsFirstCollectionCandidate'>,
  board: { slug: string; platform: string }, sourceUrl?: string, discoveryRunId?: string): Promise<void> {
  if (!isFirstCollectionPlatform(board.platform)) throw new Error('Not a managed first-collection provider');
  await client.atsFirstCollectionCandidate.upsert({
    where: { slug_platform: { slug: board.slug, platform: board.platform } },
    create: { slug: board.slug, platform: board.platform, sourceUrl, discoveryRunId },
    update: { ...(sourceUrl ? { sourceUrl } : {}), ...(discoveryRunId ? { discoveryRunId } : {}) },
  });
}

/** Successful persistence, not listing completion, earns normal rotation. */
export async function reconcileFirstCollectionCompletion(client: Pick<Client, '$executeRaw'>): Promise<void> {
  await client.$executeRaw`
    UPDATE "AtsCompany" board
       SET "firstCollectionState"='established', "firstCollectionCompletedAt"=batch."processedAt",
           "firstCollectionHoldReason"=NULL
      FROM "AtsIngestionBatch" batch
     WHERE board."firstCollectionState"='admitted'
       AND board."firstCollectionBatchId"=batch.id
       AND batch.status='processed' AND batch."processedAt" IS NOT NULL
       AND batch."processingErrorCount"=0
  `;
}

export function firstCollectionAllowance(input: {
  mode: string; dailyBoardLimit: number; maxUnfinished: number;
  startedInWindow: number; unfinished: number; healthySince: Date | null; healthObservedAt: Date | null; now: Date;
}): boolean {
  return ['pilot', 'ramp'].includes(input.mode)
    && input.startedInWindow < input.dailyBoardLimit
    && input.unfinished < input.maxUnfinished
    && input.healthySince !== null
    && input.healthObservedAt !== null
    && input.healthObservedAt.getTime() >= input.now.getTime() - 10 * 60_000
    && input.healthySince.getTime() <= input.now.getTime() - FIRST_COLLECTION_HEALTH_WINDOW_MS;
}

/** JobScore's public feed is limited to one request per tenant per hour, across hosts and callers. */
export async function reserveJobScoreFeedRequest(client: Pick<Client, '$queryRaw'>, slug: string, now = new Date()): Promise<boolean> {
  const reserved = await client.$queryRaw<Array<{ slug: string }>>`
    INSERT INTO "AtsFirstCollectionCandidate" (slug,platform,"lastFeedRequestedAt","updatedAt")
    VALUES (${slug},'jobscore',${now},${now})
    ON CONFLICT (slug,platform) DO UPDATE SET "lastFeedRequestedAt"=${now},"updatedAt"=${now}
    WHERE "AtsFirstCollectionCandidate"."lastFeedRequestedAt" IS NULL
       OR "AtsFirstCollectionCandidate"."lastFeedRequestedAt" <= ${new Date(now.getTime() - 60 * 60_000)}
    RETURNING slug
  `;
  return reserved.length === 1;
}

async function firstCollectionCounts(client: Pick<Client, 'atsCompany'>, now: Date) {
  const [unfinished, startedInWindow] = await Promise.all([
    client.atsCompany.count({ where: { platform: { in: [...FIRST_COLLECTION_PLATFORMS] }, firstCollectionState: 'admitted' } }),
    client.atsCompany.count({ where: { platform: { in: [...FIRST_COLLECTION_PLATFORMS] }, firstCollectionAdmittedAt: { gt: new Date(now.getTime() - 86_400_000) } } }),
  ]);
  return { unfinished, startedInWindow };
}

/** Filter before the candidate limit so held boards cannot hide established work. */
export async function firstCollectionSelectionWhere(client: Client, now = new Date()): Promise<Prisma.AtsCompanyWhereInput> {
  const established: Prisma.AtsCompanyWhereInput = { OR: [
    { platform: { notIn: [...FIRST_COLLECTION_PLATFORMS] } }, { firstCollectionState: 'established' },
  ] };
  await reconcileFirstCollectionCompletion(client);
  const policy = await client.atsFirstCollectionPolicy.findUnique({ where: { id: FIRST_COLLECTION_POLICY_ID } });
  if (!policy || policy.mode === 'held') return established;
  const counts = await firstCollectionCounts(client, now);
  if (!firstCollectionAllowance({ ...policy, ...counts, now })) return established;
  const pilotBoards = Array.isArray(policy.pilotBoards) ? policy.pilotBoards.filter((x): x is string => typeof x === 'string') : [];
  const pilots = pilotBoards.map(value => { const split = value.indexOf('::'); return { platform: value.slice(0, split), slug: value.slice(split + 2) }; });
  return { OR: [...(established.OR || []), {
    platform: { in: [...FIRST_COLLECTION_PLATFORMS] }, firstCollectionState: 'ready',
    ...(policy.mode === 'pilot' ? { OR: pilots.length ? pilots : [{ slug: '__no_pilot__' }] } : {}),
  }] };
}

export async function firstCollectionHealth(client: Pick<Client, '$queryRaw'>, reserveJobs = 250, reserveBytes = 5242880) {
  const [snapshot] = await client.$queryRaw<Array<{ items: bigint; bytes: bigint; persistence: bigint; gate: string }>>`
    SELECT
      COALESCE((SELECT SUM(GREATEST("rawObservationCount"-"compactedOccurrenceCount"-"publishedItemCount",0))
        FROM "AtsIngestionBatch" WHERE "writerMode"='v2' AND status IN ('fetching','partial','synchronized')),0)::bigint AS items,
      COALESCE((SELECT SUM("acquisitionBytes") FROM "AtsIngestionBatch"
        WHERE "writerMode"='v2' AND status IN ('fetching','partial','synchronized')),0)::bigint AS bytes,
      (COALESCE((SELECT SUM(GREATEST("itemCount"-"processingOffset",0)) FROM "AtsIngestionSegment"
        WHERE status IN ('published','processing')),0)
       + COALESCE((SELECT SUM(GREATEST("jobCount"-"processingOffset",0)) FROM "AtsIngestionBatch"
        WHERE "writerMode"='legacy' AND status IN ('queued','processing')),0))::bigint AS persistence,
      (SELECT "admissionState" FROM "AtsAcquisitionRuntimeGate" WHERE id='global') AS gate
  `;
  const limit = (value: string | undefined, fallback: number) => value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  const itemLimit = Math.min(limit(process.env.ATS_LEDGER_STAGING_ITEM_LOW_WATERMARK, 50000), limit(process.env.ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK, 100000));
  const byteLimit = Math.min(limit(process.env.ATS_LEDGER_STAGING_BYTE_LOW_WATERMARK, 750000000), limit(process.env.ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK, 1500000000));
  const persistenceLimit = limit(process.env.ATS_ACQUISITION_JOB_LOW_WATERMARK, 1000);
  // Reserve every bounded page, not just the first response, for a paged catalogue.
  const catalogueByteReserve = reserveBytes * Math.max(1, Math.ceil(reserveJobs / 20));
  const healthy = !!snapshot && snapshot.gate === 'open'
    && Number(snapshot.items) + reserveJobs < itemLimit
    && Number(snapshot.bytes) + catalogueByteReserve < byteLimit
    && Number(snapshot.persistence) + reserveJobs < persistenceLimit;
  return { healthy, items: Number(snapshot?.items || 0), bytes: Number(snapshot?.bytes || 0), persistence: Number(snapshot?.persistence || 0),
    limits: { stagedItems: itemLimit, stagedBytes: byteLimit, persistenceJobs: persistenceLimit },
    reservation: { jobs: reserveJobs, catalogueBytes: catalogueByteReserve } };
}

/** Call inside the exact batch-creation transaction. The policy row serializes all hosts. */
export async function reserveFirstCollection(client: Client, board: { slug: string; platform: string }, batchId: string, now = new Date()): Promise<boolean> {
  if (!isFirstCollectionPlatform(board.platform)) return true;
  await client.$queryRaw`SELECT id FROM "AtsFirstCollectionPolicy" WHERE id=${FIRST_COLLECTION_POLICY_ID} FOR UPDATE`;
  await reconcileFirstCollectionCompletion(client);
  const current = await client.atsCompany.findUnique({ where: { slug_platform: { slug: board.slug, platform: board.platform } } });
  if (!current) return false;
  if (current.firstCollectionState === 'established') return true;
  if (current.firstCollectionState !== 'ready') return false;
  const policy = await client.atsFirstCollectionPolicy.findUnique({ where: { id: FIRST_COLLECTION_POLICY_ID } });
  if (!policy || !firstCollectionAllowance({ ...policy, ...await firstCollectionCounts(client, now), now })) return false;
  if (policy.mode === 'pilot' && (!Array.isArray(policy.pilotBoards) || !policy.pilotBoards.includes(`${board.platform}::${board.slug}`))) return false;
  if (current.jobsFound > policy.maxCatalogueJobs) return false;
  const health = await firstCollectionHealth(client, policy.maxCatalogueJobs, policy.maxResponseBytes);
  const growing = policy.lastStagedItems !== null && health.items > policy.lastStagedItems
    || policy.lastPersistenceJobs !== null && health.persistence > policy.lastPersistenceJobs;
  if (!health.healthy || growing) {
    await client.atsFirstCollectionPolicy.update({ where: { id: FIRST_COLLECTION_POLICY_ID }, data: {
      healthySince: health.healthy ? now : null, healthObservedAt: now,
      lastStagedItems: health.items, lastPersistenceJobs: health.persistence,
    } });
    return false;
  }
  const reserved = await client.atsCompany.updateMany({
    where: { slug: board.slug, platform: board.platform, firstCollectionState: 'ready' },
    data: { firstCollectionState: 'admitted', firstCollectionBatchId: batchId, firstCollectionAdmittedAt: now },
  });
  return reserved.count === 1;
}

export async function firstCollectionBodyLimits(client: Pick<Client, 'atsCompany' | 'atsFirstCollectionPolicy'>,
  board: { slug: string; platform: string }): Promise<{ maximumBytes: number; maximumJobs: number | null }> {
  if (!isFirstCollectionPlatform(board.platform)) return { maximumBytes: 50 * 1024 * 1024, maximumJobs: null };
  const current = await client.atsCompany.findUnique({ where: { slug_platform: { slug: board.slug, platform: board.platform } }, select: { firstCollectionState: true, firstCollectionHoldReason: true } });
  if (current?.firstCollectionHoldReason) throw new AtsFirstCollectionSizeError(`ATS catalogue deferred by first-collection review: ${current.firstCollectionHoldReason}`);
  const policy = await client.atsFirstCollectionPolicy.findUnique({ where: { id: FIRST_COLLECTION_POLICY_ID } });
  return { maximumBytes: current?.firstCollectionState === 'established' ? 15 * 1024 * 1024 : policy?.maxResponseBytes || 5242880,
    maximumJobs: current?.firstCollectionState !== 'established' ? policy?.maxCatalogueJobs || 250 : null };
}
