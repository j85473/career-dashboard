export {};
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Marks ATS platforms as already crawled through the newest Common Crawl index.
 *
 * A legacy progress-format migration silently reset every platform to the
 * oldest index (2008), so platforms that had genuinely been walked end to end
 * were restarting a 126-index crawl from scratch — and the newly wired
 * platforms sat behind them in declaration order.
 *
 * Marking a platform complete does not retire it: the crawler resumes at the
 * first index published *after* the recorded one, so new monthly indices are
 * still picked up.
 *
 *   node --import tsx scripts/mark_ats_platforms_crawled.ts            # preview
 *   node --import tsx scripts/mark_ats_platforms_crawled.ts --apply
 *   node --import tsx scripts/mark_ats_platforms_crawled.ts --apply greenhouse lever
 */

const PROGRESS_FILE = path.resolve(process.cwd(), 'discover_progress.json');

const DEFAULT_PLATFORMS = [
  'greenhouse', 'lever', 'ashby', 'workday',
  'smartrecruiters', 'workable', 'bamboohr',
];

type ProgressState = { indexId: string; page: number; completedThrough?: string };

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

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const named = args.filter((arg) => !arg.startsWith('--'));
  const platforms = named.length > 0 ? named : DEFAULT_PLATFORMS;

  const newest = await newestIndexId();
  const tracker: Record<string, ProgressState> = fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    : {};

  console.log(`Newest Common Crawl index: ${newest}\n`);
  for (const platform of platforms) {
    const before = tracker[platform];
    console.log(`  ${platform.padEnd(16)} ${before ? `${before.indexId} page ${before.page}` : '(no progress recorded)'} -> complete through ${newest}`);
    tracker[platform] = { indexId: newest, page: 0, completedThrough: newest };
  }

  const untouched = Object.keys(tracker).filter((key) => !platforms.includes(key));
  if (untouched.length) console.log(`\n  untouched: ${untouched.join(', ')}`);

  if (!apply) {
    console.log('\nPreview only. Re-run with --apply to write.');
    console.log('Stop the crawler first — it rewrites this file after every page.');
    return;
  }
  fs.writeFileSync(PROGRESS_FILE, `${JSON.stringify(tracker, null, 2)}\n`);
  console.log(`\nWrote ${PROGRESS_FILE}. Those platforms will be skipped until a newer index is published.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
