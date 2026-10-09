import { randomUUID } from 'node:crypto';
import { prisma } from './prisma';
import { recordDiscoveredAtsBoard } from './atsBoardDiscovery';
import { FIRST_COLLECTION_POLICY_ID, FIRST_COLLECTION_HEALTH_WINDOW_MS, FIRST_COLLECTION_PLATFORMS,
  firstCollectionHealth, firstCollectionAllowance, reconcileFirstCollectionCompletion } from './atsFirstCollectionAdmission';

export type FirstCollectionValidation = { success: boolean; jobsFound?: number; reason?: string; sizeReview?: boolean };
export function nextFirstCollectionHealthySince(input: {
  healthy: boolean; items: number; persistence: number; previousItems: number | null;
  previousPersistence: number | null; previousObservedAt: Date | null; previousHealthySince: Date | null; now: Date;
}): Date | null {
  if (!input.healthy) return null;
  const growing = input.previousItems !== null && input.items > input.previousItems
    || input.previousPersistence !== null && input.persistence > input.previousPersistence;
  const stale = !input.previousObservedAt || input.now.getTime() - input.previousObservedAt.getTime() > 10 * 60_000;
  return growing || stale ? input.now : input.previousHealthySince || input.now;
}

/** One leased validator across all hosts. Catalogue discovery itself makes no vendor calls. */
export async function tickFirstCollections(validate: (platform: string, slug: string, maximumBytes: number) => Promise<FirstCollectionValidation>, now = new Date(), client = prisma) {
  const token = randomUUID();
  const candidate = await client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AtsFirstCollectionPolicy" WHERE id=${FIRST_COLLECTION_POLICY_ID} FOR UPDATE`;
    await reconcileFirstCollectionCompletion(tx);
    const policy = await tx.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: FIRST_COLLECTION_POLICY_ID } });
    if (policy.mode === 'held') return null;
    const health = await firstCollectionHealth(tx, policy.maxCatalogueJobs, policy.maxResponseBytes);
    const healthySince = nextFirstCollectionHealthySince({ ...health, previousItems: policy.lastStagedItems,
      previousPersistence: policy.lastPersistenceJobs, previousObservedAt: policy.healthObservedAt,
      previousHealthySince: policy.healthySince, now });
    await tx.atsFirstCollectionPolicy.update({ where: { id: policy.id }, data: {
      healthySince, healthObservedAt: now, lastStagedItems: health.items, lastPersistenceJobs: health.persistence,
    } });
    if (policy.validationLeaseExpiresAt && policy.validationLeaseExpiresAt > now) return null;
    const windowStart = new Date(now.getTime() - 86_400_000);
    const unfinished = await tx.atsCompany.count({ where: { platform: { in: [...FIRST_COLLECTION_PLATFORMS] }, firstCollectionState: 'admitted' } });
    const startedInWindow = await tx.atsCompany.count({ where: { platform: { in: [...FIRST_COLLECTION_PLATFORMS] }, firstCollectionAdmittedAt: { gt: windowStart } } });
    if (!firstCollectionAllowance({ ...policy, healthySince, healthObservedAt: now, unfinished, startedInWindow, now })) return null;
    // Keep only one verified catalogue ahead of the single unfinished collection.
    if (await tx.atsCompany.count({ where: { platform: { in: [...FIRST_COLLECTION_PLATFORMS] }, firstCollectionState: 'ready' } })) return null;
    if (await tx.atsFirstCollectionCandidate.count({ where: { lastValidationStartedAt: { gt: windowStart } } }) >= policy.dailyBoardLimit) return null;
    const pilots = Array.isArray(policy.pilotBoards) ? policy.pilotBoards.filter((value): value is string => typeof value === 'string').map(value => {
      const split = value.indexOf('::'); return { platform: value.slice(0, split), slug: value.slice(split + 2) };
    }) : [];
    const next = await tx.atsFirstCollectionCandidate.findFirst({ where: {
      state: 'discovered', nextValidationAt: { lte: now },
      ...(policy.mode === 'pilot' ? { OR: pilots.length ? pilots : [{ slug: '__no_pilot__' }] } : {}),
    }, orderBy: [{ createdAt: 'asc' }, { platform: 'asc' }, { slug: 'asc' }] });
    if (!next) return null;
    await tx.atsFirstCollectionPolicy.update({ where: { id: policy.id }, data: {
      validationLeaseToken: token, validationLeaseExpiresAt: new Date(now.getTime() + 3 * 60_000),
    } });
    await tx.atsFirstCollectionCandidate.update({ where: { slug_platform: { slug: next.slug, platform: next.platform } }, data: { lastValidationStartedAt: now } });
    return { ...next, maximumBytes: policy.maxResponseBytes, maximumJobs: policy.maxCatalogueJobs };
  }, { timeout: 30_000 });
  if (!candidate) return { outcome: 'waiting_for_admission_conditions', healthWindowMinutes: FIRST_COLLECTION_HEALTH_WINDOW_MS / 60_000 };
  let validation: FirstCollectionValidation;
  try { validation = await validate(candidate.platform, candidate.slug, candidate.maximumBytes); }
  catch { validation = { success: false, reason: 'Public career feed validation failed' }; }
  const finishedAt = new Date();
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AtsFirstCollectionPolicy" WHERE id=${FIRST_COLLECTION_POLICY_ID} FOR UPDATE`;
    const policy = await tx.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: FIRST_COLLECTION_POLICY_ID } });
    if (policy.validationLeaseToken !== token || !policy.validationLeaseExpiresAt || policy.validationLeaseExpiresAt <= finishedAt) return { outcome: 'expired_validation_lease' };
    await tx.atsFirstCollectionPolicy.update({ where: { id: policy.id }, data: { validationLeaseToken: null, validationLeaseExpiresAt: null } });
    if (policy.mode === 'held' || policy.mode === 'pilot' && (!Array.isArray(policy.pilotBoards) || !policy.pilotBoards.includes(`${candidate.platform}::${candidate.slug}`))) return { outcome: 'policy_changed_during_validation' };
    const sizeReview = validation.sizeReview || (validation.jobsFound || 0) > Math.min(candidate.maximumJobs, policy.maxCatalogueJobs);
    if (!validation.success || sizeReview || !Number.isSafeInteger(validation.jobsFound) || (validation.jobsFound || 0) < 0) {
      await tx.atsFirstCollectionCandidate.update({ where: { slug_platform: { slug: candidate.slug, platform: candidate.platform } }, data: {
        state: sizeReview ? 'size_review' : 'discovered', estimatedJobs: validation.jobsFound,
        lastError: sizeReview ? 'Catalogue exceeds the first-collection allowance' : validation.reason || 'Feed validation failed',
        nextValidationAt: new Date(finishedAt.getTime() + 86_400_000),
      } });
      return { outcome: sizeReview ? 'size_review' : 'validation_deferred', platform: candidate.platform, slug: candidate.slug };
    }
    const board = { platform: candidate.platform, slug: candidate.slug };
    const outcome = await recordDiscoveredAtsBoard(tx, board, finishedAt, { jobsFound: validation.jobsFound, reactivateExisting: false });
    if (outcome !== 'retired') await tx.atsCompany.updateMany({ where: { ...board, firstCollectionState: 'waiting' }, data: {
      firstCollectionState: 'ready', jobsFound: validation.jobsFound,
      // JobScore documents at most one feed request per hour.
      nextCheckDate: new Date(finishedAt.getTime() + (board.platform === 'jobscore' ? 60 * 60_000 : 0)),
    } });
    await tx.atsFirstCollectionCandidate.update({ where: { slug_platform: board }, data: {
      state: outcome === 'retired' ? 'retired' : 'validated', validatedAt: finishedAt,
      estimatedJobs: validation.jobsFound, lastError: null,
    } });
    return { outcome: outcome === 'retired' ? 'retired' : 'ready', ...board, listingCount: validation.jobsFound };
  }, { timeout: 30_000 });
}
