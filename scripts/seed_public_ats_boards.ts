import { prisma } from '../src/lib/prisma';
import { PUBLIC_ATS_LAUNCH_BOARDS } from '../src/lib/publicAtsLaunchBoards';
import { recordDiscoveredAtsBoard } from '../src/lib/atsBoardDiscovery';
import { validateSlug } from '../src/scripts/discoverATS';

/** Default is live validation only. --apply adds verified NEW boards to normal rotation. */
async function main() {
  const apply = process.argv.includes('--apply');
  for (const board of PUBLIC_ATS_LAUNCH_BOARDS) {
    const validation = await validateSlug(board.platform, board.slug);
    if (!validation.success) throw new Error(`${board.platform} validation failed: ${validation.reason}`);
    const outcome = apply ? await prisma.$transaction(transaction => recordDiscoveredAtsBoard(transaction, board,
      new Date(), { jobsFound: validation.jobsFound, reactivateExisting: false })) : 'validated_only';
    console.log(JSON.stringify({ ...board, outcome, listingCount: validation.jobsFound }));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Public board validation failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
