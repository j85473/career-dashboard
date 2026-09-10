/**
 * Retires board rows that are the same board written with different capitals.
 *
 * Discovery derives a slug from whatever URL it crawled, and providers publish
 * the same tenant under whatever capitalisation the linking page used. Nothing
 * normalises that, so the catalog holds 4,085 case-insensitive groups covering
 * 8,221 rows. Roughly 2,479 of those rows are active, which means about 4% of
 * every rotation is spent fetching a board the rotation already fetched -- and
 * both copies land on the same host at the same time. On 2026-09-10 two Lowe's
 * rows differing only in capitals took two of eight lanes for over two hours and
 * returned nothing, while 5,052 boards waited for a lane.
 *
 * WHY THIS CANNOT BE DONE PER PLATFORM
 *
 * The obvious rule -- "Workday is case-insensitive, so collapse every Workday
 * group" -- is wrong, and the evidence says where. Comparing the provider
 * posting ids each capitalisation actually returned:
 *
 *   workday          1,691 groups   1,371 near-identical    34 sharing nothing
 *   smartrecruiters    115 groups      94 near-identical     6 sharing nothing
 *   greenhouse          74 groups      63 near-identical     1 sharing nothing
 *   ashby              275 groups     145 near-identical    66 sharing nothing
 *
 * A quarter of Ashby's groups are two different companies whose names differ
 * only in capitals. Collapsing those by platform would silence a live board and
 * leave no trace of why its postings stopped arriving. So the evidence is read
 * per group, never per platform, and a group proves its own redundancy or is
 * left exactly as it is.
 *
 * WHAT IT TAKES TO RETIRE A ROW
 *
 * A row is retired only when every one of these holds:
 *   - another row in its group has synchronised at least once and is active,
 *   - this row returned at least one posting of its own, and
 *   - every posting it returned was also returned by that survivor, within the
 *     overlap floor below.
 *
 * That third condition is the whole safety argument: a row is removed because
 * it demonstrably adds nothing, not because a provider is assumed to ignore
 * capitals. A row that returned postings the survivor never saw is a different
 * board and is reported as such.
 *
 * WHAT IT DOES NOT DO
 *
 * No job, score, application, or history is touched, and nothing is deleted. A
 * retired row keeps every posting it ever contributed; it simply stops being
 * swept, exactly as any excluded board does. Rows that have never returned
 * anything are counted and reported but never retired here -- a board that is
 * merely dead is the pruning review's business, and mixing the two would let a
 * capitalisation rule quietly retire boards for a different reason.
 */
import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { prisma } from '../src/lib/prisma';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';

const VERSION = 'ats-case-duplicate-consolidation-v1';

/**
 * How much of a row's own catalogue the survivor must also have returned.
 *
 * Not 100%: two sweeps of one board days apart legitimately differ at the edges
 * as postings open and close, and demanding exactness would spare almost
 * nothing. Not 50%: two genuinely different tenants in the same industry can
 * share a surprising number of syndicated postings. At four fifths a row is
 * retired only when the survivor already carries nearly everything it has.
 */
export const CASE_DUPLICATE_OVERLAP_FLOOR = 0.8;

/** A row must have returned at least this many postings to be judged at all. */
export const CASE_DUPLICATE_MIN_EVIDENCE = 1;

type VariantRow = {
  slug: string;
  platform: string;
  status: string;
  jobsFound: number;
  lastCheckedAt: Date | null;
  lastSynchronizedAt: Date | null;
  postingCount: number;
};

type Verdict = 'retire' | 'survivor' | 'distinct' | 'barren' | 'unjudgeable';

type Judgement = {
  platform: string;
  key: string;
  slug: string;
  verdict: Verdict;
  survivorSlug: string | null;
  postings: number;
  sharedWithSurvivor: number;
  sharedShare: number;
};

function parseMode(argv: readonly string[]): { apply: boolean; approved: string } {
  const apply = argv.includes('--apply');
  const index = argv.indexOf('--approved-hash');
  return { apply, approved: index >= 0 ? String(argv[index + 1] || '') : '' };
}

