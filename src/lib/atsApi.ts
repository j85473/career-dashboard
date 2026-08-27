import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';

import { cleanHtmlText } from '@/lib/jobIngestion';
import { assessJobDescriptionQuality } from '@/lib/jobDescriptionQuality';
import { assertSafeExternalUrl, safeExternalFetch } from '@/lib/safeExternalFetch';
import { boardSlugFromJobUrl } from '@/lib/atsBoardYield';
import { workdayHiringOrganizationName } from '@/lib/workdayCompany';
import { workdayDetailLocation } from '@/lib/workdayLocation';

function isDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export type AtsScrapeResult = {
  text: string,
  ats: string,
  atsSlug?: string,
  platform?: string,
  title?: string,
  company?: string,
  location?: string,
};

type IcimsJobData = {
  idRaw?: number | string;
  title?: string;
  company?: string;
  location?: {
    city?: string;
    state?: string;
    country?: string;
  };
};

type ComeetCompanyData = {
  name?: unknown;
  company_uid?: unknown;
};

type ComeetPositionData = {
  name?: unknown;
  uid?: unknown;
  company_name?: unknown;
  custom_fields?: {
    details?: unknown;
  };
  location?: {
    name?: unknown;
    city?: unknown;
    state?: unknown;
  };
};

export type ComeetPostingIdentity = {
  companySlug: string;
  companyUid: string;
  positionUid: string;
};

