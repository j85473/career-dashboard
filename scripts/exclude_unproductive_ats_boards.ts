import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { boardSlugFromJobUrl } from '../src/lib/atsBoardYield';
import {
  classifyBoardForExclusion,
  ATS_EXCLUSION_MIN_LOCATED_POSTINGS,
  ATS_EXCLUSION_MIN_UNPRODUCTIVE_EVIDENCE,
} from '../src/lib/atsBoardExclusionPolicy';
import {
  hasGeneralRemoteOption,
  hasMinnesotaLocationOption,
  isUnknownOrBroadUSOption,
  splitLocationOptions,
} from '../src/lib/jobLocationPolicy';
import { prisma } from '../src/lib/prisma';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';

const VERSION = 'ats-board-exclusion-v1';
const DEAD_STATUSES = ['dismissed', 'archived', 'expired'];
const OUTSTANDING_BATCH_STATUSES = ['fetching', 'partial', 'queued', 'processing'];

type Candidate = {
  slug: string;
  platform: string;
  basis: 'proven_unproductive' | 'out_of_territory';
  storedJobs: number;
  locatedJobs: number;
  outOfTerritoryJobs: number;
  postingsLastCheck: number;
  reason: string;
};

/**
 * A location specific enough to attribute to a place.
 *
 * "Remote", "United States", "2 Locations", and blanks say nothing about where
 * an employer hires, so they are left out of the territory denominator rather
 * than counted against the board.
 */
function locationIsPlaceable(location: string | null): boolean {
  const raw = String(location || '').trim();
  if (!raw) return false;
  if (hasGeneralRemoteOption(raw)) return false;
  const options = splitLocationOptions(raw);
  return options.length > 0 && !options.every((option) => isUnknownOrBroadUSOption(option));
}

async function loadCandidates(): Promise<{ candidates: Candidate[]; scanned: number }> {
  const boards = await prisma.atsCompany.findMany({
    where: { status: 'active' },
    select: { slug: true, platform: true, jobsFound: true },
  });
  const key = (platform: string, slug: string) => `${platform}::${slug}`;
  const evidence = new Map<string, {
    storedJobs: number; survivingJobs: number; locallyScoredJobs: number;
    locatedJobs: number; outOfTerritoryJobs: number;
  }>();

  // One pass per platform over that platform's jobs, bucketed by the board slug
  // recovered from each job's URL -- the only durable link a job keeps to the
  // board that produced it.
  for (const platform of new Set(boards.map((board) => board.platform))) {
    const jobs = await prisma.job.findMany({
      where: { url: { not: null }, source: { contains: platform, mode: 'insensitive' } },
      select: { url: true, status: true, location: true, scoringStatus: true },
    });
    for (const job of jobs) {
      const slug = boardSlugFromJobUrl(job.url, platform);
      if (!slug) continue;
      const bucket = evidence.get(key(platform, slug))
        || { storedJobs: 0, survivingJobs: 0, locallyScoredJobs: 0, locatedJobs: 0, outOfTerritoryJobs: 0 };
      bucket.storedJobs++;
      if (!DEAD_STATUSES.includes(job.status)) bucket.survivingJobs++;
      if (job.scoringStatus === 'scored') bucket.locallyScoredJobs++;
      if (locationIsPlaceable(job.location)) {
        bucket.locatedJobs++;
        if (!hasMinnesotaLocationOption(String(job.location))) bucket.outOfTerritoryJobs++;
      }
      evidence.set(key(platform, slug), bucket);
    }
  }

  const candidates: Candidate[] = [];
  for (const board of boards) {
    const measured = evidence.get(key(board.platform, board.slug))
      || { storedJobs: 0, survivingJobs: 0, locallyScoredJobs: 0, locatedJobs: 0, outOfTerritoryJobs: 0 };
    const verdict = classifyBoardForExclusion(measured);
    if (!verdict.exclude) continue;
    candidates.push({
      slug: board.slug,
      platform: board.platform,
      basis: verdict.basis,
      storedJobs: measured.storedJobs,
      locatedJobs: measured.locatedJobs,
      outOfTerritoryJobs: measured.outOfTerritoryJobs,
      postingsLastCheck: board.jobsFound,
      reason: verdict.reason,
    });
  }
  candidates.sort((a, b) => b.postingsLastCheck - a.postingsLastCheck
    || `${a.platform}:${a.slug}`.localeCompare(`${b.platform}:${b.slug}`));
  return { candidates, scanned: boards.length };
}

