import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { AGGREGATOR_SNIPPET_DISCARD_REASON } from '../src/lib/jdRecoveryPolicy';

/**
 * Recovers full job descriptions for Adzuna postings.
 *
 * Adzuna's API truncates `description` at exactly 500 characters, which sits
 * just under the 650-character quality gate, so every Adzuna job fails JD
 * recovery and lands in Action Needed — 842 of them at time of writing. The
 * stored URL is an Adzuna interstitial that does not redirect server-side, and
 * a plain fetch (or plain headless Chrome) is met with "Our systems have
 * detected suspicious behaviour associated with this request".
 *
 * `cloakbrowser` — already used by the CareerForce scraper — is not blocked.
 * The interstitial then either forwards to the employer's own posting or
 * settles on Adzuna's `/details/` page; both carry the full text.
 *
 * Deliberately a batch script rather than an ingestion stage: each posting
 * costs ~7.5s of browser time, which is fine offline and much too slow inline.
 *
 * Dry-run is the default. `--apply` writes. `--limit N` bounds a run so this
 * can be done in sittings.
 */
const HYDRATION_MS = 7_000;
const MIN_USABLE_LENGTH = 650;
const SAMPLE_LIMIT = 12;

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
    throw new Error('Usage: resolve_adzuna_descriptions.ts [--apply] [--limit N]');
  }
  return { apply, limit };
}

interface Resolved {
  id: string;
  company: string | null;
  title: string | null;
  description: string;
  landedOnEmployer: boolean;
  finalUrl: string;
}

/**
 * Page text arrives with the site's chrome attached. Drop the short
 * navigation-ish lines so the JD quality gate is judging the posting rather
 * than a menu, and so length is not inflated by boilerplate.
 */
function cleanPageText(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 30 || /[.;:]$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function main(): Promise<void> {
  const { apply, limit } = parseArguments(process.argv.slice(2));

  const targets = await prisma.job.findMany({
    where: {
      source: 'Adzuna',
      status: { in: ['pending_af', 'inbox'] },
      scoringStatus: 'failed',
      url: { not: '' },
    },
    select: { id: true, company: true, title: true, url: true },
    orderBy: { id: 'asc' },
    ...(limit ? { take: limit } : {}),
  });

  const estimate = Math.round((targets.length * (HYDRATION_MS + 1_500)) / 60_000);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${targets.length.toLocaleString()} stuck Adzuna jobs (~${estimate} min of browser time).\n`);
  if (targets.length === 0) return;

  const { launch } = await import('cloakbrowser');
  const browser: { newPage: () => Promise<any>; close: () => Promise<void> } = await launch({ headless: true });

  const resolved: Resolved[] = [];
  let attempted = 0;
  let blocked = 0;

  try {
    for (const target of targets) {
      attempted += 1;
      const page = await browser.newPage();
      try {
        await page.goto(String(target.url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await new Promise((resolve) => setTimeout(resolve, HYDRATION_MS));
        const finalUrl: string = page.url();
        const raw: string = await page.evaluate(() => document.body?.innerText || '');

        if (/suspicious behaviour|unusual behaviour/i.test(raw)) {
          blocked += 1;
        } else {
          const description = cleanPageText(raw);
          if (description.length >= MIN_USABLE_LENGTH) {
            resolved.push({
              id: target.id,
              company: target.company,
              title: target.title,
              description,
              landedOnEmployer: !/adzuna\.com/i.test(finalUrl),
              finalUrl,
            });
          }
        }
      } catch {
        // A posting that has been taken down simply does not resolve.
      } finally {
        await page.close().catch(() => {});
      }

      if (attempted % 25 === 0) {
        console.log(`  probed ${attempted.toLocaleString()}/${targets.length.toLocaleString()} — ${resolved.length.toLocaleString()} recovered, ${blocked} blocked`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const employer = resolved.filter((job) => job.landedOnEmployer).length;
  console.log(`\n  recovered: ${resolved.length.toLocaleString()} of ${targets.length.toLocaleString()}`);
  console.log(`    reached the employer's own posting: ${employer.toLocaleString()}`);
  console.log(`    read from Adzuna's details page:    ${(resolved.length - employer).toLocaleString()}`);
  console.log(`  bot-blocked: ${blocked.toLocaleString()}`);
  console.log(`  unrecoverable (removed, or still under ${MIN_USABLE_LENGTH} chars): ${(targets.length - resolved.length - blocked).toLocaleString()}`);

  if (resolved.length > 0) {
    console.log('\n  samples:');
    for (const job of resolved.slice(0, SAMPLE_LIMIT)) {
      console.log(`    ${String(job.company || '?').slice(0, 20).padEnd(22)} ${String(job.description.length).padStart(6)}ch  ${job.landedOnEmployer ? 'employer' : 'adzuna  '}  ${String(job.title || '').slice(0, 38)}`);
    }
  }

  // Anything the browser could not rescue is dismissed rather than left in
  // Action Needed. There is no full description behind an Adzuna listing for a
  // human to go and fetch, so queueing it for review asks for the impossible.
  const unrecoverable = targets
    .filter((target) => !resolved.some((job) => job.id === target.id))
    .map((target) => target.id);
  console.log(`  will dismiss as unrecoverable: ${unrecoverable.length.toLocaleString()}`);

  if (!apply || (resolved.length === 0 && unrecoverable.length === 0)) {
    console.log(apply ? '\nNothing to write.' : '\nDry run only. Re-run with --apply to store these descriptions, requeue them, and dismiss the rest.');
    return;
  }

  let written = 0;
  for (let index = 0; index < resolved.length; index += 200) {
    const chunk = resolved.slice(index, index + 200);
    const results = await prisma.$transaction(chunk.map((job) => prisma.job.updateMany({
      // Re-check status so a job the pipeline has since claimed is left alone.
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
    console.log(`  requeued ${written.toLocaleString()}/${resolved.length.toLocaleString()}`);
  }
  console.log(`\nRequeued ${written.toLocaleString()} job(s) for scoring.`);

  let dismissed = 0;
  for (let index = 0; index < unrecoverable.length; index += 500) {
    const chunk = unrecoverable.slice(index, index + 500);
    const result = await prisma.job.updateMany({
      where: { id: { in: chunk }, scoringStatus: 'failed' },
      data: {
        scoringStatus: 'skipped',
        status: 'dismissed',
        passReason: AGGREGATOR_SNIPPET_DISCARD_REASON,
        scoreError: null,
      },
    });
    dismissed += result.count;
  }
  console.log(`Dismissed ${dismissed.toLocaleString()} unrecoverable listing(s).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