/**
 * Every row that shares a platform and a case-folded slug with another row,
 * with the postings each one actually returned.
 *
 * Posting identity is the provider's own id rather than a URL: the URL is the
 * thing whose capitalisation is in question, so using it to decide a question
 * about capitalisation would assume the answer.
 */
async function loadGroups(): Promise<Map<string, VariantRow[]>> {
  const rows = await prisma.$queryRaw<Array<VariantRow & { key: string }>>`
    WITH groups AS (
      SELECT platform, lower(slug) AS key
        FROM "AtsCompany"
       GROUP BY 1, 2
      HAVING count(*) > 1
    )
    SELECT c.slug,
           c.platform,
           c.status,
           c."jobsFound",
           c."lastCheckedAt",
           c."lastSynchronizedAt",
           g.key,
           COALESCE(p.n, 0)::int AS "postingCount"
      FROM "AtsCompany" c
      JOIN groups g ON g.platform = c.platform AND g.key = lower(c.slug)
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT i."providerSourceId") AS n
          FROM "AtsIngestionBatch" b
          JOIN "AtsIngestionItem" i ON i."batchId" = b.id
         WHERE b.slug = c.slug
           AND b.platform = c.platform
           AND i."providerSourceId" IS NOT NULL
      ) p ON TRUE
     ORDER BY c.platform, g.key, c.slug
  `;
  const groups = new Map<string, VariantRow[]>();
  for (const row of rows) {
    const key = `${row.platform}\u0000${row.key}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return groups;
}

/** How many posting ids two rows returned in common. */
async function sharedPostings(
  platform: string,
  left: string,
  right: string,
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ shared: bigint | number }>>`
    WITH ids AS (
      SELECT b.slug, i."providerSourceId" AS pid
        FROM "AtsIngestionBatch" b
        JOIN "AtsIngestionItem" i ON i."batchId" = b.id
       WHERE b.platform = ${platform}
         AND b.slug IN (${left}, ${right})
         AND i."providerSourceId" IS NOT NULL
    )
    SELECT count(*)::bigint AS shared
      FROM (
        SELECT pid FROM ids WHERE slug = ${left}
        INTERSECT
        SELECT pid FROM ids WHERE slug = ${right}
      ) both_returned
  `;
  return Number(rows[0]?.shared || 0);
}

/**
 * The row a group keeps: the one with the strongest evidence of being the live
 * board. Ordered so that a proven sweep outranks a large stale catalogue, and
 * the final tiebreak is lexicographic so two runs over unchanged data always
 * choose the same row.
 */
function chooseSurvivor(variants: readonly VariantRow[]): VariantRow | null {
  const eligible = variants.filter(
    (variant) => variant.status === 'active' && variant.lastSynchronizedAt !== null,
  );
  if (eligible.length === 0) return null;
  return [...eligible].sort((left, right) => (
    (right.lastSynchronizedAt?.valueOf() || 0) - (left.lastSynchronizedAt?.valueOf() || 0)
    || right.postingCount - left.postingCount
    || (right.lastCheckedAt?.valueOf() || 0) - (left.lastCheckedAt?.valueOf() || 0)
    || left.slug.localeCompare(right.slug)
  ))[0];
}

async function judge(groups: Map<string, VariantRow[]>): Promise<Judgement[]> {
  const judgements: Judgement[] = [];
  for (const [key, variants] of groups) {
    const [platform, folded] = key.split('\u0000');
    const survivor = chooseSurvivor(variants);
    if (!survivor) {
      for (const variant of variants) {
        judgements.push({
          platform,
          key: folded,
          slug: variant.slug,
          verdict: 'unjudgeable',
          survivorSlug: null,
          postings: variant.postingCount,
          sharedWithSurvivor: 0,
          sharedShare: 0,
        });
      }
      continue;
    }
    for (const variant of variants) {
      if (variant.slug === survivor.slug) {
        judgements.push({
          platform,
          key: folded,
          slug: variant.slug,
          verdict: 'survivor',
          survivorSlug: survivor.slug,
          postings: variant.postingCount,
          sharedWithSurvivor: variant.postingCount,
          sharedShare: 1,
        });
        continue;
      }
      // A row that never returned a posting has proved nothing either way. It
      // may be a dead capitalisation or a board that was never given a fair
      // sweep, and this rule is not the one that can tell them apart.
      if (variant.postingCount < CASE_DUPLICATE_MIN_EVIDENCE) {
        judgements.push({
          platform,
          key: folded,
          slug: variant.slug,
          verdict: 'barren',
          survivorSlug: survivor.slug,
          postings: variant.postingCount,
          sharedWithSurvivor: 0,
          sharedShare: 0,
        });
        continue;
      }
      const shared = await sharedPostings(platform, variant.slug, survivor.slug);
      const share = shared / variant.postingCount;
      judgements.push({
        platform,
        key: folded,
        slug: variant.slug,
        verdict: share >= CASE_DUPLICATE_OVERLAP_FLOOR ? 'retire' : 'distinct',
        survivorSlug: survivor.slug,
        postings: variant.postingCount,
        sharedWithSurvivor: shared,
        sharedShare: Number(share.toFixed(3)),
      });
    }
  }
  return judgements;
}

function tally(judgements: readonly Judgement[], verdict: Verdict): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const judgement of judgements) {
    if (judgement.verdict !== verdict) continue;
    counts[judgement.platform] = (counts[judgement.platform] || 0) + 1;
  }
  return counts;
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { apply, approved } = parseMode(argv);
  const groups = await loadGroups();
  const judgements = await judge(groups);
  const retire = judgements.filter((judgement) => judgement.verdict === 'retire');
  const activeRetire = retire.length;
  const selectionHash = canonicalJsonSha256(
    retire.map((r) => ({ slug: r.slug, platform: r.platform, survivor: r.survivorSlug })),
  );

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    selectionHash,
    overlapFloor: CASE_DUPLICATE_OVERLAP_FLOOR,
    groupsScanned: groups.size,
    rowsScanned: judgements.length,
    retire: activeRetire,
    retireByPlatform: tally(retire, 'retire'),
    keptAsDistinctBoards: judgements.filter((j) => j.verdict === 'distinct').length,
    distinctByPlatform: tally(judgements, 'distinct'),
    neverReturnedAnything: judgements.filter((j) => j.verdict === 'barren').length,
    groupsWithNoLiveRow: judgements.filter((j) => j.verdict === 'unjudgeable').length,
    sampleRetirements: retire.slice(0, 25),
    sampleKeptAsDistinct: judgements.filter((j) => j.verdict === 'distinct').slice(0, 15),
    effect: 'A retired row stops being swept and nothing else. Every posting it ever '
      + 'contributed stays exactly where it is, and no job, score, application or '
      + 'history is read or written. Rows that returned postings the survivor never '
      + 'saw are treated as separate boards and left untouched.',
    writesPerformed: 0,
  }, null, 2));

  if (!apply) return;
  if (selectionHash !== approved) {
    throw new Error(
      `Selection hash mismatch: reviewed ${approved}; current ${selectionHash}. No writes were attempted.`,
    );
  }

  let retired = 0;
  for (const judgement of retire) {
    const result = await prisma.atsCompany.updateMany({
      where: { slug: judgement.slug, platform: judgement.platform },
      data: {
        status: 'excluded',
        excludedAt: new Date(),
        excludedReason: `Same board as ${judgement.survivorSlug} with different capitals; `
          + `${judgement.sharedWithSurvivor} of ${judgement.postings} postings also returned there (${VERSION}).`,
      },
    });
    retired += result.count;
  }
  console.log(JSON.stringify({ mode: 'apply', version: VERSION, retired }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error(
        `Case-duplicate consolidation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}

export { judge, loadGroups, chooseSurvivor, main };
