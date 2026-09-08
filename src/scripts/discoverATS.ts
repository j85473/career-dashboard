export {};
import { PrismaClient } from '@prisma/client';

import * as fs from 'fs';
import * as path from 'path';
import { assignedRotationDay } from '../lib/atsRotation';

const prisma = new PrismaClient();

let logger: ((msg: string) => void) | null = null;
export const setLogger = (fn: ((msg: string) => void) | null) => { logger = fn; };

let shouldCancel = false;
export const cancelDiscovery = () => { shouldCancel = true; };

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

const originalLog = console.log;
console.log = (...args: any[]) => {
  if (!logger) originalLog(...args);
  if (logger) logger(args.join(' '));
};
const originalError = console.error;
console.error = (...args: any[]) => {
  if (!logger) originalError(...args);
  if (logger) logger('[ERROR] ' + args.join(' '));
};

const CONFIG = {
  BATCH_SIZE: Infinity, // Process this many slugs per run, then exit.
  MAX_CONCURRENT_REQUESTS: 5,
  // There is deliberately no region filter here. Discovery answers "is this a
  // real board that publishes jobs"; which jobs are worth keeping is decided
  // downstream by the ingestion location gate, against every posting on the
  // board rather than the first page the crawler happened to see. The old
  // filter also matched the bare substring "mn", so it passed nearly
  // everything anyway — removing it means more boards land 'active', not that
  // out-of-area jobs start reaching the Inbox.
};

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Vendor subdomains are not tenants. A Common Crawl sweep of "*.recruitee.com"
 * returns the vendor's own marketing and docs hosts far more often than it
 * returns customers, and each one would otherwise be validated as a slug.
 */
const RESERVED_SUBDOMAINS = new Set([
  'www', 'support', 'docs', 'help', 'blog', 'api', 'app', 'status',
  'careers', 'career', 'jobs', 'developers', 'developer', 'partners', 'resources',
]);

/** Greenhouse serves these off the board host; none of them is a tenant. */
const RESERVED_GREENHOUSE_PATHS = new Set([
  'robots.txt', 'sitemap.xml', 'embed', 'favicon.ico', 'assets', '_next',
]);

export function subdomainSlug(url: string, pattern: RegExp): string | null {
  const match = url.match(pattern);
  const slug = match ? match[1].toLowerCase() : null;
  return slug && !RESERVED_SUBDOMAINS.has(slug) ? slug : null;
}

