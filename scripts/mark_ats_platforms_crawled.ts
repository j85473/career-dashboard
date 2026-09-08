export {};
import { PrismaClient } from '@prisma/client';
import { PLATFORMS, patternsFor } from '../src/scripts/discoverATS';

const prisma = new PrismaClient();

/**
 * Marks ATS crawl patterns as already crawled through the newest Common Crawl index.
 *
 * A legacy progress-format migration silently reset every platform to the
 * oldest index (2008), so platforms that had genuinely been walked end to end
 * were restarting a 126-index crawl from scratch — and the newly wired
 * platforms sat behind them in declaration order.
 *
 * Marking a pattern complete does not retire it: the crawler resumes at the
 * first index published *after* the recorded one, so new monthly indices are
 * still picked up.
 *
 * Progress lives in the database rather than a working-directory JSON file, so
 * this reads and writes the same state the dashboard's crawler does regardless
 * of which host you run it from. It is keyed by URL pattern, and the preview
 * names every pattern it would touch — a platform that has just gained a second
 * host will list that host, and marking it complete would skip its history.
 *
 *   node --import tsx scripts/mark_ats_platforms_crawled.ts            # preview
 *   node --import tsx scripts/mark_ats_platforms_crawled.ts --apply
 *   node --import tsx scripts/mark_ats_platforms_crawled.ts --apply greenhouse lever
 *   node --import tsx scripts/mark_ats_platforms_crawled.ts --apply 'greenhouse:boards.greenhouse.io/*'
 */

const DEFAULT_PLATFORMS = [
  'greenhouse', 'lever', 'ashby', 'workday',
  'smartrecruiters', 'workable', 'bamboohr',
];

async function newestIndexId(): Promise<string> {
  const response = await fetch('https://index.commoncrawl.org/collinfo.json', {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`collinfo.json returned HTTP ${response.status}`);
  const collections = await response.json() as Array<{ id: string }>;
  if (!collections.length) throw new Error('collinfo.json returned no collections');
  // collinfo is newest-first; the crawler reverses it to walk oldest-first.
  return `${collections[0].id}-index`;
}

/**
 * `greenhouse` means every greenhouse pattern; `greenhouse:<pattern>` means
 * exactly that one, so a platform's newly added host can be left to crawl the
 * history it has not seen.
 */
function resolveTargets(names: string[]): Array<{ platform: string; pattern: string }> {
  const targets: Array<{ platform: string; pattern: string }> = [];
  for (const name of names) {
    const separator = name.indexOf(':');
    const platformKey = separator === -1 ? name : name.slice(0, separator);
    const entry = (PLATFORMS as Record<string, { cc_pattern: string | string[] }>)[platformKey];
    if (!entry) throw new Error(`Unknown platform: ${platformKey}`);
    const patterns = patternsFor(entry);
    if (separator === -1) {
      for (const pattern of patterns) targets.push({ platform: platformKey, pattern });
      continue;
    }
    const wanted = name.slice(separator + 1);
    if (!patterns.includes(wanted)) {
      throw new Error(`${platformKey} has no pattern ${wanted}. It has: ${patterns.join(', ')}`);
    }
    targets.push({ platform: platformKey, pattern: wanted });
  }
  return targets;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const named = args.filter((arg) => !arg.startsWith('--'));
  const platforms = named.length > 0 ? named : DEFAULT_PLATFORMS;
  const targets = resolveTargets(platforms);

  const newest = await newestIndexId();
  const existing = new Map<string, { indexId: string; page: number }>();
  for (const row of await prisma.atsDiscoveryProgress.findMany()) {
    existing.set(`${row.platform} ${row.pattern}`, row);
  }

  console.log(`Newest Common Crawl index: ${newest}\n`);
  for (const { platform, pattern } of targets) {
    const before = existing.get(`${platform} ${pattern}`);
    const label = `${platform} ${pattern}`;
    console.log(`  ${label.padEnd(48)} ${before ? `${before.indexId} page ${before.page}` : '(no progress recorded)'} -> complete through ${newest}`);
  }

  const touched = new Set(targets.map((target) => `${target.platform} ${target.pattern}`));
  const untouched = [...existing.keys()].filter((key) => !touched.has(key));
  if (untouched.length) console.log(`\n  untouched: ${untouched.join(', ')}`);

  if (!apply) {
    console.log('\nPreview only. Re-run with --apply to write.');
    console.log('Stop the crawler first — it rewrites its progress after every page.');
    return;
  }
  for (const { platform, pattern } of targets) {
    await prisma.atsDiscoveryProgress.upsert({
      where: { platform_pattern: { platform, pattern } },
      update: { indexId: newest, page: 0, completedThrough: newest },
      create: { platform, pattern, indexId: newest, page: 0, completedThrough: newest },
    });
  }
  console.log(`\nMarked ${targets.length} pattern(s) complete through ${newest}. They will be skipped until a newer index is published.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
