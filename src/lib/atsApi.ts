import { gunzipSync } from 'node:zlib';

import { cleanHtmlText } from '@/lib/jobIngestion';
import { assessJobDescriptionQuality } from '@/lib/jobDescriptionQuality';
import { assertSafeExternalUrl, safeExternalFetch } from '@/lib/safeExternalFetch';

function isDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export type AtsScrapeResult = { text: string, ats: string, atsSlug?: string, platform?: string, title?: string };

export async function scrapeAtsApi(url: string): Promise<AtsScrapeResult | null> {
  try {
    const parsed = await assertSafeExternalUrl(url);
    const host = parsed.hostname.toLowerCase();
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    // DEjobs / jobsyn.org (CareerForce's syndication network)
    if (isDomain(host, 'jobsyn.org') || isDomain(host, 'dejobs.org')) {
      return await scrapeDejobsPosting(url);
    }

    // Greenhouse
    // Standard: https://boards.greenhouse.io/{company}/jobs/{jobId}
    // Embedded: https://www.company.com/careers/?gh_jid={jobId}
    const ghJidMatch = url.match(/[?&]gh_jid=([^&#]+)/);
    if ((isDomain(host, 'greenhouse.io') && pathParts.length >= 3 && pathParts[1] === 'jobs') || ghJidMatch) {
      let company = pathParts[0];
      let jobId = pathParts.length >= 3 ? pathParts[2] : '';

      if (ghJidMatch) {
        jobId = ghJidMatch[1];
        // For embedded boards, we need the board token. Often it's the hostname without TLD, 
        // or we can fetch the page and extract it from the iframe embed URL.
        const pageRes = await safeExternalFetch(url).catch(() => null);
        if (pageRes && pageRes.ok) {
          const html = await pageRes.text();
          const embedMatch = html.match(/boards\.greenhouse\.io\/embed\/job_app\?for=([^&"']+)/);
          if (embedMatch) {
            company = embedMatch[1];
          } else {
            // Fallback: guess from hostname (e.g. www.equipmentshare.com -> equipmentsharecom)
            company = host.replace(/^www\./, '').replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '') + 'com';
            // It could be 'com' or not, we'll try with 'com' first if guessing, but usually scraping the embed link works perfectly.
          }
        }
      }

      if (company && jobId) {
        const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company)}/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          let cleanTitle = data.title;
          if (cleanTitle) {
             cleanTitle = cleanTitle.replace(/^Job Application for /i, '');
             cleanTitle = cleanTitle.replace(/ at .*$/i, '');
             cleanTitle = cleanTitle.trim();
          }
          return { text: cleanHtmlText(data.content || ''), ats: 'Greenhouse', atsSlug: company, platform: 'greenhouse', title: cleanTitle };
        }
      }
    }

    // Lever
    // https://jobs.lever.co/{company}/{jobId}
    if (isDomain(host, 'lever.co') && pathParts.length >= 2) {
      const company = pathParts[0];
      const jobId = pathParts[1];
      const res = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        
        let rawDescription = data.descriptionPlain || data.description || '';
        if (data.lists && Array.isArray(data.lists)) {
          data.lists.forEach((list: { text?: string; content?: string }) => {
            if (list.text) rawDescription += `\n\n${list.text}`;
            if (list.content) rawDescription += `\n${list.content}`;
          });
        }
        if (data.additional) {
          rawDescription += `\n\n${data.additional}`;
        } else if (data.additionalPlain) {
          rawDescription += `\n\n${data.additionalPlain}`;
        }
        
        return { text: cleanHtmlText(rawDescription), ats: 'Lever', atsSlug: company, platform: 'lever', title: data.text };
      }
    }

    // Ashby
    // https://jobs.ashbyhq.com/{company}/{jobId}
    if (isDomain(host, 'ashbyhq.com') && pathParts.length >= 2) {
      const company = decodeURIComponent(pathParts[0]);
      const jobId = pathParts[1];
      const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company)}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        const job = data.jobs?.find((candidate: {
          id?: string;
          descriptionHtml?: string;
          descriptionPlain?: string;
          title?: string;
        }) => candidate.id === jobId);
        if (job) {
          return { text: cleanHtmlText(job.descriptionHtml || job.descriptionPlain || ''), ats: 'Ashby', atsSlug: company, platform: 'ashby', title: job.title };
        }
      }
    }
    
    // Workday (Basic heuristic)
    if (isDomain(host, 'myworkdayjobs.com')) {
      const jobIndex = pathParts.indexOf('job');
      if (jobIndex >= 1 && pathParts.length > jobIndex + 1) {
        const tenant = host.split('.')[0];
        const companySite = pathParts[jobIndex - 1];
        const jobPath = pathParts.slice(jobIndex + 1).join('/'); // Includes the whole path after /job/
        
        const encodedJobPath = jobPath.split('/').map(encodeURIComponent).join('/');
        const apiUrl = `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(companySite)}/job/${encodedJobPath}`;
        const res = await safeExternalFetch(apiUrl, {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10000)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.jobPostingInfo?.jobDescription) {
            return { text: cleanHtmlText(data.jobPostingInfo.jobDescription), ats: 'Workday', atsSlug: `${tenant}::${companySite}`, platform: 'workday', title: data.jobPostingInfo.title };
          }
        }
      }
    }

    return null;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw e;
    }
    console.error("ATS API Scraping error:", e);
    return null;
  }
}

