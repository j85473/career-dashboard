/**
 * The board-liveness arm of the weekly pruning review.
 *
 * Every other arm judges evidence already in the database. This one is the
 * exception the review used to exclude: it contacts each demoted board once and
 * decides from what the board says today. That is why the tier grew to 46,170
 * boards -- larger than the active catalog -- before anyone noticed. A counter
 * said those boards had failed; nothing had asked them lately whether they were
 * still there, and 25% of them turned out to be answering normally.
 *
 * Two arms, deliberately asymmetric.
 *
 * PROMOTE is reversible and simply runs. A board returning a listing that
 * carries at least one posting is neither absent nor failing, so it goes back to
 * `active` with its counters cleared. If it stops answering, the ordinary path
 * demotes it again. A board answering with a valid but *empty* listing is left
 * alone: alive, but nothing to collect, and promoting it would only crowd the
 * rotation.
 *
 * RETIRE is permanent and never re-judged, so it carries every brake below.
 *
 * The probe runs OUT OF BAND: it builds requests with the pipeline's own URL
 * builder but takes no provider reservation and consults no circuit. A weekly
 * sweep must never be able to trip a breaker that stops real acquisition.
 */
import 'dotenv/config';

import {
  ATS_ABSENCE_LIVE_STATUSES,
  classifyBoardForAbsence,
  type BoardAbsenceEvidence,
} from '../src/lib/atsBoardExclusionPolicy';
import { buildAtsBoardRequest, parseAtsListingPayload } from '../src/lib/atsAcquisition';
import { prisma } from '../src/lib/prisma';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';

const VERSION = 'ats-board-liveness-v1';
const DEMOTED_STATUSES = ['parked', 'blacklisted'];
const OUTSTANDING_BATCH_STATUSES = ['fetching', 'partial', 'synchronized'];

/**
 * A run where providers were throttling is a run whose evidence must not retire
 * anything: a refusal we caused is not proof a board is gone.
 */
export const LIVENESS_MAX_INCONCLUSIVE_SHARE = 0.15;
/**
 * The share-shift brake, and the reason it is a share and not a count.
 *
 * On 2026-09-02 a classifier that only accepted JSON marked 925 healthy Personio
 * boards as walled -- Personio serves XML. The tell was not the number. It was
 * that one platform held 93% of a bucket while holding about 11% of the swept
 * population. A flat "retire no more than N per run" cap would have passed those
 * 925 without a murmur on a 28,000-board run.
 */
export const LIVENESS_MAX_PLATFORM_SHARE_FACTOR = 3;

type Candidate = {
  slug: string;
  platform: string;
  boardStatus: string;
  historicalNotFound: number;
  historicalOffHostRedirect: number;
  everResponded2xx: boolean;
  everYieldedJobs: boolean;
  jobsInserted: number;
  liveStatus: number | null;
  liveRedirectedOffHost: boolean;
  outcome: string;
  postings: number | null;
};

/** Mirrors `responseMatchesPlatform`: Personio answers in XML, everything else in JSON. */
function payloadMatchesPlatform(platform: string, contentType: string): boolean {
  return platform === 'personio' ? /xml/i.test(contentType) : /json/i.test(contentType);
}

const INCONCLUSIVE = new Set(['rate_limited', 'unreachable', 'timeout', 'server_error']);
const ABSENT = new Set(['not_found', 'gone_offhost', 'wall_own_host']);

export function classifyLivenessOutcome(input: {
  platform: string;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
}): string {
  if (input.status === 429) return 'rate_limited';
  if (ATS_ABSENCE_LIVE_STATUSES.includes(input.status as 404 | 410)) return 'not_found';
  let offHost = false;
  try { offHost = new URL(input.finalUrl).host !== new URL(input.requestedUrl).host; } catch { offHost = false; }
  // A board that left its own address is gone. A board still answering at its
  // own address has not been shown to be absent, whatever it chose to serve.
  if (offHost) return 'gone_offhost';
  if (input.status >= 500) return 'server_error';
  if (input.status >= 400) return `http_${input.status}`;
  if (payloadMatchesPlatform(input.platform, input.contentType)) return 'alive';
  return 'wall_own_host';
}

/** Interleave platforms so no provider sees a long contiguous burst. */
export function interleaveByPlatform<T extends { platform: string }>(rows: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    if (!groups.has(row.platform)) groups.set(row.platform, []);
    groups.get(row.platform)!.push(row);
  }
  const lists = [...groups.values()];
  const out: T[] = [];
  for (let index = 0; ; index++) {
    let added = false;
    for (const list of lists) if (index < list.length) { out.push(list[index]); added = true; }
    if (!added) break;
  }
  return out;
}

