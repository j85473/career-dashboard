import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildAtsBoardRequest } from '../src/lib/atsAcquisition';
import {
  classifyBoardForAbsence,
  type BoardAbsenceEvidence,
} from '../src/lib/atsBoardExclusionPolicy';
import { prisma } from '../src/lib/prisma';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';

const VERSION = 'ats-board-absence-exclusion-v1';
const OUTSTANDING_BATCH_STATUSES = ['fetching', 'partial', 'synchronized'];
const RETIRABLE_BOARD_STATUSES = ['active', 'parked', 'blacklisted'];

type Candidate = {
  slug: string;
  platform: string;
  boardStatus: string;
  historicalNotFound: number;
  historicalOffHostRedirect: number;
  liveStatus: number | null;
  liveRedirectedOffHost: boolean;
  liveError: string | null;
};

/**
 * Boards the ledger has ever seen return 404, from both engines.
 *
 * The v2 receipt tables only reach back to 2026-08-27, so the legacy attempt
 * table is unioned in rather than treated as superseded -- it is the only
 * record of anything older, and "every board that will never respond" cannot be
 * answered from six days of receipts alone.
 */
async function loadCandidates(): Promise<{ candidates: Candidate[]; scanned: number }> {
  const rows = await prisma.$queryRaw<Array<{
    slug: string; platform: string; status: string;
    historical_not_found: bigint; historical_off_host: bigint;
  }>>`
    with v2_404 as (
      select b."slug", b."platform", count(*) n
      from "AtsAcquisitionWorkReceipt" w
      join "AtsIngestionBatch" b on b.id = w."batchId"
      where w.error = 'HTTP 404'
      group by 1, 2
    ),
    legacy_404 as (
      select "slug", "platform", count(*) n
      from "AtsBoardCheckAttempt"
      where "httpStatus" = 404
      group by 1, 2
    ),
    not_found as (
      select slug, platform, sum(n) n from (
        select * from v2_404 union all select * from legacy_404
      ) x group by 1, 2
    ),
    -- A vendor that answers a closed account with its own marketing page
    -- instead of a 404. The acquisition path already distinguishes this from a
    -- platform schema change and records it per board.
    off_host as (
      select b."slug", b."platform", count(*) n
      from "AtsAcquisitionWorkReceipt" w
      join "AtsIngestionBatch" b on b.id = w."batchId"
      where w.error like '%instead of the expected payload format'
      group by 1, 2
    ),
    absent_evidence as (
      select coalesce(nf.slug, oh."slug") slug,
             coalesce(nf.platform, oh."platform") platform,
             coalesce(nf.n, 0) not_found_n,
             coalesce(oh.n, 0) off_host_n
      from not_found nf
      full outer join off_host oh
        on oh."slug" = nf.slug and oh."platform" = nf.platform
    ),
    -- Keep-signals. Any one of these ends the board's candidacy outright.
    ever_yielded as (
      select distinct "slug", "platform" from "AtsIngestionBatch" where "jobCount" > 0
    ),
    ever_2xx as (
      select distinct "slug", "platform" from "AtsBoardCheckAttempt"
      where "httpStatus" between 200 and 299
    ),
    ever_inserted as (
      select distinct b."slug", b."platform"
      from "AtsIngestionSegment" s
      join "AtsIngestionBatch" b on b.id = s."batchId"
      where s."insertedCount" > 0
    )
    select c."slug", c."platform", c."status",
           nf.not_found_n as historical_not_found, nf.off_host_n as historical_off_host
    from absent_evidence nf
    join "AtsCompany" c on c."slug" = nf.slug and c."platform" = nf.platform
    left join ever_yielded y on y."slug" = nf.slug and y."platform" = nf.platform
    left join ever_2xx g on g."slug" = nf.slug and g."platform" = nf.platform
    left join ever_inserted i on i."slug" = nf.slug and i."platform" = nf.platform
    where y."slug" is null and g."slug" is null and i."slug" is null
      and c."status" = any(${RETIRABLE_BOARD_STATUSES})
    order by c."platform", c."slug"
  `;
  return {
    candidates: rows.map((row) => ({
      slug: row.slug,
      platform: row.platform,
      boardStatus: row.status,
      historicalNotFound: Number(row.historical_not_found),
      historicalOffHostRedirect: Number(row.historical_off_host),
      liveStatus: null,
      liveRedirectedOffHost: false,
      liveError: null,
    })),
    scanned: rows.length,
  };
}

/**
 * Re-contact every candidate now.
 *
 * A historical 404 is not enough on its own: most of these boards were
 * contacted once, and the arm refuses to retire a board on a single stale
 * failure. A check that does not complete leaves `liveStatus` null, which the
 * policy treats as unconfirmed rather than as absence.
 */
