import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { buildEmployerRuleIndex, employerAliasKey, resolveEmployer } from '../src/lib/employerIdentity';
import {
  applyDirectMatchEnrichment,
  isDirectPostingUrl,
  findStoredAtsPostings,
  isAggregatorSource,
  planDirectMatchEnrichment,
  resolveDirectAtsPostingFromCatalogue,
  type BoardPosting,
} from '../src/lib/atsDirectMatch';
import { rotatingCandidateIds } from '../src/lib/himalayasBrowserResolver';
import { canonicalRecoveryCheckpoint, selectCanonicalRecoveryIds } from '../src/lib/canonicalRecoverySelection';
import { recoverAggregatorSource, sourceRecoveryCache, type SourceRecoveryResult } from '../src/lib/aggregatorSourceRecovery';
import { isPermanentAtsBoardRetirement, recordDiscoveredAtsBoard } from '../src/lib/atsBoardDiscovery';
import { EMPLOYER_CATALOGUE_TIMEOUT_MS } from '../src/lib/employerBoardPostings';

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

type Options = { apply: boolean; linksOnly: boolean; activeOnly: boolean; storedOnly: boolean; limit: number | null; maxJobs?: number;
  jobId?: string; company?: string; cursorPath?: string; reportPath?: string };

function parseArguments(argv: string[]): Options {
  const options: Options = { apply: false, linksOnly: false, activeOnly: false, storedOnly: false, limit: null };
  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--links-only') options.linksOnly = true;
    else if (argument === '--active-only') options.activeOnly = true;
    else if (argument === '--stored-only') options.storedOnly = true;
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
    else if (argument.startsWith('--report-path=')) {
      options.reportPath = argument.slice('--report-path='.length).trim();
      if (!options.reportPath) throw new Error('--report-path requires a nonempty path');
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
      throw new Error('Usage: resolve_aggregator_ats_matches.ts [--apply] [--links-only] [--active-only] [--stored-only] [--limit=N] [--max-jobs=N] [--job-id=UUID] [--company=NAME] [--cursor-path=PATH] [--report-path=PATH]');
    }
  }
  if (options.maxJobs && options.limit !== null) throw new Error('Choose either --max-jobs or the company --limit');
  return options;
}

