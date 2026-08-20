import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { scrapeAtsApi } from '../src/lib/atsApi';
import { generateV4Fingerprint } from '../src/lib/jobIngestion';

/**
 * Recovers a locatable value for Workday rows stuck at the "<N> Locations"
 * placeholder by reading `jobPostingInfo.location` and
 * `jobPostingInfo.additionalLocations` from Workday's authoritative CXS
 * detail response. The old URL parser remains the ingestion fallback when a
 * detail request is unavailable, but it cannot enumerate every site and is
 * therefore not sufficient for this long-term backfill.
 *
 * Scoped to live rows only (not archived/dismissed/expired). Those statuses
 * are excluded from both sides of duplicate suppression and from scoring, so
 * fixing their location changes nothing anyone reads — it would just be
 * 7,483 writes against a Pi shared with prod for no operational benefit.
 *
 * Never silently makes an existing Aim/Experience decision stale. Location is
 * a scoring input, so rows with either score are reported and withheld from
 * the automatic write set. They require a separate, explicit invalidation and
 * re-score decision; clearing a score here would put it back into a manual
 * batch that costs Joseph real time.
 *
 * Dry run by default; `--apply` writes.
 */
const LIVE_STATUS_EXCLUSIONS = ['archived', 'dismissed', 'expired'];

type Candidate = {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string | null;
  status: string;
  aimFitScore: number | null;
  reqFitScore: number | null;
};

function parseArguments(argv: string[]): { apply: boolean } {
  for (const argument of argv) {
    if (argument !== '--apply') throw new Error('Usage: backfill_workday_locations.ts [--apply]');
  }
  return { apply: argv.includes('--apply') };
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — selecting live Workday placeholder rows...`);

  // Filtered in Postgres, not fetched wholesale and filtered in JS: the
  // database is on a Pi across Tailscale and shipping row bodies looks hung.
  // \\s and \\d, not \s and \d: this is a JS template literal, so an
  // unescaped backslash is swallowed before the string ever reaches
  // Postgres — that bug silently matched zero rows on the first pass here.
  const candidates = await prisma.$queryRaw<Candidate[]>`
    SELECT id, title, company, location, url, status, "aimFitScore", "reqFitScore"
    FROM "Job"
    WHERE source = 'ATS-workday'
      AND location ~* '^[0-9]+\\s+locations?$'
      AND status NOT IN (${LIVE_STATUS_EXCLUSIONS[0]}, ${LIVE_STATUS_EXCLUSIONS[1]}, ${LIVE_STATUS_EXCLUSIONS[2]})
  `;

  const [{ count: totalPlaceholders }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "Job"
    WHERE source = 'ATS-workday'
      AND location ~* '^[0-9]+\\s+locations?$'
  `;

  console.log(`  total placeholder rows (all statuses): ${totalPlaceholders.toLocaleString()}`);
  console.log(`  live candidates (${LIVE_STATUS_EXCLUSIONS.join('/')} excluded): ${candidates.length.toLocaleString()}`);

  const resolved: Array<{ candidate: Candidate; location: string; identityFingerprint: string }> = [];
  const missingUrl: Candidate[] = [];
  const detailUnavailable: Candidate[] = [];
  const detailWithoutLocations: Candidate[] = [];
  const concurrency = 4;

  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    const batch = candidates.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (candidate) => {
      if (!candidate.url) return { candidate, kind: 'missing_url' as const };
      try {
        const detail = await scrapeAtsApi(candidate.url);
        if (!detail || detail.ats !== 'Workday') {
          return { candidate, kind: 'detail_unavailable' as const };
        }
        if (!detail.location) {
          return { candidate, kind: 'no_locations' as const };
        }
        return { candidate, kind: 'resolved' as const, location: detail.location };
      } catch {
        return { candidate, kind: 'detail_unavailable' as const };
      }
    }));

    for (const result of results) {
      if (result.kind === 'missing_url') {
        missingUrl.push(result.candidate);
      } else if (result.kind === 'detail_unavailable') {
        detailUnavailable.push(result.candidate);
      } else if (result.kind === 'no_locations') {
        detailWithoutLocations.push(result.candidate);
      } else {
        resolved.push({
          candidate: result.candidate,
          location: result.location,
          identityFingerprint: generateV4Fingerprint(
            result.candidate.title,
            result.candidate.company,
            result.location,
          ),
        });
      }
    }
    console.log(`  inspected ${Math.min(offset + batch.length, candidates.length).toLocaleString()}/${candidates.length.toLocaleString()} detail response(s)`);
  }

  const skipped = [...missingUrl, ...detailUnavailable, ...detailWithoutLocations];
  const alreadyScored = resolved.filter(
    ({ candidate }) => candidate.aimFitScore !== null || candidate.reqFitScore !== null,
  );
  const writable = resolved.filter(
    ({ candidate }) => candidate.aimFitScore === null && candidate.reqFitScore === null,
  );

  console.log(`\n  authoritative detail locations recovered: ${resolved.length.toLocaleString()}`);
  console.log(`  missing posting URL:                       ${missingUrl.length.toLocaleString()}`);
  console.log(`  detail response unavailable/closed:        ${detailUnavailable.length.toLocaleString()}`);
  console.log(`  detail response carried no locations:      ${detailWithoutLocations.length.toLocaleString()}`);
  console.log(`  failed closed total (left unchanged):      ${skipped.length.toLocaleString()}`);
  console.log(`  eligible unscored rows:                     ${writable.length.toLocaleString()}`);
  console.log(`  scored rows withheld for explicit review:   ${alreadyScored.length.toLocaleString()}`);

  if (skipped.length > 0) {
    console.log('\n  skipped — no authoritative detail locations:');
    for (const job of skipped.slice(0, 25)) {
      console.log(`    ${job.location.padEnd(14)}${job.title.slice(0, 40).padEnd(42)}${job.url || '(no url)'}`);
    }
    if (skipped.length > 25) console.log(`    ... and ${skipped.length - 25} more`);
  }

  if (writable.length === 0) {
    console.log('\n  (nothing to backfill)');
    return;
  }

  console.log('\n  would backfill:');
  for (const { candidate, location } of writable.slice(0, 25)) {
    console.log(`    ${candidate.location.padEnd(14)} -> ${location}`);
    console.log(`      ${candidate.title.slice(0, 70)}`);
  }
  if (writable.length > 25) console.log(`    ... and ${writable.length - 25} more`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write these.');
    return;
  }

  let written = 0;
  for (const { candidate, location, identityFingerprint } of writable) {
    // Re-check the location so a row already fixed (or changed) since the
    // read above is left alone.
    const result = await prisma.job.updateMany({
      where: { id: candidate.id, location: candidate.location },
      data: { location, identityFingerprint },
    });
    written += result.count;
  }
  console.log(`\nBackfilled ${written.toLocaleString()} row(s).`);
}

main()
  .catch((error: unknown) => {
    console.error(`Workday location backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
