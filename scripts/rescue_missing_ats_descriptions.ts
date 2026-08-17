import 'dotenv/config';

import { prisma } from '../src/lib/prisma';

/**
 * Recovers jobs that were discarded for a reason that no longer applies.
 *
 * SmartRecruiters and Workable publish no posting body on their list
 * endpoints, so until the detail fetch was added to `jobIngestion.ts` every job
 * from those platforms was stored with an empty description, sent to
 * `needs_jd`, failed Jina recovery against the public page, and landed in
 * Action Needed as "no usable role duties". Roughly 914 jobs are sitting there
 * for that reason alone.
 *
 * The ingestion fix only helps jobs seen from now on — dedupe skips these on
 * the next board sweep, so they would stay stuck forever. This pulls the body
 * from the same detail endpoints the pipeline now uses and returns each job to
 * `queued` so it re-enters scoring normally.
 *
 * Dry-run is the default; `--apply` is required to write.
 */
const SAMPLE_LIMIT = 12;
const CONCURRENCY = 4;
/** Below this a description is not worth requeuing — it would fail the gate again. */
const MIN_USABLE_LENGTH = 650;

function parseArguments(argv: string[]): { apply: boolean } {
  const allowed = new Set(['--apply']);
  for (const argument of argv) {
    if (!allowed.has(argument)) throw new Error('Usage: rescue_missing_ats_descriptions.ts [--apply]');
  }
  return { apply: argv.includes('--apply') };
}

interface Target {
  id: string;
  company: string | null;
  title: string | null;
  // Nullable in the schema even though the query filters empties out.
  url: string | null;
  source: string | null;
}

interface Recovered extends Target {
  description: string;
}

function stripHtml(value: unknown): string {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `https://jobs.smartrecruiters.com/{slug}/{postingId}` */
async function fetchSmartRecruiters(url: string): Promise<string | null> {
  const match = url.match(/jobs\.smartrecruiters\.com\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;
  const response = await fetch(
    `https://api.smartrecruiters.com/v1/companies/${match[1]}/postings/${match[2]}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) return null;
  const detail = await response.json();
  const sections = detail?.jobAd?.sections || {};
  // Mirrors the ingestion path: companyDescription is boilerplate and excluded.
  return [sections.jobDescription?.text, sections.qualifications?.text, sections.additionalInformation?.text]
    .filter(Boolean).map(stripHtml).join('\n\n');
}

/** `https://apply.workable.com/{slug}/j/{shortcode}` — v1 serves the body, v3 404s. */
async function fetchWorkable(url: string): Promise<string | null> {
  const match = url.match(/apply\.workable\.com\/([^/]+)\/j\/([^/?#]+)/);
  if (!match) return null;
  const response = await fetch(
    `https://apply.workable.com/api/v1/accounts/${match[1]}/jobs/${match[2]}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) return null;
  const detail = await response.json();
  return [detail?.description, detail?.requirements, detail?.benefits]
    .filter(Boolean).map(stripHtml).join('\n\n');
}

async function recover(target: Target): Promise<Recovered | null> {
  if (!target.url) return null;
  try {
    const description = target.source === 'ATS-smartrecruiters'
      ? await fetchSmartRecruiters(target.url)
      : await fetchWorkable(target.url);
    if (!description || description.length < MIN_USABLE_LENGTH) return null;
    return { ...target, description };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));

  const targets = await prisma.job.findMany({
    where: {
      source: { in: ['ATS-smartrecruiters', 'ATS-workable'] },
      status: { in: ['pending_af', 'inbox'] },
      scoringStatus: 'failed',
      url: { not: '' },
    },
    select: { id: true, company: true, title: true, url: true, source: true },
    orderBy: { id: 'asc' },
  });

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${targets.length.toLocaleString()} stuck SmartRecruiters/Workable jobs.\n`);

  const recovered: Recovered[] = [];
  let attempted = 0;
  for (let index = 0; index < targets.length; index += CONCURRENCY) {
    const batch = targets.slice(index, index + CONCURRENCY);
    const results = await Promise.all(batch.map(recover));
    attempted += batch.length;
    for (const result of results) if (result) recovered.push(result);
    if (attempted % 100 < CONCURRENCY) {
      console.log(`  probed ${attempted.toLocaleString()}/${targets.length.toLocaleString()} — ${recovered.length.toLocaleString()} recoverable`);
    }
  }

  const bySource = (source: string) => recovered.filter((job) => job.source === source).length;
  console.log(`\n  recoverable: ${recovered.length.toLocaleString()} of ${targets.length.toLocaleString()}`);
  console.log(`    ATS-smartrecruiters ${bySource('ATS-smartrecruiters').toLocaleString()}`);
  console.log(`    ATS-workable        ${bySource('ATS-workable').toLocaleString()}`);
  console.log(`  unrecoverable (posting gone, or body still under ${MIN_USABLE_LENGTH} chars): ${(targets.length - recovered.length).toLocaleString()}`);

  if (recovered.length > 0) {
    console.log('\n  samples:');
    for (const job of recovered.slice(0, SAMPLE_LIMIT)) {
      console.log(`    ${String(job.company || '?').slice(0, 22).padEnd(24)} ${String(job.description.length).padStart(6)}ch  ${String(job.title || '').slice(0, 42)}`);
    }
  }

  if (!apply || recovered.length === 0) {
    console.log(apply ? '\nNothing to write.' : '\nDry run only. Re-run with --apply to restore these descriptions and requeue them.');
    return;
  }

  let written = 0;
  for (let index = 0; index < recovered.length; index += 200) {
    const chunk = recovered.slice(index, index + 200);
    const results = await prisma.$transaction(chunk.map((job) => prisma.job.updateMany({
      // Re-check scoringStatus so a job the pipeline has since picked up on its
      // own is never yanked back out from under it.
      where: { id: job.id, scoringStatus: 'failed' },
      data: {
        description: job.description,
        scoringStatus: 'queued',
        scoreError: null,
        passReason: null,
        scoreAttempts: 0,
      },
    })));
    written += results.reduce((sum, result) => sum + result.count, 0);
    console.log(`  requeued ${written.toLocaleString()}/${recovered.length.toLocaleString()}`);
  }
  console.log(`\nRequeued ${written.toLocaleString()} job(s) for scoring.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
