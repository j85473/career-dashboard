import 'dotenv/config';

import { writeFileSync } from 'node:fs';

import { prisma } from '../src/lib/prisma';
import { buildClosedPostingUpdate } from '../src/lib/jdRecoveryPolicy';
import { isClosedJobPosting, readerReportsMissingPosting } from '../src/lib/jobDescriptionQuality';
import { cleanHtmlText } from '../src/lib/jobIngestion';
import { automatedLifecycleIsProtected } from '../src/lib/manualImportPolicy';
import { buildSafeJinaReaderUrl } from '../src/lib/safeExternalFetch';
import { preferredJdSourceUrl } from '../src/lib/jobSourceProvenance';

/**
 * One-time recheck of jobs sitting in Needs JD because recovery ended on a
 * "dead page" verdict. Before the page reader's 404/410 report counted as
 * proof of closure, those jobs went to manual review even when the job board
 * had answered "no such posting" (JobLeads is the case that surfaced it).
 *
 * Each job's posting URL is fetched once through the page reader. A job is
 * dismissed as closed only when the fresh response is proof of closure under
 * the current rule; everything else is left exactly as it is. Only jobs still
 * waiting in the pipeline (`pending_af`) are touched — applied, passed and
 * Manual Import jobs are user decisions and are never changed here.
 * Dry run by default; `--apply` also writes an undo file of old values.
 */

const DEAD_PAGE_ERROR = 'JD recovery rejected: expired, closed, login, cookie, or portal shell%';

async function fetchThroughReader(url: string): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'X-Return-Format': 'markdown' };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  const readerUrl = await buildSafeJinaReaderUrl(url);
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(readerUrl, { headers, signal: AbortSignal.timeout(30_000) });
    if (response.status === 429 && attempt < 5) {
      await new Promise(resolve => setTimeout(resolve, 15_000 * attempt));
      continue;
    }
    return { status: response.status, body: response.ok ? await response.text() : '' };
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const jobs = await prisma.job.findMany({
    where: { scoringStatus: 'failed', status: 'pending_af', scoreError: { startsWith: DEAD_PAGE_ERROR.slice(0, -1) } },
    select: {
      id: true, title: true, company: true, url: true, source: true, status: true,
      scoringStatus: true, scoreError: true, passReason: true, scoreAttempts: true,
      observations: { select: { source: true, url: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — recheck of dead-page Needs JD jobs (${jobs.length})`);
  const closed: typeof jobs = [];
  for (const job of jobs) {
    const label = `${job.company} — ${job.title}`.slice(0, 90);
    if (automatedLifecycleIsProtected(job)) {
      console.log(`  keep   manual import   ${label}`);
      continue;
    }
    const url = preferredJdSourceUrl({ source: job.source, jobUrl: job.url, observations: job.observations }) || job.url;
    if (!url) {
      console.log(`  keep   no url          ${label}`);
      continue;
    }
    try {
      const { status, body } = await fetchThroughReader(url);
      const text = cleanHtmlText(body).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
      if (isClosedJobPosting(text)) {
        closed.push(job);
        const why = readerReportsMissingPosting(text) ? 'site 404/410' : 'closure notice';
        console.log(`  CLOSE  ${why.padEnd(15)} ${label}`);
      } else {
        console.log(`  keep   reader ${String(status).padEnd(8)} ${label}`);
      }
    } catch (error) {
      console.log(`  keep   fetch failed    ${label} (${error instanceof Error ? error.message : String(error)})`);
    }
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }

  console.log(`\n  proven closed: ${closed.length}   left in Needs JD: ${jobs.length - closed.length}`);
  if (!apply) {
    console.log('Zero writes performed. Re-run with --apply to dismiss the proven-closed jobs.');
    return;
  }

  const undoPath = `tmp/dead-page-recheck-undo-${Date.now()}.json`;
  writeFileSync(undoPath, JSON.stringify(closed.map(({ id, status, scoringStatus, scoreError, passReason, scoreAttempts }) => (
    { id, status, scoringStatus, scoreError, passReason, scoreAttempts }
  ))));
  console.log(`  undo file: ${undoPath}`);

  let written = 0;
  for (const job of closed) {
    // Re-check the state the decision was made on, so a job the user touched
    // during the run is left alone.
    const result = await prisma.job.updateMany({
      where: { id: job.id, status: 'pending_af', scoringStatus: 'failed', scoreError: job.scoreError },
      data: buildClosedPostingUpdate(),
    });
    written += result.count;
  }
  console.log(`  dismissed as closed: ${written} (skipped because changed meanwhile: ${closed.length - written})`);
}

main()
  .catch((error: unknown) => {
    console.error(`Dead-page recheck failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
