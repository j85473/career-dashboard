import { prisma } from '../src/lib/prisma';
import { readLegacyAtsRetirement, retireLegacyAtsWorker } from '../src/lib/atsLegacyRetirement';

async function main() {
  const args = process.argv.slice(2);
  const apply = args[0] === '--apply';
  if (args.length && (!apply || args.length !== 2)) {
    throw new Error('Usage: retire_legacy_ats_worker.ts [--apply <selection-hash>]; default is a read-only preview.');
  }
  const releaseId = process.env.ATS_WORKER_RELEASE_ID || '';
  if (!/^[a-f0-9]{40}$/.test(releaseId)) throw new Error('Load the deployed acquisition-release.env before running this command.');
  const result = apply
    ? await retireLegacyAtsWorker(prisma, releaseId, args[1])
    : await readLegacyAtsRetirement(prisma, releaseId);
  console.log(JSON.stringify({ apply, ...result }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
