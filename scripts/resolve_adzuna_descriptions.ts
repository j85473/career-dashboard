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

function parseArguments(argv: string[]): { apply: boolean; limit: number | null; repair: boolean } {
  let apply = false;
  let repair = false;
  let limit: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') { apply = true; continue; }
    if (argument === '--repair') { repair = true; continue; }
    if (argument === '--limit') {
      const value = Number.parseInt(argv[index + 1] || '', 10);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--limit needs a positive integer');
      limit = value;
      index += 1;
      continue;
    }
    throw new Error('Usage: resolve_adzuna_descriptions.ts [--apply] [--limit N] [--repair]');
  }
  return { apply, limit, repair };
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
 * Whole lines that are site furniture regardless of length.
 *
 * The length rule below is not enough on its own: Adzuna renders its search
 * bar as a single long line — "What?  Where?  Search  Advanced  ...  ❮ back to
 * last search" — which clears 30 characters and became the head of 9,868
 * stored descriptions. Google Tag Manager's <noscript> iframe arrived the same
 * way, as literal markup inside innerText.
 */
const CHROME_LINE_PATTERNS: RegExp[] = [
  /back to last search/i,
  /^what\?\s*where\?/i,
  /skip to main content/i,
  /googletagmanager\.com/i,
  /^<\/?[a-z][a-z0-9]*(\s[^<>]*)?>/i,
  /^(sign in|log in|register|create alert|save|share|report this job|menu|home)$/i,
  /^(cookie|cookies|privacy policy|terms and conditions|accept all)\b/i,
];

/**
 * Page text arrives with the site's chrome attached. Drop the furniture so the
 * JD quality gate is judging the posting rather than a menu, and so length is
 * not inflated by boilerplate.
 *
 * Order matters: the pattern list runs first, because a chrome line can be
 * long enough to survive the length rule.
 */
function cleanPageText(raw: string): string {
  const seen = new Set<string>();
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !CHROME_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => line.length > 30 || /[.;:]$/.test(line))
    // A repeated line is navigation echoed in a mobile menu, not prose.
    .filter((line) => {
      if (line.length > 120) return true;
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Read the posting container when the page states one, and the body only as a
 * last resort. Stripping the chrome elements first is what stops GTM's
 * <noscript> iframe and the nav from reaching innerText at all — filtering
 * lines afterwards was always a second line of defence.
 *
 * No *named* function may be declared inside page.evaluate: tsx/esbuild runs
 * with keepNames and injects a __name() helper that does not exist in the page.
 */
async function readPostingText(page: { evaluate: (fn: unknown) => Promise<string> }): Promise<string> {
  return page.evaluate(() => {
    const strip = document.querySelectorAll(
      'script, style, noscript, iframe, svg, nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="search"]',
    );
    for (const node of Array.from(strip)) node.remove();

    const containers = [
      '[data-testid*="jobDescription" i]',
      '[class*="job-description" i]',
      '[class*="jobDescription" i]',
      '[id*="job-description" i]',
      '[itemprop="description"]',
      'section.adp-body',
      'article',
      'main',
    ];
    for (const selector of containers) {
      const node = document.querySelector(selector) as HTMLElement | null;
      const text = node ? node.innerText || '' : '';
      if (text.trim().length >= 400) return text;
    }
    return document.body ? document.body.innerText || '' : '';
  });
}

type Target = { id: string; company: string | null; title: string | null; url: string | null; status: string; scoringStatus: string };

/**
 * `--repair` rescrapes rows whose stored description is chrome rather than a
 * posting. It deliberately does NOT take all 9,868 matching rows.
 *
 * 9,604 of them sit at archived/skipped or dismissed/skipped: the pre-filter
 * rejected them on *title*, so their description never entered a decision and
 * rewriting it changes nothing. At ~7.5s of browser time each that would be
 * roughly 20 hours spent on rows no one will read. What is left is ~264 rows
 * that are live, applied, or were scored — including 145 dismissed *after*
 * scoring, which are the ones that may have been judged on furniture.
 *
 * Matched in Postgres. Never `LIKE '%<%'` plus a JS test: that ships every job
 * body from the Pi across Tailscale and looks hung.
 */
async function repairTargets(limit: number | null): Promise<Target[]> {
  console.log('Selecting repair candidates in Postgres...');
  const rows = await prisma.$queryRawUnsafe<Target[]>(
    `SELECT id, company, title, url, status, "scoringStatus" AS "scoringStatus"
       FROM "Job"
      WHERE source = 'Adzuna'
        AND url <> ''
        AND description ~* '</?[a-z][a-z0-9]*([[:space:]][^<>]*)?>'
        AND NOT ("scoringStatus" = 'skipped' AND status IN ('archived', 'dismissed'))
      ORDER BY id ASC
      ${limit ? `LIMIT ${Number(limit)}` : ''}`,
  );
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.status}/${row.scoringStatus}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  console.log('  candidates by status/scoringStatus:');
  for (const [key, count] of [...buckets].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(5)}  ${key}`);
  }
  return rows;
}

async function main(): Promise<void> {
  const { apply, limit, repair } = parseArguments(process.argv.slice(2));

  const targets = repair ? await repairTargets(limit) : await prisma.job.findMany({
    where: {
      source: 'Adzuna',
      status: { in: ['pending_af', 'inbox'] },
      scoringStatus: 'failed',
      url: { not: '' },
    },
    select: { id: true, company: true, title: true, url: true, status: true, scoringStatus: true },
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
        const raw: string = await readPostingText(page);

        // "Just a moment..." / "Verifying you are human" is Cloudflare, and was
        // previously counted as an unrecoverable listing rather than a block.
        if (/suspicious behaviour|unusual behaviour|just a moment|verifying you are|security verification/i.test(raw)) {
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
      // A character count is not evidence the chrome is gone — it was a large
      // number that made the original defect look like a successful rescue.
      // Show the head of the text, which is exactly where the furniture landed.
      console.log(`      head: ${JSON.stringify(job.description.slice(0, 220))}`);
    }
  }

  if (repair) {
    // A repair rewrites text. It does not silently re-open decisions Joseph
    // made: an applied or passed row keeps its status, and no Aim/Experience
    // projection is cleared here — clearing those is what puts a row back in
    // the manual export batch, which costs real time.
    const reopenable = targets.filter((target) =>
      target.status === 'dismissed' && target.scoringStatus === 'scored'
      && resolved.some((job) => job.id === target.id));
    console.log(`  would rewrite ${resolved.length.toLocaleString()} description(s)`);
    console.log(`  of those, ${reopenable.length.toLocaleString()} were dismissed *after* scoring and will be requeued for local scoring`);
    console.log(`  the rest keep their current status; only the stored text changes`);

    if (!apply) {
      console.log('\nDry run only. Re-run with --apply --repair to write.');
      return;
    }

    const reopen = new Set(reopenable.map((target) => target.id));
    let rewritten = 0;
    let requeued = 0;
    for (const job of resolved) {
      const result = await prisma.job.updateMany({
        where: { id: job.id },
        data: reopen.has(job.id)
          ? {
              description: job.description,
              status: 'pending_af',
              scoringStatus: 'queued',
              scoreAttempts: 0,
              scoreError: null,
              passReason: null,
            }
          : { description: job.description },
      });
      rewritten += result.count;
      if (reopen.has(job.id)) requeued += result.count;
    }
    console.log(`\nRewrote ${rewritten.toLocaleString()} description(s); requeued ${requeued.toLocaleString()} for local scoring.`);
    return;
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
