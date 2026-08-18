import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import { scrapeAtsApi } from '../src/lib/atsApi';

/**
 * Replaces the Himalayas interstitial with the employer's own posting URL.
 *
 * `parseHimalayasJob` stores `applicationLink`, which is always a
 * `himalayas.app/companies/{slug}/jobs/{slug}` page rather than the employer's
 * board. Two costs follow: "View Posting" lands on an aggregator page, and the
 * underlying ATS board stays invisible to discovery. Chainguard was the example
 * — reachable at `boards-api.greenhouse.io/v1/boards/chainguard` with 87 jobs,
 * but absent from `AtsCompany`, so the sweep never touched it. Every Himalayas
 * posting is a board we are probably not sweeping.
 *
 * `atsRedirect.ts` already knows how to find the Apply anchor and follow it,
 * but it is gated on `response.ok` and himalayas.app answers a plain fetch with
 * **HTTP 403**, so that path is inert. A real browser is required, exactly as
 * for the Adzuna interstitial, and `cloakbrowser` is what got through there.
 *
 * Resolving a URL is cheap in DB terms and slow in browser terms (~8s each),
 * which is why this is a batch script rather than an ingestion stage.
 *
 * Dry run by default. `--apply` writes. `--limit N` bounds a run — start small,
 * because whether cloakbrowser clears Himalayas is unverified.
 */

const prisma = new PrismaClient();
const HYDRATION_MS = 6_000;
const SAMPLE_LIMIT = 15;

function parseArguments(argv: string[]): { apply: boolean; limit: number | null } {
  let apply = false;
  let limit: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') { apply = true; continue; }
    if (argument === '--limit') {
      const value = Number.parseInt(argv[index + 1] || '', 10);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--limit needs a positive integer');
      limit = value;
      index += 1;
      continue;
    }
    throw new Error('Usage: resolve_himalayas_urls.ts [--apply] [--limit N]');
  }
  return { apply, limit };
}

interface Resolved {
  id: string;
  company: string | null;
  title: string | null;
  resolvedUrl: string;
  ats: string | null;
  slug: string | null;
  platform: string | null;
}

