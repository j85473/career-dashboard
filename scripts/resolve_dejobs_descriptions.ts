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
 * `scrapeAtsApi`'s dejobs branch also returns `company`/`location` straight
 * off the JSON when the microsites route resolves the posting -- CareerForce
 * reads company/location off its own search card, which can drift from what
 * the JSON's canonical `company`/`city`/`state_short` say (same defect class
 * as the Rippling detail fetch correcting a board-slug company name). A
 * recovered row whose JSON disagrees with what is stored gets corrected here.
 *
 * Dry-run is the default. `--apply` writes. `--limit N` bounds a run.
 * `--reset-terminal` switches to a different mode entirely: instead of
 * probing URLs, it finds rows a *previous* run of this script marked
 * terminal for a dejobs/jobsyn URL and clears their attempt count so they
 * re-enter this script's own query on the next plain run. It never touches
 * rows terminal for any other reason.
 */
const ACTIVE_STATUSES = ['pending_af', 'inbox'];
const STRUCTURED_MIN_LENGTH = 500;
const SAMPLE_LIMIT = 12;
const CONCURRENCY = 6;
const DEJOBS_EXHAUSTED_REASON = 'DEjobs/CareerForce recovery exhausted';

function parseArguments(argv: string[]): { apply: boolean; limit: number | null; resetTerminal: boolean } {
  let apply = false;
  let limit: number | null = null;
  let resetTerminal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') { apply = true; continue; }
    if (argument === '--reset-terminal') { resetTerminal = true; continue; }
    if (argument === '--limit') {
      const value = Number.parseInt(argv[index + 1] || '', 10);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--limit needs a positive integer');
      limit = value;
      index += 1;
      continue;
    }
    throw new Error('Usage: resolve_dejobs_descriptions.ts [--apply] [--limit N] [--reset-terminal]');
  }
  return { apply, limit, resetTerminal };
}

function valuesDisagree(stored: string | null, fresh: string | undefined): fresh is string {
  if (!fresh) return false;
  return stored === null || stored.trim().toLowerCase() !== fresh.trim().toLowerCase();
}

type Target = { id: string; company: string | null; title: string | null; url: string | null; location: string | null };
type Recovered = {
  id: string;
  company: string | null;
  title: string | null;
  description: string;
  ats: string;
  correctedCompany: string | null;
  correctedLocation: string | null;
};
type Unresolved = { id: string; company: string | null; title: string | null; reason: string };

/**
 * Rows a previous run of this script marked terminal via
 * `buildTerminalJdRecoveryUpdate` -- identified by the reason text this
 * script itself wrote plus a dejobs/jobsyn URL, never by terminal status
 * alone, so a row some other JD-recovery path exhausted is left untouched.
 */
async function resetTerminalRows(apply: boolean, limit: number | null): Promise<void> {
  const rows = await prisma.job.findMany({
    where: {
      scoringStatus: 'failed',
      scoreError: { startsWith: DEJOBS_EXHAUSTED_REASON },
      OR: [{ url: { contains: 'jobsyn.org' } }, { url: { contains: 'dejobs.org' } }],
    },
    select: { id: true, company: true, title: true, scoreAttempts: true },
    orderBy: { id: 'asc' },
    ...(limit ? { take: limit } : {}),
  });

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${rows.length.toLocaleString()} row(s) this script previously marked terminal for a dejobs/jobsyn URL.\n`);
  if (rows.length === 0) return;

  for (const row of rows.slice(0, SAMPLE_LIMIT)) {
    console.log(`    ${String(row.company || '?').slice(0, 20).padEnd(22)} attempts=${row.scoreAttempts}  ${String(row.title || '').slice(0, 50)}`);
  }
  if (rows.length > SAMPLE_LIMIT) console.log(`    ...and ${(rows.length - SAMPLE_LIMIT).toLocaleString()} more`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to clear their attempt count, then re-run the plain script to retry them.');
    return;
  }

  let reset = 0;
  for (let index = 0; index < rows.length; index += 200) {
    const chunk = rows.slice(index, index + 200);
    const results = await prisma.$transaction(chunk.map((row) => prisma.job.updateMany({
      where: { id: row.id, scoringStatus: 'failed', scoreError: { startsWith: DEJOBS_EXHAUSTED_REASON } },
      data: { scoreAttempts: 0, scoreError: null, passReason: null },
    })));
    reset += results.reduce((sum, result) => sum + result.count, 0);
  }
  console.log(`\nReset ${reset.toLocaleString()} row(s). Re-run without --reset-terminal to retry them.`);
}

async function main(): Promise<void> {
  const { apply, limit, resetTerminal } = parseArguments(process.argv.slice(2));
  if (resetTerminal) return resetTerminalRows(apply, limit);

  const targets = await prisma.job.findMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      scoringStatus: 'failed',
      OR: [{ url: { contains: 'jobsyn.org' } }, { url: { contains: 'dejobs.org' } }],
    },
    select: { id: true, company: true, title: true, url: true, location: true },
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
          recovered.push({
            id: target.id,
            company: target.company,
            title: target.title,
            description: result.text,
            ats: result.ats,
            correctedCompany: valuesDisagree(target.company, result.company) ? result.company : null,
            correctedLocation: valuesDisagree(target.location, result.location) ? result.location : null,
          });
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

  const corrections = recovered.filter((job) => job.correctedCompany || job.correctedLocation);
  if (corrections.length > 0) {
    console.log(`\n  ${corrections.length.toLocaleString()} recovered row(s) disagree with the JSON on company/location:`);
    for (const job of corrections.slice(0, SAMPLE_LIMIT)) {
      if (job.correctedCompany) console.log(`    ${job.id}  company: ${JSON.stringify(job.company)} -> ${JSON.stringify(job.correctedCompany)}`);
      if (job.correctedLocation) console.log(`    ${job.id}  location -> ${JSON.stringify(job.correctedLocation)}`);
    }
  }

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
        ...(job.correctedCompany ? { company: job.correctedCompany } : {}),
        ...(job.correctedLocation ? { location: job.correctedLocation } : {}),
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