async function verifyLive(candidates: Candidate[], concurrency: number): Promise<void> {
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= candidates.length) return;
      const candidate = candidates[index];
      try {
        // The pipeline's own request builder, so a board is judged on exactly
        // the endpoint acquisition calls -- including Workday's POST body.
        const { url, init } = buildAtsBoardRequest(candidate);
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
        candidate.liveStatus = response.status;
        // `response.url` is the address the redirect chain settled on. A board
        // whose own subdomain no longer exists lands on the vendor's own site,
        // which is the absence signal; a board still answering at its own
        // hostname is reachable whatever it chose to serve there.
        candidate.liveRedirectedOffHost = new URL(response.url).host !== new URL(url).host;
      } catch (error) {
        candidate.liveError = error instanceof Error ? error.message : String(error);
      }
      done++;
      if (done % 250 === 0) console.error(`  verified ${done}/${candidates.length}`);
    }
  });
  await Promise.all(workers);
}

function parseMode(argv: string[]): {
  apply: boolean; approved: string | null; concurrency: number; limit: number | null; hashOnly: boolean;
} {
  const rest = [...argv];
  const hashOnly = rest.includes('--hash-only');
  if (hashOnly) rest.splice(rest.indexOf('--hash-only'), 1);
  let concurrency = 8;
  const concurrencyIndex = rest.indexOf('--concurrency');
  if (concurrencyIndex >= 0) {
    concurrency = Number(rest[concurrencyIndex + 1]);
    if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error('--concurrency must be between 1 and 16');
    }
    rest.splice(concurrencyIndex, 2);
  }
  // Smoke-test escape hatch. A limited run can never apply: it would retire the
  // arbitrary prefix of the catalog it happened to look at.
  let limit: number | null = null;
  const limitIndex = rest.indexOf('--limit');
  if (limitIndex >= 0) {
    limit = Number(rest[limitIndex + 1]);
    if (!Number.isFinite(limit) || limit < 1) throw new Error('--limit must be a positive integer');
    rest.splice(limitIndex, 2);
  }
  if (rest.length === 0) return { apply: false, approved: null, concurrency, limit, hashOnly };
  if (rest.length !== 3 || rest[0] !== '--apply' || rest[1] !== '--selection-hash' || !rest[2]) {
    throw new Error(
      'Usage: exclude_absent_ats_boards.ts [--concurrency N] [--limit N] '
      + '[--apply --selection-hash <reviewed-dry-run-hash>]',
    );
  }
  if (limit !== null) throw new Error('--limit cannot be combined with --apply');
  if (hashOnly) throw new Error('--hash-only cannot be combined with --apply');
  return { apply: true, approved: rest[2], concurrency, limit, hashOnly };
}

