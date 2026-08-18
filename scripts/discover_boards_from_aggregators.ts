import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

/**
 * Turns aggregator listings into sweepable ATS boards, without a browser.
 *
 * Every Himalayas posting names a company we are very likely not sweeping
 * directly. Chainguard was the case that surfaced this: 87 jobs live at
 * `boards-api.greenhouse.io/v1/boards/chainguard`, and `AtsCompany` had no row
 * for it, so the sweep never looked.
 *
 * The obvious route — resolve the Himalayas interstitial in a browser and read
 * the employer's URL — costs ~8s per posting and has to clear a Cloudflare
 * challenge ("Just a moment...", which is why a plain fetch of a Himalayas page
 * returns 403 while their JSON API answers fine).
 *
 * This takes the cheap route instead. A company's aggregator slug is usually
 * its ATS slug, so the board can be found by asking the ATS directly: three
 * JSON requests per company, no browser, no challenge. On a 91-company sample
 * that identified 14 boards holding 939 jobs — a 15% hit rate for essentially
 * no cost.
 *
 * The 85% it misses still need the browser (`resolve_himalayas_urls.ts`). Run
 * this first: it is free, and it shrinks that job.
 *
 * **Every hit is name-verified before registration.** A slug guess can collide
 * with an unrelated company on the same platform, and registering a wrong board
 * would pull a stranger's entire catalogue into the pipeline. A board counts
 * only when it reports a company name matching the aggregator's.
 *
 * Dry run by default; `--apply` registers.
 */

const prisma = new PrismaClient();
const CONCURRENCY = 8;
const TIMEOUT_MS = 15_000;

/** Platforms with a public JSON list endpoint that also states a company name. */
const PLATFORM_PROBES: Record<string, { list: (slug: string) => string; count: (body: unknown) => number; name: (body: unknown) => string }> = {
  greenhouse: {
    list: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    count: (body) => ((body as { jobs?: unknown[] })?.jobs || []).length,
    name: (body) => String((body as { name?: string })?.name || ''),
  },
  lever: {
    list: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    count: (body) => (Array.isArray(body) ? body.length : 0),
    name: (body) => String((Array.isArray(body) && (body[0] as { categories?: { team?: string } })?.categories?.team) || ''),
  },
  ashby: {
    list: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    count: (body) => ((body as { jobs?: unknown[] })?.jobs || []).length,
    name: () => '',
  },
};

