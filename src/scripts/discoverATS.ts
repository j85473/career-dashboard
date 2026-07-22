export {};
import { PrismaClient } from '@prisma/client';

import * as fs from 'fs';
import * as path from 'path';

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
  BATCH_SIZE: 2000, // Process this many slugs per run, then exit.
  MAX_CONCURRENT_REQUESTS: 5,
  LOCATION_KEYWORDS: ["minneapolis", "st. paul", "saint paul", "minnesota", "mn", "554", "551"],
};

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const PLATFORMS = {
  greenhouse: {
    cc_pattern: "boards.greenhouse.io/*",
    extract_slug: (url: string) => {
      const match = url.match(/boards\.greenhouse\.io\/([^/?]+)/);
      return match ? match[1] : null;
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
  }
};

const PROGRESS_FILE = path.resolve(process.cwd(), 'discover_progress.json');

type ProgressState = {
  indexId: string;
  page: number;
};
let progressTracker: Record<string, ProgressState> = {};

if (fs.existsSync(PROGRESS_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    if (Object.values(raw).length > 0 && typeof Object.values(raw)[0] === 'number') {
       console.log("[Migration] Old progress file format detected. Starting fresh.");
    } else {
       progressTracker = raw;
    }
  } catch(e) {}
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

async function fetchCommonCrawl(indexId: string, pattern: string, page: number, retries = 3): Promise<any[]> {
  const url = `https://index.commoncrawl.org/${indexId}?url=${encodeURIComponent(pattern)}&output=json&page=${page}`;
  console.log(`[CommonCrawl] Fetching page ${page} from ${indexId} for ${pattern}...`);
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Massive wildcard queries take a long time on CC, use 60s timeout
      const response = await fetch(url, { headers: DEFAULT_HEADERS, signal: AbortSignal.timeout(60000) });
      if (!response.ok) {
        if (response.status === 404 || response.status === 400) return []; // No more pages
        throw new Error(`CC API error: ${response.statusText}`);
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
      return records;
    } catch (error: any) {
      console.error(`[CommonCrawl] Error fetching page ${page} (Attempt ${attempt}/${retries}):`, error.message || error);
      
      // If it's a hard network error (API is offline/blocked), halt entirely instead of skipping indices
      if (attempt === retries && (error.message?.includes('fetch failed') || error.cause?.code === 'ECONNREFUSED')) {
        throw new Error("CommonCrawl API is unreachable. Halting discovery to prevent index exhaustion.");
      }
      
      if (attempt === retries) return [];
      // Wait before retrying (exponential backoff)
      await new Promise(res => setTimeout(res, 2000 * attempt));
    }
  }
  return [];
}

function isLocationMatch(job: any): boolean {
  const jsonStr = JSON.stringify(job).toLowerCase();
  return CONFIG.LOCATION_KEYWORDS.some(kw => jsonStr.includes(kw));
}

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
      return { success: false, reason: `HTTP ${response.status}` };
    }
    const data = await response.json();
    const jobs = platform.get_jobs(data);
    
    if (jobs.length === 0) {
      return { success: false, reason: "No jobs listed" };
    }

    const matchesMN = jobs.some((job: any) => isLocationMatch(job));
    if (!matchesMN) {
      return { success: false, reason: "No jobs in target region" };
    }

    return { success: true, jobsFound: jobs.length };
  } catch (err: any) {
    return { success: false, reason: err.message };
  }
}

export async function runDiscovery() {
  shouldCancel = false;
  const indices = await getIndices();
  console.log(`[Discovery] Loaded ${indices.length} Common Crawl indices.`);

  for (const [platformKey, platform] of Object.entries(PLATFORMS)) {
    if (shouldCancel) {
      console.log('[System] Process cancelled by user. Halting.');
      return;
    }
    console.log(`\n=== Processing ${platformKey.toUpperCase()} ===`);
    
    let currentState = progressTracker[platformKey] || { indexId: indices[0], page: 0 };
    let indexIdx = indices.indexOf(currentState.indexId);
    if (indexIdx === -1) {
      indexIdx = 0;
      currentState = { indexId: indices[0], page: 0 };
    }

    const slugsToProcess = new Set<string>();

    while (slugsToProcess.size < CONFIG.BATCH_SIZE && indexIdx < indices.length) {
      if (shouldCancel) {
        console.log('[System] Process cancelled by user. Halting.');
        return;
      }
      const currentIndexId = indices[indexIdx];
      const records = await fetchCommonCrawl(currentIndexId, platform.cc_pattern, currentState.page);
      
      if (records.length === 0) {
        console.log(`[CommonCrawl] Exhausted ${currentIndexId} for ${platformKey} at page ${currentState.page}. Rolling over to next index...`);
        indexIdx++;
        if (indexIdx < indices.length) {
          currentState = { indexId: indices[indexIdx], page: 0 };
          progressTracker[platformKey] = currentState;
          fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressTracker, null, 2));
          continue;
        } else {
          console.log(`[CommonCrawl] Exhausted all available Common Crawl indices for ${platformKey}!`);
          break;
        }
      }

      for (const record of records) {
        const slug = platform.extract_slug(record.url);
        if (slug) {
          slugsToProcess.add(slug);
        }
      }
      currentState.page++;
      progressTracker[platformKey] = currentState;
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressTracker, null, 2));
      
      // CRITICAL: Prevent IP bans by waiting 5 seconds between CC index pagination requests
      await delay(5000);
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
          
          if (result.success) {
            console.log(`  [✅] ${slug}: SUCCESS! Found ${result.jobsFound} jobs in target region.`);
            
            const nextCheck = new Date();
            nextCheck.setDate(nextCheck.getDate() + 1);

            await prisma.atsCompany.create({
              data: {
                slug,
                platform: platformKey,
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
