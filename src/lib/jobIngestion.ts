import { prisma } from "./prisma";
import * as crypto from "crypto";
import { passesPreFilter } from "./jobFiltering";
import { scrapeAtsApi } from "./atsApi";

function normalizeUrl(urlStr: string) {
  if (!urlStr) return "";
  try {
    const u = new URL(urlStr);
    u.searchParams.delete("utm_source");
    u.searchParams.delete("utm_medium");
    u.searchParams.delete("utm_campaign");
    return u.toString();
  } catch (e) {
    return urlStr;
  }
}

export function generateFingerprint(title: string, company: string, location: string) {
  const normalize = (str: string) => {
    let t = (str || "").toLowerCase();
    // Strip common location separators and any trailing text if it looks like a location/bonus
    t = t.replace(/[,\-|(].*(mn|minnesota|remote|usa|st\.?\s*paul|twin cities|minneapolis|woodbury|apple valley|edina|plymouth|maple grove).*/gi, '');
    return t.replace(/[^a-z0-9]/g, "");
  };
  const raw = `${normalize(company)}|${normalize(title)}`; // Ignore location for deduplication
  return crypto.createHash("md5").update(raw).digest("hex");
}


export function cleanHtmlText(html: string): string {
  if (!html) return "";
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "") // Strip emojis robustly
    .replace(/[ \t]+/g, " ") // Collapse horizontal whitespace
    .replace(/\n\s*\n\s*\n+/g, "\n\n") // Compress 3+ newlines into 2
    .trim();
}

export async function resolveCanonicalUrl(job: { company?: string | null; title?: string | null; url?: string | null }): Promise<string | null> {
  const serpApiKey = process.env.SERPAPI_KEY;
  if (!serpApiKey || !job.company || !job.title) return job.url || null;

  const urlLower = (job.url || '').toLowerCase();
  const isAggregator = urlLower.includes('adzuna') || urlLower.includes('indeed') || urlLower.includes('linkedin') || urlLower.includes('jsearch');
  if (!isAggregator) return job.url || null;

  try {
    const serpParams = new URLSearchParams({
      engine: "google",
      q: `${job.company} ${job.title} careers`,
      api_key: serpApiKey,
    });
    const serpRes = await fetch(`https://serpapi.com/search.json?${serpParams.toString()}`);
    if (serpRes.ok) {
      const data = await serpRes.json();
      const topLink = data.organic_results?.[0]?.link;
      if (topLink && !topLink.includes("glassdoor") && !topLink.includes("salary.com")) {
        return topLink;
      }
    }
  } catch (e) {}
  
  return job.url || null;
}

