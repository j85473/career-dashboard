import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { prisma } from '../src/lib/prisma';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';

const VERSION = 'ats-board-never-relevant-exclusion-v1';
const OUTSTANDING_BATCH_STATUSES = ['fetching', 'partial', 'synchronized'];
const RETIRABLE_BOARD_STATUSES = ['active', 'parked', 'blacklisted'];

/**
 * Boards whose postings could never pass the catalog's geography gate.
 *
 * A fourth basis beside proven_unproductive, out_of_territory, and
 * endpoint_absent. It exists because out_of_territory structurally cannot see
 * these boards: that arm judges stored Job rows attributed back by URL, and a
 * board whose every posting fails the geography gate never produces a Job row
 * to attribute. It therefore reports zero postings and is declined as "never
 * been judged" -- so a hospital in Mumbai or a church in Tuscaloosa is fetched
 * every week, forever, by the very system built to retire boards that produce
 * nothing.
 *
 * The evidence here is the retained raw listing payload, which holds every
 * posting the pipeline ever fetched whether or not it survived the gate.
 *
 * Three guards, all deliberately biased toward keeping a board:
 *
 *  1. A minimum posting count, so a board with a handful of listings is never
 *     retired on a thin sample.
 *  2. At least one readable location. A board whose locations are all illegible
 *     has not been judged -- it may hire in Minneapolis and simply publish in a
 *     shape the cascade cannot parse -- and a parsing gap must never read as a
 *     fact about the employer.
 *  3. Never a single job that reached the catalog. One is enough to keep a
 *     board forever, matching the keep-signal the other three arms use. This
 *     counts inserted jobs, not the batch's posting count: those are different
 *     numbers, and confusing them inverts the whole arm.
 *
 * The location cascade mirrors `isLocationMatch` in jobIngestion.ts field for
 * field, because that is the function deciding what the pipeline keeps. Reading
 * a field it ignores would nominate a board whose postings are in fact kept.
 */
export const ATS_NEVER_RELEVANT_MIN_POSTINGS = 25;

const LOCATION_SQL = `
  lower(coalesce(
    nullif(case when jsonb_typeof(i."rawJson"->'location') = 'string'
      then i."rawJson"->>'location' end, ''),
    nullif(i."rawJson"->'location'->>'name', ''),
    nullif(trim(concat_ws(' ',
      i."rawJson"->'location'->>'city',
      i."rawJson"->'location'->>'region')), ''),
    nullif(i."rawJson"->'categories'->>'location', ''),
    nullif(i."rawJson"->>'locationsText', ''),
    nullif(trim(concat_ws(' ',
      i."rawJson"->>'city',
      i."rawJson"->>'state',
      i."rawJson"->>'country')), ''),
    ''
  ))`;

const REMOTE_SQL = `
  lower(concat_ws(' ',
    i."rawJson"->>'title',
    i."rawJson"->>'text',
    i."rawJson"->>'name',
    i."rawJson"->>'workplaceType',
    i."rawJson"->>'workplace_type'
  ))`;

const MATCH_SQL = `(
  ${LOCATION_SQL} ~ '(minneapolis|st\\. paul|saint paul|minnesota|mn|554|551|remote|virtual|anywhere|nationwide|distributed)'
  or ${REMOTE_SQL} ~ '\\y(remote|virtual|distributed|work from home)\\y'
)`;

type Candidate = {
  platform: string;
  slug: string;
  status: string;
  postings: bigint;
  readable: bigint;
  sample_locations: string[];
};