function parseMode(argv: string[]): { apply: boolean; approved: string | null } {
  if (argv.length === 0) return { apply: false, approved: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash' || !argv[2]) {
    throw new Error('Usage: exclude_unproductive_ats_boards.ts [--apply --selection-hash <reviewed-dry-run-hash>]');
  }
  return { apply: true, approved: argv[2] };
}

async function main(argv: string[]): Promise<void> {
  const { apply, approved } = parseMode(argv);
  const { candidates, scanned } = await loadCandidates();
  const selectionHash = canonicalJsonSha256(
    candidates.map((c) => ({ slug: c.slug, platform: c.platform, basis: c.basis })),
  );
  const postings = candidates.reduce((sum, c) => sum + c.postingsLastCheck, 0);

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    selectionHash,
    activeBoardsScanned: scanned,
    exclusionCandidates: candidates.length,
    byBasis: {
      out_of_territory: candidates.filter((c) => c.basis === 'out_of_territory').length,
      proven_unproductive: candidates.filter((c) => c.basis === 'proven_unproductive').length,
    },
    postingsReclaimedPerRotation: postings,
    // Enrichment is one detail request per posting at about 2.9s measured, and
    // acquisition runs four workers, so this is the share of a 96-hour day freed.
    workerHoursPerDayReclaimed: Number(((postings / 7 * 2.9) / 3600).toFixed(1)),
    bars: {
      minUnproductiveEvidence: ATS_EXCLUSION_MIN_UNPRODUCTIVE_EVIDENCE,
      minLocatedPostings: ATS_EXCLUSION_MIN_LOCATED_POSTINGS,
    },
    survivingJobsAcrossCandidates: 0,
    topCandidates: candidates.slice(0, 25),
    effect: 'Excluded boards leave the weekly rotation indefinitely and their in-flight batch payloads are dropped. Jobs already stored from these boards keep their status, score, and history untouched. Reversible: set status back to active and clear excludedReason.',
    writesPerformed: 0,
  }, null, 2));

  if (!apply) return;
  if (selectionHash !== approved) {
    throw new Error(
      `Selection hash mismatch: reviewed ${approved}; current ${selectionHash}. No writes were attempted.`,
    );
  }

  const now = new Date();
  let excludedBoards = 0;
  let droppedBatches = 0;
  for (const candidate of candidates) {
    // The board leaves the rotation and its in-flight payload stops being work
    // in the same transaction, so a concurrent turn cannot resume a board this
    // pass has already retired. Job rows are deliberately never touched.
    const result = await prisma.$transaction(async (transaction) => {
      const batches = await transaction.atsIngestionBatch.updateMany({
        where: {
          slug: candidate.slug,
          platform: candidate.platform,
          writerMode: 'legacy',
          status: { in: OUTSTANDING_BATCH_STATUSES },
        },
        data: {
          status: 'excluded',
          nextProcessAt: null,
          leaseToken: null,
          leaseOwner: null,
          leaseStartedAt: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          lastError: candidate.reason,
        },
      });
      const boards = await transaction.atsCompany.updateMany({
        where: { slug: candidate.slug, platform: candidate.platform, status: 'active' },
        data: { status: 'excluded', excludedReason: `${candidate.basis}: ${candidate.reason}`, excludedAt: now },
      });
      return { boards: boards.count, batches: batches.count };
    });
    excludedBoards += result.boards;
    droppedBatches += result.batches;
  }
  console.log(JSON.stringify({
    mode: 'apply', version: VERSION, excludedBoards, droppedBatches,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}

export { loadCandidates, locationIsPlaceable };
