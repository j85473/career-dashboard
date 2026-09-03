import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ATS_OFF_HOST_RATE_LIMIT_MIN_REFUSALS,
  classifyBoardForOffHostRateLimit,
  type BoardOffHostRateLimitEvidence,
} from '../src/lib/atsBoardExclusionPolicy';
import { ATS_OFF_HOST_RATE_LIMIT_PLATFORMS } from '../src/lib/atsUtils';
import { prisma } from '../src/lib/prisma';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';

const VERSION = 'ats-board-offhost-rate-limit-exclusion-v1';
const OUTSTANDING_BATCH_STATUSES = ['fetching', 'partial', 'synchronized'];
const RETIRABLE_BOARD_STATUSES = ['active', 'parked', 'blacklisted'];

/**
 * Retire boards a vendor answers from its own site under HTTP 429.
 *
 * The sibling arm, `exclude_absent_ats_boards`, re-contacts every board before
 * retiring it and is the stronger design. It cannot be used here: a live check
 * returns the same 429 these boards have always returned, so it would confirm
 * nothing the history does not already say. What separates a phantom board
 * from a throttled one is not the status code but where the answer came from,
 * and the acquisition path threw on the status before recording the address.
 *
 * That gap is closed going forward -- an off-host 429 now records as
 * `AtsBoardOffHostError` and the ordinary absence arm will see it. This script
 * exists for the boards already in the ledger, whose only history is the
 * mislabelled refusal.
 *
 * Safety rests entirely on the keep-signals, since there is no live check: one
 * successful response, one non-empty batch, or one stored job anywhere in the
 * board's recorded life ends its candidacy.
 */
type Candidate = {
  slug: string;
  platform: string;
  boardStatus: string;
  rateLimitRefusals: number;
  discoveredAt: Date;
  lastRespondedAt: Date | null;
};

