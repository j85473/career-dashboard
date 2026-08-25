import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import { assignedRotationDay } from '../src/lib/atsRotation';

/**
 * Turns aggregator listings into sweepable ATS boards, without a browser.
 *
 * Every Himalayas posting names a company we are very likely not sweeping
 * directly. Chainguard was the case that surfaced this: 87 jobs live at
 * `boards-api.greenhouse.io/v1/boards/chainguard`, and `AtsCompany` had no row
 * for it, so the sweep never looked.
 *
 * A company's aggregator slug is usually its ATS slug, so the board can be
 * found by asking the ATS directly: three JSON requests per company, no
 * browser, no challenge.
 *
 * **Every hit is verified before registration.** A slug guess can collide with
 * an unrelated company on the same platform, and registering a wrong board
 * would pull a stranger's entire catalogue into the pipeline.
 *
 * ## Why verification needs more than a name
 *
 * Only Greenhouse publishes the board's company name (`/v1/boards/{slug}` ->
 * `.name`). Checked against the live APIs on 2026-08-19: Lever's
 * `/v0/postings/{slug}` carries `categories.{commitment,location,team,
 * allLocations}` and nothing else identifying, and Ashby's
 * `/posting-api/job-board/{slug}` returns exactly `{jobs, apiVersion}`. The
 * previous version read Lever's `categories.team` as if it were a company name
 * — it yields "Sales", "G&A", "FDE" — and hardcoded Ashby's to `''`. So every
 * Lever and Ashby board was rejected by construction: 24 of 63 on the
 * 2026-08-19 run, including Kong, Imprint, Spreedly, Cyara and Sitetracker.
 *
 * The browser route that was supposed to catch them (`resolve_himalayas_urls.ts`)
 * is retired: Himalayas serves anonymous visitors a signup wall in place of the
 * employer's link (`/signup/talent?redirect=...&showModal=true`) behind a
 * Cloudflare challenge, so it resolved 0 of 20 and could only ever work against
 * a logged-in session.
 *
 * ## What replaces it
 *
 * Job titles. The aggregator already told us which titles a company is hiring
 * for; a board that lists those same titles is that company's board. Two
 * distinct exact matches is the bar, because single generic titles
 * ("Account Executive") collide across unrelated companies. A single match
 * counts only when the board's own posting text also names the company.
 *
 * Dry run by default; `--apply` registers.
 */

const prisma = new PrismaClient();
const CONCURRENCY = 8;
const TIMEOUT_MS = 15_000;
/** Two distinct titles in common; one generic title is not evidence. */
const TITLE_MATCHES_REQUIRED = 2;
/** Enough posting text to look for the company's own name, not the whole board. */
const TEXT_SAMPLE_POSTINGS = 5;
const TEXT_SAMPLE_CHARS = 8_000;

interface ProbeSpec {
  list: (slug: string) => string;
  count: (body: unknown) => number;
  /** Empty unless the platform states the board's company name. */
  name: (body: unknown) => string;
  /** The board's own job titles, for overlap verification. */
  titles: (body: unknown) => string[];
  /** Posting prose, searched for the company name when only one title matches. */
  text: (body: unknown) => string;
}

function sampleText(values: string[]): string {
  return values.slice(0, TEXT_SAMPLE_POSTINGS).join(' ').slice(0, TEXT_SAMPLE_CHARS);
}

