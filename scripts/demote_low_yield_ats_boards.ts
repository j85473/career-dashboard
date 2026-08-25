import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ATS_YIELD_MIN_EVIDENCE,
  boardSlugFromJobUrl,
  classifyBoardYield,
  lowYieldNextCheckDate,
} from '../src/lib/atsBoardYield';
import { prisma } from '../src/lib/prisma';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';

const VERSION = 'ats-low-yield-demotion-v1';
const DEAD_STATUSES = ['dismissed', 'archived', 'expired'];

type Candidate = {
  slug: string;
  platform: string;
  storedJobs: number;
  survivingJobs: number;
  postingsLastCheck: number;
  reason: string;
};

/**
 * Moves boards that have proven they publish nothing usable onto a slower lane.
 *
 * Dry-run by default. Demotion pushes `nextCheckDate` out by one long cadence
 * and changes nothing else: the board keeps its rotation day, its status, and
 * its history, and it returns on its own to be judged again. No board is
 * deleted, blacklisted, or hidden.
 */
async function loadCandidates(): Promise<{ candidates: Candidate[]; scanned: number }> {
  const boards = await prisma.atsCompany.findMany({
    where: { status: 'active' },
    select: { slug: true, platform: true, jobsFound: true },
  });
  const byPlatform = new Map<string, Map<string, { stored: number; surviving: number }>>();

  // One pass per platform over that platform's jobs, bucketed by the board slug
  // recovered from each job's URL.
  for (const platform of new Set(boards.map((board) => board.platform))) {
    const jobs = await prisma.job.findMany({
      where: { source: `ATS-${platform}` },
      select: { url: true, canonicalUrl: true, status: true },
    });
    const bucket = new Map<string, { stored: number; surviving: number }>();
    for (const job of jobs) {
      const slug = boardSlugFromJobUrl(job.url || job.canonicalUrl, platform);
      if (!slug) continue;
      const entry = bucket.get(slug) || { stored: 0, surviving: 0 };
      entry.stored += 1;
      if (!DEAD_STATUSES.includes(job.status)) entry.surviving += 1;
      bucket.set(slug, entry);
    }
    byPlatform.set(platform, bucket);
  }

  const candidates: Candidate[] = [];
  for (const board of boards) {
    const measured = byPlatform.get(board.platform)?.get(board.slug)
      // Workday stores tenant::site; the job URL yields the same shape.
      || byPlatform.get(board.platform)?.get(board.slug.split('::')[0]);
    if (!measured) continue;
    const verdict = classifyBoardYield({
      storedJobs: measured.stored,
      survivingJobs: measured.surviving,
    });
    if (verdict.classification !== 'low_yield') continue;
    candidates.push({
      slug: board.slug,
      platform: board.platform,
      storedJobs: measured.stored,
      survivingJobs: measured.surviving,
      postingsLastCheck: board.jobsFound,
      reason: verdict.reason,
    });
  }
  candidates.sort((left, right) => right.storedJobs - left.storedJobs);
  return { candidates, scanned: boards.length };
}

function parseMode(argv: string[]): { apply: boolean; approved: string | null } {
  if (argv.length === 0) return { apply: false, approved: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash'
    || !/^[a-f0-9]{64}$/.test(argv[2])) {
    throw new Error('Usage: demote_low_yield_ats_boards.ts [--apply --selection-hash <reviewed-dry-run-hash>]');
  }
  return { apply: true, approved: argv[2] };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { apply, approved } = parseMode(argv);
  const { candidates, scanned } = await loadCandidates();
  const selectionHash = canonicalJsonSha256(
    candidates.map((c) => ({ slug: c.slug, platform: c.platform, stored: c.storedJobs })),
  );

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    selectionHash,
    activeBoardsScanned: scanned,
    minimumEvidence: ATS_YIELD_MIN_EVIDENCE,
    demotionCandidates: candidates.length,
    postingsReclaimedPerRotation: candidates.reduce((sum, c) => sum + c.postingsLastCheck, 0),
    topCandidates: candidates.slice(0, 25),
    effect: 'Demoted boards keep their rotation day, status, and history. Only the '
      + 'next sweep date moves out by one long cadence, after which they are judged again.',
    writesPerformed: 0,
  }, null, 2));

  if (!apply) return;
  if (selectionHash !== approved) {
    throw new Error(
      `Selection hash mismatch: reviewed ${approved}; current ${selectionHash}. No writes were attempted.`,
    );
  }

  let demoted = 0;
  for (const candidate of candidates) {
    const result = await prisma.atsCompany.updateMany({
      where: { slug: candidate.slug, platform: candidate.platform, status: 'active' },
      data: { nextCheckDate: lowYieldNextCheckDate() },
    });
    demoted += result.count;
  }
  console.log(JSON.stringify({ mode: 'apply', version: VERSION, demoted }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error(`Low-yield demotion failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