export type LivenessBrake = { blocked: false } | { blocked: true; reason: string };

export function checkLivenessBrakes(input: {
  sweptByPlatform: Record<string, number>;
  retiringByPlatform: Record<string, number>;
  swept: number;
  inconclusive: number;
}): LivenessBrake {
  if (input.swept === 0) return { blocked: true, reason: 'nothing was swept' };
  const inconclusiveShare = input.inconclusive / input.swept;
  if (inconclusiveShare > LIVENESS_MAX_INCONCLUSIVE_SHARE) {
    return {
      blocked: true,
      reason: `${(inconclusiveShare * 100).toFixed(1)}% of the sweep was inconclusive `
        + `(rate limited, unreachable or erroring); a throttled run is not evidence of absence`,
    };
  }
  const retiring = Object.values(input.retiringByPlatform).reduce((sum, n) => sum + n, 0);
  if (retiring === 0) return { blocked: false };
  for (const [platform, count] of Object.entries(input.retiringByPlatform)) {
    const swept = input.sweptByPlatform[platform] || 0;
    if (swept === 0) continue;
    const retireShare = count / retiring;
    const populationShare = swept / input.swept;
    if (retireShare > populationShare * LIVENESS_MAX_PLATFORM_SHARE_FACTOR) {
      return {
        blocked: true,
        reason: `${platform} is ${(retireShare * 100).toFixed(1)}% of the proposed retirements `
          + `but only ${(populationShare * 100).toFixed(1)}% of the swept boards; one platform `
          + 'dominating this way has meant a broken classifier every time, not a dead platform',
      };
    }
  }
  return { blocked: false };
}

async function loadDemoted(): Promise<Candidate[]> {
  const rows = await prisma.$queryRaw<Array<{
    slug: string; platform: string; status: string;
    historical_not_found: bigint; historical_off_host: bigint;
    ever_2xx: boolean; ever_yielded: boolean; jobs_inserted: bigint;
  }>>`
    with not_found as (
      select b."slug", b."platform", count(*) n
      from "AtsAcquisitionWorkReceipt" w
      join "AtsIngestionBatch" b on b.id = w."batchId"
      where w.error = 'HTTP 404'
      group by 1, 2
    ),
    off_host as (
      select b."slug", b."platform", count(*) n
      from "AtsAcquisitionWorkReceipt" w
      join "AtsIngestionBatch" b on b.id = w."batchId"
      where w.error like '%instead of the expected payload format'
      group by 1, 2
    ),
    ever_yielded as (
      select distinct "slug", "platform" from "AtsIngestionBatch" where "jobCount" > 0
    ),
    ever_2xx as (
      select distinct "slug", "platform" from "AtsBoardCheckAttempt"
      where "httpStatus" between 200 and 299
    ),
    inserted as (
      select b."slug", b."platform", sum(s."insertedCount") n
      from "AtsIngestionSegment" s
      join "AtsIngestionBatch" b on b.id = s."batchId"
      group by 1, 2
    )
    select c."slug", c."platform", c."status",
           coalesce(nf.n, 0) as historical_not_found,
           coalesce(oh.n, 0) as historical_off_host,
           (g."slug" is not null) as ever_2xx,
           (y."slug" is not null) as ever_yielded,
           coalesce(i.n, 0) as jobs_inserted
    from "AtsCompany" c
    left join not_found nf on nf.slug = c."slug" and nf.platform = c."platform"
    left join off_host oh on oh."slug" = c."slug" and oh."platform" = c."platform"
    left join ever_yielded y on y."slug" = c."slug" and y."platform" = c."platform"
    left join ever_2xx g on g."slug" = c."slug" and g."platform" = c."platform"
    left join inserted i on i."slug" = c."slug" and i."platform" = c."platform"
    where c."status" = any(${DEMOTED_STATUSES})
    order by c."platform", c."slug"
  `;
  return rows.map((row) => ({
    slug: row.slug,
    platform: row.platform,
    boardStatus: row.status,
    historicalNotFound: Number(row.historical_not_found),
    historicalOffHostRedirect: Number(row.historical_off_host),
    everResponded2xx: row.ever_2xx,
    everYieldedJobs: row.ever_yielded,
    jobsInserted: Number(row.jobs_inserted),
    liveStatus: null,
    liveRedirectedOffHost: false,
    outcome: 'unprobed',
    postings: null,
  }));
}