const ICIMS_JOB_PATH_PATTERN = /^\/jobs\/(\d+)((?:\/[^/?#]+)*)\/(?:job|login)\/?$/i;

// iCIMS returned HTTP 405 for the longer Chrome-identifying UA used by the
// generic JSON-LD scraper while serving the same public iframe normally for
// this minimal browser token. Keep this adapter's transport behavior isolated
// from unrelated page scrapers so a future generic-UA change cannot break it.
export const ICIMS_FETCH_USER_AGENT = 'Mozilla/5.0';

export const COMEET_FETCH_USER_AGENT = 'Mozilla/5.0';

/**
 * Comeet/Spark Hire Recruit hosted postings encode both stable provider IDs in
 * the path. Company-only boards stop after the company UID and are deliberately
 * excluded because this adapter recovers one exact public posting at a time.
 */
export function parseComeetPostingUrl(value: string): ComeetPostingIdentity | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (!isDomain(host, 'comeet.com') && !isDomain(host, 'comeet.co')) return null;
    const pathParts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (pathParts.length < 5 || pathParts[0].toLowerCase() !== 'jobs') return null;
    const companySlug = pathParts[1].trim();
    const companyUid = pathParts[2].trim();
    const positionUid = pathParts[pathParts.length - 1].trim();
    if (!companySlug || !/^[a-z0-9.-]+$/i.test(companyUid) || !/^[a-z0-9.-]+$/i.test(positionUid)) return null;
    return { companySlug, companyUid, positionUid };
  } catch {
    return null;
  }
}

/**
 * Parse a JSON object assigned to a named page variable without evaluating the
 * surrounding JavaScript. Comeet emits COMPANY_DATA and POSITION_DATA as
 * JSON-compatible object literals, but values can contain braces and escaped
 * quotes, so a balanced scanner is safer than a non-greedy regular expression.
 */
function parseAssignedJsonObject(source: string, variableName: string): Record<string, unknown> | null {
  const safeName = variableName.replace(/[^a-z0-9_$]/gi, '');
  const assignment = new RegExp(`\\b${safeName}\\s*=\\s*\\{`, 'i').exec(source);
  if (!assignment) return null;

  const start = assignment.index + assignment[0].lastIndexOf('{');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character !== '}') continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      const parsed = JSON.parse(source.slice(start, index + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function comeetLocation(position: ComeetPositionData): string | undefined {
  const city = typeof position.location?.city === 'string' ? position.location.city.trim() : '';
  const state = typeof position.location?.state === 'string' ? position.location.state.trim() : '';
  if (city) return state ? `${city}, ${state}` : city;
  const name = typeof position.location?.name === 'string' ? position.location.name.trim() : '';
  return name || undefined;
}

/**
 * Comeet renders with Angular, so the visible body in the initial response is
 * only a template. The same response embeds the exact provider-owned company
 * and position objects. Extract only their labeled description fields and
 * verify both path identities before returning any data.
 */
export function parseComeetPostingHtml(
  html: string,
  expected?: Pick<ComeetPostingIdentity, 'companyUid' | 'positionUid'>,
): AtsScrapeResult | null {
  if (!html) return null;
  const company = parseAssignedJsonObject(html, 'COMPANY_DATA') as ComeetCompanyData | null;
  const position = parseAssignedJsonObject(html, 'POSITION_DATA') as ComeetPositionData | null;
  if (!company || !position) return null;

  const companyUid = typeof company.company_uid === 'string' ? company.company_uid.trim() : '';
  const positionUid = typeof position.uid === 'string' ? position.uid.trim() : '';
  if (!companyUid || !positionUid) return null;
  if (expected && (companyUid !== expected.companyUid || positionUid !== expected.positionUid)) return null;

  const rawDetails = Array.isArray(position.custom_fields?.details) ? position.custom_fields.details : [];
  const details = rawDetails
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    .map((value, index) => ({
      name: typeof value.name === 'string' ? value.name.trim() : '',
      body: typeof value.value === 'string' ? cleanHtmlText(value.value) : '',
      order: typeof value.order === 'number' && Number.isFinite(value.order) ? value.order : index,
    }))
    .filter((value) => value.body)
    .sort((left, right) => left.order - right.order);
  const text = details.map((value) => value.name ? `${value.name}\n${value.body}` : value.body).join('\n\n').trim();
  if (!text || !assessJobDescriptionQuality(text, { structuredSource: true }).scorable) return null;

  const title = typeof position.name === 'string' && position.name.trim() ? position.name.trim() : undefined;
  const positionCompany = typeof position.company_name === 'string' ? position.company_name.trim() : '';
  const companyName = positionCompany
    || (typeof company.name === 'string' ? company.name.trim() : '')
    || undefined;
  const location = comeetLocation(position);

  return {
    text,
    ats: 'Comeet',
    atsSlug: companyUid,
    platform: 'comeet',
    ...(title ? { title } : {}),
    ...(companyName ? { company: companyName } : {}),
    ...(location ? { location } : {}),
  };
}

/** Fetch and parse one public Comeet/Spark Hire Recruit hosted posting. */
export async function scrapeComeetPosting(url: string): Promise<AtsScrapeResult | null> {
  const identity = parseComeetPostingUrl(url);
  if (!identity) return null;
  const response = await safeExternalFetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': COMEET_FETCH_USER_AGENT,
    },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  return parseComeetPostingHtml(await readSafeFetchText(response), identity);
}

/**
 * iCIMS' public job URL is usually an employer-branded wrapper. The wrapper
 * creates a same-origin iframe with `in_iframe=1`; that response is the actual
 * iCIMS job document and contains the posting fields without authentication or
 * browser rendering. Preserve tenant-specific query parameters and change only
 * the render-mode flag.
 */
export function buildIcimsIframeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!isDomain(url.hostname.toLowerCase(), 'icims.com')) return null;
    const pathMatch = url.pathname.match(ICIMS_JOB_PATH_PATTERN);
    if (!pathMatch) return null;
    // Aggregators often store iCIMS' application/login route. The public job
    // document uses the same id/slug at `/job`, so normalize before selecting
    // iframe mode instead of scraping a login wall.
    url.pathname = `/jobs/${pathMatch[1]}${pathMatch[2]}/job`;
    url.searchParams.set('in_iframe', '1');
    return url;
  } catch {
    return null;
  }
}

/**
 * Read a JSON array assigned in an inline script without evaluating JavaScript.
 * iCIMS exposes useful job metadata through `dataLayer = [{ ... }]`, and a
 * balanced scanner safely tolerates nested arrays plus brackets inside quoted
 * strings that a non-greedy regular expression would truncate.
 */
