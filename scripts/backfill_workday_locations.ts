import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { generateV4Fingerprint } from '../src/lib/jobIngestion';
import { composeMultiSiteLocation, parseWorkdayLocationFromPath } from '../src/lib/workdayLocation';

/**
 * Recovers a locatable value for Workday rows stuck at the "<N> Locations"
 * placeholder, by re-parsing the `/job/<segment>/` URL Workday already gave
 * us and composing it with the placeholder rather than replacing it — see
 * composeMultiSiteLocation in workdayLocation.ts and
 * docs/prompts/workday-location-multi-site.md. The URL only names the
 * primary of the N sites; writing it alone would turn a permissive "N
 * Locations" into one confident, possibly-wrong claim and could silently
 * withhold a job open in Minneapolis among other cities.
 *
 * Scoped to live rows only (not archived/dismissed/expired). Those statuses
 * are excluded from both sides of duplicate suppression and from scoring, so
 * fixing their location changes nothing anyone reads — it would just be
 * 7,483 writes against a Pi shared with prod for no operational benefit.
 *
 * Never touches aimFitScore/reqFitScore: the export queue selects on
 * aimFitScore: null, so clearing a score would put a row back into a manual
 * scoring batch that costs Joseph real time. Rows that are already scored
 * still get their location/fingerprint fixed; the script only reports how
 * many that affected.
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
  // Two distinct failure shapes worth telling apart: a segment with nothing
  // readable at all, versus one that parsed but didn't reduce to a clean
  // "City, ST" — the case the earlier dry run got wrong ("5 Locations" ->
  // "Ohio USA") by treating a word blob as if it were a real single place.
  const noReadablePrimary: Candidate[] = [];
  const primaryNotCleanShape: Array<Candidate & { primary: string }> = [];

  for (const candidate of candidates) {
    const primary = parseWorkdayLocationFromPath(candidate.url);
    if (!primary) {
      noReadablePrimary.push(candidate);
      continue;
    }
    const location = composeMultiSiteLocation(primary, candidate.location);
    if (!location) {
      primaryNotCleanShape.push({ ...candidate, primary });
      continue;
    }
    const identityFingerprint = generateV4Fingerprint(candidate.title, candidate.company, location);
    resolved.push({ candidate, location, identityFingerprint });
  }

  const skipped = [...noReadablePrimary, ...primaryNotCleanShape];
  const alreadyScored = resolved.filter(
    ({ candidate }) => candidate.aimFitScore !== null || candidate.reqFitScore !== null,
  );

  console.log(`\n  primary normalized to a clean City, ST/State: ${resolved.length.toLocaleString()}`);
  console.log(`  failed closed, no readable primary in URL:    ${noReadablePrimary.length.toLocaleString()}`);
  console.log(`  failed closed, primary not a clean shape:     ${primaryNotCleanShape.length.toLocaleString()}`);
  console.log(`  failed closed total (left unchanged):         ${skipped.length.toLocaleString()}`);
  console.log(`  already Aim/Req-scored (score untouched, left as-is): ${alreadyScored.length.toLocaleString()}`);

  if (primaryNotCleanShape.length > 0) {
    console.log('\n  skipped — primary parsed but not a clean city/state shape:');
    for (const job of primaryNotCleanShape.slice(0, 25)) {
      console.log(`    ${job.location.padEnd(14)} primary="${job.primary}"`);
      console.log(`      ${job.title.slice(0, 70)}`);
    }
    if (primaryNotCleanShape.length > 25) console.log(`    ... and ${primaryNotCleanShape.length - 25} more`);
  }

  if (noReadablePrimary.length > 0) {
    console.log('\n  skipped — no readable place in URL:');
    for (const job of noReadablePrimary.slice(0, 25)) {
      console.log(`    ${job.location.padEnd(14)}${job.title.slice(0, 40).padEnd(42)}${job.url || '(no url)'}`);
    }
    if (noReadablePrimary.length > 25) console.log(`    ... and ${noReadablePrimary.length - 25} more`);
  }

  if (resolved.length === 0) {
    console.log('\n  (nothing to backfill)');
    return;
  }

  console.log('\n  would backfill:');
  for (const { candidate, location } of resolved.slice(0, 25)) {
    console.log(`    ${candidate.location.padEnd(14)} -> ${location}`);
    console.log(`      ${candidate.title.slice(0, 70)}`);
  }
  if (resolved.length > 25) console.log(`    ... and ${resolved.length - 25} more`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write these.');
    return;
  }

  let written = 0;
  for (const { candidate, location, identityFingerprint } of resolved) {
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