async function retainSourceDiscovery(company: string, recovery: SourceRecoveryResult, apply: boolean): Promise<boolean> {
  if (!recovery.discoveries || !recovery.match || !recovery.website) return true;
  for (const discovery of recovery.discoveries) {
    const registered = await prisma.atsCompany.findMany({ where: { platform: discovery.board.platform,
      slug: { equals: discovery.board.slug, mode: 'insensitive' } }, select: { status: true, excludedReason: true } });
    const retired = registered.some(isPermanentAtsBoardRetirement);
    if (retired && discovery.postings.some(posting => posting.url === recovery.match!.url)) return false;
    if (!apply || retired || !discovery.matchCount) continue;
    const persisted = await prisma.$transaction(async tx => {
      if (await recordDiscoveredAtsBoard(tx, discovery.board, new Date(), {
        jobsFound: discovery.postings.length, reactivateExisting: false,
      }) === 'retired') return false;
      const employerKey = `source:${employerAliasKey(company)}`;
      const data = { companyName: company, officialWebsite: recovery.website!, evidenceUrl: discovery.evidenceUrl,
        discoverySource: 'aggregator_source_official_site', verifiedAt: new Date() };
      await tx.employerAtsBoard.upsert({ where: { employerKey_slug_platform: { employerKey, ...discovery.board } },
        create: { employerKey, ...discovery.board, ...data }, update: data });
      return true;
    });
    if (!persisted && discovery.postings.some(posting => posting.url === recovery.match!.url)) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const { apply, linksOnly, activeOnly, storedOnly, limit, maxJobs, jobId, company, cursorPath, reportPath } = parseArguments(process.argv.slice(2));
  const rules = await prisma.companyNameRule.findMany();
  const index = buildEmployerRuleIndex(rules);
  const companyKey = (name: string) => employerAliasKey(resolveEmployer({ company: name }, index));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — resolving aggregator listings to direct ATS postings`);
  if (linksOnly) console.log('  --links-only: apply links only, descriptions left untouched.');

  const jobs = await prisma.job.findMany({
    where: { NOT: { source: { startsWith: 'ATS-' } }, source: { not: null }, userCanonicalUrl: null,
      ...(jobId ? { id: jobId } : {}),
      ...(activeOnly ? { status: { in: ['inbox', 'pending_af', 'bookmarked', 'applied', 'interviewing'] } } : {}),
    },
    select: {
      id: true, title: true, company: true, location: true, url: true,
      canonicalUrl: true, description: true, source: true, status: true, updatedAt: true,
    },
    orderBy: { id: 'asc' },
  });

  const candidates = jobs.filter((job) =>
    isAggregatorSource(job.source)
    && job.title?.trim()
    && job.company?.trim()
    && (!company || companyKey(job.company) === companyKey(company))
    // Already pointing at a board posting: nothing to resolve.
    && !isDirectPostingUrl(job.url));

  const byCompany = new Map<string, typeof candidates>();
  for (const job of candidates) {
    const key = companyKey(job.company || '');
    if (!key) continue;
    const bucket = byCompany.get(key);
    if (bucket) bucket.push(job);
    else byCompany.set(key, [job]);
  }

  console.log(`  unresolved aggregator listings: ${candidates.length.toLocaleString()}`);
  console.log(`  distinct companies:             ${byCompany.size.toLocaleString()}`);
  if (storedOnly) console.log('  Stored catalogue only; no network requests.');

  let boardsKnown = 0;
  const liveCache = new Map<string, Promise<BoardPosting[] | null>>();
  const sourceCache = sourceRecoveryCache();
  const outcomes: Record<string, number> = {};
  const attempts: Array<{ jobId: string; company: string; source: string | null; outcome: string;
    fromUrl?: string | null; toUrl?: string; applied?: boolean; error?: string; catalogueOutcome?: string }> = [];
  let matchedStored = 0;
  let matchedLive = 0;
  let written = 0;
  let refused = 0;
  let failedCompanies = 0;
  const rows: string[] = [];

  const companyKeys = [...byCompany.keys()];
  let cursor = 0;
  let afterId: string | null = null;
  if (cursorPath) {
    try {
      const saved = JSON.parse(await readFile(cursorPath, 'utf8'));
      cursor = Number(saved.nextOffset) || 0;
      afterId = typeof saved.afterId === 'string' ? saved.afterId : null;
    } catch { /* first pass */ }
  }
  // A stable ID boundary survives arrivals and successful repairs removing
  // earlier rows. An offset over a shrinking list skipped unresolved cards.
  const rotation = maxJobs
    ? selectCanonicalRecoveryIds(candidates.map(job => job.id), afterId, maxJobs)
    : { ...rotatingCandidateIds(companyKeys, cursor, limit ?? companyKeys.length), afterId: null };
  const selectedIds = maxJobs ? new Set(rotation.ids) : null;
  const keyById = new Map(candidates.map(job => [job.id, companyKey(job.company)]));
  const selectedKeys = maxJobs ? [...new Set(rotation.ids.map(id => keyById.get(id)!))] : rotation.ids;
  const attemptedIds = new Set<string>();
  const saveCursor = async (value: object) => {
    if (!apply || !cursorPath) return;
    await writeFile(`${cursorPath}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(`${cursorPath}.tmp`, cursorPath);
  };
  console.log(`  selected listings:              ${maxJobs ? rotation.ids.length : selectedKeys.reduce((sum, key) => sum + byCompany.get(key)!.length, 0)}`);
  for (const key of selectedKeys) {
    const group = byCompany.get(key)!.filter(job => !selectedIds || selectedIds.has(job.id));

    // Advance the attempt boundary before potentially slow provider/database
    // work. A terminated process retries unresolved rows on its next rotation,
    // rather than pinning every later job behind the same employer forever.
    if (maxJobs) {
      for (const job of group) attemptedIds.add(job.id);
      await saveCursor({ afterId: canonicalRecoveryCheckpoint(rotation.ids, attemptedIds) });
    }

    try {

      const catalogue = await findStoredAtsPostings(group[0].company, prisma, group, { linksOnly });
      if (catalogue.boards.length) boardsKnown += 1;
      if (storedOnly && !catalogue.boards.length && catalogue.postings.length === 0) {
        for (const job of group) attempts.push({ jobId: job.id, company: job.company, source: job.source,
          outcome: 'no_stored_match_or_known_board' });
        continue;
      }

      for (const job of group) {
        const attempt = { jobId: job.id, company: job.company, source: job.source, outcome: 'lookup_inconclusive',
          fromUrl: job.url } as (typeof attempts)[number];
        attempts.push(attempt);
        let match = await resolveDirectAtsPostingFromCatalogue(job, catalogue, {
          store: prisma, allowLivePing: !storedOnly, timeoutMs: EMPLOYER_CATALOGUE_TIMEOUT_MS, liveCache,
          onOutcome: outcome => { attempt.outcome = outcome; },
        });
        if (!match && !storedOnly) {
          attempt.catalogueOutcome = attempt.outcome;
          const recovery = await recoverAggregatorSource({ ...job,
            company: resolveEmployer({ company: job.company }, index) }, { cache: sourceCache, competingPostings: catalogue.postings });
          attempt.outcome = recovery.outcome;
          if (recovery.match && await retainSourceDiscovery(job.company, recovery, apply)) match = recovery.match;
          else if (recovery.match) attempt.outcome = 'discovered_board_retired';
        }
        if (!match) continue;
        const via = match.matchedVia;
        if (via === 'stored') matchedStored += 1;
        else matchedLive += 1;

        const plan = planDirectMatchEnrichment(job, {
          ...match,
          description: linksOnly ? null : match.description,
        });
        if (!plan) continue;
        attempt.toUrl = plan.url;

        rows.push(
          `    ${job.status.padEnd(12)}${String(job.source).slice(0, 10).padEnd(12)}`
          + `${String(job.title).slice(0, 34).padEnd(36)}${String(job.company).slice(0, 18).padEnd(20)}`
          + `${via}${plan.description ? `  +${plan.description.length - String(job.description || '').length} chars` : ''}`,
        );
        rows.push(`        ${plan.url}`);

        if (apply) {
          const ok = await applyDirectMatchEnrichment(job.id, job.updatedAt, plan, prisma);
          attempt.applied = ok;
          if (ok) written += 1;
          else refused += 1;
        }
      }
    } catch (error: unknown) {
      failedCompanies += 1;
      for (const job of group.filter(job => !attempts.some(attempt => attempt.jobId === job.id))) {
        attempts.push({ jobId: job.id, company: job.company, source: job.source, outcome: 'lookup_inconclusive',
          error: error instanceof Error ? error.message : String(error) });
      }
      console.error(`Employer lookup deferred for ${group[0].company}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await saveCursor(maxJobs ? { afterId: rotation.afterId } : { nextOffset: 'nextCursor' in rotation ? rotation.nextCursor : 0 });
  for (const attempt of attempts) outcomes[attempt.outcome] = (outcomes[attempt.outcome] || 0) + 1;

  console.log(`  companies whose board we can identify: ${boardsKnown.toLocaleString()}`);
  console.log(`  live employer lookups:                 ${liveCache.size.toLocaleString()}`);
  console.log(`  matched from stored ATS postings:      ${matchedStored.toLocaleString()}`);
  console.log(`  matched from live employer/source:     ${matchedLive.toLocaleString()}\n`);
  if (failedCompanies) console.log(`  employer lookups deferred to the next rotation: ${failedCompanies}`);
  console.log(`  outcomes: ${JSON.stringify(outcomes)}`);
  const destination = reportPath || (apply && cursorPath ? `${cursorPath}.report.json` : null);
  if (destination) {
    await writeFile(`${destination}.tmp`, `${JSON.stringify({ startedAt, finishedAt: new Date(), apply,
      storedOnly, linksOnly, unresolved: candidates.length, outcomes, written, refused, attempts }, null, 2)}\n`, { mode: 0o600 });
    await rename(`${destination}.tmp`, destination);
    console.log(`  recovery report saved: ${destination}`);
  }

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
