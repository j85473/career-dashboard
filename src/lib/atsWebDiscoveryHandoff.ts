import { firstDiscoveredAtsBoardCheckDate, isPermanentAtsBoardRetirement, recordDiscoveredAtsBoard } from './atsBoardDiscovery';
import { isFirstCollectionPlatform } from './atsFirstCollectionAdmission';
import { gustoBoardIdFromSlug } from './gustoBoard';
import { knownAtsBoardFromUrl } from './atsWebDiscoveryLinks';
import type { AtsWebDiscoveryState } from './atsWebDiscoveryState';
import type { PrismaClient } from './prismaClient';

export type WebBoardValidation = { success: boolean; browserPending?: boolean; transient?: boolean; jobsFound?: number; reason?: string };
type Client = Pick<PrismaClient, 'atsCompany' | 'atsFirstCollectionCandidate' | '$transaction'>;

/** Publish only through existing validation/admission. Existing records receive no updates. */
export async function publishAtsWebDiscoveries(
  state: AtsWebDiscoveryState, client: Client,
  validate: (platform: string, slug: string) => Promise<WebBoardValidation>,
  limit = 3, now: () => number = Date.now, signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Publish limit must be between 1 and 20');
  const outcomes: Record<string, number> = {};
  state.acquire(now());
  try {
    for (const candidate of state.pendingCandidates(limit, now())) {
      if (signal?.aborted) break;
      state.renew(now());
      let outcome = 'retry';
      let reason: string | null = null;
      try {
        const parsed = knownAtsBoardFromUrl(candidate.matchedUrl);
        if (!parsed || parsed.platform !== candidate.platform || parsed.slug !== candidate.slug) {
          outcome = 'rejected';
          reason = 'Saved URL no longer matches a supported board identity';
        } else {
          const gustoId = candidate.platform === 'gusto' ? gustoBoardIdFromSlug(candidate.slug) : null;
          const existing = await client.atsCompany.findMany({ where: {
            platform: candidate.platform,
            OR: [{ slug: { equals: candidate.slug, mode: 'insensitive' } },
              ...(gustoId ? [{ slug: { endsWith: gustoId, mode: 'insensitive' as const } }] : [])],
          }, select: { status: true, excludedReason: true } });
          if (existing.length) {
            outcome = existing.some(isPermanentAtsBoardRetirement) || existing.every(board => board.status === 'excluded')
              ? 'retired' : 'existing';
          } else if (isFirstCollectionPlatform(candidate.platform)) {
            // Do not refresh an existing candidate's evidence, state, pacing, or
            // retry dates. The normal first-collection worker owns those fields.
            await client.atsFirstCollectionCandidate.createMany({
              data: [{ platform: candidate.platform, slug: candidate.slug, sourceUrl: candidate.matchedUrl }], skipDuplicates: true,
            });
            outcome = 'waiting_for_admission';
          } else {
            const result = await validate(candidate.platform, candidate.slug);
            if (signal?.aborted) break;
            if (result.transient) {
              reason = result.reason || 'Board validation temporarily unavailable';
            } else if (result.browserPending || result.success && Number.isSafeInteger(result.jobsFound) && result.jobsFound! >= 0) {
              const registered = await client.$transaction(tx => recordDiscoveredAtsBoard(tx, candidate,
                firstDiscoveredAtsBoardCheckDate(result, new Date(now())), {
                  status: result.success ? 'active' : 'parked', jobsFound: result.jobsFound || 0,
                  reactivateExisting: false, browserPending: result.browserPending,
                }));
              outcome = registered === 'created' ? 'registered' : registered;
            } else {
              outcome = 'rejected';
              reason = result.reason || 'Board did not validate';
            }
          }
        }
      } catch {
        reason = 'Handoff failed; discovery retained for retry';
      }
      state.finishCandidate(candidate, outcome, now(), reason);
      outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    }
  } finally {
    state.release();
  }
  return outcomes;
}
