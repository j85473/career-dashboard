import { prisma } from '../src/lib/prisma';
import { tickFirstCollections } from '../src/lib/atsFirstCollectionController';
import { FIRST_COLLECTION_POLICY_ID, FIRST_COLLECTION_PLATFORMS, catalogueFirstCollectionCandidate, firstCollectionHealth } from '../src/lib/atsFirstCollectionAdmission';
import { publicAtsBoardUrl, publicAtsBoardSlugFromUrl, type PublicAtsPlatform } from '../src/lib/publicAtsBoards';
import { validateSlug, type PLATFORMS } from '../src/scripts/discoverATS';

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find(arg => arg.startsWith('--mode='))?.slice(7);
  const pilots = args.filter(arg => arg.startsWith('--pilot=')).map(arg => arg.slice(8));
  if (mode && !['held', 'pilot', 'ramp'].includes(mode)) throw new Error('Mode must be held, pilot or ramp');
  if (mode === 'pilot' && !pilots.length) throw new Error('Pilot mode requires explicit platform::tenant identities');
  for (const value of pilots) {
    const split = value.indexOf('::');
    const platform = value.slice(0, split), slug = value.slice(split + 2);
    if (split < 1 || !(FIRST_COLLECTION_PLATFORMS as readonly string[]).includes(platform)
      || publicAtsBoardSlugFromUrl(publicAtsBoardUrl(platform as PublicAtsPlatform, slug), platform as PublicAtsPlatform) !== slug) throw new Error('Invalid pilot board identity');
  }
  if (mode && args.includes('--apply')) await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AtsFirstCollectionPolicy" WHERE id=${FIRST_COLLECTION_POLICY_ID} FOR UPDATE`;
    await tx.atsFirstCollectionPolicy.update({ where: { id: FIRST_COLLECTION_POLICY_ID }, data: {
      mode, ...(mode === 'pilot' ? { pilotBoards: pilots } : {}), healthySince: null, healthObservedAt: null,
    } });
    for (const value of pilots) {
      const split = value.indexOf('::');
      await catalogueFirstCollectionCandidate(tx, { platform: value.slice(0, split), slug: value.slice(split + 2) });
    }
  });
  if (args.includes('--tick')) {
    if (mode || pilots.length) throw new Error('Run policy changes separately from a controller tick');
    console.log(JSON.stringify(await tickFirstCollections((platform, slug, maximumBytes) => validateSlug(platform as keyof typeof PLATFORMS, slug, maximumBytes))));
    return;
  }
  const [policy, candidates, boards, health] = await Promise.all([
    prisma.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: FIRST_COLLECTION_POLICY_ID } }),
    prisma.atsFirstCollectionCandidate.groupBy({ by: ['platform', 'state'], _count: true }),
    prisma.atsCompany.findMany({ where: { platform: { in: [...FIRST_COLLECTION_PLATFORMS] }, firstCollectionState: { not: 'established' } },
      select: { platform: true, slug: true, firstCollectionState: true, firstCollectionBatchId: true, firstCollectionHoldReason: true, jobsFound: true }, take: 100 }),
    firstCollectionHealth(prisma),
  ]);
  console.log(JSON.stringify({ ...(mode && !args.includes('--apply') ? { preview: { mode, pilots } } : {}), policy, health, candidates, boards }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'First-collection control failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
