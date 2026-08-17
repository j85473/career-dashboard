import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { derivePostingFacts } from '../src/lib/postingFacts';

/**
 * Populates only empty posted-fact fields from the JD already stored on each
 * job. Dry-run is the default; --apply is required to write anything. It never
 * reads Aim/Experience results and never changes the legacy `compensation` or
 * `travelScore` fields.
 *
 * New jobs no longer need this: Local Triage derives both fields at ingest and
 * again when Jina fills in a short posting. This exists to cover the history
 * that predates that wiring, and as a re-run after an extractor change.
 */
const SAMPLE_LIMIT = 15;
const PAGE_SIZE = 5_000;

/**
 * `--refresh` re-derives fields that already have a value and corrects them,
 * including clearing one back to null. Default mode only ever fills a hole, so
 * a tightened extractor cannot retract a figure it should no longer be
 * showing; refresh is how a rule change reaches rows already written.
 */
function parseArguments(argv: string[]): { apply: boolean; refresh: boolean } {
  const allowed = new Set(['--apply', '--refresh']);
  for (const argument of argv) {
    if (!allowed.has(argument)) {
      throw new Error('Usage: backfill_posted_compensation.ts [--apply] [--refresh]');
    }
  }
  return { apply: argv.includes('--apply'), refresh: argv.includes('--refresh') };
}

interface Candidate {
  id: string;
  company: string | null;
  title: string | null;
  postedCompensation: string | null;
  postedTravel: string | null;
  /** Set on a refresh that retracts a value the extractor no longer accepts. */
  clearedCompensation: string | null;
  clearedTravel: string | null;
}

async function main(): Promise<void> {
  const { apply, refresh } = parseArguments(process.argv.slice(2));

  let cursor: string | undefined;
  let examined = 0;
  const candidates: Candidate[] = [];

  // Paged deliberately: the unscanned history is ~330k rows with full JD text
  // attached, and loading every description at once is what turns a backfill
  // into an out-of-memory crash.
  for (;;) {
    const page = await prisma.job.findMany({
      where: refresh
        // Refresh re-reads every stored JD, because a row that must have a
        // value retracted is precisely one that is currently non-null.
        ? { description: { not: null } }
        : { description: { not: null }, OR: [{ postedCompensation: null }, { postedTravel: null }] },
      select: {
        id: true,
        company: true,
        title: true,
        description: true,
        postedCompensation: true,
        postedTravel: true,
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    examined += page.length;
    cursor = page[page.length - 1].id;

    for (const job of page) {
      const facts = derivePostingFacts(job.description);

      // Default mode only ever fills a hole, so a re-run cannot silently
      // rewrite history. Refresh mode compares against what is stored and
      // corrects any disagreement, in either direction.
      const compensationChanged = refresh && facts.postedCompensation !== job.postedCompensation;
      const travelChanged = refresh && facts.postedTravel !== job.postedTravel;

      const postedCompensation = refresh
        ? (compensationChanged ? facts.postedCompensation : null)
        : (job.postedCompensation === null ? facts.postedCompensation : null);
      const postedTravel = refresh
        ? (travelChanged ? facts.postedTravel : null)
        : (job.postedTravel === null ? facts.postedTravel : null);

      const clearedCompensation = compensationChanged && facts.postedCompensation === null
        ? job.postedCompensation : null;
      const clearedTravel = travelChanged && facts.postedTravel === null
        ? job.postedTravel : null;

      if (postedCompensation || postedTravel || clearedCompensation || clearedTravel) {
        candidates.push({
          id: job.id,
          company: job.company,
          title: job.title,
          postedCompensation,
          postedTravel,
          clearedCompensation,
          clearedTravel,
        });
      }
    }
  }

  const withCompensation = candidates.filter((candidate) => candidate.postedCompensation);
  const withTravel = candidates.filter((candidate) => candidate.postedTravel);
  const rate = (count: number) => (examined === 0 ? '0.0' : ((count / examined) * 100).toFixed(1));

  const clearedCompensation = candidates.filter((candidate) => candidate.clearedCompensation);
  const clearedTravel = candidates.filter((candidate) => candidate.clearedTravel);

  const mode = `${apply ? 'APPLY' : 'DRY RUN'}${refresh ? ' (refresh)' : ''}`;
  console.log(`${mode} — examined ${examined.toLocaleString()} jobs with stored JDs.`);
  console.log(`  posted compensation: ${withCompensation.length.toLocaleString()} (${rate(withCompensation.length)}%)`);
  console.log(`  posted travel:       ${withTravel.length.toLocaleString()} (${rate(withTravel.length)}%)`);
  if (refresh) {
    console.log(`  retracting salary:   ${clearedCompensation.length.toLocaleString()}`);
    console.log(`  retracting travel:   ${clearedTravel.length.toLocaleString()}`);
  }
  console.log(`  rows to write:       ${candidates.length.toLocaleString()}`);

  const preview = (
    label: string,
    rows: Candidate[],
    field: 'postedCompensation' | 'postedTravel' | 'clearedCompensation' | 'clearedTravel',
  ) => {
    if (rows.length === 0) return;
    console.log(`\n  ${label}:`);
    for (const row of rows.slice(0, SAMPLE_LIMIT)) {
      console.log(`    ${row.company || '?'} | ${row.title || '?'} | ${String(row[field])}`);
    }
    if (rows.length > SAMPLE_LIMIT) {
      console.log(`    … ${(rows.length - SAMPLE_LIMIT).toLocaleString()} more`);
    }
  };
  preview('compensation samples', withCompensation, 'postedCompensation');
  preview('travel samples', withTravel, 'postedTravel');
  preview('salary values being retracted', clearedCompensation, 'clearedCompensation');
  preview('travel values being retracted', clearedTravel, 'clearedTravel');

  if (!apply || candidates.length === 0) {
    console.log(apply
      ? '\nNothing to write.'
      : `\nDry run only. Re-run with --apply${refresh ? ' --refresh' : ''} to write exactly these changes.`);
    return;
  }

  let written = 0;
  for (let index = 0; index < candidates.length; index += 500) {
    const chunk = candidates.slice(index, index + 500);
    const results = await prisma.$transaction(chunk.map((candidate) => prisma.job.updateMany({
      where: { id: candidate.id },
      data: {
        ...(candidate.postedCompensation ? { postedCompensation: candidate.postedCompensation } : {}),
        ...(candidate.postedTravel ? { postedTravel: candidate.postedTravel } : {}),
        ...(candidate.clearedCompensation ? { postedCompensation: null } : {}),
        ...(candidate.clearedTravel ? { postedTravel: null } : {}),
      },
    })));
    written += results.reduce((sum, result) => sum + result.count, 0);
    console.log(`  applied ${written.toLocaleString()}/${candidates.length.toLocaleString()}`);
  }
  console.log(`Applied ${written.toLocaleString()} row(s).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
