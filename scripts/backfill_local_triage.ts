export {};
import { prisma } from '../src/lib/prisma';
import { runLocalHeuristic } from '../src/lib/jobScoring';
import { localTriageVerdict } from '../src/lib/localTriage';
import { getAllResumes } from '../src/lib/resume';

/**
 * Applies local triage to jobs that were scored before the gate existed.
 *
 * The gate governs newly scored jobs only, so the pending Aim queue still holds
 * everything admitted while `gatePass` was hardcoded true. This replays the same
 * verdict over that backlog.
 *
 * Reversible: it sets status/scoringStatus and records the reason in
 * `passReason` with a stable prefix, so a mistaken cull can be found and undone
 * with a single query. Nothing is deleted.
 *
 * Manual Import keeps its status, matching the live scoring path.
 */

const PREFIX = 'Locally triaged out:';
const BATCH_SIZE = 500;

async function main() {
  const apply = process.argv.includes('--apply');
  const resumes = await getAllResumes();
  const preferences = await prisma.userPreference.findMany();
  if (resumes.length === 0) throw new Error('No resumes loaded; triage would be meaningless.');

  const jobs = await prisma.job.findMany({
    where: { status: 'pending_af', scoringStatus: 'scored', aimFitScore: null },
    select: {
      id: true, title: true, company: true, url: true, source: true,
      manualAts: true, description: true, location: true,
    },
  });
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — evaluating ${jobs.length} pending Aim jobs`);

  const doomed: Array<{ id: string; reason: string; source: string | null }> = [];
  let keep = 0;
  for (const job of jobs) {
    const heuristic = runLocalHeuristic({
      title: job.title, company: job.company, url: job.url, source: job.source,
      manualAts: job.manualAts, fullDescription: job.description || '',
    }, resumes, preferences);
    const verdict = heuristic.gatePass
      ? localTriageVerdict({ capRationale: '', title: job.title, location: job.location })
      : { pass: false, reason: heuristic.gateReason };
    if (verdict.pass) { keep++; continue; }
    doomed.push({ id: job.id, reason: verdict.reason, source: job.source });
  }

  console.log(`  keep:    ${keep}`);
  console.log(`  triage:  ${doomed.length}`);
  if (!apply) {
    console.log('\nRe-run with --apply to write. Undo afterwards with:');
    console.log(`  UPDATE "Job" SET status='pending_af', "scoringStatus"='scored', "passReason"=NULL`);
    console.log(`  WHERE "passReason" LIKE '${PREFIX}%';`);
    await prisma.$disconnect();
    return;
  }

  let written = 0;
  for (let start = 0; start < doomed.length; start += BATCH_SIZE) {
    const batch = doomed.slice(start, start + BATCH_SIZE);
    await prisma.$transaction(batch.map((entry) => prisma.job.update({
      where: { id: entry.id },
      data: {
        scoringStatus: 'skipped',
        // Matches the live scoring path: a manual import keeps its status.
        ...(entry.source === 'Manual Import' ? {} : { status: 'dismissed' }),
        passReason: `${PREFIX} ${entry.reason}`.slice(0, 1000),
      },
    })));
    written += batch.length;
    if (written % 5000 === 0 || written === doomed.length) {
      console.log(`  written ${written}/${doomed.length}`);
    }
  }
  console.log(`Done. ${written} triaged, ${keep} left for Aim.`);
  await prisma.$disconnect();
}

main().catch((error) => { console.error(error); process.exit(1); });
