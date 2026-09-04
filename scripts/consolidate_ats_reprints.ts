import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { consolidateStoredAtsReprint } from '../src/lib/atsDuplicateConsolidation';

// Existing listings use the same guarded operation as prospective ingestion.
// No provider calls, deletions, score writes, or automatic rescoring.
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply' && arg !== '--inbox' && !arg.startsWith('--source=') && !arg.startsWith('--id='))) {
    throw new Error('Usage: consolidate_ats_reprints.ts [--apply] [--inbox] [--source=Himalayas] [--id=JOB_ID ...]');
  }
  const apply = args.includes('--apply');
  const inbox = args.includes('--inbox');
  const source = args.find(arg => arg.startsWith('--source='))?.slice('--source='.length) || (inbox ? null : 'Himalayas');
  const ids = args.filter(arg => arg.startsWith('--id=')).map(arg => arg.slice('--id='.length));
  const jobs = await prisma.job.findMany({
    where: {
      source: source || { not: { startsWith: 'ATS-' } },
      ...(ids.length ? { id: { in: ids } } : {}),
      status: inbox ? 'inbox' : { in: ['inbox', 'pending_af', 'applied', 'interviewing'] },
    },
    select: { id: true }, orderBy: { id: 'asc' },
  });
  let matched = 0;
  for (const job of jobs) {
    const result = await consolidateStoredAtsReprint(job.id, apply);
    if (result) { matched += 1; console.log(JSON.stringify(result)); }
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'candidate preview; writes recheck scores, leases and decisions', source: source || 'all aggregators', inbox, examined: jobs.length, matched }));
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