async function probe(candidates: Candidate[], concurrency: number): Promise<void> {
  const queue = interleaveByPlatform(candidates);
  const backoffUntil = new Map<string, number>();
  const pending = new Set<number>(queue.map((_unused, index) => index));
  let done = 0;
  /**
   * Take the next board whose provider is not backing off, rather than waiting
   * on the one that happens to be next. Sleeping in place stalled a sweep at
   * 2,000 of 9,220 boards: every worker ended up parked on one throttled
   * provider's cooldown while eleven other providers sat idle.
   */
  const takeNext = (): number | null => {
    const now = Date.now();
    let soonest: number | null = null;
    for (const index of pending) {
      const until = backoffUntil.get(queue[index].platform) || 0;
      if (until <= now) { pending.delete(index); return index; }
      soonest = soonest === null ? until : Math.min(soonest, until);
    }
    return null;
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      let index = takeNext();
      while (index === null) {
        if (pending.size === 0) return;
        // Everything left is cooling down; wait the shortest cooldown, not a
        // fixed minute, and re-check.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        index = takeNext();
      }
      const candidate = queue[index];
      try {
        // The pipeline's own request builder, and deliberately nothing else from
        // the acquisition path: no reservation, no circuit, no receipt.
        const { url, init } = buildAtsBoardRequest(candidate);
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
        candidate.liveStatus = response.status;
        candidate.outcome = classifyLivenessOutcome({
          platform: candidate.platform,
          requestedUrl: url,
          finalUrl: response.url,
          status: response.status,
          contentType: response.headers.get('content-type') || '',
        });
        try {
          candidate.liveRedirectedOffHost = new URL(response.url).host !== new URL(url).host;
        } catch { candidate.liveRedirectedOffHost = false; }
        if (candidate.outcome === 'alive') {
          const text = await response.text();
          const parsed = candidate.platform === 'personio' ? {} : JSON.parse(text) as unknown;
          candidate.postings = parseAtsListingPayload(candidate.platform, parsed, text).jobs.length;
        } else {
          await response.body?.cancel();
        }
        if (response.status === 429) backoffUntil.set(candidate.platform, Date.now() + 60_000);
      } catch (error) {
        candidate.outcome = /timeout|abort/i.test(String(error)) ? 'timeout' : 'unreachable';
      }
      if (++done % 1000 === 0) console.error(`  probed ${done}/${queue.length}`);
    }
  }));
}

function absenceEvidence(candidate: Candidate): BoardAbsenceEvidence {
  return {
    historicalNotFound: candidate.historicalNotFound,
    historicalOffHostRedirect: candidate.historicalOffHostRedirect,
    everResponded2xx: candidate.everResponded2xx,
    everYieldedJobs: candidate.everYieldedJobs,
    jobsInserted: candidate.jobsInserted,
    liveStatus: candidate.liveStatus,
    liveRedirectedOffHost: candidate.liveRedirectedOffHost,
  };
}

function parseMode(argv: string[]): { apply: boolean; approved: string | null; concurrency: number } {
  const rest = [...argv];
  // `--auto` is the weekly run. The probe is the expensive part and the hash
  // exists to pin a list a *human* reviewed, so re-probing 10,000 boards purely
  // to reproduce a hash nobody read would double the outbound traffic for
  // nothing. The brakes, not the hash, are what stand between this mode and a
  // bad retirement.
  const auto = rest.indexOf('--auto');
  if (auto >= 0) rest.splice(auto, 1);
  let concurrency = 16;
  const flag = rest.indexOf('--concurrency');
  if (flag >= 0) {
    concurrency = Number.parseInt(rest[flag + 1] || '', 10);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error('--concurrency must be between 1 and 32');
    }
    rest.splice(flag, 2);
  }
  if (auto >= 0) {
    if (rest.length > 0) throw new Error('--auto takes no other arguments besides --concurrency');
    return { apply: true, approved: null, concurrency };
  }
  if (rest.length === 0) return { apply: false, approved: null, concurrency };
  if (rest.length !== 3 || rest[0] !== '--apply' || rest[1] !== '--selection-hash' || !rest[2]) {
    throw new Error('Usage: refresh_ats_board_liveness.ts [--concurrency N] '
      + '[--apply --selection-hash <reviewed-dry-run-hash>]');
  }
  return { apply: true, approved: rest[2], concurrency };
}

