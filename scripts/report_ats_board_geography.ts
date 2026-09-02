import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { prisma } from '../src/lib/prisma';

const VERSION = 'ats-board-geography-report-v1';

/**
 * Which boards can never produce a job this catalog would keep.
 *
 * Read-only. This reports; it excludes nothing and writes nothing.
 *
 * The existing `out_of_territory` exclusion arm judges boards on *stored* Job
 * rows attributed back by URL. That arm is blind to exactly the boards asked
 * about here: a hospital in Mumbai fails the ingestion geography gate, so none
 * of its postings ever become Job rows, so the board shows zero attributed
 * postings and `classifyBoardForExclusion` declines it as "never been judged".
 * The board then sits in the rotation forever, fetched weekly, producing
 * nothing, and invisible to the tool built to find boards producing nothing.
 *
 * The raw listing payloads are the way around that. Every posting the pipeline
 * ever fetched is retained in `AtsIngestionItem.rawJson`, whether or not it
 * survived the gate, so a board's hiring geography can be read from what it
 * actually published rather than from what got through.
 *
 * The location cascade below mirrors `isLocationMatch` in jobIngestion.ts,
 * which is the function that decides what is kept, field for field. It must
 * keep mirroring it: a report that reads a field the live gate ignores will
 * call a board relevant that the pipeline throws away, and one that ignores a
 * field the gate reads will nominate a live board for retirement.
 */

type BoardRow = {
  platform: string;
  slug: string;
  status: string;
  postings: bigint;
  matched: bigint;
  unreadable: bigint;
  sample_locations: string[];
};

/**
 * `locationString` as jobIngestion.ts builds it, in the same precedence order.
 * `mn` and the 554/551 ZIP prefixes are substring tests there, so they stay
 * substring tests here: a stray match makes a board look relevant and keeps it
 * in the rotation, which is the safe direction for a report feeding exclusion.
 */
const LOCATION_SQL = `
  lower(coalesce(
    -- Only when location is genuinely a string. Postgres' ->> renders an object
    -- as its JSON text, so a bare ->>'location' on Greenhouse's
    -- {"id":4551234,"name":"Paris"} yields the whole literal -- and that text
    -- carries the id, whose digits can contain the 554/551 ZIP prefixes and
    -- score a Minnesota match for a board in Paris.
    nullif(case when jsonb_typeof(i."rawJson"->'location') = 'string'
      then i."rawJson"->>'location' end, ''),
    nullif(i."rawJson"->'location'->>'name', ''),
    nullif(trim(concat_ws(' ',
      i."rawJson"->'location'->>'city',
      i."rawJson"->'location'->>'region')), ''),
    nullif(i."rawJson"->'categories'->>'location', ''),
    nullif(i."rawJson"->'workLocation'->>'label', ''),
    nullif(i."rawJson"->>'locationsText', ''),
    nullif(trim(concat_ws(' ',
      i."rawJson"->>'city',
      i."rawJson"->>'state',
      i."rawJson"->>'country')), ''),
    ''
  ))`;

/**
 * Remote evidence, from title and workplace-type only.
 *
 * jobIngestion.ts also scans the description, which lives in a separate and
 * much larger column. Reading it for every posting would pull the whole catalog
 * across the wire from the Pi. Leaving it out can only *understate* how remote
 * a board is, so a board this report calls out-of-territory might still be kept
 * by the live gate on description evidence -- again the safe direction.
 */
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

async function main(argv: string[]): Promise<void> {
  const minPostings = Number(argv[0] || 25);
  if (!Number.isFinite(minPostings) || minPostings < 1) {
    throw new Error('Usage: report_ats_board_geography.ts [minPostings]');
  }

  const rows = await prisma.$queryRawUnsafe<BoardRow[]>(`
    with per_board as (
      select
        b."platform",
        b."slug",
        count(*) as postings,
        count(*) filter (where ${MATCH_SQL}) as matched,
        count(*) filter (where ${LOCATION_SQL} = '') as unreadable,
        (array_agg(distinct ${LOCATION_SQL}))[1:5] as sample_locations
      from "AtsIngestionItem" i
      join "AtsIngestionBatch" b on b.id = i."batchId"
      where i."rawJson" is not null
      group by 1, 2
    )
    select p.*, c."status"
    from per_board p
    join "AtsCompany" c on c."slug" = p."slug" and c."platform" = p."platform"
    where p.postings >= ${minPostings}
      and p.matched = 0
      and c."status" <> 'excluded'
    order by p.postings desc
  `);

  // A board whose locations are all unreadable has not been judged -- it may
  // hire in Minneapolis and simply publish in a shape the cascade cannot see.
  // That is a parsing gap, not a fact about the employer, so the two are
  // reported apart and only the legible group is offered as exclusion evidence.
  const legible = rows.filter((row) => Number(row.unreadable) < Number(row.postings));
  const unreadable = rows.filter((row) => Number(row.unreadable) === Number(row.postings));

  const summarize = (list: BoardRow[]) => list.reduce<Record<string, number>>((acc, row) => {
    acc[row.platform] = (acc[row.platform] || 0) + 1;
    return acc;
  }, {});

  console.log(JSON.stringify({
    version: VERSION,
    generatedAt: new Date().toISOString(),
    minPostings,
    neverRelevantBoards: legible.length,
    neverRelevantPostingsPerCycle: legible.reduce((sum, row) => sum + Number(row.postings), 0),
    byPlatform: summarize(legible),
    unreadableLocationBoards: unreadable.length,
    unreadableByPlatform: summarize(unreadable),
    topNeverRelevant: legible.slice(0, 40).map((row) => ({
      platform: row.platform,
      slug: row.slug,
      status: row.status,
      postings: Number(row.postings),
      sampleLocations: row.sample_locations.filter(Boolean).slice(0, 3),
    })),
    caveat: 'Remote evidence here reads title and workplace-type only, not the description, so a board '
      + 'listed as never-relevant may still be kept by the live gate on description evidence. This report '
      + 'writes nothing.',
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