function parseAssignedJsonArray(source: string, variableName: string): unknown[] | null {
  const assignment = new RegExp(`\\b${variableName.replace(/[^a-z0-9_$]/gi, '')}\\s*=\\s*\\[`, 'i').exec(source);
  if (!assignment) return null;

  const start = assignment.index + assignment[0].lastIndexOf('[');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') depth += 1;
    if (character !== ']') continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      const parsed = JSON.parse(source.slice(start, index + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function icimsJobData($: cheerio.CheerioAPI): IcimsJobData | null {
  for (const script of $('script:not([src])').toArray()) {
    const values = parseAssignedJsonArray($(script).contents().text(), 'dataLayer');
    if (!values) continue;
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const job = (value as { job?: unknown }).job;
      if (job && typeof job === 'object') return job as IcimsJobData;
    }
  }
  return null;
}

function icimsLocation(job: IcimsJobData | null, $: cheerio.CheerioAPI): string | undefined {
  const city = typeof job?.location?.city === 'string' ? job.location.city.trim() : '';
  const state = typeof job?.location?.state === 'string' ? job.location.state.trim() : '';
  if (city) return state ? `${city}, ${state}` : city;

  const displayed = $('.iCIMS_JobsTable .header.left > span:not(.sr-only)').first().text().trim();
  if (!displayed) return undefined;
  return displayed
    .split(/\s*\|\s*/)
    .map((part) => {
      const cityAndState = part.match(/^US-([A-Z]{2})-(.+)$/i);
      if (cityAndState) return `${cityAndState[2].trim()}, ${cityAndState[1].toUpperCase()}`;
      const stateOnly = part.match(/^US-([A-Z]{2})$/i);
      return stateOnly ? stateOnly[1].toUpperCase() : part;
    })
    .join(' | ');
}

/**
 * Parse only platform-labeled iCIMS description fields. Keeping application
 * controls, cookie warnings, sharing widgets, and the employer-branded outer
 * page out of `text` prevents a long portal shell from masquerading as a JD.
 */
export function parseIcimsPostingHtml(html: string, expectedJobId?: string): AtsScrapeResult | null {
  if (!html) return null;
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return null;
  }

  const job = icimsJobData($);
  const embeddedJobId = job?.idRaw == null ? '' : String(job.idRaw).trim();
  if (expectedJobId && embeddedJobId && embeddedJobId !== expectedJobId) return null;

  const title = $('h1.iCIMS_Header').first().text().replace(/\s+/g, ' ').trim()
    || (typeof job?.title === 'string' ? job.title.trim() : '');
  if (!title) return null;

  const sections: string[] = [];
  const seenHeadings = new Set<string>();
  $('h2.iCIMS_InfoField_Job').each((_index, headingElement) => {
    const heading = $(headingElement).text().replace(/\s+/g, ' ').trim();
    const bodyElement = $(headingElement).next('.iCIMS_InfoMsg_Job');
    const body = cleanHtmlText(bodyElement.html() || bodyElement.text());
    const headingKey = heading.toLowerCase();
    if (!heading || !body || seenHeadings.has(headingKey)) return;
    seenHeadings.add(headingKey);
    sections.push(`${heading}\n${body}`);
  });

  const text = sections.join('\n\n').trim();
  if (!text || !assessJobDescriptionQuality(text, { structuredSource: true }).scorable) return null;

  const location = icimsLocation(job, $);
  return {
    text,
    ats: 'iCIMS',
    platform: 'icims',
    title,
    ...(location ? { location } : {}),
  };
}

/** Fetch and parse the public iCIMS job document without using Jina. */
export async function scrapeIcimsPosting(url: string): Promise<AtsScrapeResult | null> {
  const iframeUrl = buildIcimsIframeUrl(url);
  if (!iframeUrl) return null;
  const jobId = iframeUrl.pathname.match(ICIMS_JOB_PATH_PATTERN)?.[1];
  if (!jobId) return null;

  const response = await safeExternalFetch(iframeUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': ICIMS_FETCH_USER_AGENT,
    },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  return parseIcimsPostingHtml(await readSafeFetchText(response), jobId);
}

/**
 * Fetches Workday's CXS detail response without requiring a scorable JD.
 * Company and location remain authoritative structured metadata even when a
 * closed or sparse posting has no usable description.
 */
export async function scrapeWorkdayPostingDetail(url: string): Promise<AtsScrapeResult | null> {
  const parsed = await assertSafeExternalUrl(url);
  const host = parsed.hostname.toLowerCase();
  if (!isDomain(host, 'myworkdayjobs.com')) return null;

  const boardSlug = boardSlugFromJobUrl(url, 'workday');
  if (!boardSlug) return null;

  const pathParts = parsed.pathname.split('/').filter(Boolean);
  const jobIndex = pathParts.findIndex((part) => part.toLowerCase() === 'job');
  if (jobIndex < 1 || pathParts.length <= jobIndex + 1) return null;

  const tenant = host.split('.')[0];
  const companySite = pathParts[jobIndex - 1];
  const jobPath = pathParts.slice(jobIndex + 1).join('/');
  const encodedJobPath = jobPath.split('/').map(encodeURIComponent).join('/');
  const apiUrl = `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(companySite)}/job/${encodedJobPath}`;
  const res = await safeExternalFetch(apiUrl, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;

  const data = await res.json();
  const postingInfo = data?.jobPostingInfo;
  const company = workdayHiringOrganizationName(data?.hiringOrganization) || undefined;
  const location = workdayDetailLocation(postingInfo) || undefined;
  const text = cleanHtmlText(
    typeof postingInfo?.jobDescription === 'string' ? postingInfo.jobDescription : '',
  );
  if (!postingInfo && !company && !location) return null;

  return {
    text,
    ats: 'Workday',
    // The CXS path uses the shardless tenant above, but the schedulable board
    // identity must retain the public hostname shard (for example `.wd5`).
    atsSlug: boardSlug,
    platform: 'workday',
    ...(typeof postingInfo?.title === 'string' && postingInfo.title.trim()
      ? { title: postingInfo.title.trim() }
      : {}),
    ...(company ? { company } : {}),
    ...(location ? { location } : {}),
  };
}

export async function scrapeAtsApi(url: string): Promise<AtsScrapeResult | null> {
  try {
    const parsed = await assertSafeExternalUrl(url);
    const host = parsed.hostname.toLowerCase();
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    // DEjobs / jobsyn.org (CareerForce's syndication network)
    if (isDomain(host, 'jobsyn.org') || isDomain(host, 'dejobs.org')) {
      return await scrapeDejobsPosting(url);
    }

    // iCIMS public career portal iframe
    if (isDomain(host, 'icims.com')) {
      const detail = await scrapeIcimsPosting(url);
      if (detail) return detail;
    }

    // Comeet / Spark Hire Recruit public hosted posting
    if (isDomain(host, 'comeet.com') || isDomain(host, 'comeet.co')) {
      const detail = await scrapeComeetPosting(url);
      if (detail) return detail;
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
    
    // Workday
    if (isDomain(host, 'myworkdayjobs.com')) {
      const detail = await scrapeWorkdayPostingDetail(url);
      if (detail) return detail;
    }

    // Every platform-specific branch above missed. schema.org `JobPosting`
    // JSON-LD is a web standard, not an ATS feature -- Breezy embeds it despite
    // having no JSON detail route at all, and it turns out several platforms
    // above (Workday, Teamtailor) carry it too, alongside boards this function
    // has no dedicated branch for. Fetch the page itself and look for that
    // block before giving up to the caller's (paid) Jina fallback.
    return await scrapeJsonLdJobPosting(url);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw e;
    }
    console.error("ATS API Scraping error:", e);
    return null;
  }
}

type JsonLdAddress = {
  addressLocality?: unknown;
  addressRegion?: unknown;
  addressCountry?: unknown;
};

type JsonLdPlace = {
  address?: JsonLdAddress;
};

export type JsonLdJobPosting = {
  '@type'?: unknown;
  description?: unknown;
  title?: unknown;
  hiringOrganization?: { name?: unknown } | string;
  jobLocation?: JsonLdPlace | JsonLdPlace[];
  employmentType?: unknown;
  datePosted?: unknown;
};

/**
 * A page can carry several `ld+json` blocks (breadcrumbs, org info, review
 * snippets, ...) and the value can be a bare object, an array of objects, or
 * an object using `@graph`. `@type` can itself be a string or an array (a
 * posting tagged both `JobPosting` and `Product`, for instance). A block that
 * fails to parse -- or an entry whose type isn't `JobPosting` -- is skipped
 * rather than thrown on, since most of what's on a real page is not the
 * posting itself.
 */
export function extractJsonLdJobPosting(html: string): JsonLdJobPosting | null {
  if (!html) return null;
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return null;
  }

  for (const script of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(script).contents().text().trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const candidates: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    for (const entry of [...candidates]) {
      const graph = entry && typeof entry === 'object' ? (entry as { '@graph'?: unknown })['@graph'] : undefined;
      if (Array.isArray(graph)) candidates.push(...graph);
    }

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const type = (candidate as JsonLdJobPosting)['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (types.some((t) => t === 'JobPosting')) {
        return candidate as JsonLdJobPosting;
      }
    }
  }
  return null;
}