async function main(argv: string[]): Promise<void> {
  const { apply, approved, concurrency, limit, hashOnly } = parseMode(argv);
  const loaded = await loadCandidates();
  const scanned = loaded.scanned;
  const candidates = limit === null ? loaded.candidates : loaded.candidates.slice(0, limit);

  // The selection hash covers the candidate population only, so it can be read
  // off without contacting a single board. This is the cheap way to confirm the
  // reviewed set has not shifted before authorising an apply.
  if (hashOnly) {
    console.log(JSON.stringify({
      mode: 'hash-only',
      version: VERSION,
      candidatesScanned: scanned,
      selectionHash: canonicalJsonSha256(
        candidates.map((candidate) => ({ slug: candidate.slug, platform: candidate.platform })),
      ),
    }, null, 2));
    return;
  }

  console.error(`Re-contacting ${candidates.length} candidate board(s) at concurrency ${concurrency}...`);
  await verifyLive(candidates, concurrency);

  const judged = candidates.map((candidate) => {
    const evidence: BoardAbsenceEvidence = {
      historicalNotFound: candidate.historicalNotFound,
      historicalOffHostRedirect: candidate.historicalOffHostRedirect,
      everResponded2xx: false,
      everYieldedJobs: false,
      jobsInserted: 0,
      liveStatus: candidate.liveStatus,
      liveRedirectedOffHost: candidate.liveRedirectedOffHost,
    };
    return { candidate, verdict: classifyBoardForAbsence(evidence) };
  });
  const confirmed = judged.filter((row) => row.verdict.exclude);
  const declined = judged.filter((row) => !row.verdict.exclude);

  // The hash pins the candidate *population* -- the set the operator reviewed --
  // and deliberately not the live results. Live statuses move between runs: a
  // rate limit or a provider blip changes them without changing what was
  // approved, and hashing them would make apply refuse almost every time while
  // proving nothing. Per-board freshness is not this hash's job; the live
  // re-check inside the apply pass is, and it runs again on every board it
  // writes. So the hash answers "is this still the same set of boards?" and the
  // live check answers "is this particular board still absent right now?"
  const selectionHash = canonicalJsonSha256(
    candidates.map((candidate) => ({ slug: candidate.slug, platform: candidate.platform })),
  );

  const byPlatform: Record<string, number> = {};
  for (const row of confirmed) {
    byPlatform[row.candidate.platform] = (byPlatform[row.candidate.platform] || 0) + 1;
  }
  const declinedReasons: Record<string, number> = {};
  for (const row of declined) {
    const key = row.candidate.liveRedirectedOffHost
      ? 'live redirect off-host'
      : row.candidate.liveStatus === null
      ? `live check failed: ${row.candidate.liveError || 'unknown'}`.slice(0, 80)
      : `live HTTP ${row.candidate.liveStatus}`;
    declinedReasons[key] = (declinedReasons[key] || 0) + 1;
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    selectionHash,
    candidatesScanned: scanned,
    confirmedAbsent: confirmed.length,
    declined: declined.length,
    declinedReasons,
    byPlatform,
    byPriorStatus: confirmed.reduce<Record<string, number>>((acc, row) => {
      acc[row.candidate.boardStatus] = (acc[row.candidate.boardStatus] || 0) + 1;
      return acc;
    }, {}),
    sample: confirmed.slice(0, 20).map((row) => ({
      platform: row.candidate.platform,
      slug: row.candidate.slug,
      priorStatus: row.candidate.boardStatus,
      historicalNotFound: row.candidate.historicalNotFound,
      historicalOffHostRedirect: row.candidate.historicalOffHostRedirect,
      liveStatus: row.candidate.liveStatus,
      liveRedirectedOffHost: row.candidate.liveRedirectedOffHost,
    })),
    // Every board the arm refused, in full. A board declined for a rate limit is
    // unverified rather than alive, and stays a candidate for a slower pass; a
    // board declined for a 2xx is a genuine save and should be read closely.
    declinedBoards: declined.map((row) => ({
      platform: row.candidate.platform,
      slug: row.candidate.slug,
      priorStatus: row.candidate.boardStatus,
      historicalNotFound: row.candidate.historicalNotFound,
      historicalOffHostRedirect: row.candidate.historicalOffHostRedirect,
      liveStatus: row.candidate.liveStatus,
      liveRedirectedOffHost: row.candidate.liveRedirectedOffHost,
      liveError: row.candidate.liveError,
      reason: row.verdict.reason,
    })),
    effect: 'Confirmed-absent boards move to status=excluded and leave the rotation, including the '
      + 'parked/blacklisted recovery tier that still contacts them weekly. Their outstanding batches are '
      + 'retired so an in-flight continuation cannot keep contacting a retired board. Every candidate has '
      + 'zero stored jobs by construction, so no job row, score, or history is touched. Reversible: set '
      + 'status back to active and clear excludedReason.',
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
  let retiredBatches = 0;
  const writeFailures: Array<{ platform: string; slug: string; error: string }> = [];
  for (const row of confirmed) {
    const { candidate, verdict } = row;
    if (!verdict.exclude) continue;
    try {
    const result = await prisma.$transaction(async (transaction) => {
      // `AtsIngestionBatch_legacy_writer_guard` splits batch columns into two
      // classes. Lease and payload fields -- nextProcessAt, leaseToken,
      // leaseOwner, heartbeatAt, leaseExpiresAt -- are legacy authority and are
      // rejected outright on a v2 batch, with no capability that grants them.
      // Only status/lastError are v2 lifecycle, and only with the writer
      // capability set below. So the retirement is exactly that pair: clearing
      // the lease alongside it is what the guard exists to stop.
      //
      // Leaving a stale lease is safe. `claimNextAtsV2Continuation` selects on
      // status in (fetching, partial, synchronized, reset_draining), so an
      // excluded batch is no longer claimable whatever its lease columns say.
      await transaction.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true)`;
      const batches = await transaction.atsIngestionBatch.updateMany({
        where: {
          slug: candidate.slug,
          platform: candidate.platform,
          status: { in: OUTSTANDING_BATCH_STATUSES },
        },
        data: {
          status: 'excluded',
          lastError: verdict.reason,
        },
      });
      const boards = await transaction.atsCompany.updateMany({
        where: {
          slug: candidate.slug,
          platform: candidate.platform,
          status: { in: RETIRABLE_BOARD_STATUSES },
        },
        data: {
          status: 'excluded',
          excludedReason: `${verdict.basis}: ${verdict.reason}`,
          excludedAt: now,
        },
      });
      return { boards: boards.count, batches: batches.count };
    });
      excludedBoards += result.boards;
      retiredBatches += result.batches;
    } catch (error) {
      // One board's write failing is not a reason to abandon the other 5,000.
      // Each board is its own transaction, so a failure here leaves that board
      // untouched and every earlier board committed; re-running picks up the
      // remainder, because an excluded board drops out of the candidate query.
      writeFailures.push({
        platform: candidate.platform,
        slug: candidate.slug,
        error: error instanceof Error ? error.message.split('\n')[0] : String(error),
      });
    }
  }
  console.log(JSON.stringify({
    mode: 'apply',
    version: VERSION,
    selectionHash,
    excludedBoards,
    retiredBatches,
    writeFailures: writeFailures.length,
    writeFailureSample: writeFailures.slice(0, 10),
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
