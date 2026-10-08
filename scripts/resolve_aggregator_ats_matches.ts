import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { buildEmployerRuleIndex, employerAliasKey, resolveEmployer } from '../src/lib/employerIdentity';
import {
  applyDirectMatchEnrichment,
  boardIdentityFromUrl,
  findStoredAtsPostings,
  isAggregatorSource,
  fetchBoardPostings,
  planDirectMatchEnrichment,
  selectDirectAtsMatch,
  type BoardPosting,
} from '../src/lib/atsDirectMatch';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';
import { rotatingCandidateIds } from '../src/lib/himalayasBrowserResolver';

/**
 * Points existing aggregator listings at the employer's own ATS posting.
 *
 * Karbon's "Customer Success Manager - Mid Market" was applied to through a
 * jobicy.com link while the requisition sat on a Greenhouse board already in
 * `AtsCompany`. This is the retroactive half of the resolution now wired into
 * ingestion.
 *
 * Work is grouped by employer. Feeds are shared within a group; Eightfold
 * title searches are shared for listings bearing the same source title.
 *
 * **Scores are never touched.** Only `url`, `canonicalUrl` and — when the
 * employer's copy is genuinely fuller — `description` are written, with a
 * direct field update rather than the job PATCH route, because that route
 * treats a changed description as a scoring input and would invalidate existing
 * score events. A job that is already scored keeps its score.
 *
 * Dry run by default; `--apply` writes.
 */

type Options = { apply: boolean; linksOnly: boolean; activeOnly: boolean; limit: number | null; maxJobs?: number;
  jobId?: string; company?: string; cursorPath?: string };

function parseArguments(argv: string[]): Options {
  const options: Options = { apply: false, linksOnly: false, activeOnly: false, limit: null };
  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--links-only') options.linksOnly = true;
    else if (argument === '--active-only') options.activeOnly = true;
    else if (argument.startsWith('--job-id=')) {
      options.jobId = argument.slice('--job-id='.length);
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(options.jobId)) throw new Error('--job-id must be a UUID');
    }
    else if (argument.startsWith('--company=')) {
      options.company = argument.slice('--company='.length).trim();
      if (!options.company) throw new Error('--company requires a nonempty employer name');
    }
    else if (argument.startsWith('--cursor-path=')) {
      options.cursorPath = argument.slice('--cursor-path='.length).trim();
      if (!options.cursorPath) throw new Error('--cursor-path requires a nonempty path');
    }
    else if (argument.startsWith('--max-jobs=')) {
      const value = Number(argument.slice('--max-jobs='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid --max-jobs: ${argument}`);
      options.maxJobs = value;
    }
    else if (argument.startsWith('--limit=')) {
      const value = Number(argument.slice('--limit='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid --limit: ${argument}`);
      options.limit = value;
    } else {
      throw new Error('Usage: resolve_aggregator_ats_matches.ts [--apply] [--links-only] [--active-only] [--limit=N] [--max-jobs=N] [--job-id=UUID] [--company=NAME] [--cursor-path=PATH]');
    }
  }
  if (options.maxJobs && options.limit !== null) throw new Error('Choose either --max-jobs or the company --limit');
  return options;
}

const BOARD_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const { apply, linksOnly, activeOnly, limit, maxJobs, jobId, company, cursorPath } = parseArguments(process.argv.slice(2));
  const rules = await prisma.companyNameRule.findMany();
  const index = buildEmployerRuleIndex(rules);
  const companyKey = (name: string) => employerAliasKey(resolveEmployer({ company: name }, index));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — resolving aggregator listings to direct ATS postings`);
  if (linksOnly) console.log('  --links-only: apply links only, descriptions left untouched.');

  const jobs = await prisma.job.findMany({
    where: { NOT: { source: { startsWith: 'ATS-' } }, source: { not: null },
      ...(jobId ? { id: jobId } : {}),
      ...(activeOnly ? { status: { in: ['inbox', 'pending_af', 'needs_jd', 'applied', 'interviewing'] } } : {}),
    },
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
    && (!company || companyKey(job.company) === companyKey(company))
    // Already pointing at a board posting: nothing to resolve.
    && !boardIdentityFromUrl(job.canonicalUrl || job.url));

  const byCompany = new Map<string, typeof candidates>();
  for (const job of candidates) {
    const key = companyKey(job.company || '');
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
    select: { company: true, employer: true },
    distinct: ['company', 'employer'],
  });
  const haveAtsPostings = new Set(
    atsCompanies.map((row) => companyKey(row.employer || row.company || '')).filter(Boolean),
  );
  for (const rule of rules) {
    if (rule.matchType === 'ats_board_employer' && rule.origin === 'verified_ats_source') haveAtsPostings.add(companyKey(rule.standardName));
  }

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

  const reachableKeys = [...byCompany.keys()].filter(key => haveAtsPostings.has(key));
  let cursor = 0;
  if (cursorPath) {
    try { cursor = Number(JSON.parse(await readFile(cursorPath, 'utf8')).nextOffset) || 0; } catch { /* first pass */ }
  }
  const rotation = rotatingCandidateIds(maxJobs ? candidates.filter(job => haveAtsPostings.has(companyKey(job.company))).map(job => job.id)
    : reachableKeys, cursor, maxJobs ?? limit ?? reachableKeys.length);
  const selectedIds = maxJobs ? new Set(rotation.ids) : null;
  const selectedKeys = maxJobs ? reachableKeys.filter(key => byCompany.get(key)!.some(job => selectedIds!.has(job.id))) : rotation.ids;
  for (const key of selectedKeys) {
    const group = byCompany.get(key)!.filter(job => !selectedIds || selectedIds.has(job.id));

    const { postings: stored, board } = await findStoredAtsPostings(group[0].company, prisma);
    if (!board && stored.length === 0) continue;
    boardsKnown += 1;

    // Ask a known board only for jobs missing from the stored catalogue.
    const liveByTitle = new Map<string, BoardPosting[]>();
    for (const job of group) {
      let match = selectDirectAtsMatch(job, stored);
      let via: 'stored' | 'live' = 'stored';
      if (!match) {
        if (!board) continue;
        const liveKey = board.platform === 'eightfold' ? job.title : '*';
        let live = liveByTitle.get(liveKey);
        if (!live) {
          live = await fetchBoardPostings(board, safeExternalFetch, BOARD_TIMEOUT_MS,
            { title: job.title, company: resolveEmployer({ company: job.company }, index) });
          liveByTitle.set(liveKey, live);
          boardsFetched += 1;
        }
        match = selectDirectAtsMatch(job, live);
        via = 'live';
      }
      if (!match) continue;
      if (via === 'stored') matchedStored += 1;
      else matchedLive += 1;

      const identity = boardIdentityFromUrl(match.url) || board;
      const plan = planDirectMatchEnrichment(job, {
        url: match.url,
        description: linksOnly ? null : match.description,
        platform: identity?.platform || 'unknown',
        slug: identity?.slug || '',
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

  if (apply && cursorPath) {
    await writeFile(`${cursorPath}.tmp`, `${JSON.stringify({ nextOffset: rotation.nextCursor })}\n`, { mode: 0o600 });
    await rename(`${cursorPath}.tmp`, cursorPath);
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