async function main(): Promise<void> {
  const { apply, limit } = parseArguments(process.argv.slice(2));

  const targets = await prisma.job.findMany({
    where: {
      source: 'Himalayas',
      url: { contains: 'himalayas.app' },
    },
    select: { id: true, company: true, title: true, url: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    ...(limit ? { take: limit } : {}),
  });

  const estimate = Math.round((targets.length * (HYDRATION_MS + 2_000)) / 60_000);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${targets.length.toLocaleString()} Himalayas job(s) still pointing at the interstitial (~${estimate} min of browser time).\n`);
  if (targets.length === 0) return;

  const { launch } = await import('cloakbrowser');
  const browser: { newPage: () => Promise<any>; close: () => Promise<void> } = await launch({ headless: true });

  const resolved: Resolved[] = [];
  let attempted = 0;
  let blocked = 0;
  let noApplyLink = 0;

  try {
    for (const target of targets) {
      attempted += 1;
      const page = await browser.newPage();
      try {
        await page.goto(String(target.url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await new Promise((resolve) => setTimeout(resolve, HYDRATION_MS));

        const body: string = await page.evaluate(() => document.body?.innerText || '');
        if (/suspicious behaviour|unusual behaviour|access denied|are you a robot/i.test(body)) {
          blocked += 1;
          continue;
        }

        // Same rule as findHimalayasApplyUrl in atsRedirect.ts: an anchor whose
        // text mentions apply and which leaves himalayas.app's own company pages.
        const applyUrl: string | null = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
          for (const anchor of anchors) {
            if (!(anchor.textContent || '').trim().toLowerCase().includes('apply')) continue;
            const href = anchor.href;
            if (!href) continue;
            if (/(^|\.)himalayas\.app$/i.test(new URL(href).hostname)
              && new URL(href).pathname.startsWith('/companies/')) continue;
            return href;
          }
          return null;
        });

        if (!applyUrl) { noApplyLink += 1; continue; }

        let finalUrl = applyUrl;
        if (/(^|\.)himalayas\.app$/i.test(new URL(applyUrl).hostname)) {
          // The Apply route is itself a redirect hop; follow it in the browser.
          await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          finalUrl = page.url();
        }
        if (/(^|\.)himalayas\.app$/i.test(new URL(finalUrl).hostname)) { noApplyLink += 1; continue; }

        // Reuse the same detection the manual scrape route uses, so a board
        // discovered here is registered on identical terms.
        const ats = await scrapeAtsApi(finalUrl).catch(() => null);
        resolved.push({
          id: target.id,
          company: target.company,
          title: target.title,
          resolvedUrl: finalUrl,
          ats: ats?.ats || null,
          slug: ats?.atsSlug || null,
          platform: ats?.platform || null,
        });
      } catch {
        // A posting taken down since ingestion simply will not resolve.
      } finally {
        await page.close().catch(() => {});
      }

      if (attempted % 25 === 0) {
        console.log(`  probed ${attempted.toLocaleString()}/${targets.length.toLocaleString()} — ${resolved.length.toLocaleString()} resolved, ${blocked} blocked, ${noApplyLink} no apply link`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const withBoard = resolved.filter((job) => job.slug && job.platform);
  const newBoards = new Map<string, string>();
  for (const job of withBoard) newBoards.set(`${job.platform}:${job.slug}`, `${job.platform} / ${job.slug}`);

  console.log(`\n  resolved to the employer's posting: ${resolved.length.toLocaleString()} of ${targets.length.toLocaleString()}`);
  console.log(`  bot-blocked:      ${blocked.toLocaleString()}`);
  console.log(`  no apply link:    ${noApplyLink.toLocaleString()}`);
  console.log(`  unresolvable:     ${(targets.length - resolved.length - blocked - noApplyLink).toLocaleString()}`);
  console.log(`\n  ATS board identified: ${withBoard.length.toLocaleString()} (${newBoards.size.toLocaleString()} distinct board(s))`);

  if (newBoards.size > 0) {
    console.log('\n  boards that would be registered for sweeping:');
    for (const label of [...newBoards.values()].slice(0, 40)) console.log(`    ${label}`);
    if (newBoards.size > 40) console.log(`    ... and ${newBoards.size - 40} more`);
  }

  if (resolved.length > 0) {
    console.log('\n  samples:');
    for (const job of resolved.slice(0, SAMPLE_LIMIT)) {
      console.log(`    ${String(job.company || '?').slice(0, 18).padEnd(20)}${String(job.ats || 'unknown').padEnd(14)}${job.resolvedUrl.slice(0, 82)}`);
    }
  }

  if (!apply || resolved.length === 0) {
    console.log(apply ? '\nNothing to write.' : '\nDry run. Re-run with --apply to store the resolved URLs and register the boards.');
    return;
  }

  let written = 0;
  for (const job of resolved) {
    const result = await prisma.job.updateMany({
      // Re-check the URL so a job a human has already re-pointed is left alone.
      where: { id: job.id, url: { contains: 'himalayas.app' } },
      data: {
        url: job.resolvedUrl,
        canonicalUrl: job.resolvedUrl,
        ...(job.ats ? { manualAts: job.ats } : {}),
      },
    });
    written += result.count;
  }
  console.log(`\nRe-pointed ${written.toLocaleString()} job(s) at the employer's posting.`);

  // Registered only after the job write, matching the manual scrape route:
  // discovery state must not be fed by a resolution that did not stick.
  let registered = 0;
  for (const job of withBoard) {
    await prisma.atsCompany.upsert({
      where: { slug_platform: { slug: job.slug as string, platform: job.platform as string } },
      update: { status: 'active', nextCheckDate: new Date() },
      create: {
        slug: job.slug as string,
        platform: job.platform as string,
        status: 'active',
        nextCheckDate: new Date(),
        failCount: 0,
        jobsFound: 1,
      },
    }).then(() => { registered += 1; })
      .catch((error: unknown) => console.error(`Failed to register ${job.platform}/${job.slug}:`, error));
  }
  console.log(`Registered ${registered.toLocaleString()} board upsert(s) — ${newBoards.size.toLocaleString()} distinct board(s) now sweepable.`);
}

main()
  .catch((error: unknown) => {
    console.error(`Himalayas URL resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