export async function tryFetchFullDescription(job: {

  url?: string | null;
  resolvedUrl?: string | null;
  source?: string | null;
  sourceId?: string | null;
  company?: string | null;
  title?: string | null;
}): Promise<string | null> {
  const rapidApiKey = process.env.RAPIDAPI_KEY;

  // Attempt API-based fetching first for perfect reliability
  if (job.source === "Indeed" && job.sourceId && rapidApiKey) {
    try {
      const res = await fetch(
        `https://indeed12.p.rapidapi.com/job/${job.sourceId}`,
        {
          headers: {
            "X-RapidAPI-Key": rapidApiKey,
            "X-RapidAPI-Host": "indeed12.p.rapidapi.com",
          },
        },
      );
      if (res.ok) {
        const data = await res.json();
        if (data.description) {
          return cleanHtmlText(data.description);
        }
      }
    } catch (e) {}
  }

  if (job.source === "JSearch" && job.sourceId && rapidApiKey) {
    try {
      const res = await fetch(
        `https://jsearch.p.rapidapi.com/job-details?job_id=${job.sourceId}`,
        {
          headers: {
            "X-RapidAPI-Key": rapidApiKey,
            "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
          },
        },
      );
      if (res.ok) {
        const data = await res.json();
        if (data.data?.[0]?.job_description) {
          return data.data[0].job_description;
        }
      }
    } catch (e) {}
  }

  // Fallback 3: Canonical Webpage Scraping via resolvedUrl
  const finalUrl = job.resolvedUrl || job.url;
  if (finalUrl && finalUrl.startsWith("http")) {
    try {
      const pageRes = await fetch(finalUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        
        // Try JSON-LD first
        let jsonLdDescription = '';
        try {
          const scriptMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
          if (scriptMatch) {
            const data = JSON.parse(scriptMatch[1]);
            const parseJob = (obj: any) => {
              if (obj['@type'] === 'JobPosting' && obj.description) {
                jsonLdDescription = obj.description;
              } else if (Array.isArray(obj)) {
                obj.forEach(parseJob);
              } else if (typeof obj === 'object' && obj !== null) {
                if (obj['@graph']) parseJob(obj['@graph']);
              }
            };
            parseJob(data);
          }
        } catch (e) {}

        if (jsonLdDescription && jsonLdDescription.length > 500) {
          return cleanHtmlText(jsonLdDescription);
        }

        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        let bodyText = bodyMatch ? bodyMatch[1] : html;
        bodyText = bodyText
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<template[^>]*>[\s\S]*?<\/template>/gi, "")
          .replace(/<div[^>]*class=["'][^"']*ph-page-data[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        
        if (bodyText.length > 500 && !(bodyText.startsWith('{') && bodyText.endsWith('}'))) {
          return bodyText;
        }
      }
    } catch (e) {}
  }

  // Fallback 4: Raw HTML scraping
  if (!finalUrl || !finalUrl.startsWith("http")) return null;
  try {
    const res = await fetch(finalUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 500) return text;
    return null;
  } catch (e) {
    // Ignore fetch error
  }

  return null;
}

export async function ingestJobs(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  targetAtsSlugs?: {slug: string, platform: string}[]
): Promise<number> {
  const serpApiKey = process.env.SERPAPI_KEY;
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  const serpApiKeys = [serpApiKey, process.env.SERPAPI_KEY_2].filter(Boolean) as string[];
  const rapidApiKeys = [rapidApiKey, process.env.RAPIDAPI_KEY_2].filter(Boolean) as string[];

  if (serpApiKeys.length === 0 && rapidApiKeys.length === 0) {
    if (onProgress) onProgress("No API keys found, skipping ingestion.");
    console.log("No API keys found, skipping ingestion.");
    return 0;
  }

  async function fetchWithKeyRotation(
    keys: string[],
    fetchFn: (key: string) => Promise<Response>
  ): Promise<Response | null> {
    for (const key of keys) {
      if (!key) continue;
      const res = await fetchFn(key);
      if (res.status === 429 || res.status === 402 || res.status === 403) {
        console.warn('API key limit reached, trying next key...');
        continue;
      }
      return res;
    }
    return null;
  }

  let newJobsCount = 0;

  async function processJob(jobData: any) {
    if (signal?.aborted) return;
    let {
      title,
      company,
      description,
      location,
      url: rawUrl,
      source,
      sourceId,
      postedAt,
    } = jobData;

    description = cleanHtmlText(description || "");

    if (!sourceId) return;

    const canonicalUrl = normalizeUrl(rawUrl);
    const fingerprint = generateFingerprint(title, company, location);

    // 1. Exact Source + SourceId in observations
    const obs = await prisma.jobSourceObservation.findUnique({
      where: { source_sourceId: { source, sourceId: sourceId.toString() } },
    });
    if (obs) return; // Already seen this exact posting

    // 2. Matching canonicalUrl OR Fingerprint
    let existingJob = null;
    if (canonicalUrl) {
      existingJob = await prisma.job.findFirst({ where: { canonicalUrl } });
    }
    if (!existingJob && fingerprint) {
      existingJob = await prisma.job.findFirst({ 
        where: { 
          fingerprint,
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
        } 
      });
    }

    if (existingJob) {
      // Record observation to track duplicate source
      try {
        await prisma.jobSourceObservation.create({
          data: {
            jobId: existingJob.id,
            source,
            sourceId: sourceId.toString(),
            url: rawUrl,
          },
        });
      } catch (e: any) {
        if (e.code !== 'P2002') throw e;
      }
      return;
    }

    let finalDescription = description || "";
    let finalCanonicalUrl = canonicalUrl;
    let manualAts: string | undefined = undefined;

    const isAggregator = rawUrl && (rawUrl.includes('adzuna.com') || rawUrl.includes('indeed.com') || rawUrl.includes('jsearch') || rawUrl.includes('linkedin.com'));

    if (finalDescription.length < 400 || isAggregator) {
      const resolvedUrl = await resolveCanonicalUrl({ company, title, url: rawUrl });
      finalCanonicalUrl = resolvedUrl || canonicalUrl;
      
      let atsResult = null;
      if (finalCanonicalUrl) {
         atsResult = await scrapeAtsApi(finalCanonicalUrl);
      }
      
      if (atsResult) {
         finalDescription = atsResult.text;
         manualAts = atsResult.ats;
         
         if (atsResult.atsSlug && atsResult.platform) {
            try {
              await prisma.atsCompany.upsert({
                 where: { slug_platform: { slug: atsResult.atsSlug, platform: atsResult.platform } },
                 update: {},
                 create: { slug: atsResult.atsSlug, platform: atsResult.platform }
              });
            } catch (e) {
              // Ignore unique constraint errors from concurrency
            }
         }
      } else {
         const scraped = await tryFetchFullDescription({
           url: rawUrl,
           resolvedUrl,
           source,
           sourceId,
           company,
           title,
         });
         if (scraped && scraped.length > finalDescription.length) {
           finalDescription = scraped;
         }
      }
    }

    
    const preFilterResult = passesPreFilter({
      title,
      company,
      description: finalDescription,
      location,
      url: rawUrl,
    });

    if (!preFilterResult.passes) {
      // Save as archived so we don't process it, but we keep the observation
      try {
        await prisma.job.create({
          data: {
            title,
            company,
            description: finalDescription,
            location,
            url: rawUrl,
            source,
            sourceId: sourceId.toString(),
            canonicalUrl: finalCanonicalUrl,
            manualAts,
            fingerprint,
            postedAt,
            status: "archived",
            fitCategory: "rejected",
            fitRationale: preFilterResult.reason,
            scoringStatus: "skipped",
            observations: {
              create: {
                source,
                sourceId: sourceId.toString(),
                url: rawUrl,
              },
            },
          },
        });
      } catch (e: any) {
        if (e.code !== 'P2002') throw e;
      }
      return;
    }

    // New Job! Save as pending_af for batch processing

    const needsJd = finalDescription.length < 400;

    try {
      await prisma.job.create({
        data: {
          title,
          company,
          description: finalDescription,
          location,
          url: rawUrl,
          source,
          sourceId: sourceId.toString(),
          canonicalUrl: finalCanonicalUrl,
          manualAts,
          fingerprint,
          postedAt,
          status: "pending_af", // Keep all new jobs in pending_af so they don't show up in inbox prematurely
          fitCategory: "unscored",
          fitRationale: null,
          scoringStatus: needsJd ? "needs_jd" : "queued",
          observations: {
            create: {
              source,
              sourceId: sourceId.toString(),
              url: rawUrl,
            },
          },
        },
      });
      newJobsCount++;
    } catch (e: any) {
      if (e.code !== 'P2002') throw e;
    }
  }

  // BROAD SEARCH: "sales" in "55405" over last 24 hours
  const baseQuery = "sales";
  const zipCode = "55405";

  // 0. BioSpace RSS Scraper
  if (!targetAtsSlugs || targetAtsSlugs.length === 0) {
    if (onProgress) onProgress("Searching BioSpace RSS...");
    try {
      const bsRes = await fetch("https://jobs.biospace.com/jobsrss/?keywords=sales");
      if (bsRes.ok) {
        const xml = await bsRes.text();
        const cheerio = await import("cheerio");
        const $ = cheerio.load(xml, { xmlMode: true });
        const items = $("item").slice(0, 100).toArray(); // Limit to top 100 to avoid slamming db
        
        for (const item of items) {
          const $item = $(item);
          const fullTitle = $item.find("title").text();
          const link = $item.find("link").text();
          const descHtml = $item.find("description").text();
          const pubDate = $item.find("pubDate").text();
          const creator = $item.find("dc\\:creator").text() || $item.find("author").text();
          
          let company = "BioSpace";
          let title = fullTitle;
          if (creator && !creator.match(/^\d/) && creator.split(' ').length < 6) {
             company = creator;
             if (title.startsWith(company + " - ")) {
               title = title.substring(company.length + 3).trim();
             } else if (title.startsWith(company + ": ")) {
               title = title.substring(company.length + 2).trim();
             }
          } else if (fullTitle.includes(": ")) {
            const parts = fullTitle.split(": ");
            company = parts[0].trim();
            title = parts.slice(1).join(": ").trim();
          }

          let location = "Remote / US";
          const descLines = descHtml.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          if (descLines.length > 0) {
            const lastLine = descLines[descLines.length - 1];
            if (!lastLine.includes(":") && lastLine.length < 50) {
               location = lastLine;
            }
          }

          try {
            await processJob({
            title,
            company,
            description: descHtml, // BioSpace provides snippet, but we need full JD. Will be flagged as needs_jd if short.
            location,
            url: link,
            source: 'BioSpace',
            sourceId: link,
            postedAt: (() => { const d = pubDate ? new Date(pubDate) : new Date(); return isNaN(d.getTime()) ? new Date() : d; })()
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
       console.error("BioSpace scraper failed", e);
    }

    // 0.1 The Muse API
    if (onProgress) onProgress("Searching The Muse API...");
    try {
      const museRes = await fetch("https://www.themuse.com/api/public/jobs?page=1&category=Sales");
      if (museRes.ok) {
        const data = await museRes.json();
        const jobs = data.results || [];
        for (const job of jobs) {
          const location = job.locations && job.locations.length > 0 ? job.locations[0].name : "Flexible / Remote";
          if (!/\b(us|usa|u\.s\.|united states|remote|flexible)\b|,\s*[A-Z]{2}\b/i.test(location)) continue;

          try {
            await processJob({
            title: job.name,
            company: job.company?.name || "The Muse",
            description: job.contents,
            location,
            url: job.refs?.landing_page || String(job.id),
            source: 'TheMuse',
            sourceId: String(job.id),
            postedAt: job.publication_date ? new Date(job.publication_date) : new Date()
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error("The Muse scraper failed", e);
    }

    // 0.2 Himalayas API
    if (onProgress) onProgress("Searching Himalayas API...");
    try {
      const himalayasRes = await fetch("https://himalayas.app/jobs/api?limit=50");
      if (himalayasRes.ok) {
        const data = await himalayasRes.json();
        const jobs = data.jobs || [];
        for (const job of jobs) {
          if (!job.title.toLowerCase().includes("sales") && !job.title.toLowerCase().includes("account executive")) continue;
          
          const sid = job.id ?? job.applicationLink;
          if (sid == null) continue;
          let location = "Remote";
          if (job.locationRestrictions && job.locationRestrictions.length > 0) {
            location = job.locationRestrictions.join(", ");
          }
          if (!/\b(us|usa|u\.s\.|united states|worldwide|anywhere|remote)\b/i.test(location)) continue;

          try {
            await processJob({
            title: job.title,
            company: job.companyName || "Himalayas",
            description: job.description,
            location,
            url: job.applicationLink,
            source: 'Himalayas',
            sourceId: String(sid),
            postedAt: job.pubDate ? new Date(job.pubDate * 1000) : new Date()
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error("Himalayas scraper failed", e);
    }

    // 0.3 Remotive API
    if (onProgress) onProgress("Searching Remotive API...");
    try {
      const remotiveRes = await fetch("https://remotive.com/api/remote-jobs?search=sales&limit=50");
      if (remotiveRes.ok) {
        const data = await remotiveRes.json();
        const jobs = data.jobs || [];
        for (const job of jobs) {
          const location = job.candidate_required_location || "Remote";
          if (!/\b(us|usa|u\.s\.|united states|worldwide|anywhere|remote)\b/i.test(location)) continue;

          try {
            await processJob({
            title: job.title,
            company: job.company_name || "Remotive",
            description: job.description,
            location,
            url: job.url || String(job.id),
            source: 'Remotive',
            sourceId: String(job.id),
            postedAt: job.publication_date ? new Date(job.publication_date) : new Date()
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error("Remotive scraper failed", e);
    }

    // 0.4 Arbeitnow API
    if (onProgress) onProgress("Searching Arbeitnow API...");
    try {
      const arbeitRes = await fetch("https://www.arbeitnow.com/api/job-board-api");
      if (arbeitRes.ok) {
        const data = await arbeitRes.json();
        const jobs = data.data || [];
        for (const job of jobs) {
          if (!job.title.toLowerCase().includes("sales") && !job.title.toLowerCase().includes("account executive")) continue;
          
          const location = job.location || "Remote";
          if (!/\b(us|usa|u\.s\.|united states)\b/i.test(location)) continue;

          try {
            await processJob({
            title: job.title,
            company: job.company_name || "Arbeitnow",
            description: job.description,
            location,
            url: job.url,
            source: 'Arbeitnow',
            sourceId: job.slug ?? job.url,
            postedAt: job.created_at ? new Date(job.created_at * 1000) : new Date()
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error("Arbeitnow scraper failed", e);
    }
  }

  // 1. CareerForce MN Scraper
  if (!targetAtsSlugs || targetAtsSlugs.length === 0) {
    if (onProgress) onProgress("Starting CareerForce MN Stealth Scraper...");
    try {
      const { spawn } = await import('child_process');
      const scriptPath = require('path').join(process.cwd(), 'src/scripts/careerForceScraper.ts');
      
      await new Promise<void>((resolve) => {
        const child = spawn('npx', ['tsx', scriptPath, baseQuery], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        child.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter(Boolean);
          lines.forEach((line: string) => {
             if (onProgress) onProgress(`[CareerForce] ${line}`);
             
             // Extract added count from stdout to accurately return newJobsCount
             const match = line.match(/added (\d+) new jobs/);
             if (match && match[1]) {
               newJobsCount += parseInt(match[1], 10);
             }
          });
        });
        
        child.stderr.on('data', (data) => {
          console.error(`[CareerForce Error] ${data.toString()}`);
        });
        
        child.on('close', (code) => {
          if (onProgress) onProgress(`CareerForce Scraper finished with code ${code}`);
          resolve();
        });
      });
    } catch (e) {
      console.error("CareerForce scraper failed", e);
    }
  }

  // 1. SerpApi Fetch
  if (serpApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    if (onProgress) onProgress("Searching SerpApi (Google Jobs)...");
    try {
      const serpParams = new URLSearchParams({
        engine: "google_jobs",
        q: baseQuery,
        location: zipCode,
        chips: "date_posted:today", // Last 24 hours
      });

      const serpRes = await fetchWithKeyRotation(serpApiKeys, async (key) => {
        serpParams.set("api_key", key);
        return fetch(`https://serpapi.com/search.json?${serpParams.toString()}`);
      });
      if (serpRes && serpRes.ok) {
        const data = await serpRes.json();
        const jobs = data.jobs_results || [];
        for (const job of jobs) {
          if (signal?.aborted) break;
          let postedAt = new Date(); // Google jobs with 'date_posted:today' are basically today
          const fallbackQuery = `${job.title} ${job.company_name} ${job.location} jobs`;
          try {
            await processJob({
            title: job.title,
            company: job.company_name,
            description: job.description,
            location: job.location,
            url:
              job.apply_options?.[0]?.link ||
              `https://www.google.com/search?q=${encodeURIComponent(fallbackQuery)}`,
            source: "SerpApi",
            sourceId: job.job_id,
            postedAt,
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  // 2. JSearch via RapidAPI
  if (rapidApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    if (onProgress) onProgress("Searching JSearch...");
    try {
      const jsearchParams = new URLSearchParams({
        query: `${baseQuery} in ${zipCode}`,
        page: "1",
        num_pages: "1",
        date_posted: "today",
      });

      const jsearchRes = await fetchWithKeyRotation(rapidApiKeys, async (key) => {
        return fetch(
          `https://jsearch.p.rapidapi.com/search?${jsearchParams.toString()}`,
          {
            method: "GET",
            headers: {
              "X-RapidAPI-Key": key,
              "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
            },
          }
        );
      });
      if (jsearchRes && jsearchRes.ok) {
        const data = await jsearchRes.json();
        const jobs = data.data || [];
        for (const job of jobs) {
          if (signal?.aborted) break;
          try {
            await processJob({
            title: job.job_title,
            company: job.employer_name,
            description: job.job_description,
            location: `${job.job_city || ""}, ${job.job_state || ""}`
              .trim()
              .replace(/^,|,$/g, ""),
            url: job.job_apply_link || job.job_google_link || "",
            source: "JSearch",
            sourceId: job.job_id,
            postedAt: job.job_posted_at_datetime_utc
              ? new Date(job.job_posted_at_datetime_utc)
              : new Date(),
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  // 3. Indeed via RapidAPI
  if (rapidApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    if (onProgress) onProgress("Searching Indeed...");
    try {
      const indeedParams = new URLSearchParams({
        query: baseQuery,
        location: zipCode,
        radius: "50",
        fromage: "1", // Last 24 hours
        sort: "date",
      });

      const indeedRes = await fetchWithKeyRotation(rapidApiKeys, async (key) => {
        return fetch(
          `https://indeed12.p.rapidapi.com/jobs/search?${indeedParams.toString()}`,
          {
            headers: {
              "X-RapidAPI-Key": key,
              "X-RapidAPI-Host": "indeed12.p.rapidapi.com",
            },
          }
        );
      });
      if (indeedRes && indeedRes.ok) {
        const data = await indeedRes.json();
        const jobs = data.hits || data.jobs || data.data || [];
        for (const job of jobs) {
          if (signal?.aborted) break;
          const sourceId = job.id || job.job_id || job.guid || job.url;
          try {
            await processJob({
            title: job.title || job.job_title || "Unknown Title",
            company: job.company_name || "Unknown Company",
            description:
              job.description || job.snippet || "No description provided.",
            location: job.location || "Minneapolis, MN",
            url: job.url || job.job_url || "",
            source: "Indeed",
            sourceId: sourceId,
            postedAt: job.publication_date
              ? new Date(job.publication_date)
              : new Date(),
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  // 4. LinkedIn Job Search API (RapidAPI)
  if (rapidApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    if (onProgress) onProgress("Searching LinkedIn...");
    try {
      const linkedinParams = new URLSearchParams({
        time_frame: "past_24_hours",
        limit: "20",
        offset: "0",
        description_format: "text",
        title: baseQuery,
        location: zipCode,
      });

      const linkedinRes = await fetchWithKeyRotation(rapidApiKeys, async (key) => {
        return fetch(
          `https://linkedin-job-search-api.p.rapidapi.com/active-job?${linkedinParams.toString()}`,
          {
            headers: {
              "X-RapidAPI-Key": key,
              "X-RapidAPI-Host": "linkedin-job-search-api.p.rapidapi.com",
            },
          }
        );
      });
      if (linkedinRes && linkedinRes.ok) {
        const data = await linkedinRes.json();
        const jobs = data.data || [];
        for (const job of jobs) {
          if (signal?.aborted) break;
          try {
            await processJob({
            title: job.title,
            company: job.company?.name || job.company_name || "Unknown Company",
            description: job.description,
            location: job.location || "Minneapolis, MN",
            url: job.url || job.job_url || "",
            source: "LinkedIn",
            sourceId: job.job_id || job.id,
            postedAt: job.posted_date ? new Date(job.posted_date) : new Date(),
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  // 4.5 Workday Jobs API (RapidAPI)
  if (rapidApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    if (onProgress) onProgress("Searching Workday Jobs (RapidAPI)...");
    try {
      const workdayParams = new URLSearchParams({
        title_filter: baseQuery,
        location_filter: zipCode, 
      });

      const workdayRes = await fetchWithKeyRotation(rapidApiKeys, async (key) => {
        return fetch(
          `https://workday-jobs-api.p.rapidapi.com/active-ats-24h?${workdayParams.toString()}`,
          {
            headers: {
              "X-RapidAPI-Key": key,
              "X-RapidAPI-Host": "workday-jobs-api.p.rapidapi.com",
            },
          }
        );
      });

      if (workdayRes && workdayRes.ok) {
        const data = await workdayRes.json();
        const jobs = data.data || data.jobs || [];
        for (const job of jobs) {
          if (signal?.aborted) break;
          try {
            await processJob({
            title: job.title || job.job_title || "Unknown Title",
            company: job.company || "Unknown Company",
            description: job.description || "No description provided.",
            location: job.location || "Minneapolis, MN",
            url: job.url || job.job_url || "",
            source: "Workday (RapidAPI)",
            sourceId: job.id || job.job_id || job.url,
            postedAt: job.posted_date ? new Date(job.posted_date) : new Date(),
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error("Workday RapidAPI Error", e);
    }
  }

  // 4.6 Glassdoor Jobs API (RapidAPI)
  if (rapidApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    if (onProgress) onProgress("Searching Glassdoor Jobs (RapidAPI)...");
    try {
      const gdParams = new URLSearchParams({
        query: baseQuery,
        location: zipCode, 
        fromAge: "1"
      });

      const gdRes = await fetchWithKeyRotation(rapidApiKeys, async (key) => {
        return fetch(
          `https://glassdoor-real-time.p.rapidapi.com/jobs/search?${gdParams.toString()}`,
          {
            headers: {
              "X-RapidAPI-Key": key,
              "X-RapidAPI-Host": "glassdoor-real-time.p.rapidapi.com",
            },
          }
        );
      });

      if (gdRes && gdRes.ok) {
        const data = await gdRes.json();
        const jobs = data.data || data.jobs || [];
        for (const job of jobs) {
          if (signal?.aborted) break;
          try {
            await processJob({
            title: job.title || job.job_title || "Unknown Title",
            company: job.company || job.employerName || "Unknown Company",
            description: job.description || "No description provided.",
            location: job.location || "Minneapolis, MN",
            url: job.url || job.job_url || "",
            source: "Glassdoor (RapidAPI)",
            sourceId: job.id || job.job_id || job.url,
            postedAt: job.posted_date ? new Date(job.posted_date) : new Date(),
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error("Glassdoor RapidAPI Error", e);
    }
  }

  // 4.7 Active Jobs DB (RapidAPI)
  if (rapidApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    if (onProgress) onProgress("Searching Active Jobs DB (RapidAPI)...");
    try {
      const activeJobsParams = new URLSearchParams({
        time_frame: "24h",
        limit: "20",
        offset: "0",
        description_format: "text",
        title: baseQuery,
        location: zipCode
      });

      const activeJobsRes = await fetchWithKeyRotation(rapidApiKeys, async (key) => {
        return fetch(
          `https://active-jobs-db.p.rapidapi.com/active-ats?${activeJobsParams.toString()}`,
          {
            headers: {
              "X-RapidAPI-Key": key,
              "X-RapidAPI-Host": "active-jobs-db.p.rapidapi.com",
            },
          }
        );
      });

      if (activeJobsRes && activeJobsRes.ok) {
        const data = await activeJobsRes.json();
        const jobs = data.data || data.jobs || [];
        for (const job of jobs) {
          if (signal?.aborted) break;
          try {
            await processJob({
            title: job.title || job.job_title || "Unknown Title",
            company: job.company || job.company_name || "Unknown Company",
            description: job.description || "No description provided.",
            location: job.location || "Minneapolis, MN",
            url: job.url || job.job_url || "",
            source: "Active Jobs DB (RapidAPI)",
            sourceId: job.id || job.job_id || job.url,
            postedAt: job.posted_date ? new Date(job.posted_date) : new Date(),
          });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
    } catch (e) {
      console.error("Active Jobs DB RapidAPI Error", e);
    }
  }

  // 5. Direct ATS Ingestion (Greenhouse, Lever, Ashby, Workday)
    if (onProgress) onProgress("Searching Direct ATS Boards...");
    try {
      const LOCATION_KEYWORDS = [
        "minneapolis",
        "st. paul",
        "saint paul",
        "minnesota",
        "mn",
        "554",
        "551",
      ];
      const isLocationMatch = (job: any): boolean => {
        let locationString = "";
        if (typeof job.location === "string")
          locationString = job.location.toLowerCase();
        else if (job.location?.name)
          locationString = job.location.name.toLowerCase();
        else if (job.location?.city || job.location?.region)
          locationString = `${job.location.city || ''} ${job.location.region || ''}`.toLowerCase();
        else if (job.categories?.location)
          locationString = job.categories.location.toLowerCase();
        else if (job.locationsText)
          locationString = job.locationsText.toLowerCase();
        return LOCATION_KEYWORDS.some((kw) => locationString.includes(kw));
      };

      let activeBoards = [];
      if (targetAtsSlugs && targetAtsSlugs.length > 0) {
        activeBoards = await prisma.atsCompany.findMany({
          where: {
            OR: targetAtsSlugs.map(t => ({ slug: t.slug, platform: t.platform }))
          }
        });
      } else {
        activeBoards = await prisma.atsCompany.findMany({
          where: {
            status: "active",
            nextCheckDate: { lte: new Date() },
          }
        });
      }

      for (const board of activeBoards) {
        if (signal?.aborted) break;
        let apiUrl = "";
        let fetchOptions: RequestInit = { signal: AbortSignal.timeout(10000) };

        if (board.platform === "workday") {
          const [company, tenant] = board.slug.split("::");
          const companyWithoutWd = company.split(".")[0];
          apiUrl = `https://${company}.myworkdayjobs.com/wday/cxs/${companyWithoutWd}/${tenant}/jobs`;
          fetchOptions = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              appliedFacets: {},
              limit: 20,
              offset: 0,
              searchText: "",
            }),
            signal: AbortSignal.timeout(10000),
          };
        } else if (board.platform === "workable") {
          apiUrl = `https://apply.workable.com/api/v3/accounts/${board.slug}/jobs`;
          fetchOptions = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [] }),
            signal: AbortSignal.timeout(10000),
          };
        } else if (board.platform === "greenhouse")
          apiUrl = `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`;
        else if (board.platform === "lever")
          apiUrl = `https://api.lever.co/v0/postings/${board.slug}`;
        else if (board.platform === "ashby")
          apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${board.slug}`;
        else if (board.platform === "smartrecruiters")
          apiUrl = `https://api.smartrecruiters.com/v1/companies/${board.slug}/postings`;
        else if (board.platform === "bamboohr")
          apiUrl = `https://${board.slug}.bamboohr.com/careers/list`;


        if (!apiUrl) continue;

        try {
          const res = await fetch(apiUrl, fetchOptions);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const data = await res.json();
          let jobs = [];
          if (board.platform === "lever")
            jobs = Array.isArray(data) ? data : [];
          else if (board.platform === "workday") jobs = data.jobPostings || [];
          else if (board.platform === "smartrecruiters") jobs = data.content || [];
          else if (board.platform === "workable") jobs = data.results || [];
          else if (board.platform === "bamboohr") jobs = data.result || [];
          else jobs = data.jobs || [];

          if (jobs.length === 0) {
            // Empty, but not a failure. Just means no open jobs.
            await prisma.atsCompany.update({
              where: {
                slug_platform: { slug: board.slug, platform: board.platform },
              },
              data: {
                failCount: 0,
                lastCheckedAt: new Date(),
              },
            });
            continue;
          }

          // Process jobs
          let mnJobsFound = 0;
          for (const job of jobs) {
            if (!isLocationMatch(job)) continue;
            mnJobsFound++;

            // Strip HTML tags for clean text to save tokens
            let rawDescription =
              job.content || job.description || job.descriptionPlain || "";
            if (board.platform === "workday" && job.externalPath) {
              const [company, tenant] = board.slug.split("::");
              const companyWithoutWd = company.split(".")[0];
              const singleJobUrl = `https://${company}.myworkdayjobs.com/wday/cxs/${companyWithoutWd}/${tenant}${job.externalPath}`;
              try {
                const res = await fetch(singleJobUrl, { headers: { "Accept": "application/json" } });
                if (res.ok) {
                  const singleJobData = await res.json();
                  if (singleJobData.jobPostingInfo?.jobDescription) {
                    rawDescription = singleJobData.jobPostingInfo.jobDescription;
                  }
                }
              } catch (e) {
                console.error("Failed to fetch Workday job desc:", e);
              }
              // Fallback if the fetch fails
              if (!rawDescription && job.bulletFields) {
                rawDescription = job.bulletFields.join("\n");
              }
            }
            if (board.platform === "lever") {
              if (job.lists && Array.isArray(job.lists)) {
                job.lists.forEach((list: any) => {
                  if (list.text) rawDescription += `\n\n${list.text}`;
                  if (list.content) rawDescription += `\n${list.content}`;
                });
              }
              if (job.additional) {
                rawDescription += `\n\n${job.additional}`;
              } else if (job.additionalPlain) {
                rawDescription += `\n\n${job.additionalPlain}`;
              }
            }
            const cleanDescription = cleanHtmlText(rawDescription);

            let sourceId = job.id?.toString();
            if (board.platform === "workday" && job.externalPath)
              sourceId = job.externalPath;

            if (!sourceId) continue;

            let title = job.title || job.name || job.jobOpeningName || "Unknown Title";
            let company = board.slug; // Fallback
            let locationStr = "Unknown Location";
            let url = job.absolute_url || job.hostedUrl || job.jobUrl || "";

            if (board.platform === "workday") {
              const [c, tenant] = board.slug.split("::");
              url = `https://${c}.myworkdayjobs.com/en-US/${tenant}${job.externalPath}`;
            } else if (board.platform === "smartrecruiters") {
              url = `https://jobs.smartrecruiters.com/${board.slug}/${job.id}`;
            } else if (board.platform === "workable") {
              url = `https://apply.workable.com/${board.slug}/j/${job.shortcode}`;
            } else if (board.platform === "bamboohr") {
              url = `https://${board.slug}.bamboohr.com/careers/${job.id}`;
            }

            // Parse platform specifics
            if (board.platform === "lever") {
              company = job.categories?.team || board.slug;
              locationStr = job.categories?.location || "Unknown";
            } else if (board.platform === "greenhouse") {
              company = data.name || board.slug;
              locationStr = job.location?.name || "Unknown";
            } else if (board.platform === "ashby") {
              const decodedSlug = decodeURIComponent(board.slug);
              company = decodedSlug.split(/[-_ ]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              locationStr = job.location || "Unknown";
            } else if (board.platform === "workday") {
              company = board.slug.split("::")[0];
              locationStr = job.locationsText || "Unknown";
            } else if (board.platform === "smartrecruiters") {
              company = data.company?.name || board.slug;
              locationStr = job.location?.city ? `${job.location.city}, ${job.location.region || ''}` : "Unknown";
            } else if (board.platform === "workable") {
              company = board.slug;
              locationStr = job.location?.city ? `${job.location.city}, ${job.location.region || ''}` : "Unknown";
            } else if (board.platform === "bamboohr") {
              company = board.slug;
              locationStr = job.location?.city || "Unknown";
            }

            let postedAt =
              job.updated_at || job.createdAt || job.publishedAt
                ? new Date(job.updated_at || job.createdAt || job.publishedAt)
                : new Date();

            try {
            await processJob({
              title,
              company,
              description: cleanDescription,
              location: locationStr,
              url,
              source: `ATS-${board.platform}`,
              sourceId,
              postedAt,
            });
          } catch (err) {
            console.error("Error processing single job:", err);
          }
          }

          // Reset fail count and set next check to tomorrow
          const nextCheck = new Date();
          nextCheck.setDate(nextCheck.getDate() + 1);
          await prisma.atsCompany.update({
            where: {
              slug_platform: { slug: board.slug, platform: board.platform },
            },
            data: {
              failCount: 0,
              nextCheckDate: nextCheck,
              lastCheckedAt: new Date(),
              jobsFound: mnJobsFound,
            },
          });
        } catch (err) {
          console.error(`Error fetching ATS board ${board.slug}:`, err);
          // On error, increment fail count
          const newFailCount = board.failCount + 1;
          const newStatus = newFailCount >= 3 ? "blacklisted" : "parked";
          const nextCheck = new Date();
          nextCheck.setDate(nextCheck.getDate() + 30);

          await prisma.atsCompany.update({
            where: {
              slug_platform: { slug: board.slug, platform: board.platform },
            },
            data: {
              failCount: newFailCount,
              status: newStatus,
              nextCheckDate: nextCheck,
              lastCheckedAt: new Date(),
            },
          });
        }
      }
    } catch (e) {
      console.error(e);
    }

    return newJobsCount;
  }