const PLATFORM_PROBES: Record<string, ProbeSpec> = {
  greenhouse: {
    list: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    count: (body) => ((body as { jobs?: unknown[] })?.jobs || []).length,
    name: (body) => String((body as { name?: string })?.name || ''),
    titles: (body) => ((body as { jobs?: { title?: string }[] })?.jobs || []).map((job) => String(job?.title || '')),
    // The list endpoint omits posting bodies unless content=true is requested,
    // and Greenhouse states its name outright, so this is never needed.
    text: () => '',
  },
  lever: {
    list: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    count: (body) => (Array.isArray(body) ? body.length : 0),
    name: () => '',
    titles: (body) => (Array.isArray(body) ? body.map((job) => String((job as { text?: string })?.text || '')) : []),
    text: (body) => (Array.isArray(body)
      ? sampleText(body.map((job) => String((job as { descriptionPlain?: string })?.descriptionPlain || '')))
      : ''),
  },
  ashby: {
    list: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    count: (body) => ((body as { jobs?: unknown[] })?.jobs || []).length,
    name: () => '',
    titles: (body) => ((body as { jobs?: { title?: string }[] })?.jobs || []).map((job) => String(job?.title || '')),
    text: (body) => sampleText(((body as { jobs?: { descriptionHtml?: string }[] })?.jobs || [])
      .map((job) => String(job?.descriptionHtml || ''))),
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

/**
 * Some Himalayas rows carry the literal string "name" as the company — seen on
 * panopto, sonatype, trace3 and crosscountry-consulting. Treated as absent
 * rather than compared, or the board's real name is measured against garbage.
 */
const JUNK_COMPANY_NAMES = new Set(['name', 'unknown company', 'unknown', 'n/a', '-']);

function isJunkCompany(value: string): boolean {
  return !value.trim() || JUNK_COMPANY_NAMES.has(value.trim().toLowerCase());
}

/**
 * The slug is Himalayas' own identifier for the company and is exactly what
 * was guessed with, so a board whose stated name matches it is verified on the
 * same footing as one matching the company field — and it still works when the
 * company field is junk. "crosscountry-consulting" -> "crosscountryconsulting"
 * matches Greenhouse's "CrossCountry Consulting".
 */
function slugAsName(slug: string): string {
  return slug.replace(/[-_]+/g, ' ');
}

/** Tolerates "Steer" vs "Steer CRM" without accepting two unrelated names. */
function namesAgree(boardName: string, companyName: string): boolean {
  const a = normalizeName(boardName);
  const b = normalizeName(companyName);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Punctuation, casing and spacing drift between an aggregator's copy of a
 * title and the ATS's own ("Account Executive - North America New Logo" vs
 * "Account Executive – North America, New Logo"). Everything else must match:
 * a loose comparison is what would let an unrelated board through.
 */
function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function countTitleOverlap(boardTitles: string[], aggregatorTitles: Set<string>): number {
  const matched = new Set<string>();
  for (const title of boardTitles) {
    const normalized = normalizeTitle(title);
    if (normalized && aggregatorTitles.has(normalized)) matched.add(normalized);
  }
  return matched.size;
}

/** A company naming itself in its own postings, tolerant of markup and spacing. */
function textNamesCompany(text: string, companyName: string): boolean {
  const needle = normalizeName(companyName);
  if (needle.length < 4) return false;
  return normalizeName(text).includes(needle);
}

interface Candidate { slug: string; company: string; titles: Set<string> }
interface Discovery extends Candidate {
  platform: string;
  jobCount: number;
  boardName: string;
  titleMatches: number;
  verified: boolean;
  evidence: string;
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

    const titleMatches = countTitleOverlap(probeSpec.titles(body), candidate.titles);

    let verified = false;
    let evidence = '';
    const nameSubject = isJunkCompany(candidate.company) ? slugAsName(candidate.slug) : candidate.company;
    if (namesAgree(boardName, nameSubject) || namesAgree(boardName, slugAsName(candidate.slug))) {
      verified = true;
      evidence = `name "${boardName}"`;
    } else if (titleMatches >= TITLE_MATCHES_REQUIRED) {
      verified = true;
      evidence = `${titleMatches} titles`;
    } else if (titleMatches === 1 && textNamesCompany(probeSpec.text(body), nameSubject)) {
      verified = true;
      evidence = '1 title + company named in postings';
    } else {
      evidence = titleMatches > 0 ? `only ${titleMatches} title, company not named` : 'no name, no shared title';
    }

    found.push({ ...candidate, platform, jobCount, boardName, titleMatches, verified, evidence });
  }
  return found;
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));

  // Himalayas stores the company slug in the interstitial URL it supplies.
  const rows = await prisma.job.findMany({
    where: { source: 'Himalayas', url: { contains: '/companies/' } },
    select: { url: true, company: true, title: true },
  });

  const candidates = new Map<string, Candidate>();
  for (const row of rows) {
    const match = String(row.url || '').match(/\/companies\/([^/?#]+)/);
    if (!match) continue;
    const slug = match[1].toLowerCase();
    const existing = candidates.get(slug);
    const candidate = existing || { slug, company: row.company || '', titles: new Set<string>() };
    // One poisoned row must not decide the company for the whole slug: prefer
    // any real name over "name"/"Unknown Company".
    if (isJunkCompany(candidate.company) && !isJunkCompany(row.company || '')) {
      candidate.company = row.company || '';
    }
    const normalized = normalizeTitle(row.title || '');
    if (normalized) candidate.titles.add(normalized);
    if (!existing) candidates.set(slug, candidate);
  }

  const known = new Set(
    (await prisma.atsCompany.findMany({ select: { slug: true, platform: true } }))
      .map((board) => `${board.platform}:${board.slug.toLowerCase()}`),
  );

  const pending = [...candidates.values()];
  const singleTitle = pending.filter((candidate) => candidate.titles.size < TITLE_MATCHES_REQUIRED).length;
  const junkCompany = pending.filter((candidate) => isJunkCompany(candidate.company)).length;
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${pending.length.toLocaleString()} distinct Himalayas compan(ies), ${(pending.length * Object.keys(PLATFORM_PROBES).length).toLocaleString()} probes.`);
  console.log(`  ${singleTitle.toLocaleString()} of them have fewer than ${TITLE_MATCHES_REQUIRED} known titles, so title overlap alone cannot clear them.`);
  console.log(`  ${junkCompany.toLocaleString()} store no usable company name (an ingestion defect); those fall back to the slug.\n`);
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
  const byName = verified.filter((d) => d.evidence.startsWith('name')).length;
  const byTitle = verified.length - byName;

  console.log(`\n  boards responding:      ${discoveries.length.toLocaleString()}`);
  console.log(`  verified:               ${verified.length.toLocaleString()} (${byName.toLocaleString()} by stated name, ${byTitle.toLocaleString()} by title overlap)`);
  console.log(`  rejected:               ${rejected.length.toLocaleString()}`);
  console.log(`  already registered:     ${already.toLocaleString()}`);
  console.log(`  new boards to register: ${fresh.length.toLocaleString()} (${fresh.reduce((sum, d) => sum + d.jobCount, 0).toLocaleString()} jobs behind them)\n`);

  if (rejected.length > 0) {
    console.log('  rejected (inspect before trusting the rule):');
    for (const d of rejected.slice(0, 15)) {
      console.log(`    ${d.slug.slice(0, 22).padEnd(24)}${d.platform.padEnd(11)}${String(d.jobCount).padStart(4)} jobs  company="${d.company.slice(0, 20)}"  ${d.evidence}`);
    }
    if (rejected.length > 15) console.log(`    ... and ${rejected.length - 15} more`);
    console.log('');
  }

  if (fresh.length > 0) {
    console.log('  new boards:');
    for (const d of [...fresh].sort((a, b) => b.jobCount - a.jobCount).slice(0, 40)) {
      console.log(`    ${String(d.jobCount).padStart(5)} jobs  ${d.platform.padEnd(11)}${d.slug.slice(0, 24).padEnd(26)}${d.company.slice(0, 24).padEnd(26)}${d.evidence}`);
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
          checkDay: assignedRotationDay(d.slug, d.platform),
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