/**
 * `de.jobsyn.org/<id>` 301-redirects to either the employer's own ATS or a
 * `<employer>.dejobs.org/.../<JOB_ID>/job/` detail page. That page is a
 * client-rendered Nuxt SPA -- `data-ssr="false"`, zero characters of
 * server-rendered text -- so a plain fetch of it returns an empty shell no
 * matter how the redirect was reached. Its bootstrap config exposes a fixed
 * `"job-folder":"ALL_JOBS"` and the page's own XHR (watched in devtools)
 * reveals the real route: a static, gzip-served JSON file per posting at
 * `microsites.dejobs.org`, keyed by the 32-character hex ID already in the
 * detail URL. No rendering required, and it responds in well under a second.
 */
const DEJOBS_JOB_ID_PATTERN = /\/([0-9a-f]{32})\/job\/?(?:[/?#]|$)/i;

export function extractDejobsJobId(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(DEJOBS_JOB_ID_PATTERN);
    return match ? match[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * The JSON's `description` is Markdown, padded with the site's own layout
 * whitespace (runs of two-space-then-newline between every block). Strip the
 * bold markers and `+` bullets so the stored text reads like prose rather
 * than raw Markdown, and collapse the padding rather than storing it.
 */
export function cleanDejobsMarkdown(markdown: string): string {
  return markdown
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .split('\n')
    .map((line) => line.trim().replace(/^\+\s+/, '- '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The static JSON file is served with `content-encoding: gzip` even when the
 * request states `accept-encoding: identity` -- observed against a live
 * posting, not documented behaviour -- so `safeExternalFetch`'s pinned
 * transport (which intentionally never content-decodes) hands back gzip
 * bytes verbatim. Decompress by header rather than assuming either way.
 */
async function readSafeFetchText(res: Response): Promise<string> {
  const buffer = Buffer.from(await res.arrayBuffer());
  if ((res.headers.get('content-encoding') || '').toLowerCase().includes('gzip')) {
    return gunzipSync(buffer).toString('utf-8');
  }
  return buffer.toString('utf-8');
}

async function scrapeDejobsPosting(url: string): Promise<AtsScrapeResult | null> {
  const pageRes = await safeExternalFetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!pageRes) return null;
  const landedUrl = pageRes.url || url;

  const jobId = extractDejobsJobId(landedUrl);
  if (jobId) {
    const jsonRes = await safeExternalFetch(
      `https://microsites.dejobs.org/ALL_JOBS/${jobId}.json`,
      { signal: AbortSignal.timeout(10000) },
    ).catch(() => null);
    if (!jsonRes || !jsonRes.ok) return null;
    let data: { description?: string; title?: string } | null = null;
    try {
      data = JSON.parse(await readSafeFetchText(jsonRes));
    } catch {
      return null;
    }
    if (!data?.description) return null;
    return { text: cleanDejobsMarkdown(data.description), ats: 'DEJobs', platform: 'dejobs', title: data.title };
  }

  // The redirect chain left the dejobs network entirely -- most often landing
  // on the employer's own ATS -- so hand the resolved URL to the matchers
  // above for structured extraction (Workday's is far cleaner than a raw page
  // scrape) before falling back to the page already fetched.
  let landedHost = '';
  try { landedHost = new URL(landedUrl).hostname.toLowerCase(); } catch { /* keep the raw-page fallback below */ }
  const originalHost = new URL(url).hostname.toLowerCase();
  if (landedHost && landedHost !== originalHost && !isDomain(landedHost, 'jobsyn.org') && !isDomain(landedHost, 'dejobs.org')) {
    const structured = await scrapeAtsApi(landedUrl);
    if (structured) return structured;
  }

  if (!pageRes.ok) return null;
  const text = cleanHtmlText(await readSafeFetchText(pageRes));
  // Unlike the JSON `description` field above, this is an unstructured page
  // scrape -- the same trust level as jobScoring's own naive-fetch fallback,
  // not the ATS API branches above whose callers treat any non-null result as
  // a complete JD. Self-validate with the full (non-structured) gate so a
  // page that is really an apply-form portal shell -- real prose, real
  // length, zero duties or qualifications content -- returns null instead of
  // masquerading as a recovered posting.
  const quality = assessJobDescriptionQuality(text);
  return quality.scorable ? { text, ats: 'DEJobs (redirect)', platform: 'dejobs' } : null;
}
// PR 7 Direct ATS Discovery Repair
// PR 8 Direct ATS Adapter Hardening