export const PLATFORMS = {
  greenhouse: {
    // Greenhouse moved tenants to job-boards.greenhouse.io and kept the old
    // host alive. Crawling only the old one missed the larger, current half.
    cc_pattern: ["boards.greenhouse.io/*", "job-boards.greenhouse.io/*"],
    extract_slug: (url: string) => {
      const match = url.match(/(?:job-)?boards\.greenhouse\.io\/([^/?]+)/);
      const slug = match ? match[1] : null;
      return slug && !RESERVED_GREENHOUSE_PATHS.has(slug.toLowerCase()) ? slug : null;
    },
    test_api: "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true",
    get_jobs: (data: any) => data.jobs || []
  },
  lever: {
    cc_pattern: "jobs.lever.co/*",
    extract_slug: (url: string) => {
      const match = url.match(/jobs\.lever\.co\/([^/?]+)/);
      return match ? match[1] : null;
    },
    test_api: "https://api.lever.co/v0/postings/{slug}",
    get_jobs: (data: any) => (Array.isArray(data) ? data : [])
  },
  ashby: {
    cc_pattern: "jobs.ashbyhq.com/*",
    extract_slug: (url: string) => {
      const match = url.match(/jobs\.ashbyhq\.com\/([^/?]+)/);
      return match ? match[1] : null;
    },
    test_api: "https://api.ashbyhq.com/posting-api/job-board/{slug}",
    get_jobs: (data: any) => data.jobs || []
  },
  workday: {
    cc_pattern: "*.myworkdayjobs.com/*",
    extract_slug: (url: string) => {
      const match = url.match(/https?:\/\/([^.]+(?:\.wd\d+)?)\.myworkdayjobs\.com\/(?:[a-zA-Z]{2}-[a-zA-Z]{2}\/)?([^/?]+)/);
      return match ? `${match[1]}::${match[2]}` : null;
    },
    test_api: "", // handled explicitly in validateSlug
    get_jobs: (data: any) => data.jobPostings || []
  },
  smartrecruiters: {
    cc_pattern: "careers.smartrecruiters.com/*",
    extract_slug: (url: string) => {
      const match = url.match(/careers\.smartrecruiters\.com\/([^/?]+)/);
      return match ? match[1] : null;
    },
    test_api: "https://api.smartrecruiters.com/v1/companies/{slug}/postings",
    get_jobs: (data: any) => data.content || []
  },
  workable: {
    cc_pattern: "apply.workable.com/*",
    extract_slug: (url: string) => {
      const match = url.match(/apply\.workable\.com\/([^/?]+)/);
      return match ? match[1] : null;
    },
    test_api: "https://apply.workable.com/api/v3/accounts/{slug}/jobs",
    get_jobs: (data: any) => data.results || []
  },
  bamboohr: {
    cc_pattern: "*.bamboohr.com/careers*",
    extract_slug: (url: string) => {
      const match = url.match(/https?:\/\/([^.]+)\.bamboohr\.com/);
      return match ? match[1] : null;
    },
    test_api: "https://{slug}.bamboohr.com/careers/list",
    get_jobs: (data: any) => data.result || []
  },
  // Platforms below were verified against live tenants: each exposes every job
  // for a slug from one unauthenticated endpoint, exactly like Greenhouse.
  //
  // JazzHR is deliberately absent. Its `/apply/jobs/rss` path answers HTTP 200
  // with a 404 HTML body even for real tenants, so status-only validation would
  // mark every slug valid; the real API needs a per-customer key.
  breezy: {
    cc_pattern: "*.breezy.hr/*",
    extract_slug: (url: string) => subdomainSlug(url, /https?:\/\/([^.]+)\.breezy\.hr/),
    test_api: "https://{slug}.breezy.hr/json",
    get_jobs: (data: any) => (Array.isArray(data) ? data : [])
  },
  teamtailor: {
    cc_pattern: "*.teamtailor.com/*",
    extract_slug: (url: string) => subdomainSlug(url, /https?:\/\/([^.]+)\.teamtailor\.com/),
    test_api: "https://{slug}.teamtailor.com/jobs.json",
    get_jobs: (data: any) => data.items || []
  },
  pinpoint: {
    cc_pattern: "*.pinpointhq.com/*",
    extract_slug: (url: string) => subdomainSlug(url, /https?:\/\/([^.]+)\.pinpointhq\.com/),
    test_api: "https://{slug}.pinpointhq.com/postings.json",
    get_jobs: (data: any) => data.data || []
  },
  recruitee: {
    cc_pattern: "*.recruitee.com/*",
    extract_slug: (url: string) => subdomainSlug(url, /https?:\/\/([^.]+)\.recruitee\.com/),
    test_api: "https://{slug}.recruitee.com/api/offers",
    get_jobs: (data: any) => data.offers || []
  },
  rippling: {
    // Rippling is path-scoped rather than subdomain-scoped.
    cc_pattern: "ats.rippling.com/*",
    extract_slug: (url: string) => {
      const match = url.match(/ats\.rippling\.com\/([^/?#]+)/);
      const slug = match ? match[1] : null;
      return slug && !['api', 'jobs', 'assets', '_next'].includes(slug.toLowerCase()) ? slug : null;
    },
    test_api: "https://ats.rippling.com/api/v1/board/{slug}/jobs",
    get_jobs: (data: any) => (Array.isArray(data) ? data : [])
  },
  personio: {
    // The extractor already accepted .com tenants; the crawl never asked for them.
    cc_pattern: ["*.jobs.personio.de/*", "*.jobs.personio.com/*"],
    extract_slug: (url: string) => subdomainSlug(url, /https?:\/\/([^.]+)\.jobs\.personio\.(?:de|com)/),
    // XML rather than JSON; validateSlug handles the parse explicitly.
    test_api: "https://{slug}.jobs.personio.de/xml",
    get_jobs: (data: any) => data.positions || []
  }
};

const PROGRESS_FILE = path.resolve(process.cwd(), 'discover_progress.json');

type ProgressState = {
  indexId: string;
  page: number;
  /**
   * Every index up to and including this one has been exhausted. A completed
   * pattern resumes at the next index rather than re-walking history, and is
   * skipped entirely when Common Crawl has published nothing newer.
   */
  completedThrough?: string;
};

/**
 * Keyed `platform\u0000pattern`. A platform's patterns advance independently, so
 * adding a second host to an already-finished platform crawls that host's
 * history from the beginning instead of inheriting a marker it never earned.
 */
let progressTracker: Record<string, ProgressState> = {};

const progressKey = (platform: string, pattern: string) => `${platform}\u0000${pattern}`;

export function patternsFor(platform: { cc_pattern: string | string[] }): string[] {
  return Array.isArray(platform.cc_pattern) ? platform.cc_pattern : [platform.cc_pattern];
}

/**
 * Reads the on-disk progress file. It is no longer the store of record — the
 * database is — but a host that has been crawling for months has its history
 * only here, so it is imported once into any pattern that has no row yet.
 * Never the other way around: a stale file must not rewind the database.
 *
 * The file predates multi-host platforms, so its per-platform state belongs to
 * that platform's *first* pattern, which is the one it was recorded against.
 */
function readLegacyProgressFile(): Record<string, ProgressState> {
  if (!fs.existsSync(PROGRESS_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    // The format once changed from `{ platform: pageNumber }` to
    // `{ platform: { indexId, page } }`, and this branch quietly reset every
    // platform to the oldest index. Months of greenhouse/ashby/lever crawling
    // were thrown away with a one-line log nobody saw. Keep a copy and say so.
    if (Object.values(raw).length > 0 && typeof Object.values(raw)[0] === 'number') {
      const backup = `${PROGRESS_FILE}.legacy-${Date.now()}`;
      fs.copyFileSync(PROGRESS_FILE, backup);
      console.error('='.repeat(72));
      console.error('[Migration] Legacy progress format detected. Progress CANNOT be carried');
      console.error('over (the old format recorded no index id), so every platform will');
      console.error(`restart from the oldest index. A copy was saved to ${backup}.`);
      console.error('Mark already-crawled platforms complete before running, or this will');
      console.error('re-crawl years of Common Crawl history.');
      console.error('='.repeat(72));
      return {};
    }
    const imported: Record<string, ProgressState> = {};
    for (const [platformKey, state] of Object.entries(raw as Record<string, any>)) {
      const platform = (PLATFORMS as Record<string, { cc_pattern: string | string[] }>)[platformKey];
      if (!platform || !state || typeof state.indexId !== 'string') continue;
      imported[progressKey(platformKey, patternsFor(platform)[0])] = {
        indexId: state.indexId,
        page: typeof state.page === 'number' ? state.page : 0,
        completedThrough: typeof state.completedThrough === 'string' ? state.completedThrough : undefined,
      };
    }
    return imported;
  } catch {
    return {};
  }
}

async function loadProgress(): Promise<void> {
  const rows = await prisma.atsDiscoveryProgress.findMany();
  progressTracker = {};
  for (const row of rows) {
    progressTracker[progressKey(row.platform, row.pattern)] = {
      indexId: row.indexId,
      page: row.page,
      completedThrough: row.completedThrough ?? undefined,
    };
  }

  const fromFile = readLegacyProgressFile();
  const adopted: string[] = [];
  for (const [key, state] of Object.entries(fromFile)) {
    if (progressTracker[key]) continue;
    progressTracker[key] = state;
    const [platform, pattern] = key.split('\u0000');
    await saveProgress(platform, pattern, state);
    adopted.push(`${platform} (${pattern})`);
  }
  if (adopted.length) {
    console.log(`[Progress] Imported ${adopted.join(', ')} from ${PROGRESS_FILE} into the database. That file is no longer read once a pattern has a database row.`);
  }
}

async function saveProgress(platform: string, pattern: string, state: ProgressState): Promise<void> {
  const data = {
    indexId: state.indexId,
    page: state.page,
    completedThrough: state.completedThrough ?? null,
  };
  await prisma.atsDiscoveryProgress.upsert({
    where: { platform_pattern: { platform, pattern } },
    update: data,
    create: { platform, pattern, ...data },
  });
}

async function getIndices(): Promise<string[]> {
  try {
    const res = await fetch('https://index.commoncrawl.org/collinfo.json');
    const data = await res.json();
    // Older indices first so we crawl forward in time
    return data.map((d: any) => d.id + '-index').reverse();
  } catch (e) {
    console.error("Error fetching CC indices:", e);
    return ["CC-MAIN-2024-18-index"]; // fallback
  }
}

/**
 * A page of index records, or an explicit failure.
 *
 * These were once the same thing: any error returned an empty array, and the
 * caller reads empty as "this index holds nothing more", advances to the next
 * index and writes that down. Common Crawl's index server answers 503 whenever
 * it is busy, so one busy moment permanently skipped a whole index — and a 503
 * on the newest index marked the platform fully crawled having read nothing.
 */
type CrawlPage =
  | { ok: true; records: any[] }
  | { ok: false; reason: string };

async function fetchCommonCrawl(indexId: string, pattern: string, page: number, retries = 3): Promise<CrawlPage> {
  const url = `https://index.commoncrawl.org/${indexId}?url=${encodeURIComponent(pattern)}&output=json&page=${page}`;
  console.log(`[CommonCrawl] Fetching page ${page} from ${indexId} for ${pattern}...`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Broad Common Crawl queries take a long time, so use a 60s timeout.
      const response = await fetch(url, { headers: DEFAULT_HEADERS, signal: AbortSignal.timeout(60000) });
      if (!response.ok) {
        // 404/400 is the index server's way of saying the page is past the end
        // of the result set. Everything else is the server having a bad time.
        if (response.status === 404 || response.status === 400) return { ok: true, records: [] };
        throw new Error(`CC API error: HTTP ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      const lines = text.split('\n').filter(l => l.trim() !== '');

      const records: any[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch (parseErr) {
          // If the socket closed early, the very last line might be truncated/corrupted JSON.
          // We can just ignore that specific line and keep the rest.
        }
      }
      return { ok: true, records };
    } catch (error: any) {
      const reason = error.message || String(error);
      console.error(`[CommonCrawl] Error fetching page ${page} (Attempt ${attempt}/${retries}):`, reason);

      if (attempt === retries) {
        // Never a silent empty page: the caller must leave progress where it is.
        return { ok: false, reason };
      }
      // Wait before retrying. The index server sheds load aggressively, so back
      // off in tens of seconds rather than single-digit ones.
      await delay(10000 * attempt);
    }
  }
  return { ok: false, reason: 'retries exhausted' };
}

/**
 * Statuses that say the vendor is unavailable, not that the slug is fake.
 * A slug that hits one of these gets no row at all and is retried on the next
 * run, matching how a thrown network error has always behaved.
 */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524]);

async function validateSlug(platformKey: keyof typeof PLATFORMS, slug: string): Promise<any> {
  const platform = PLATFORMS[platformKey];
  
  try {
    let response;
    if (platformKey === 'workday') {
      const [company, tenant] = slug.split("::");
      const companyWithoutWd = company.split('.')[0];
      const apiUrl = `https://${company}.myworkdayjobs.com/wday/cxs/${companyWithoutWd}/${tenant}/jobs`;
      response = await fetch(apiUrl, {
        method: "POST",
        headers: { ...DEFAULT_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }),
        signal: AbortSignal.timeout(10000)
      });
    } else if (platformKey === 'workable') {
      const apiUrl = platform.test_api.replace("{slug}", slug);
      response = await fetch(apiUrl, {
        method: "POST",
        headers: { ...DEFAULT_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [] }),
        signal: AbortSignal.timeout(10000)
      });
    } else {
      const apiUrl = platform.test_api.replace("{slug}", slug);
      response = await fetch(apiUrl, { headers: DEFAULT_HEADERS, signal: AbortSignal.timeout(10000) });
    }

    if (!response.ok) {
      // A throttled or broken vendor is not a verdict on the slug. Recording
      // one parks a real board forever, because the dedup check below skips
      // any slug that already has a row and never revisits it.
      return { success: false, transient: TRANSIENT_STATUSES.has(response.status), reason: `HTTP ${response.status}` };
    }

    // Some tenants answer 200 with an HTML error page rather than a real 404.
    // Validating on status alone would accept every slug on such a platform.
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      return { success: false, reason: 'HTML response, not a job feed' };
    }

    let jobs: any[];
    if (platformKey === 'personio') {
      // Personio publishes XML. Each <position> is one posting; the whole
      // element is kept as text so the location match below still works.
      const xml = await response.text();
      jobs = [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].map((match) => match[1]);
    } else {
      const data = await response.json();
      jobs = platform.get_jobs(data);
    }
    
    if (jobs.length === 0) {
      return { success: false, reason: "No jobs listed" };
    }

    return { success: true, jobsFound: jobs.length };
  } catch (err: any) {
    return { success: false, transient: true, reason: err.message };
  }
}

export async function runDiscovery() {
  shouldCancel = false;
  await loadProgress();
  const indices = await getIndices();
  console.log(`[Discovery] Loaded ${indices.length} Common Crawl indices.`);

  for (const [platformKey, platform] of Object.entries(PLATFORMS)) {
    if (shouldCancel) {
      console.log('[System] Process cancelled by user. Halting.');
      return;
    }
    console.log(`\n=== Processing ${platformKey.toUpperCase()} ===`);
    
    const slugsToProcess = new Set<string>();

    // Each pattern carries its own place in Common Crawl history. Greenhouse's
    // second host was added long after the first was walked end to end; sharing
    // one marker would have declared it finished without ever requesting it.
    for (const pattern of patternsFor(platform)) {
      if (shouldCancel) {
        console.log('[System] Process cancelled by user. Halting.');
        return;
      }
      const key = progressKey(platformKey, pattern);
      let currentState = progressTracker[key] || { indexId: indices[0], page: 0 };

      // A pattern that has already been walked end to end resumes at the first
      // index published since, so a finished crawl is never repeated and newly
      // released indices are still picked up.
      if (currentState.completedThrough) {
        const completedIdx = indices.indexOf(currentState.completedThrough);
        if (completedIdx >= 0 && completedIdx + 1 >= indices.length) {
          console.log(`[Discovery] ${platformKey} (${pattern}) is complete through ${currentState.completedThrough}; no newer index published. Skipping.`);
          continue;
        }
        if (completedIdx >= 0) {
          currentState = {
            indexId: indices[completedIdx + 1],
            page: 0,
            completedThrough: currentState.completedThrough,
          };
        }
      }

      let indexIdx = indices.indexOf(currentState.indexId);
      if (indexIdx === -1) {
        indexIdx = 0;
        currentState = { indexId: indices[0], page: 0 };
      }

      while (slugsToProcess.size < CONFIG.BATCH_SIZE && indexIdx < indices.length) {
        if (shouldCancel) {
          console.log('[System] Process cancelled by user. Halting.');
          return;
        }
        const currentIndexId = indices[indexIdx];
        const page = await fetchCommonCrawl(currentIndexId, pattern, currentState.page);

        if (!page.ok) {
          // Progress stays exactly where it is. Treating this as "no more data"
          // is what silently skipped whole indices; the next run resumes here.
          console.error(`[CommonCrawl] ${currentIndexId} page ${currentState.page} for ${platformKey} (${pattern}) could not be read: ${page.reason}. Leaving progress at this page; the next run picks it up here.`);
          break;
        }

        if (page.records.length === 0) {
          console.log(`[CommonCrawl] Exhausted ${currentIndexId} for ${platformKey} (${pattern}) at page ${currentState.page}. Rolling over to next index...`);
          indexIdx++;
          if (indexIdx < indices.length) {
            currentState = {
              indexId: indices[indexIdx],
              page: 0,
              completedThrough: currentState.completedThrough,
            };
            progressTracker[key] = currentState;
            await saveProgress(platformKey, pattern, currentState);
            // Rate-limited like any other page. A pattern for a host that did
            // not exist in 2008 rolls through ~100 empty indices in a row, and
            // firing those back to back is what makes the index server answer
            // 503 — which now costs the rest of the run.
            await delay(5000);
            continue;
          } else {
            console.log(`[CommonCrawl] Exhausted all available Common Crawl indices for ${platformKey} (${pattern})!`);
            // Record the finish, or the next run walks all 126 indices again.
            currentState = {
              indexId: indices[indices.length - 1],
              page: currentState.page,
              completedThrough: indices[indices.length - 1],
            };
            progressTracker[key] = currentState;
            await saveProgress(platformKey, pattern, currentState);
            break;
          }
        }

        for (const record of page.records) {
          const slug = platform.extract_slug(record.url);
          if (slug) {
            slugsToProcess.add(slug);
          }
        }
        currentState = { indexId: currentState.indexId, page: currentState.page + 1, completedThrough: currentState.completedThrough };
        progressTracker[key] = currentState;
        await saveProgress(platformKey, pattern, currentState);

        // CRITICAL: Prevent IP bans by waiting 5 seconds between CC index pagination requests
        await delay(5000);
      }
    }

    const slugsArray = Array.from(slugsToProcess);
    console.log(`[Discovery] Found ${slugsArray.length} unique slugs. Validating against API...`);

    let i = 0;
    while (i < slugsArray.length) {
      if (shouldCancel) {
        console.log('[System] Process cancelled by user. Halting.');
        return;
      }
      const batch = slugsArray.slice(i, i + CONFIG.MAX_CONCURRENT_REQUESTS);
      i += CONFIG.MAX_CONCURRENT_REQUESTS;

      const promises = batch.map(async (slug) => {
        try {
          // Dedup against Prisma!
          const existing = await prisma.atsCompany.findUnique({
            where: { slug_platform: { slug, platform: platformKey } }
          });
          if (existing) return;

          console.log(`  -> Testing ${slug}...`);
          const result = await validateSlug(platformKey as keyof typeof PLATFORMS, slug);
          
          if (result.transient) {
            // No row. The slug stays undiscovered and is re-read from Common
            // Crawl on a later run, rather than being parked forever because
            // the vendor was rate-limiting the moment we asked.
            console.log(`  [⏳] ${slug}: Skipped, vendor unavailable - ${result.reason}`);
            return;
          }

          if (result.success) {
            console.log(`  [✅] ${slug}: SUCCESS! Board is live with ${result.jobsFound} open jobs.`);
            
            const nextCheck = new Date();
            nextCheck.setDate(nextCheck.getDate() + 1);

            await prisma.atsCompany.create({
              data: {
                slug,
                platform: platformKey,
                checkDay: assignedRotationDay(slug, platformKey),
                status: 'active',
                failCount: 0,
                nextCheckDate: nextCheck,
                jobsFound: result.jobsFound
              }
            });
          } else {
            console.log(`  [❌] ${slug}: Failed - ${result.reason}`);
            
            const nextCheck = new Date();
            nextCheck.setDate(nextCheck.getDate() + 30);

            await prisma.atsCompany.create({
              data: {
                slug,
                platform: platformKey,
                checkDay: assignedRotationDay(slug, platformKey),
                status: 'parked',
                failCount: 1,
                nextCheckDate: nextCheck
              }
            });
          }
        } catch (e: any) {
          console.log(`  [❌] ${slug}: Script Error - ${e.message || 'Unknown error'}`);
        }
      });

      await Promise.all(promises);
    }
  }

  console.log("\n=== Discovery Run Complete ===");
  const activeCount = await prisma.atsCompany.count({ where: { status: 'active' } });
  console.log(`Total Active Verified Boards in Prisma: ${activeCount}`);
}

const isMain = typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
const isCLI = typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].includes('discoverATS.ts');

if (isMain || isCLI) {
  runDiscovery()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
}
