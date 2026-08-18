import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import { cleanHtmlText } from '../src/lib/jobIngestion';
import { withPostingFacts } from '../src/lib/postingFacts';

/**
 * Repairs job descriptions that were stored as visible markup.
 *
 * Greenhouse's boards API returns `content` HTML-*escaped*
 * (`&lt;div class=&quot;content-intro&quot;&gt;`). Cheerio parsed that as a
 * single text node — no elements to remove — and `.text()` then decoded the
 * entities, so the old single-pass `cleanHtmlText` returned the tags as literal
 * visible text. Every Greenhouse posting was stored that way, on both the board
 * sweep and the manual re-scrape, which means Aim and Experience have been
 * reading job descriptions made substantially of `<div>` and `<p>`.
 *
 * `cleanHtmlText` now re-runs while its output still looks like markup, but
 * that only helps rows ingested from now on, and dedupe stops the sweep from
 * revisiting the ones already stored.
 *
 * **No refetching is required.** What was stored is the decoded markup, so
 * running the corrected cleaner over the stored text strips it in place. That
 * makes this a local pass with no provider requests, and it is idempotent —
 * cleaning an already-clean description returns it unchanged.
 *
 * Posted salary and travel are re-derived alongside, via `withPostingFacts`,
 * because they were extracted from the polluted text and are pure functions of
 * it — that helper exists so no site writes a description without them.
 *
 * Scores are left alone by default. A description this damaged probably
 * produced a bad Aim result, but re-scoring is a manual batch export, so the
 * dry run reports how many scored rows are affected and `--rescore` is opt-in.
 *
 * Dry run by default; `--apply` writes.
 */

const prisma = new PrismaClient();
const PAGE_SIZE = 500;
const SAMPLE_LIMIT = 8;

/** A real tag shape, so "<10% travel" is never mistaken for markup. */
const MARKUP_RESIDUE = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/i;

/** Statuses where a requeue is safe — never revive a human's decision. */
const REQUEUEABLE = ['pending_af', 'inbox'];

function parseArguments(argv: string[]): { apply: boolean; rescore: boolean } {
  const allowed = new Set(['--apply', '--rescore']);
  for (const argument of argv) {
    if (!allowed.has(argument)) throw new Error('Usage: repair_escaped_html_descriptions.ts [--apply] [--rescore]');
  }
  return { apply: argv.includes('--apply'), rescore: argv.includes('--rescore') };
}

interface Repair {
  id: string;
  company: string | null;
  source: string | null;
  status: string;
  scoringStatus: string;
  hasScore: boolean;
  before: string;
  after: string;
}

async function main(): Promise<void> {
  const { apply, rescore } = parseArguments(process.argv.slice(2));

  const repairs: Repair[] = [];
  let scanned = 0;
  let cursor: string | undefined;

  // Paged rather than loaded whole: the description column is the largest in
  // the table and the affected set could be tens of thousands of rows.
  for (;;) {
    const page = await prisma.job.findMany({
      where: { description: { contains: '<' } },
      select: {
        id: true, company: true, source: true, status: true,
        scoringStatus: true, description: true, aimFitScore: true, fitScore: true,
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;
    scanned += page.length;

    for (const job of page) {
      const description = job.description || '';
      if (!MARKUP_RESIDUE.test(description)) continue;
      const cleaned = cleanHtmlText(description);
      // Only a repair if the cleaner actually removed the markup and left
      // usable text behind; anything else stays untouched for inspection.
      if (cleaned === description || MARKUP_RESIDUE.test(cleaned) || cleaned.length < 200) continue;
      repairs.push({
        id: job.id,
        company: job.company,
        source: job.source,
        status: job.status,
        scoringStatus: job.scoringStatus,
        hasScore: job.aimFitScore != null || job.fitScore != null,
        before: description,
        after: cleaned,
      });
    }
    if (scanned % 5_000 < PAGE_SIZE) console.log(`  scanned ${scanned.toLocaleString()} — ${repairs.length.toLocaleString()} repairable`);
  }

  const bySource = new Map<string, number>();
  for (const repair of repairs) bySource.set(String(repair.source), (bySource.get(String(repair.source)) || 0) + 1);
  const scored = repairs.filter((repair) => repair.hasScore);
  const requeueable = repairs.filter((repair) => REQUEUEABLE.includes(repair.status));
  const shrink = repairs.reduce((sum, r) => sum + (r.before.length - r.after.length), 0);

  console.log(`\n${apply ? 'APPLY' : 'DRY RUN'} — scanned ${scanned.toLocaleString()} description(s) containing '<'.\n`);
  console.log(`  repairable:            ${repairs.length.toLocaleString()}`);
  console.log(`  markup removed:        ${shrink.toLocaleString()} characters`);
  console.log(`  already scored:        ${scored.length.toLocaleString()} (scored against the damaged text)`);
  console.log(`  safe to requeue:       ${requeueable.length.toLocaleString()} (status pending_af or inbox)\n`);

  if (bySource.size > 0) {
    console.log('  by source:');
    for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(6)}  ${source}`);
    }
  }

  if (repairs.length > 0) {
    console.log('\n  samples (first 110 chars):');
    for (const repair of repairs.slice(0, SAMPLE_LIMIT)) {
      console.log(`    ${String(repair.company || '?').slice(0, 24)}  [${repair.source}]`);
      console.log(`      before: ${JSON.stringify(repair.before.slice(0, 110))}`);
      console.log(`      after : ${JSON.stringify(repair.after.slice(0, 110))}`);
    }
  }

  if (!apply || repairs.length === 0) {
    console.log(apply ? '\nNothing to write.' : '\nDry run. Re-run with --apply to repair the descriptions'
      + (rescore ? ' and requeue them for scoring.' : ' (add --rescore to also requeue them for scoring).'));
    return;
  }

  let written = 0;
  for (const repair of repairs) {
    const result = await prisma.job.updateMany({
      // Re-check the stored text so a row repaired or edited since the scan is
      // never overwritten with a stale cleaning.
      where: { id: repair.id, description: { contains: '<' } },
      data: withPostingFacts(repair.after, {
        ...(rescore && REQUEUEABLE.includes(repair.status)
          ? { scoringStatus: 'queued', scoreAttempts: 0, scoreError: null, passReason: null }
          : {}),
      }),
    });
    written += result.count;
    if (written % 500 === 0) console.log(`  repaired ${written.toLocaleString()}/${repairs.length.toLocaleString()}`);
  }

  console.log(`\nRepaired ${written.toLocaleString()} description(s).`);
  console.log(rescore
    ? `Requeued the ${requeueable.length.toLocaleString()} row(s) in an active status for scoring.`
    : `Left scoring untouched. ${scored.length.toLocaleString()} row(s) still carry a score derived from the damaged text — re-run with --rescore to queue the active ones.`);
}

main()
  .catch((error: unknown) => {
    console.error(`Description repair failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