/** Greenhouse states the board's own company name; used to confirm a guess. */
const BOARD_NAME_ENDPOINT: Record<string, (slug: string) => string | null> = {
  greenhouse: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`,
  lever: () => null,
  ashby: () => null,
};

function parseArguments(argv: string[]): { apply: boolean } {
  for (const argument of argv) {
    if (argument !== '--apply') throw new Error('Usage: discover_boards_from_aggregators.ts [--apply]');
  }
  return { apply: argv.includes('--apply') };
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|plc)\b/g, '').replace(/[^a-z0-9]/g, '');
}

/** Tolerates "Steer" vs "Steer CRM" without accepting two unrelated names. */
function namesAgree(boardName: string, companyName: string): boolean {
  const a = normalizeName(boardName);
  const b = normalizeName(companyName);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

interface Candidate { slug: string; company: string }
interface Discovery extends Candidate { platform: string; jobCount: number; boardName: string; verified: boolean }

async function probe(candidate: Candidate): Promise<Discovery[]> {
  const found: Discovery[] = [];
  for (const [platform, probeSpec] of Object.entries(PLATFORM_PROBES)) {
    const body = await fetchJson(probeSpec.list(candidate.slug));
    if (!body) continue;
    const jobCount = probeSpec.count(body);
    if (jobCount <= 0) continue;

    const nameUrl = BOARD_NAME_ENDPOINT[platform]?.(candidate.slug) || null;
    const boardName = nameUrl
      ? String((await fetchJson(nameUrl) as { name?: string })?.name || '')
      : probeSpec.name(body);

    found.push({
      ...candidate,
      platform,
      jobCount,
      boardName,
      verified: namesAgree(boardName, candidate.company),
    });
  }
  return found;
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));

  // Himalayas stores the company slug in the interstitial URL it supplies.
  const rows = await prisma.job.findMany({
    where: { source: 'Himalayas', url: { contains: '/companies/' } },
    select: { url: true, company: true },
  });

  const candidates = new Map<string, Candidate>();
  for (const row of rows) {
    const match = String(row.url || '').match(/\/companies\/([^/?#]+)/);
    if (!match) continue;
    const slug = match[1].toLowerCase();
    if (!candidates.has(slug)) candidates.set(slug, { slug, company: row.company || '' });
  }

  const known = new Set(
    (await prisma.atsCompany.findMany({ select: { slug: true, platform: true } }))
      .map((board) => `${board.platform}:${board.slug.toLowerCase()}`),
  );

  const pending = [...candidates.values()];
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${pending.length.toLocaleString()} distinct Himalayas compan(ies), ${(pending.length * Object.keys(PLATFORM_PROBES).length).toLocaleString()} probes.\n`);
  if (pending.length === 0) return;

  const discoveries: Discovery[] = [];
  for (let index = 0; index < pending.length; index += CONCURRENCY) {
    const batch = pending.slice(index, index + CONCURRENCY);
    for (const result of await Promise.all(batch.map(probe))) discoveries.push(...result);
    if ((index + CONCURRENCY) % 80 < CONCURRENCY) {
      console.log(`  probed ${Math.min(index + CONCURRENCY, pending.length).toLocaleString()}/${pending.length.toLocaleString()} — ${discoveries.length.toLocaleString()} board(s) responding`);
    }
  }

  const verified = discoveries.filter((d) => d.verified);
  const rejected = discoveries.filter((d) => !d.verified);
  const fresh = verified.filter((d) => !known.has(`${d.platform}:${d.slug}`));
  const already = verified.length - fresh.length;

  console.log(`\n  boards responding:      ${discoveries.length.toLocaleString()}`);
  console.log(`  name-verified:          ${verified.length.toLocaleString()}`);
  console.log(`  rejected on name:       ${rejected.length.toLocaleString()} (slug collision, or the platform states no name)`);
  console.log(`  already registered:     ${already.toLocaleString()}`);
  console.log(`  new boards to register: ${fresh.length.toLocaleString()} (${fresh.reduce((sum, d) => sum + d.jobCount, 0).toLocaleString()} jobs behind them)\n`);

  if (rejected.length > 0) {
    console.log('  rejected (inspect before trusting the rule):');
    for (const d of rejected.slice(0, 12)) {
      console.log(`    ${d.slug.slice(0, 24).padEnd(26)}${d.platform.padEnd(12)}board="${d.boardName.slice(0, 24)}" vs company="${d.company.slice(0, 24)}"`);
    }
    console.log('');
  }

  if (fresh.length > 0) {
    console.log('  new boards:');
    for (const d of [...fresh].sort((a, b) => b.jobCount - a.jobCount).slice(0, 40)) {
      console.log(`    ${String(d.jobCount).padStart(5)} jobs  ${d.platform.padEnd(12)}${d.slug.slice(0, 26).padEnd(28)}${d.company.slice(0, 28)}`);
    }
    if (fresh.length > 40) console.log(`    ... and ${fresh.length - 40} more`);
  }

  if (!apply || fresh.length === 0) {
    console.log(apply ? '\nNothing to register.' : '\nDry run. Re-run with --apply to register the verified boards above.');
    return;
  }

  let registered = 0;
  for (const d of fresh) {
    try {
      await prisma.atsCompany.upsert({
        where: { slug_platform: { slug: d.slug, platform: d.platform } },
        update: { status: 'active', nextCheckDate: new Date() },
        create: {
          slug: d.slug,
          platform: d.platform,
          status: 'active',
          nextCheckDate: new Date(),
          failCount: 0,
          jobsFound: d.jobCount,
        },
      });
      registered += 1;
    } catch (error: unknown) {
      console.error(`Failed to register ${d.platform}/${d.slug}:`, error);
    }
  }
  console.log(`\nRegistered ${registered.toLocaleString()} new board(s) for sweeping.`);
}

main()
  .catch((error: unknown) => {
    console.error(`Board discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