async function main(argv: string[]): Promise<void> {
  const { apply, approved, concurrency } = parseMode(argv);
  const candidates = await loadDemoted();
  // The hash pins the population that was reviewed, not the live results: a
  // provider blip moves statuses between runs without changing what was approved.
  const selectionHash = canonicalJsonSha256(
    candidates.map((c) => ({ slug: c.slug, platform: c.platform })),
  );
  if (apply && approved !== null && approved !== selectionHash) {
    throw new Error(`Selection hash mismatch: reviewed ${approved}, current ${selectionHash}. `
      + 'Re-read the dry run before applying.');
  }

  console.error(`probing ${candidates.length} demoted board(s) at concurrency ${concurrency}...`);
  await probe(candidates, concurrency);

  const promote = candidates.filter((c) => c.outcome === 'alive' && (c.postings || 0) > 0);
  const aliveButEmpty = candidates.filter((c) => c.outcome === 'alive' && (c.postings || 0) === 0);
  const retire = candidates.filter(
    (c) => ABSENT.has(c.outcome) && classifyBoardForAbsence(absenceEvidence(c)).exclude,
  );
  const inconclusive = candidates.filter((c) => INCONCLUSIVE.has(c.outcome));

  const tally = (rows: Candidate[]) => rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.platform] = (acc[row.platform] || 0) + 1;
    return acc;
  }, {});
  const brake = checkLivenessBrakes({
    sweptByPlatform: tally(candidates),
    retiringByPlatform: tally(retire),
    swept: candidates.length,
    inconclusive: inconclusive.length,
  });

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    version: VERSION,
    selectionHash,
    swept: candidates.length,
    alive: promote.length + aliveButEmpty.length,
    promotable: promote.length,
    aliveButEmpty: aliveButEmpty.length,
    inconclusive: inconclusive.length,
    retirable: retire.length,
    retirementBlocked: brake.blocked ? brake.reason : null,
    retirableByPlatform: tally(retire),
    effect: 'Boards answering with at least one posting return to the rotation, which is '
      + 'reversible. Boards confirmed absent are excluded permanently; every one has no '
      + 'successful listing, no job and no inserted row, so no job, score or history is touched.',
  };

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    await prisma.$disconnect();
    return;
  }

  let promoted = 0;
  for (const board of promote) {
    await prisma.atsCompany.update({
      where: { slug_platform: { slug: board.slug, platform: board.platform } },
      data: { status: 'active', failCount: 0, retryCount: 0, nextCheckDate: new Date() },
    });
    promoted++;
  }

  let excluded = 0;
  let retiredBatches = 0;
  const failures: Array<{ platform: string; slug: string; error: string }> = [];
  if (!brake.blocked) {
    const stamp = new Date().toISOString().slice(0, 10);
    for (const board of retire) {
      const reason = board.outcome === 'wall_own_host'
        ? `listing behind a login on the ${stamp} liveness sweep; an internal board we cannot read`
        : `endpoint absent on the ${stamp} liveness sweep (${board.outcome}); never produced a job`;
      try {
        // One transaction per board, so a failure leaves that board untouched
        // and every earlier one committed.
        retiredBatches += await prisma.$transaction(async (transaction) => {
          // The database refuses a v2 batch lifecycle write from a client that
          // has not declared the writer capability, and without this the batch
          // update takes the board update down with it.
          await transaction.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true)`;
          await transaction.atsCompany.update({
            where: { slug_platform: { slug: board.slug, platform: board.platform } },
            data: { status: 'excluded', excludedAt: new Date(), excludedReason: reason },
          });
          // A continuation works from the batch, not the board, so an
          // outstanding batch would keep contacting a board we just retired.
          const result = await transaction.atsIngestionBatch.updateMany({
            where: {
              slug: board.slug,
              platform: board.platform,
              status: { in: OUTSTANDING_BATCH_STATUSES },
            },
            data: { status: 'excluded', lastError: reason },
          });
          return result.count;
        });
        excluded++;
      } catch (error) {
        failures.push({
          platform: board.platform,
          slug: board.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  console.log(JSON.stringify({
    ...report,
    promoted,
    excluded,
    retiredBatches,
    writeFailures: failures.length,
    writeFailureSample: failures.slice(0, 5),
  }, null, 2));
  // A timer run has no one reading stderr, so a partial failure must be loud.
  if (failures.length > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

if (process.argv[1]?.endsWith('refresh_ats_board_liveness.ts')) {
  void main(process.argv.slice(2));
}