async function loadCandidates(): Promise<Candidate[]> {
  return prisma.$queryRawUnsafe<Candidate[]>(`
    with per_board as (
      select
        b."platform",
        b."slug",
        count(*) as postings,
        count(*) filter (where ${MATCH_SQL}) as matched,
        count(*) filter (where ${LOCATION_SQL} <> '') as readable,
        (array_agg(distinct ${LOCATION_SQL}))[1:5] as sample_locations
      from "AtsIngestionItem" i
      join "AtsIngestionBatch" b on b.id = i."batchId"
      where i."rawJson" is not null
      group by 1, 2
    ),
    -- The keep-signal is a job that actually reached the catalog. Batch
    -- "jobCount" is canonicalOccurrenceCount -- postings fetched, not jobs
    -- stored -- so a board that published 100 listings in Mumbai and had every
    -- one filtered still carries jobCount = 100. Guarding on it kept 595 of the
    -- 854 boards this arm exists to find, which is precisely backwards.
    ever_inserted as (
      select distinct b."slug", b."platform"
      from "AtsIngestionSegment" s
      join "AtsIngestionBatch" b on b.id = s."batchId"
      where s."insertedCount" > 0
    )
    select p."platform", p."slug", c."status", p.postings, p.readable, p.sample_locations
    from per_board p
    join "AtsCompany" c on c."slug" = p."slug" and c."platform" = p."platform"
    left join ever_inserted ins on ins."slug" = p."slug" and ins."platform" = p."platform"
    where p.matched = 0
      and p.postings >= ${ATS_NEVER_RELEVANT_MIN_POSTINGS}
      and p.readable > 0
      and ins."slug" is null
      and c."status" = any($1::text[])
    order by p.postings desc
  `, RETIRABLE_BOARD_STATUSES);
}

function parseMode(argv: string[]): { apply: boolean; approved: string | null } {
  if (argv.length === 0) return { apply: false, approved: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash' || !argv[2]) {
    throw new Error('Usage: exclude_never_relevant_ats_boards.ts [--apply --selection-hash <hash>]');
  }
  return { apply: true, approved: argv[2] };
}

async function main(argv: string[]): Promise<void> {
  const { apply, approved } = parseMode(argv);
  const candidates = await loadCandidates();
  const selectionHash = canonicalJsonSha256(
    candidates.map((row) => ({ slug: row.slug, platform: row.platform })),
  );
  const postings = candidates.reduce((sum, row) => sum + Number(row.postings), 0);

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    selectionHash,
    minPostings: ATS_NEVER_RELEVANT_MIN_POSTINGS,
    boards: candidates.length,
    postingsPerCycle: postings,
    postingsPerDay: Math.round(postings / 7),
    byPlatform: candidates.reduce<Record<string, number>>((acc, row) => {
      acc[row.platform] = (acc[row.platform] || 0) + 1;
      return acc;
    }, {}),
    byStatus: candidates.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {}),
    top: candidates.slice(0, 25).map((row) => ({
      platform: row.platform,
      slug: row.slug,
      status: row.status,
      postings: Number(row.postings),
      sampleLocations: row.sample_locations.filter(Boolean).slice(0, 3),
    })),
    effect: 'Excluded boards leave the rotation, including the parked/blacklisted recovery tier that '
      + 'still contacts them weekly, and their outstanding batches are retired. Every candidate has never '
      + 'produced a stored job, so no job row, score, or history is touched. Reversible: set status back '
      + 'to active and clear excludedReason.',
    writesPerformed: 0,
  }, null, 2));

  if (!apply) return;
  if (selectionHash !== approved) {
    throw new Error(`Selection hash mismatch: reviewed ${approved}; current ${selectionHash}. No writes attempted.`);
  }

  const now = new Date();
  let excludedBoards = 0;
  let retiredBatches = 0;
  const failures: Array<{ platform: string; slug: string; error: string }> = [];
  for (const row of candidates) {
    const reason = `never_relevant_geography: ${row.postings} posting(s) observed, none in territory or remote`;
    try {
      const result = await prisma.$transaction(async (transaction) => {
        // Only status and lastError: the lease columns are legacy authority and
        // the writer guard rejects them outright on a v2 batch.
        await transaction.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true)`;
        const batches = await transaction.atsIngestionBatch.updateMany({
          where: { slug: row.slug, platform: row.platform, status: { in: OUTSTANDING_BATCH_STATUSES } },
          data: { status: 'excluded', lastError: reason },
        });
        const boards = await transaction.atsCompany.updateMany({
          where: { slug: row.slug, platform: row.platform, status: { in: RETIRABLE_BOARD_STATUSES } },
          data: { status: 'excluded', excludedReason: reason, excludedAt: now },
        });
        return { boards: boards.count, batches: batches.count };
      });
      excludedBoards += result.boards;
      retiredBatches += result.batches;
    } catch (error) {
      failures.push({
        platform: row.platform,
        slug: row.slug,
        error: error instanceof Error ? error.message.split('\n')[0] : String(error),
      });
    }
  }
  console.log(JSON.stringify({
    mode: 'apply', version: VERSION, selectionHash, excludedBoards, retiredBatches,
    writeFailures: failures.length, writeFailureSample: failures.slice(0, 10),
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
