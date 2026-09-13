import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import {
  APPLIED_REPEAT_CANDIDATE_STATUSES,
  appliedRepeatDismissalData,
  findAppliedRepeatForJob,
  listAppliedRepeatAuthorities,
  recordAppliedRepeatDismissal,
} from '../src/lib/appliedDuplicateStore';
import { mayRepeat } from '../src/lib/appliedRepeatMatch';
import { assertJobLifecycleInvariants } from '../src/lib/jobLifecycleInvariant';
import { nonManualImportSourceWhere } from '../src/lib/manualImportPolicy';

/**
 * Hides jobs in the Inbox or waiting to be scored that repeat a job Joseph
 * applied to, using the same-role test the Inbox door uses from now on
 * (src/lib/appliedRepeatMatch.ts). Joseph approved this one-time cleanup on
 * 2026-09-13.
 *
 * Scores are untouched. Manual Imports, jobs Joseph acted on himself, and
 * pairs he marked "Not a repeat" are skipped. Cooldown rows are left alone:
 * they are checked when their Cooldown ends.
 *
 * Dry run by default; `--apply` writes. `--only <jobId,...>` limits the apply
 * to rows reviewed in the dry run.
 */
function parseArguments(argv: string[]): { apply: boolean; only: Set<string> | null } {
  let apply = false;
  let only: Set<string> | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') apply = true;
    else if (argv[index] === '--only' && argv[index + 1]) only = new Set(argv[++index].split(',').filter(Boolean));
    else throw new Error('Usage: dismiss_applied_repeats.ts [--apply] [--only <jobId,...>]');
  }
  return { apply, only };
}

async function main(): Promise<void> {
  const { apply, only } = parseArguments(process.argv.slice(2));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — reading applied jobs and live candidates…`);

  const authorities = await listAppliedRepeatAuthorities();
  const live = await prisma.job.findMany({
    where: { status: { in: [...APPLIED_REPEAT_CANDIDATE_STATUSES] }, AND: [nonManualImportSourceWhere()] },
    select: { id: true, title: true, company: true },
  });
  const plausible = live.filter((job) => (!only || only.has(job.id))
    && authorities.some((authority) => authority.id !== job.id && mayRepeat(job, authority)));
  console.log(`  applied authorities: ${authorities.length}`);
  console.log(`  live candidates:     ${live.length} (${plausible.length} share an employer and title with one)`);

  let matched = 0;
  let dismissed = 0;
  for (const candidate of plausible) {
    const outcome = await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Job" WHERE id = ${candidate.id} FOR UPDATE`;
      if (!locked || !(APPLIED_REPEAT_CANDIDATE_STATUSES as readonly string[]).includes(locked.status)) return null;
      const match = await findAppliedRepeatForJob(candidate.id, tx);
      if (!match) return null;
      const job = await tx.job.findUniqueOrThrow({
        where: { id: candidate.id },
        select: { title: true, company: true, location: true, source: true, sourceId: true, status: true, scoringStatus: true, aimFitScore: true, reqFitScore: true },
      });
      if (apply) {
        await tx.job.update({ where: { id: candidate.id }, data: appliedRepeatDismissalData(job, match.reason) });
        await recordAppliedRepeatDismissal(tx, {
          jobId: candidate.id, source: job.source, sourceId: job.sourceId, priorStatus: job.status, match, route: 'repeat_cleanup_2026_09_13',
        });
        await assertJobLifecycleInvariants(tx, [candidate.id]);
      }
      return { job, match };
    });
    if (!outcome) continue;
    matched += 1;
    if (apply) dismissed += 1;
    const { job, match } = outcome;
    const proof = match.evidence.rule === 'identity'
      ? 'same employer, title and location'
      : `description ${Math.round((match.evidence.containment ?? 0) * 100)}% the same`;
    console.log(`\n  ${candidate.id}  [${job.status}]  ${job.title} · ${job.company} · ${job.location ?? '—'} · via ${job.source ?? '—'}`);
    console.log(`    repeats ${match.authority.status}: ${match.authority.title} · ${match.authority.company} · ${match.authority.location ?? '—'}  (${proof})`);
  }

  console.log(`\n  ${apply ? 'dismissed' : 'would dismiss'}: ${apply ? dismissed : matched}`);
  if (!apply && matched > 0) console.log('Dry run. Re-run with --apply (optionally --only <ids>) to dismiss these.');
}

main()
  .catch((error: unknown) => {
    console.error(`Applied-repeat cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
