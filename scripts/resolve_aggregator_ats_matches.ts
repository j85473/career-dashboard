import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { normalizeCompany } from '../src/lib/jobIngestion';
import {
  applyDirectMatchEnrichment,
  atsBoardRequest,
  boardIdentityFromUrl,
  findStoredAtsPostings,
  isAggregatorSource,
  parseBoardPostings,
  planDirectMatchEnrichment,
  selectDirectAtsMatch,
  type BoardIdentity,
  type BoardPosting,
} from '../src/lib/atsDirectMatch';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';

/**
 * Points existing aggregator listings at the employer's own ATS posting.
 *
 * Karbon's "Customer Success Manager - Mid Market" was applied to through a
 * jobicy.com link while the requisition sat on a Greenhouse board already in
 * `AtsCompany`. This is the retroactive half of the resolution now wired into
 * ingestion.
 *
 * Work is grouped by company so a board is fetched at most once no matter how
 * many of its listings arrived through aggregators.
 *
 * **Scores are never touched.** Only `url`, `canonicalUrl` and — when the
 * employer's copy is genuinely fuller — `description` are written, with a
 * direct field update rather than the job PATCH route, because that route
 * treats a changed description as a scoring input and would invalidate existing
 * score events. A job that is already scored keeps its score.
 *
 * Dry run by default; `--apply` writes.
 */

type Options = { apply: boolean; linksOnly: boolean; limit: number | null };

function parseArguments(argv: string[]): Options {
  const options: Options = { apply: false, linksOnly: false, limit: null };
  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--links-only') options.linksOnly = true;
    else if (argument.startsWith('--limit=')) {
      const value = Number(argument.slice('--limit='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid --limit: ${argument}`);
      options.limit = value;
    } else {
      throw new Error('Usage: resolve_aggregator_ats_matches.ts [--apply] [--links-only] [--limit=N]');
    }
  }
  return options;
}

const BOARD_TIMEOUT_MS = 15_000;

async function fetchBoard(board: BoardIdentity): Promise<BoardPosting[]> {
  const request = atsBoardRequest(board.platform, board.slug);
  if (!request) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOARD_TIMEOUT_MS);
  try {
    const response = await safeExternalFetch(request.url, { ...request.init, signal: controller.signal });
    if (!response.ok) return [];
    if (!/json/i.test(response.headers.get('content-type') || '')) return [];
    return parseBoardPostings(board.platform, await response.json(), board.slug);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const { apply, linksOnly, limit } = parseArguments(process.argv.slice(2));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — resolving aggregator listings to direct ATS postings`);
  if (linksOnly) console.log('  --links-only: apply links only, descriptions left untouched.');

  const jobs = await prisma.job.findMany({
    where: { NOT: { source: { startsWith: 'ATS-' } }, source: { not: null } },
    select: {
      id: true, title: true, company: true, location: true, url: true,
      canonicalUrl: true, description: true, source: true, status: true, updatedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const candidates = jobs.filter((job) =>
    isAggregatorSource(job.source)
    && job.title?.trim()
    && job.company?.trim()
    // Already pointing at a board posting: nothing to resolve.
    && !boardIdentityFromUrl(job.canonicalUrl || job.url));

  const byCompany = new Map<string, typeof candidates>();
  for (const job of candidates) {
    const key = normalizeCompany(job.company || '');
    if (!key) continue;
    const bucket = byCompany.get(key);
    if (bucket) bucket.push(job);
    else byCompany.set(key, [job]);
  }

  // Nine in ten aggregator companies have no ATS posting stored at all, and a
  // per-company lookup for each of them is the bulk of the runtime. One grouped
  // read up front turns 8,902 queries into a set membership test.
  const atsCompanies = await prisma.job.findMany({
    where: { source: { startsWith: 'ATS-' } },
    select: { company: true },
    distinct: ['company'],
  });
  const haveAtsPostings = new Set(
    atsCompanies.map((row) => normalizeCompany(row.company || '')).filter(Boolean),
  );

  console.log(`  aggregator listings not already pointing at a board: ${candidates.length.toLocaleString()}`);
  console.log(`  distinct companies:                                  ${byCompany.size.toLocaleString()}`);
  const reachable = [...byCompany.keys()].filter((key) => haveAtsPostings.has(key)).length;
  console.log(`  ...of which we hold ATS postings for:                ${reachable.toLocaleString()}\n`);

  let boardsKnown = 0;
  let boardsFetched = 0;
  let matchedStored = 0;
  let matchedLive = 0;
  let written = 0;
  let refused = 0;
  const rows: string[] = [];

  let processed = 0;
  for (const [key, group] of byCompany) {
    if (!haveAtsPostings.has(key)) continue;
    if (limit !== null && processed >= limit) break;
    processed += 1;

    const { postings: stored, board } = await findStoredAtsPostings(group[0].company, prisma);
    if (!board) continue;
    boardsKnown += 1;

    // One live fetch per board, and only when a stored posting did not already
    // answer for every listing this company has.
    let live: BoardPosting[] | null = null;
    for (const job of group) {
      let match = selectDirectAtsMatch(job, stored);
      let via: 'stored' | 'live' = 'stored';
      if (!match) {
        if (live === null) {
          live = await fetchBoard(board);
          boardsFetched += 1;
        }
        match = selectDirectAtsMatch(job, live);
        via = 'live';
      }
      if (!match) continue;
      if (via === 'stored') matchedStored += 1;
      else matchedLive += 1;

      const plan = planDirectMatchEnrichment(job, {
        url: match.url,
        description: linksOnly ? null : match.description,
        platform: board.platform,
        slug: board.slug,
        matchedVia: via,
        postingTitle: match.title,
        postingLocation: match.location,
      });
      if (!plan) continue;

      rows.push(
        `    ${job.status.padEnd(12)}${String(job.source).slice(0, 10).padEnd(12)}`
        + `${String(job.title).slice(0, 34).padEnd(36)}${String(job.company).slice(0, 18).padEnd(20)}`
        + `${via}${plan.description ? `  +${plan.description.length - String(job.description || '').length} chars` : ''}`,
      );
      rows.push(`        ${plan.url}`);

      if (apply) {
        const ok = await applyDirectMatchEnrichment(job.id, job.updatedAt, plan, prisma);
        if (ok) written += 1;
        else refused += 1;
      }
    }
  }

  console.log(`  companies whose board we can identify: ${boardsKnown.toLocaleString()}`);
  console.log(`  boards pinged live:                    ${boardsFetched.toLocaleString()}`);
  console.log(`  matched from stored ATS postings:      ${matchedStored.toLocaleString()}`);
  console.log(`  matched from a live board ping:        ${matchedLive.toLocaleString()}\n`);

  if (rows.length === 0) {
    console.log('    (nothing to resolve)');
    return;
  }
  console.log('  resolutions:');
  for (const row of rows.slice(0, 120)) console.log(row);
  if (rows.length > 120) console.log(`    ... and ${(rows.length - 120) / 2} more`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write these apply links. Scores are never altered.');
    return;
  }
  console.log(`\nEnriched ${written.toLocaleString()} listing(s).`);
  if (refused > 0) console.log(`Refused after the concurrency guard: ${refused.toLocaleString()}`);
}

main()
  .catch((error: unknown) => {
    console.error(`Aggregator ATS resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
