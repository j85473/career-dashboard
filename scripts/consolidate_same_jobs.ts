import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { consolidateSameJobs } from '../src/lib/sameJobConsolidation';

/**
 * Runs one same-job combine pass (src/lib/sameJobConsolidation.ts).
 *
 * Without --apply nothing is written: the report lists every card a pass would
 * fold, which card it would fold into, and why. The pipeline runs the same
 * pass on its own every few minutes; this script is for review and one-off
 * catch-up.
 *
 *   npx tsx scripts/consolidate_same_jobs.ts [--apply] [--json]
 */
async function main() {
  const apply = process.argv.includes('--apply');
  const json = process.argv.includes('--json');
  const result = await consolidateSameJobs({ apply });
  const ids = [...new Set([...result.folded, ...result.skipped].flatMap((fold) => [fold.survivorId, fold.redundantId]))];
  const rows = await prisma.job.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, company: true, location: true, source: true, status: true, aimFitScore: true, reqFitScore: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const describe = (id: string) => {
    const row = byId.get(id);
    if (!row) return id;
    const scores = [row.aimFitScore, row.reqFitScore].map((score) => score ?? '-').join('/');
    return `${row.status.padEnd(12)} ${String(row.source).padEnd(20)} ${row.company} | ${row.title} | ${row.location} | scores ${scores}`;
  };
  if (json) {
    console.log(JSON.stringify({
      ...result,
      folded: result.folded.map((fold) => ({ ...fold, survivor: byId.get(fold.survivorId), redundant: byId.get(fold.redundantId) })),
    }, null, 1));
  } else {
    console.log(`${apply ? 'Combined' : 'Would combine'} ${result.folded.length} card(s); ${result.deferred} waiting on an export; ${result.skipped.length} skipped; ${result.held.length} group(s) left alone.`);
    for (const fold of result.folded) {
      console.log(`\n  fold ${describe(fold.redundantId)}`);
      console.log(`  into ${describe(fold.survivorId)}`);
      console.log(`       ${fold.evidence.rule}, employer ${fold.evidence.employer ?? 'different name'}, location ${fold.evidence.location}, text ${fold.evidence.containment ?? 'n/a'}`);
    }
    for (const skip of result.skipped) console.log(`\n  skipped ${describe(skip.redundantId)}: ${skip.reason}`);
  }
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
