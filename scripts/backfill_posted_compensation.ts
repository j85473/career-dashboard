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

function parseArguments(argv: string[]): { apply: boolean } {
  if (argv.length === 0) return { apply: false };
  if (argv.length === 1 && argv[0] === '--apply') return { apply: true };
  throw new Error('Usage: backfill_posted_compensation.ts [--apply]');
}

interface Candidate {
  id: string;
  company: string | null;
  title: string | null;
  postedCompensation: string | null;
  postedTravel: string | null;
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));

  let cursor: string | undefined;
  let examined = 0;
  const candidates: Candidate[] = [];

  // Paged deliberately: the unscanned history is ~330k rows with full JD text
  // attached, and loading every description at once is what turns a backfill
  // into an out-of-memory crash.
  for (;;) {
    const page = await prisma.job.findMany({
      where: {
        description: { not: null },
        OR: [{ postedCompensation: null }, { postedTravel: null }],
      },
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
      // Only ever fills a hole. An existing value is left alone so a re-run
      // after an extractor change cannot silently rewrite history.
      const postedCompensation = job.postedCompensation === null ? facts.postedCompensation : null;
      const postedTravel = job.postedTravel === null ? facts.postedTravel : null;
      if (postedCompensation || postedTravel) {
        candidates.push({
          id: job.id,
          company: job.company,
          title: job.title,
          postedCompensation,
          postedTravel,
        });
      }
    }
  }

  const withCompensation = candidates.filter((candidate) => candidate.postedCompensation);
  const withTravel = candidates.filter((candidate) => candidate.postedTravel);
  const rate = (count: number) => (examined === 0 ? '0.0' : ((count / examined) * 100).toFixed(1));

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — examined ${examined.toLocaleString()} jobs with stored JDs.`);
  console.log(`  posted compensation: ${withCompensation.length.toLocaleString()} (${rate(withCompensation.length)}% coverage)`);
  console.log(`  posted travel:       ${withTravel.length.toLocaleString()} (${rate(withTravel.length)}% coverage)`);
  console.log(`  rows to write:       ${candidates.length.toLocaleString()}`);

  const preview = (label: string, rows: Candidate[], field: 'postedCompensation' | 'postedTravel') => {
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

  if (!apply || candidates.length === 0) {
    console.log(apply
      ? '\nNothing to write.'
      : '\nDry run only. Re-run with --apply to populate exactly these empty fields.');
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
