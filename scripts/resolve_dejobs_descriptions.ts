import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { scrapeAtsApi } from '../src/lib/atsApi';
import { assessJobDescriptionQuality } from '../src/lib/jobDescriptionQuality';
import { buildTerminalJdRecoveryUpdate, JD_RECOVERY_MANUAL_REVIEW_REASON, MAX_JD_RECOVERY_ATTEMPTS } from '../src/lib/jdRecoveryPolicy';

/**
 * Backfill for the rows stuck before `scrapeAtsApi` learned to read dejobs
 * postings (see `src/lib/atsApi.ts`'s `scrapeDejobsPosting`). Every CareerForce
 * apply link that goes through `de.jobsyn.org`/`dejobs.org` was landing on a
 * client-rendered Nuxt SPA that Jina's reader fetched as an empty shell, or on
 * the employer's own ATS at a URL `scrapeAtsApi` never got to inspect because
 * the redirect was never followed. Both are now handled by the same function
 * live ingestion, local scoring, and JD recovery already call — this script
 * applies it retroactively to the backlog that accumulated before the fix.
 *
 * `scrapeAtsApi` does the network work: follow the redirect chain, read the
 * static per-posting JSON when it lands on dejobs, or hand off to the
 * Workday/Greenhouse/Lever/Ashby matchers when it lands on the employer's own
 * site. Same >500-character bar the live pipeline uses before trusting a
 * result as complete-enough to skip the duties/qualifications vocabulary
 * check (see `route.ts`'s `atsResult.text.length > 500`).
 *
 * A row `scrapeAtsApi` still can't resolve is not left to cycle through more
 * Jina attempts against a URL now known not to work that way -- it is marked
 * terminal immediately, same shape as any other exhausted JD recovery.
 *
 * Dry-run is the default. `--apply` writes. `--limit N` bounds a run.
 */
const ACTIVE_STATUSES = ['pending_af', 'inbox'];
const STRUCTURED_MIN_LENGTH = 500;
const SAMPLE_LIMIT = 12;
const CONCURRENCY = 6;
const DEJOBS_EXHAUSTED_REASON = 'DEjobs/CareerForce recovery exhausted';

function parseArguments(argv: string[]): { apply: boolean; limit: number | null } {
  let apply = false;
  let limit: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') { apply = true; continue; }
    if (argument === '--limit') {
      const value = Number.parseInt(argv[index + 1] || '', 10);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--limit needs a positive integer');
      limit = value;
      index += 1;
      continue;
    }
    throw new Error('Usage: resolve_dejobs_descriptions.ts [--apply] [--limit N]');
  }
  return { apply, limit };
}

type Target = { id: string; company: string | null; title: string | null; url: string | null };
type Recovered = { id: string; company: string | null; title: string | null; description: string; ats: string };
type Unresolved = { id: string; company: string | null; title: string | null; reason: string };

async function main(): Promise<void> {
  const { apply, limit } = parseArguments(process.argv.slice(2));

  const targets = await prisma.job.findMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      scoringStatus: 'failed',
      OR: [{ url: { contains: 'jobsyn.org' } }, { url: { contains: 'dejobs.org' } }],
    },
    select: { id: true, company: true, title: true, url: true },
    orderBy: { id: 'asc' },
    ...(limit ? { take: limit } : {}),
  });

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${targets.length.toLocaleString()} stuck dejobs/CareerForce job(s).\n`);
  if (targets.length === 0) return;

  const recovered: Recovered[] = [];
  const unresolved: Unresolved[] = [];
  let attempted = 0;

  async function probe(target: Target): Promise<void> {
    attempted += 1;
    try {
      const result = target.url ? await scrapeAtsApi(target.url) : null;
      if (result && result.text.length > STRUCTURED_MIN_LENGTH) {
        const quality = assessJobDescriptionQuality(result.text, { structuredSource: true });
        if (quality.scorable) {
          recovered.push({ id: target.id, company: target.company, title: target.title, description: result.text, ats: result.ats });
        } else {
          unresolved.push({ id: target.id, company: target.company, title: target.title, reason: quality.reason || 'not scorable' });
        }
      } else {
        unresolved.push({ id: target.id, company: target.company, title: target.title, reason: 'no recoverable text at the resolved URL' });
      }
    } catch (error) {
      unresolved.push({
        id: target.id,
        company: target.company,
        title: target.title,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (let index = 0; index < targets.length; index += CONCURRENCY) {
    const batch = (targets as Target[]).slice(index, index + CONCURRENCY);
    await Promise.all(batch.map(probe));
    if (attempted % 50 < CONCURRENCY) {
      console.log(`  probed ${attempted.toLocaleString()}/${targets.length.toLocaleString()} — ${recovered.length.toLocaleString()} recovered, ${unresolved.length.toLocaleString()} unresolved`);
    }
  }

  console.log(`\n  recovered: ${recovered.length.toLocaleString()} of ${targets.length.toLocaleString()}`);
  console.log(`  unresolved: ${unresolved.length.toLocaleString()}`);

  if (recovered.length > 0) {
    console.log('\n  samples:');
    for (const job of recovered.slice(0, SAMPLE_LIMIT)) {
      console.log(`    ${String(job.company || '?').slice(0, 20).padEnd(22)} ${String(job.description.length).padStart(6)}ch  ${job.ats.padEnd(16)} ${String(job.title || '').slice(0, 38)}`);
      console.log(`      head: ${JSON.stringify(job.description.slice(0, 200))}`);
    }
  }

  if (unresolved.length > 0) {
    console.log('\n  unresolved samples:');
    for (const job of unresolved.slice(0, SAMPLE_LIMIT)) {
      console.log(`    ${String(job.company || '?').slice(0, 20).padEnd(22)} ${String(job.title || '').slice(0, 38).padEnd(40)} ${job.reason.slice(0, 60)}`);
    }
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to store recovered descriptions and mark the rest terminal.');
    return;
  }

  let queued = 0;
  for (let index = 0; index < recovered.length; index += 200) {
    const chunk = recovered.slice(index, index + 200);
    const results = await prisma.$transaction(chunk.map((job) => prisma.job.updateMany({
      // Re-check status so a job the pipeline has since claimed is left alone.
      where: { id: job.id, status: { in: ACTIVE_STATUSES }, scoringStatus: 'failed' },
      data: {
        description: job.description,
        scoringStatus: 'queued',
        scoreAttempts: 0,
        scoreError: null,
        passReason: null,
        jdBatchId: null,
        batchJobId: null,
      },
    })));
    queued += results.reduce((sum, result) => sum + result.count, 0);
    console.log(`  queued ${queued.toLocaleString()}/${recovered.length.toLocaleString()} for local scoring`);
  }
  console.log(`\nQueued ${queued.toLocaleString()} recovered job(s) for local scoring.`);

  let marked = 0;
  for (let index = 0; index < unresolved.length; index += 200) {
    const chunk = unresolved.slice(index, index + 200);
    const results = await prisma.$transaction(chunk.map((job) => prisma.job.updateMany({
      where: { id: job.id, status: { in: ACTIVE_STATUSES }, scoringStatus: 'failed' },
      data: buildTerminalJdRecoveryUpdate(
        `${DEJOBS_EXHAUSTED_REASON}: ${job.reason}`,
        JD_RECOVERY_MANUAL_REVIEW_REASON,
      ),
    })));
    marked += results.reduce((sum, result) => sum + result.count, 0);
  }
  console.log(`Marked ${marked.toLocaleString()} unresolved job(s) terminal at ${MAX_JD_RECOVERY_ATTEMPTS} attempts (no further automatic retry).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