/** `hiringOrganization` is usually `{ name }`, occasionally a bare string. */
export function jsonLdCompanyName(hiringOrganization: JsonLdJobPosting['hiringOrganization']): string | null {
  if (typeof hiringOrganization === 'string') {
    return hiringOrganization.trim() || null;
  }
  if (hiringOrganization && typeof hiringOrganization === 'object') {
    const name = (hiringOrganization as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

/**
 * Joins `addressLocality, addressRegion` the way `splitLocationOptions` and
 * the geography gate expect ("Louisville, KY"), the same shape the dejobs
 * fix already builds from its own city/state fields. Deliberately returns
 * null whenever there is no locality at all, even if `addressCountry` is
 * present -- a bare country is never worth trading a caller's existing,
 * more specific stored value for.
 */
export function jsonLdLocationString(jobLocation: JsonLdJobPosting['jobLocation']): string | null {
  const places = Array.isArray(jobLocation) ? jobLocation : jobLocation ? [jobLocation] : [];
  for (const place of places) {
    const address = place?.address;
    if (!address || typeof address !== 'object') continue;
    const locality = typeof address.addressLocality === 'string' ? address.addressLocality.trim() : '';
    if (!locality) continue;
    const region = typeof address.addressRegion === 'string' ? address.addressRegion.trim() : '';
    return region ? `${locality}, ${region}` : locality;
  }
  return null;
}

/**
 * `safeExternalFetch`'s pinned transport otherwise sends no `User-Agent` at
 * all -- fine for a JSON API, but a CloudFront-fronted HTML page (Breezy
 * itself, verified live) answers that with a WAF 403 rather than the page.
 * Plain `fetch()` against the same URL succeeds because it does supply one;
 * this mirrors the browser UA `tryFetchFullDescription`'s own page-scrape
 * fallback in jobIngestion.ts already sends for the same reason.
 */
export const JSON_LD_FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Generic replacement for a chunk of Jina traffic, not a Breezy-specific
 * branch -- called only once every platform-specific matcher above has
 * missed. A raw page fetch is the same trust level as `scrapeDejobsPosting`'s
 * own redirect-page fallback, not the platform API branches above whose
 * callers treat any non-null result as a complete JD, so this self-validates
 * with the full (non-structured) quality gate. That is the rule that caught
 * the isolved portal shell: real prose, real length, zero duties or
 * qualifications content, so never accept an extraction merely because a
 * field existed or a length looked right.
 */
async function scrapeJsonLdJobPosting(url: string): Promise<AtsScrapeResult | null> {
  const pageRes = await safeExternalFetch(url, {
    headers: { 'User-Agent': JSON_LD_FETCH_USER_AGENT },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!pageRes || !pageRes.ok) return null;

  const jobPosting = extractJsonLdJobPosting(await readSafeFetchText(pageRes));
  if (!jobPosting) return null;

  const text = typeof jobPosting.description === 'string' ? cleanHtmlText(jobPosting.description) : '';
  if (!text) return null;

  const quality = assessJobDescriptionQuality(text);
  if (!quality.scorable) return null;

  const title = typeof jobPosting.title === 'string' && jobPosting.title.trim() ? jobPosting.title.trim() : undefined;
  const company = jsonLdCompanyName(jobPosting.hiringOrganization) ?? undefined;
  const location = jsonLdLocationString(jobPosting.jobLocation) ?? undefined;

  return {
    text,
    ats: 'JobPosting JSON-LD',
    platform: 'jsonld',
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
    ...(location ? { location } : {}),
  };
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
 *
 * The endpoint is case-sensitive -- the lowercase form of a real key 404s,
 * only the uppercase form 200s (verified live) -- so every extractor below
 * uppercases explicitly rather than trusting the source casing.
 */
const DEJOBS_JOB_ID_PATTERN = /\/([0-9a-f]{32})\/job\/?(?:[/?#]|$)/i;

export function extractDejobsJobId(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(DEJOBS_JOB_ID_PATTERN);
    return match ? match[1].slice(0, 32).toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * `de.jobsyn.org/<id>` itself already carries the microsites key -- `<id>` is
 * the 32-character job GUID with a 4-character site id (`?vs=` on the detail
 * page) concatenated directly after it, no separator, always lowercase.
 * Slicing it out here and hitting the JSON endpoint directly (tried before
 * any redirect is followed) skips a dependency `extractDejobsJobId` has no
 * control over: the redirect chain landing on a `/job/` URL at all. Verified
 * live against a spread of stuck postings whose apply link resolves to ADP,
 * Oracle Cloud, ApplicantPro, and a custom domain (`jobsus.deloitte.com`)
 * that a plain fetch can't even TLS-connect to -- every one of them still
 * 200s at this derived key, because DEJobs assigns a GUID to every syndicated
 * posting regardless of where the employer's real apply link points.
 */
const DEJOBS_SHORTLINK_ID_PATTERN = /^([0-9a-f]{32})[0-9a-f]{0,4}$/i;

export function extractDejobsShortlinkId(url: string): string | null {
  try {
    const pathParts = new URL(url).pathname.split('/').filter(Boolean);
    if (pathParts.length !== 1) return null;
    const match = pathParts[0].match(DEJOBS_SHORTLINK_ID_PATTERN);
    return match ? match[1].slice(0, 32).toUpperCase() : null;
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

/**
 * The JSON carries far more than `description` -- `company`, `city`,
 * `state_short`, and an HTML-formatted `html_description` alongside the
 * plain Markdown one. Prefer the plain `description` (cleaned of Markdown
 * syntax, then run through the same HTML/whitespace cleanup as every other
 * ATS branch); fall back to `html_description` only when the plain field is
 * empty. `company`/`location` ride along on the result so a caller can
 * correct a stored value that disagrees with CareerForce's own source of
 * truth, the same way the Rippling detail fetch corrects a board-slug
 * company name against `companyName`.
 */
type DejobsJsonPayload = {
  description?: string;
  html_description?: string;
  title?: string;
  company?: string;
  city?: string;
  state_short?: string;
};

export function parseDejobsJson(data: DejobsJsonPayload | null | undefined): AtsScrapeResult | null {
  if (!data) return null;
  const plain = typeof data.description === 'string' ? data.description.trim() : '';
  const html = typeof data.html_description === 'string' ? data.html_description.trim() : '';
  if (!plain && !html) return null;

  const text = plain ? cleanHtmlText(cleanDejobsMarkdown(plain)) : cleanHtmlText(html);
  if (!text) return null;

  const location = data.city && data.state_short ? `${data.city}, ${data.state_short}` : undefined;
  return {
    text,
    ats: 'DEJobs',
    platform: 'dejobs',
    ...(data.title ? { title: data.title } : {}),
    ...(data.company ? { company: data.company } : {}),
    ...(location ? { location } : {}),
  };
}

async function fetchDejobsJson(jobId: string): Promise<AtsScrapeResult | null> {
  const jsonRes = await safeExternalFetch(
    `https://microsites.dejobs.org/ALL_JOBS/${jobId}.json`,
    { signal: AbortSignal.timeout(10000) },
  ).catch(() => null);
  if (!jsonRes || !jsonRes.ok) return null;
  let data: DejobsJsonPayload | null = null;
  try {
    data = JSON.parse(await readSafeFetchText(jsonRes));
  } catch {
    return null;
  }
  return parseDejobsJson(data);
}

async function scrapeDejobsPosting(url: string): Promise<AtsScrapeResult | null> {
  // Try the microsites key encoded directly in the original short link first
  // -- it needs no redirect to succeed, so it survives a TLS/WAF block on
  // whatever custom domain the employer's real apply link points at.
  const shortlinkId = extractDejobsShortlinkId(url);
  if (shortlinkId) {
    const direct = await fetchDejobsJson(shortlinkId);
    if (direct) return direct;
  }

  const pageRes = await safeExternalFetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!pageRes) return null;
  const landedUrl = pageRes.url || url;

  const jobId = extractDejobsJobId(landedUrl);
  if (jobId && jobId !== shortlinkId) {
    const viaLanding = await fetchDejobsJson(jobId);
    if (viaLanding) return viaLanding;
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
