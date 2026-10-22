import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from './prismaClient';
import { isAtsBoardEnabledForIngestion, isDailyAtsBoard, nextApiBoardCheckDateForDay,
  nextAtsBoardCheckDateForDay } from './atsRotation';
import { NON_API_ATS_PLATFORMS } from './browserAtsBoards';

export type ApiRotationTransitionBoard = {
  slug: string; platform: string; checkDay: number; status: string;
  acquisitionEngine: string; firstCollectionState: string;
  firstCollectionHoldReason?: string | null;
  failCount: number; retryCount: number; nextCheckDate: Date;
  lastSynchronizedAt: Date | null; hasOpenWork: boolean;
};

/** Only proven ordinary weekly slots can be accelerated; every hold keeps authority. */
export function planApiRotationTransition(boards: ApiRotationTransitionBoard[], now = new Date()) {
  const assignments = boards.flatMap(board => {
    if (!isAtsBoardEnabledForIngestion(board) || isDailyAtsBoard(board) || board.status !== 'active'
      || board.acquisitionEngine !== 'v2' || board.firstCollectionState !== 'established'
      || board.firstCollectionHoldReason
      || board.failCount || board.retryCount || board.hasOpenWork || !board.lastSynchronizedAt
      || !Number.isInteger(board.checkDay) || board.checkDay < 0 || board.checkDay > 6
      || board.lastSynchronizedAt > now || board.nextCheckDate <= now) return [];
    const ordinary = nextAtsBoardCheckDateForDay(board.checkDay, board.lastSynchronizedAt);
    if (ordinary.getTime() !== board.nextCheckDate.getTime()) return [];
    // Continue from the last successful collection. Using the preview clock
    // skips an opening that has already arrived (including today's), leaving
    // healthy weekly boards held while their four-day cohort is due. An
    // overdue opening remains overdue so the normal dispatcher can catch up.
    const nextCheckDate = nextApiBoardCheckDateForDay(board.checkDay, board.lastSynchronizedAt);
    if (nextCheckDate >= board.nextCheckDate) return [];
    return [{ slug: board.slug, platform: board.platform, checkDay: board.checkDay,
      fromNextCheckDate: board.nextCheckDate.toISOString(), nextCheckDate: nextCheckDate.toISOString(),
      lastSynchronizedAt: board.lastSynchronizedAt.toISOString() }];
  }).sort((a, b) => a.platform.localeCompare(b.platform) || a.slug.localeCompare(b.slug));
  const selectionHash = createHash('sha256').update(JSON.stringify({ rotationDays: 4, assignments })).digest('hex');
  return { rotationDays: 4, observedAt: now.toISOString(), selectionHash,
    selected: assignments.length, assignments };
}

const unfinished = (now: Date): Prisma.AtsIngestionBatchWhereInput => ({ OR: [
  { status: { in: ['fetching', 'partial', 'queued', 'processing', 'synchronized', 'reset_synchronized', 'reset_draining'] } },
  { leaseExpiresAt: { gt: now } }, { acquisitionLeaseExpiresAt: { gt: now } },
] });

export async function readApiRotationTransition(client: PrismaClient, now = new Date()) {
  return client.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const boards = await tx.atsCompany.findMany({
      where: { platform: { notIn: NON_API_ATS_PLATFORMS }, status: 'active', acquisitionEngine: 'v2' },
      select: { slug: true, platform: true, checkDay: true, status: true, acquisitionEngine: true,
        firstCollectionState: true, firstCollectionHoldReason: true, failCount: true, retryCount: true, nextCheckDate: true, lastSynchronizedAt: true,
        ingestionBatches: { where: unfinished(now), take: 1, select: { id: true } } },
    });
    return planApiRotationTransition(boards.map(({ ingestionBatches, ...board }) => ({ ...board,
      hasOpenWork: ingestionBatches.length > 0 })), now);
  });
}

export async function applyApiRotationTransition(client: PrismaClient,
  plan: ReturnType<typeof planApiRotationTransition>, now = new Date()) {
  const age = now.getTime() - new Date(plan.observedAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > 5 * 60_000 || plan.rotationDays !== 4) {
    throw new Error('Four-day rotation preview is stale or invalid; create a fresh preview.');
  }
  const current = await readApiRotationTransition(client, now);
  if (current.selectionHash !== plan.selectionHash) throw new Error('Board schedules changed; create a fresh preview.');
  let applied = 0;
  for (let offset = 0; offset < current.assignments.length; offset += 250) {
    applied += await client.$transaction(async tx => {
      // Acquisition uses this same lock before admitting a new board cycle.
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('ats-v2-board-admission', 0))`;
      let changed = 0;
      for (const row of current.assignments.slice(offset, offset + 250)) {
        const result = await tx.atsCompany.updateMany({
          where: { slug: row.slug, platform: row.platform, status: 'active', acquisitionEngine: 'v2',
            firstCollectionState: 'established', firstCollectionHoldReason: null, checkDay: row.checkDay, failCount: 0, retryCount: 0,
            nextCheckDate: new Date(row.fromNextCheckDate), lastSynchronizedAt: new Date(row.lastSynchronizedAt),
            ingestionBatches: { none: unfinished(new Date()) } },
          data: { nextCheckDate: new Date(row.nextCheckDate) },
        });
        changed += result.count;
      }
      return changed;
    }, { timeout: 30_000 });
  }
  return { selected: current.selected, applied, skipped: current.selected - applied };
}