async function loadCandidates(): Promise<{ candidates: Candidate[]; scanned: number }> {
  const platforms = [...ATS_OFF_HOST_RATE_LIMIT_PLATFORMS];
  const rows = await prisma.$queryRaw<Array<{
    slug: string; platform: string; status: string; refusals: bigint;
    discovered_at: Date; last_responded_at: Date | null;
  }>>`
    with refused as (
      select b."slug", b."platform", count(*) n
      from "AtsAcquisitionWorkReceipt" w
      join "AtsIngestionBatch" b on b.id = w."batchId"
      where w.error like '%rate-limited this request'
        and b."platform" = any(${platforms})
      group by 1, 2
    ),
    -- Keep-signals. Any one of these ends the board's candidacy outright, and
    -- each looks across the board's whole history rather than a recent window.
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
    select c."slug", c."platform", c."status", r.n as refusals,
           c."discoveredAt" as discovered_at, c."lastRespondedAt" as last_responded_at
    from refused r
    join "AtsCompany" c on c."slug" = r."slug" and c."platform" = r."platform"
    left join ever_yielded y on y."slug" = r."slug" and y."platform" = r."platform"
    left join ever_2xx g on g."slug" = r."slug" and g."platform" = r."platform"
    left join ever_inserted i on i."slug" = r."slug" and i."platform" = r."platform"
    where y."slug" is null and g."slug" is null and i."slug" is null
      -- The board's own response clock is a keep-signal in its own right. A
      -- board that ever answered is not one the vendor disowns, whatever the
      -- attempt tables retained.
      and c."lastRespondedAt" is null
      and c."status" = any(${RETIRABLE_BOARD_STATUSES})
    order by c."platform", c."slug"
  `;
  return {
    candidates: rows.map((row) => ({
      slug: row.slug,
      platform: row.platform,
      boardStatus: row.status,
      rateLimitRefusals: Number(row.refusals),
      discoveredAt: row.discovered_at,
      lastRespondedAt: row.last_responded_at,
    })),
    scanned: rows.length,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const apply = argv.includes('--apply');
  const hashOnly = argv.includes('--selection-hash');
  const approvedIndex = argv.indexOf('--approved-hash');
  const approved = approvedIndex >= 0 ? argv[approvedIndex + 1] : '';
  // Lowering this is a deliberate act on a population the operator has probed,
  // so it is a flag rather than a quietly relaxed constant: the run's own
  // output records which threshold produced the writes, beside the default.
  const minimumIndex = argv.indexOf('--min-refusals');
  const minimumRefusals = minimumIndex >= 0
    ? Math.max(1, Number.parseInt(argv[minimumIndex + 1], 10) || ATS_OFF_HOST_RATE_LIMIT_MIN_REFUSALS)
    : ATS_OFF_HOST_RATE_LIMIT_MIN_REFUSALS;

  const { candidates, scanned } = await loadCandidates();
  const selectionHash = canonicalJsonSha256(
    candidates.map((candidate) => ({ slug: candidate.slug, platform: candidate.platform })),
  );

  if (hashOnly) {
    console.log(JSON.stringify({
      mode: 'hash-only', version: VERSION, candidatesScanned: scanned, selectionHash,
    }, null, 2));
    return;
  }

  const judged = candidates.map((candidate) => {
    const evidence: BoardOffHostRateLimitEvidence = {
      platform: candidate.platform,
      rateLimitRefusals: candidate.rateLimitRefusals,
      // False by construction: the candidate query excludes every board with a
      // 2xx, a non-empty batch, a stored job, or any recorded response at all.
      everResponded2xx: false,
      everYieldedJobs: false,
      jobsInserted: 0,
    };
    return { candidate, verdict: classifyBoardForOffHostRateLimit(evidence, minimumRefusals) };
  });
  const confirmed = judged.filter((row) => row.verdict.exclude);
  const declined = judged.filter((row) => !row.verdict.exclude);

  const declinedReasons: Record<string, number> = {};
  for (const row of declined) {
    declinedReasons[row.verdict.reason] = (declinedReasons[row.verdict.reason] || 0) + 1;
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    selectionHash,
    minimumRefusals,
    minimumRefusalsDefault: ATS_OFF_HOST_RATE_LIMIT_MIN_REFUSALS,
    candidatesScanned: scanned,
    confirmedDisowned: confirmed.length,
    declined: declined.length,
    declinedReasons,
    byPriorStatus: confirmed.reduce<Record<string, number>>((acc, row) => {
      acc[row.candidate.boardStatus] = (acc[row.candidate.boardStatus] || 0) + 1;
      return acc;
    }, {}),
    refusalSpread: confirmed.reduce<Record<string, number>>((acc, row) => {
      const key = String(row.candidate.rateLimitRefusals);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    sample: confirmed.slice(0, 25).map((row) => ({
      platform: row.candidate.platform,
      slug: row.candidate.slug,
      priorStatus: row.candidate.boardStatus,
      refusals: row.candidate.rateLimitRefusals,
      discoveredAt: row.candidate.discoveredAt,
    })),
    declinedBoards: declined.slice(0, 50).map((row) => ({
      platform: row.candidate.platform,
      slug: row.candidate.slug,
      refusals: row.candidate.rateLimitRefusals,
      reason: row.verdict.reason,
    })),
    effect: 'Confirmed boards move to status=excluded and leave the rotation, including the parked '
      + 'recovery tier that still contacts them. Their outstanding batches are retired so an in-flight '
      + 'continuation cannot keep contacting a retired board. Every candidate has never responded and has '
      + 'zero stored jobs by construction, so no job row, score, or history is touched. Reversible by hand: '
      + 'set status back to active and clear excludedReason.',
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
        // Only status and lastError are v2 lifecycle columns, and only with the
        // writer capability set here. Lease and payload columns are legacy
        // authority and the database guard rejects them on a v2 batch outright.
        // A stale lease left behind is safe: an excluded batch is no longer
        // selectable by the continuation claim whatever its lease columns say.
        await transaction.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true)`;
        const batches = await transaction.atsIngestionBatch.updateMany({
          where: {
            slug: candidate.slug,
            platform: candidate.platform,
            status: { in: OUTSTANDING_BATCH_STATUSES },
          },
          data: { status: 'excluded', lastError: verdict.reason },
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
      // One board's write failing is not a reason to abandon the rest. Each
      // board is its own transaction, so a failure leaves that board untouched
      // and every earlier board committed; re-running picks up the remainder,
      // because an excluded board drops out of the candidate query.
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
if (invokedPath === import.meta.url) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
