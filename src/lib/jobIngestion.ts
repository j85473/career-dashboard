import { prisma } from "./prisma";
import * as crypto from "crypto";
import { passesPreFilter, passesMetadataPrefilter } from "./jobFiltering";
import { scrapeAtsApi } from "./atsApi";
import * as cheerio from "cheerio";
import { safeExternalFetch } from './safeExternalFetch';
import { getSerpApiKeys, getRapidApiKeys, fetchWithKeyRotation } from './apiFallback';
import path from 'node:path';
import { resolveRedirectUrl } from './atsRedirect';

type IncomingJob = {
  title?: unknown;
  company?: unknown;
  description?: unknown;
  location?: unknown;
  url?: unknown;
  source?: unknown;
  sourceId?: unknown;
  postedAt?: unknown;
};

type SourceRunCounts = {
  seen: number;
  inserted: number;
  duplicates: number;
  filtered: number;
  errors: number;
};

export function ingestionSourceRunStatus(counts: SourceRunCounts): 'success' | 'partial' | 'failed' {
  if (counts.errors === 0) return 'success';
  const completedWork = counts.seen + counts.inserted + counts.duplicates + counts.filtered;
  return completedWork > 0 ? 'partial' : 'failed';
}

type AtsJob = {
  id?: string | number;
  title?: string;
  name?: string;
  jobOpeningName?: string;
  description?: string;
  descriptionPlain?: string;
  content?: string;
  text?: string;
  workplaceType?: string;
  location?: string | { name?: string; city?: string; region?: string };
  categories?: { location?: string; team?: string };
  locationsText?: string;
  externalPath?: string;
  bulletFields?: string[];
  lists?: Array<{ text?: string; content?: string }>;
  additional?: string;
  additionalPlain?: string;
  absolute_url?: string;
  hostedUrl?: string;
  jobUrl?: string;
  shortcode?: string;
  updated_at?: string | Date;
  createdAt?: string | Date;
  publishedAt?: string | Date;
};

function hasPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function normalizeUrl(urlStr: string) {
  if (!urlStr) return "";
  try {
    const u = new URL(urlStr);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'ref', 'source',
    ];
    trackingParams.forEach((parameter) => u.searchParams.delete(parameter));
    u.searchParams.sort();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return urlStr;
  }
}

function normalizeWords(value: string): string {
  return (value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeCompany(company: string): string {
  return normalizeWords(company)
    .replace(/\b(?:incorporated|corporation|company|limited|inc|corp|llc|ltd|plc)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeTitle(title: string): string {
  // Some sources append a location to the title. Only strip an explicit trailing
  // location segment; do not remove meaningful hyphenated title text.
  const withoutLocationSuffix = (title || '').replace(
    /\s+(?:[-|,(]\s*)(?:remote|hybrid|minneapolis|st\.?\s*paul|saint paul|twin cities|[a-z .]+,\s*[a-z]{2})(?:\s*[)|])?\s*$/i,
    '',
  );
  return normalizeWords(withoutLocationSuffix);
}

export function normalizeJobLocation(location: string): string {
  if (!location || /^https?:\/\//i.test(location)) return 'unknown';
  const normalized = normalizeWords(location)
    .replace(/\bunited states of america\b|\bunited states\b|\bu s a\b|\busa\b/g, 'us')
    .replace(/\bminnesota\b/g, 'mn')
    .replace(/\bsaint paul\b/g, 'st paul')
    .replace(/\bvirtual\b|\bwork from home\b|\bdistributed\b/g, 'remote')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || /^(?:unknown|not specified|n a|none)$/.test(normalized)) return 'unknown';
  if (/^(?:remote|anywhere|worldwide)$/.test(normalized)) return 'remote';
  return normalized;
}

function generateLegacyFingerprint(title: string, company: string, stripCompanySuffix = true): string {
  const normalize = (value: string) => {
    let normalized = (value || '').toLowerCase();
    normalized = normalized.replace(/[,\-|(].*(mn|minnesota|remote|usa|st\.?\s*paul|twin cities|minneapolis|woodbury|apple valley|edina|plymouth|maple grove).*/gi, '');
    if (stripCompanySuffix) {
      normalized = normalized.replace(/\b(?:incorporated|corporation|company|limited|inc|corp|llc|ltd)\b\.?/g, '');
    }
    return normalized.replace(/[^a-z0-9]/g, '');
  };
  return crypto.createHash('md5').update(`${normalize(company)}|${normalize(title)}`).digest('hex');
}

/** Legacy v2 identity that included location */
export function generateV2Fingerprint(title: string, company: string, location: string) {
  const raw = `${normalizeCompany(company)}|${normalizeTitle(title)}|${normalizeJobLocation(location)}`;
  return `v2:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;
}

/** Versioned identity used to find plausible candidates, not as sole proof of a duplicate. */
export function generateFingerprint(title: string, company: string) {
  const raw = `${normalizeCompany(company)}|${normalizeTitle(title)}|`;
  return `v3:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;
}

export type DuplicateJobIdentity = {
  title?: string | null;
  company?: string | null;
  location?: string | null;
  description?: string | null;
  url?: string | null;
  canonicalUrl?: string | null;
  source?: string | null;
  sourceId?: string | null;
};

function descriptionSignature(description: string | null | undefined): string | null {
  const normalized = normalizeWords(cleanHtmlText(description || ''));
  if (normalized.length < 250) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function isStrongJobUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    if (!path || /^\/(?:jobs?|careers?|search|openings?)$/.test(path)) return false;
    const jobIdParams = new Set(['jobid', 'ghjid', 'requisitionid', 'reqid', 'postingid', 'positionid']);
    if ([...url.searchParams.keys()].some((key) => jobIdParams.has(key.toLowerCase().replace(/[^a-z0-9]/g, '')))) return true;
    return /\b(?:job|jobs|position|positions|requisition|requisitions|opening|openings)\b/.test(path)
      || /(?:^|[-_/])[a-z0-9_-]*\d{4,}[a-z0-9_-]*(?:$|[-_/])/.test(path);
  } catch {
    return false;
  }
}

function requisitionIdentity(value: string | null | undefined): { host: string; key: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const jobIdParams = new Set(['jobid', 'ghjid', 'requisitionid', 'reqid', 'postingid', 'positionid']);
    for (const [parameter, value] of url.searchParams.entries()) {
      if (!jobIdParams.has(parameter.toLowerCase().replace(/[^a-z0-9]/g, ''))) continue;
      const id = value.trim().toLowerCase();
      if (id) return { host: url.hostname.toLowerCase(), key: id };
    }
    const pathSegments = url.pathname.split('/').filter(Boolean);
    const markers = new Set(['job', 'jobs', 'j', 'position', 'positions', 'requisition', 'requisitions', 'opening', 'openings']);
    for (let index = 0; index < pathSegments.length - 1; index++) {
      if (!markers.has(pathSegments[index].toLowerCase())) continue;
      const id = decodeURIComponent(pathSegments[index + 1]).trim().toLowerCase();
      if (id) return { host: url.hostname.toLowerCase(), key: id };
    }
    const idSegment = [...pathSegments].reverse().find((segment) => /\d/.test(segment) && /^[a-z0-9_-]{4,}$/i.test(segment));
    return idSegment ? { host: url.hostname.toLowerCase(), key: idSegment.toLowerCase() } : null;
  } catch {
    return null;
  }
}

/**
 * Fingerprints only narrow the database search. A duplicate still requires a
 * stable source identity, a job-specific URL/requisition, or an exact substantial
 * description. This prevents same-title requisitions from swallowing one another.
 */
export function isLikelyDuplicatePosting(
  existing: DuplicateJobIdentity,
  incoming: DuplicateJobIdentity,
): boolean {
  const existingSourceId = existing.sourceId?.trim();
  const incomingSourceId = incoming.sourceId?.trim();
  const sameSource = Boolean(existing.source && incoming.source && existing.source === incoming.source);
  if (sameSource && existingSourceId && incomingSourceId) {
    if (existingSourceId === incomingSourceId) return true;
    // Do not return false yet; if the descriptions are exactly the same, they are duplicates.
  }

  const sameCompany = normalizeCompany(existing.company || '') === normalizeCompany(incoming.company || '');
  const sameTitle = normalizeTitle(existing.title || '') === normalizeTitle(incoming.title || '');
  if (!sameCompany || !sameTitle) return false;

  const existingUrls = [existing.canonicalUrl, existing.url]
    .filter((value): value is string => Boolean(value))
    .map(normalizeUrl);
  const incomingUrls = [incoming.canonicalUrl, incoming.url]
    .filter((value): value is string => Boolean(value))
    .map(normalizeUrl);
  if (existingUrls.some((value) => isStrongJobUrl(value) && incomingUrls.includes(value))) return true;

  const existingRequisition = existingUrls.map(requisitionIdentity).find(Boolean);
  const incomingRequisition = incomingUrls.map(requisitionIdentity).find(Boolean);
  if (existingRequisition && incomingRequisition && existingRequisition.host === incomingRequisition.host) {
    if (existingRequisition.key === incomingRequisition.key) return true;
    // Do not return false yet; check descriptions.
  }

  const existingLocation = normalizeJobLocation(existing.location || '');
  const incomingLocation = normalizeJobLocation(incoming.location || '');
  const locationsCompatible = existingLocation === incomingLocation
    || existingLocation === 'unknown'
    || incomingLocation === 'unknown';
  if (!locationsCompatible) return false;

  const existingDescription = descriptionSignature(existing.description);
  const incomingDescription = descriptionSignature(incoming.description);
  
  // If descriptions match exactly, it's a duplicate regardless of different IDs
  if (existingDescription && incomingDescription && existingDescription === incomingDescription) {
    return true;
  }

  // If descriptions differ (or we can't verify), respect the explicit different IDs
  if (sameSource && existingSourceId && incomingSourceId && existingSourceId !== incomingSourceId) {
    return false;
  }
  
  if (existingRequisition && incomingRequisition && existingRequisition.host === incomingRequisition.host && existingRequisition.key !== incomingRequisition.key) {
    return false;
  }

  if (!existingDescription || !incomingDescription) {
    return true; // sameCompany and sameTitle already confirmed
  }
  
  // If we made it here: same company, same title, compatible locations,
  // and NO explicit proof they are different requisitions. 
  // We should treat this as a duplicate to be foolproof!
  return true;
}

export async function findLikelyDuplicateJob(input: DuplicateJobIdentity) {
  const title = input.title || '';
  const company = input.company || '';
  const location = input.location || '';
  const canonicalUrl = normalizeUrl(input.canonicalUrl || input.url || '');
  const oldLocations = [location, 'unknown', 'remote', 'mn', 'st paul', 'us'];
  const fingerprints = [
    generateFingerprint(title, company),
    ...oldLocations.map(loc => generateV2Fingerprint(title, company, loc)),
    generateLegacyFingerprint(title, company),
    generateLegacyFingerprint(title, company, false),
  ];
  const recentCutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const candidates = await prisma.job.findMany({
    where: {
      createdAt: { gte: recentCutoff },
      OR: [
        ...(canonicalUrl ? [{ canonicalUrl }] : []),
        { fingerprint: { in: fingerprints } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return candidates.find((candidate) => isLikelyDuplicatePosting(candidate, input)) || null;
}


export function cleanHtmlText(html: string): string {
  if (!html) return "";
  try {
    const $ = cheerio.load(html);
    // Remove scripts and styles
    $('script, style, template').remove();
    // Replace breaks with newlines
    $('br').replaceWith('\n');
    // Ensure block elements have spacing
    $('p, div').append('\n');
    // Add bullet points to list items
    $('li').prepend('• ').append('\n');
    
    const text = $.text();
    return text
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "") // Strip emojis
      .replace(/[ \t]+/g, " ") // Collapse horizontal whitespace
      .replace(/\n\s*\n\s*\n+/g, "\n\n") // Compress 3+ newlines into 2
      .trim();
  } catch {
    // Fallback if cheerio fails
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

function usaJobsFieldText(value: unknown): string {
  if (typeof value === 'string') return cleanHtmlText(value).trim();
  if (Array.isArray(value)) return value.map(usaJobsFieldText).filter(Boolean).join('\n');
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return usaJobsFieldText(record.Text ?? record.Value ?? record.Name ?? '');
  }
  return '';
}

/** Combines the substantive USAJOBS fields instead of dropping all but the first one. */
export function composeUsaJobsDescription(details: unknown): string {
  if (typeof details !== 'object' || details === null) return '';
  const fields = details as Record<string, unknown>;
  const sections: Array<[string, unknown]> = [
    ['Job Summary', fields.JobSummary],
    ['Major Duties', fields.MajorDuties ?? fields.Duties],
    ['Qualifications', fields.Qualifications],
    ['Requirements', fields.Requirements],
    ['Education', fields.Education],
    ['Evaluation', fields.Evaluations],
  ];
  return sections
    .map(([heading, value]) => [heading, usaJobsFieldText(value)] as const)
    .filter(([, text]) => Boolean(text))
    .map(([heading, text]) => `${heading}\n${text}`)
    .join('\n\n');
}

export type ExternalJobInput = {
  title: string;
  company: string;
  description?: string | null;
  location?: string | null;
  url: string;
  source: string;
  sourceId: string;
  postedAt?: Date;
};

export type ExternalIngestOutcome = 'inserted' | 'filtered' | 'duplicate';

/** Shared normalization path for API-backed sources that run outside ingestJobs. */
export async function ingestExternalJob(
  input: ExternalJobInput,
  initialStatus = 'pending_af',
): Promise<ExternalIngestOutcome> {
  const title = input.title.trim() || 'Unknown Title';
  const company = input.company.trim() || 'Unknown Company';
  const description = cleanHtmlText(input.description || '');
  const location = input.location?.trim() || 'Unknown Location';
  const canonicalUrl = normalizeUrl(input.url);
  const fingerprint = generateFingerprint(title, company);
  const sourceId = input.sourceId.trim();
  if (!sourceId) throw new Error('sourceId is required');

  const observation = await prisma.jobSourceObservation.findUnique({
    where: { source_sourceId: { source: input.source, sourceId } },
  });
  if (observation) return 'duplicate';

  const existing = await findLikelyDuplicateJob({
    title,
    company,
    description,
    location,
    url: input.url,
    canonicalUrl,
    source: input.source,
    sourceId,
  });
  if (existing) {
    await prisma.jobSourceObservation.upsert({
      where: { source_sourceId: { source: input.source, sourceId } },
      update: { url: input.url },
      create: { jobId: existing.id, source: input.source, sourceId, url: input.url },
    });
    return 'duplicate';
  }

  const filter = passesPreFilter({ title, company, description, location, url: input.url });
  try {
    await prisma.job.create({
      data: {
        title,
        company,
        description,
        location,
        url: input.url,
        canonicalUrl,
        source: input.source,
        sourceId,
        fingerprint,
        postedAt: input.postedAt && !Number.isNaN(input.postedAt.getTime()) ? input.postedAt : new Date(),
        status: filter.passes ? initialStatus : 'archived',
        passReason: filter.passes ? null : filter.reason,
        scoringStatus: filter.passes ? (description.length >= 400 ? 'queued' : 'needs_jd') : 'skipped',
        luckyStatus: 'none',
        observations: { create: { source: input.source, sourceId, url: input.url } },
      },
    });
    return filter.passes ? 'inserted' : 'filtered';
  } catch (error) {
    if (hasPrismaCode(error, 'P2002')) return 'duplicate';
    throw error;
  }
}

export async function resolveCanonicalUrl(job: { company?: string | null; title?: string | null; url?: string | null }): Promise<string | null> {
  const keys = getSerpApiKeys();
  if (keys.length === 0 || !job.company || !job.title) return job.url || null;

  const urlLower = (job.url || '').toLowerCase();
  const isAggregator = urlLower.includes('adzuna') || urlLower.includes('indeed') || urlLower.includes('linkedin') || urlLower.includes('jsearch');
  if (!isAggregator) return job.url || null;

  try {
    const serpRes = await fetchWithKeyRotation(keys, async (key) => {
      const serpParams = new URLSearchParams({
        engine: "google",
        q: `${job.company} ${job.title} careers`,
        api_key: key,
      });
      return await fetch(`https://serpapi.com/search.json?${serpParams.toString()}`);
    });
    if (serpRes && serpRes.ok) {
      const data = await serpRes.json();
      const topLink = data.organic_results?.[0]?.link;
      if (topLink && !topLink.includes("glassdoor") && !topLink.includes("salary.com")) {
        return topLink;
      }
    }
  } catch {}
  
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
  const rapidKeys = getRapidApiKeys();

  // Attempt API-based fetching first for perfect reliability
  if (job.source === "Indeed" && job.sourceId && rapidKeys.length > 0) {
    try {
      const res = await fetchWithKeyRotation(rapidKeys, async (key) => fetch(
        `https://indeed12.p.rapidapi.com/job/${job.sourceId}`,
        {
          headers: {
            "X-RapidAPI-Key": key,
            "X-RapidAPI-Host": "indeed12.p.rapidapi.com",
          },
        },
      ));
      if (res && res.ok) {
        const data = await res.json();
        if (data.description) {
          return cleanHtmlText(data.description);
        }
      }
    } catch {}
  }

  if (job.source === "JSearch" && job.sourceId && rapidKeys.length > 0) {
    try {
      const res = await fetchWithKeyRotation(rapidKeys, async (key) => fetch(
        `https://jsearch.p.rapidapi.com/job-details?job_id=${job.sourceId}`,
        {
          headers: {
            "X-RapidAPI-Key": key,
            "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
          },
        },
      ));
      if (res && res.ok) {
        const data = await res.json();
        if (data.data?.[0]?.job_description) {
          return data.data[0].job_description;
        }
      }
    } catch {}
  }

  // Fallback 3: Canonical Webpage Scraping via resolvedUrl
  const finalUrl = job.resolvedUrl || job.url;
  if (finalUrl && finalUrl.startsWith("http")) {
    try {
      const pageRes = await safeExternalFetch(finalUrl, {
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
            const parseJob = (value: unknown) => {
              if (Array.isArray(value)) {
                value.forEach(parseJob);
                return;
              }
              if (typeof value !== 'object' || value === null) return;
              const record = value as Record<string, unknown>;
              if (record['@type'] === 'JobPosting' && typeof record.description === 'string') {
                jsonLdDescription = record.description;
              } else if (record['@graph']) {
                parseJob(record['@graph']);
              }
            };
            parseJob(data);
          }
        } catch {}

        if (jsonLdDescription && jsonLdDescription.length > 500) {
          return cleanHtmlText(jsonLdDescription);
        }

        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        let bodyText = bodyMatch ? bodyMatch[1] : html;
        bodyText = cleanHtmlText(bodyText);
        
        if (bodyText.length > 500 && !(bodyText.startsWith('{') && bodyText.endsWith('}'))) {
          return bodyText;
        }
      }
    } catch {}
  }

  // Fallback 4: Raw HTML scraping
  if (!finalUrl || !finalUrl.startsWith("http")) return null;
  try {
    const res = await safeExternalFetch(finalUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = cleanHtmlText(html);
    if (text.length > 500) return text;
    return null;
  } catch {
    // Ignore fetch error
  }

  return null;
}

export async function ingestJobs(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  targetAtsSlugs?: {slug: string, platform: string}[],
  searchQuery?: string,
  initialStatus: string = 'inbox',
  skipAts: boolean = false
): Promise<number> {
  const serpApiKeys = getSerpApiKeys();
  const rapidApiKeys = getRapidApiKeys();

  let newJobsCount = 0;
  const ingestionStartedAt = new Date();
  const sourceStats = new Map<string, {
    seen: number;
    inserted: number;
    duplicates: number;
    filtered: number;
    errors: number;
    lastError: string | null;
  }>();

  function statsFor(source: string) {
    const existing = sourceStats.get(source);
    if (existing) return existing;
    const created = { seen: 0, inserted: 0, duplicates: 0, filtered: 0, errors: 0, lastError: null };
    sourceStats.set(source, created);
    return created;
  }

  function markSourceError(source: string, error: unknown) {
    const stats = statsFor(source);
    stats.errors++;
    stats.lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }

  async function finishIngestion() {
    const finishedAt = new Date();
    if (sourceStats.size > 0) {
      const summary = Array.from(sourceStats.entries())
        .map(([source, stats]) => `${source}: ${stats.inserted} new, ${stats.duplicates} duplicate, ${stats.filtered} filtered, ${stats.errors} errors / ${stats.seen} seen`)
        .join(' | ');
      onProgress?.(`Source summary — ${summary}`);

      try {
        await prisma.ingestionSourceRun.createMany({
          data: Array.from(sourceStats.entries()).map(([source, stats]) => ({
            source,
            status: ingestionSourceRunStatus(stats),
            seenCount: stats.seen,
            insertedCount: stats.inserted,
            duplicateCount: stats.duplicates,
            filteredCount: stats.filtered,
            errorCount: stats.errors,
            error: stats.lastError,
            startedAt: ingestionStartedAt,
            finishedAt,
            durationMs: finishedAt.getTime() - ingestionStartedAt.getTime(),
          })),
        });
      } catch (error) {
        console.error('Failed to persist ingestion source telemetry:', error);
      }
    }
    return newJobsCount;
  }

  async function processJobInternal(jobData: IncomingJob) {
    if (signal?.aborted) return;
    let title = typeof jobData.title === 'string' && jobData.title.trim() ? jobData.title.trim() : 'Unknown Title';
    let company = typeof jobData.company === 'string' && jobData.company.trim() ? jobData.company.trim() : 'Unknown Company';
    let description = typeof jobData.description === 'string' ? jobData.description : '';
    const location = typeof jobData.location === 'string' ? jobData.location : 'Unknown Location';
    const rawUrl = typeof jobData.url === 'string' ? jobData.url : '';
    const source = typeof jobData.source === 'string' ? jobData.source : 'Unknown';
    const sourceId = jobData.sourceId;
    const candidatePostedAt = jobData.postedAt instanceof Date ? jobData.postedAt : new Date(String(jobData.postedAt || ''));
    const postedAt = Number.isNaN(candidatePostedAt.getTime()) ? new Date() : candidatePostedAt;

    description = cleanHtmlText(description || "");

    const stats = statsFor(source || 'Unknown');
    stats.seen++;
    if (sourceId == null || !String(sourceId).trim()) {
      markSourceError(source, new Error('Job was missing a sourceId'));
      return;
    }

    const canonicalUrl = normalizeUrl(rawUrl);
    let fingerprint = generateFingerprint(title, company);

    // 1. Exact Source + SourceId in observations
    const obs = await prisma.jobSourceObservation.findUnique({
      where: { source_sourceId: { source, sourceId: sourceId.toString() } },
    });
    if (obs) {
      stats.duplicates++;
      return;
    }

    // 2. Candidate fingerprints are verified against stable job identity. They
    // are never sufficient on their own because titles are commonly reused.
    const existingJob = await findLikelyDuplicateJob({
      title,
      company,
      description,
      location,
      url: rawUrl,
      canonicalUrl,
      source,
      sourceId: sourceId.toString(),
    });

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
      } catch (error: unknown) {
        if (!hasPrismaCode(error, 'P2002')) throw error;
      }
      stats.duplicates++;
      return;
    }

    let finalDescription = description || "";
    let finalCanonicalUrl = canonicalUrl;
    let manualAts: string | undefined = undefined;

    const isAggregator = rawUrl && (rawUrl.includes('adzuna.com') || rawUrl.includes('indeed.com') || rawUrl.includes('jsearch') || rawUrl.includes('linkedin.com'));

    if (finalDescription.length < 400 || isAggregator) {
      let resolvedUrl = null;
      if (isAggregator && rawUrl) {
        try {
          const directUrl = await resolveRedirectUrl(rawUrl, 3000);
          if (directUrl && directUrl !== rawUrl && !directUrl.includes('adzuna.com') && !directUrl.includes('jsearch')) {
            resolvedUrl = directUrl;
          }
        } catch (e) {
          console.error('Redirect tracing failed in ingestion:', e);
        }
      }
      
      if (!resolvedUrl) {
        resolvedUrl = await resolveCanonicalUrl({ company, title, url: rawUrl });
      }
      
      finalCanonicalUrl = normalizeUrl(resolvedUrl || canonicalUrl);
      
      let atsResult = null;
      if (finalCanonicalUrl) {
         atsResult = await scrapeAtsApi(finalCanonicalUrl);
      }
      
      if (atsResult) {
         finalDescription = atsResult.text;
         manualAts = atsResult.ats;
         if (atsResult.title) {
            title = atsResult.title;
         }
         if (atsResult.atsSlug) {
            const lowerCompany = company.toLowerCase();
            if (lowerCompany.includes('job-boards') || lowerCompany.includes('greenhouse.io') || lowerCompany.includes('lever.co') || lowerCompany.includes('ashbyhq')) {
               company = atsResult.atsSlug.charAt(0).toUpperCase() + atsResult.atsSlug.slice(1);
            }
         }
         
         if (atsResult.atsSlug && atsResult.platform) {
            try {
              await prisma.atsCompany.upsert({
                 where: { slug_platform: { slug: atsResult.atsSlug, platform: atsResult.platform } },
                 update: {},
                 create: { slug: atsResult.atsSlug, platform: atsResult.platform }
              });
            } catch {
              // Ignore unique constraint errors from concurrency
            }
         }
      } else {
         const scraped = await tryFetchFullDescription({
           url: rawUrl,
           resolvedUrl,
           source,
           sourceId: sourceId.toString(),
           company,
           title,
         });
         if (scraped && scraped.length > finalDescription.length) {
           finalDescription = scraped;
         }
      }
    }

    finalCanonicalUrl = normalizeUrl(finalCanonicalUrl);
    fingerprint = generateFingerprint(title, company);

    // ATS/API enrichment can correct both title and company. Re-run dedupe with
    // those final values rather than saving the stale pre-enrichment fingerprint.
    const enrichedDuplicate = await findLikelyDuplicateJob({
      title,
      company,
      description: finalDescription,
      location,
      url: rawUrl,
      canonicalUrl: finalCanonicalUrl,
      source,
      sourceId: sourceId.toString(),
    });
    if (enrichedDuplicate) {
      await prisma.jobSourceObservation.upsert({
        where: { source_sourceId: { source, sourceId: sourceId.toString() } },
        update: { url: rawUrl },
        create: {
          jobId: enrichedDuplicate.id,
          source,
          sourceId: sourceId.toString(),
          url: rawUrl,
        },
      });
      stats.duplicates++;
      return;
    }

    
    const preFilterResult = passesPreFilter({
      title,
      company,
      description: finalDescription,
      location,
      url: rawUrl,
    });

    if (!preFilterResult.passes) {
      stats.filtered++;
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
            passReason: preFilterResult.reason,
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
      } catch (error: unknown) {
        if (!hasPrismaCode(error, 'P2002')) throw error;
        stats.filtered--;
        stats.duplicates++;
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
          status: initialStatus,
          luckyStatus: initialStatus === 'pending_af' && Boolean(searchQuery) ? 'pending' : 'none',
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
      stats.inserted++;
    } catch (error: unknown) {
      if (!hasPrismaCode(error, 'P2002')) throw error;
      stats.duplicates++;
    }
  }

  async function processJob(jobData: IncomingJob) {
    const source = typeof jobData.source === 'string' && jobData.source.trim()
      ? jobData.source.trim()
      : 'Unknown';
    try {
      await processJobInternal(jobData);
    } catch (error) {
      markSourceError(source, error);
      console.error(`Error processing ${source} job:`, error);
    }
  }

  // BROAD SEARCH
  const baseQuery = searchQuery || "sales";
  const zipCode = "55405";

  // 0. BioSpace RSS Scraper
  if (!targetAtsSlugs || targetAtsSlugs.length === 0) {
    statsFor('BioSpace');
    if (onProgress) onProgress("Searching BioSpace RSS...");
    try {
      const bsRes = await fetch(`https://jobs.biospace.com/jobsrss/?keywords=${encodeURIComponent(baseQuery)}`);
      if (!bsRes.ok) throw new Error(`HTTP ${bsRes.status}`);
      {
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
       markSourceError('BioSpace', e);
       console.error("BioSpace scraper failed", e);
    }

    // 0.1 The Muse API
    statsFor('TheMuse');
    if (onProgress) onProgress("Searching The Muse API...");
    try {
      const museRes = await fetch("https://www.themuse.com/api/public/jobs?page=1&category=Sales");
      if (!museRes.ok) throw new Error(`HTTP ${museRes.status}`);
      {
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
      markSourceError('TheMuse', e);
      console.error("The Muse scraper failed", e);
    }

    // 0.2 Himalayas API
    statsFor('Himalayas');
    if (onProgress) onProgress("Searching Himalayas API...");
    try {
      const himalayasRes = await fetch("https://himalayas.app/jobs/api?limit=50");
      if (!himalayasRes.ok) throw new Error(`HTTP ${himalayasRes.status}`);
      {
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
      markSourceError('Himalayas', e);
      console.error("Himalayas scraper failed", e);
    }

    // 0.3 Remotive API
    statsFor('Remotive');
    if (onProgress) onProgress("Searching Remotive API...");
    try {
      const remotiveRes = await fetch(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(baseQuery)}&limit=50`);
      if (!remotiveRes.ok) throw new Error(`HTTP ${remotiveRes.status}`);
      {
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
      markSourceError('Remotive', e);
      console.error("Remotive scraper failed", e);
    }

    // 0.4 Arbeitnow API
    statsFor('Arbeitnow');
    if (onProgress) onProgress("Searching Arbeitnow API...");
    try {
      const arbeitRes = await fetch("https://www.arbeitnow.com/api/job-board-api");
      if (!arbeitRes.ok) throw new Error(`HTTP ${arbeitRes.status}`);
      {
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
      markSourceError('Arbeitnow', e);
      console.error("Arbeitnow scraper failed", e);
    }
  }

  // Optional official/first-party aggregators. These run independently of
  // SerpApi/RapidAPI so a missing paid-search key no longer disables ingestion.
  if (!targetAtsSlugs || targetAtsSlugs.length === 0) {
    const adzunaAppId = process.env.ADZUNA_APP_ID;
    const adzunaAppKey = process.env.ADZUNA_APP_KEY;
    if (adzunaAppId && adzunaAppKey) {
      statsFor('Adzuna');
      onProgress?.('Searching Adzuna...');
      try {
        for (let page = 1; page <= 2; page++) {
          const params = new URLSearchParams({
            app_id: adzunaAppId,
            app_key: adzunaAppKey,
            results_per_page: '50',
            what: baseQuery,
            where: 'Minnesota',
            distance: '75',
            max_days_old: '7',
            sort_by: 'date',
            'content-type': 'application/json',
          });
          const response = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/${page}?${params}`, {
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          const jobs = Array.isArray(data.results) ? data.results : [];
          for (const job of jobs) {
            if (signal?.aborted) break;
            await processJob({
              title: job.title || 'Unknown Title',
              company: job.company?.display_name || 'Unknown Company',
              description: job.description || '',
              location: job.location?.display_name || 'Minnesota',
              url: job.redirect_url || '',
              source: 'Adzuna',
              sourceId: String(job.id || job.redirect_url || ''),
              postedAt: job.created ? new Date(job.created) : new Date(),
            });
          }
          if (jobs.length < 50) break;
        }
      } catch (error) {
        markSourceError('Adzuna', error);
        console.error('Adzuna ingestion failed:', error);
      }
    }

    const usaJobsKey = process.env.USAJOBS_API_KEY;
    const usaJobsUserAgent = process.env.USAJOBS_USER_AGENT;
    if (usaJobsKey && usaJobsUserAgent) {
      statsFor('USAJOBS');
      onProgress?.('Searching USAJOBS...');
      try {
        const searches = [
          { LocationName: 'Minnesota' },
          { RemoteIndicator: 'true' },
        ];
        for (const search of searches) {
          const params = new URLSearchParams({
            Keyword: baseQuery,
            ResultsPerPage: '100',
            Page: '1',
          });
          Object.entries(search).forEach(([key, value]) => {
            if (value) params.set(key, value);
          });
          const response = await fetch(`https://data.usajobs.gov/api/Search?${params}`, {
            headers: {
              'User-Agent': usaJobsUserAgent,
              'Authorization-Key': usaJobsKey,
            },
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          const items = data.SearchResult?.SearchResultItems || [];
          for (const item of items) {
            if (signal?.aborted) break;
            const descriptor = item.MatchedObjectDescriptor || {};
            const details = descriptor.UserArea?.Details || {};
            const locations = Array.isArray(descriptor.PositionLocation)
              ? descriptor.PositionLocation.map((location: { LocationName?: string }) => location.LocationName).filter(Boolean)
              : [];
            await processJob({
              title: descriptor.PositionTitle || 'Unknown Title',
              company: descriptor.OrganizationName || descriptor.DepartmentName || 'U.S. Government',
              description: composeUsaJobsDescription(details),
              location: locations.join(', ') || (search.RemoteIndicator ? 'Remote / United States' : 'Minnesota'),
              url: descriptor.PositionURI || '',
              source: 'USAJOBS',
              sourceId: String(descriptor.PositionID || descriptor.PositionURI || ''),
              postedAt: descriptor.PublicationStartDate ? new Date(descriptor.PublicationStartDate) : new Date(),
            });
          }
        }
      } catch (error) {
        markSourceError('USAJOBS', error);
        console.error('USAJOBS ingestion failed:', error);
      }
    }
  }

  // 1. CareerForce MN Scraper
  if (!targetAtsSlugs || targetAtsSlugs.length === 0) {
    statsFor('CareerForce');
    if (onProgress) onProgress("Starting CareerForce MN Stealth Scraper...");
    try {
      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'src/scripts/careerForceScraper.ts');
      
      await new Promise<void>((resolve) => {
        const child = spawn('npx', ['tsx', scriptPath, baseQuery], { stdio: ['ignore', 'pipe', 'pipe'] });
        let settled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        const wallClockTimer = setTimeout(() => {
          markSourceError('CareerForce', new Error('CareerForce scraper exceeded its 10-minute limit'));
          child.kill('SIGTERM');
          forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
        }, 10 * 60 * 1000);
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(wallClockTimer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          signal?.removeEventListener('abort', abortChild);
          resolve();
        };
        const abortChild = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', abortChild, { once: true });
        
        child.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter(Boolean);
          lines.forEach((line: string) => {
             if (onProgress) onProgress(`[CareerForce] ${line}`);
             
             // Extract added count from stdout to accurately return newJobsCount
             const match = line.match(/added (\d+) new jobs/);
             if (match && match[1]) {
               const inserted = parseInt(match[1], 10);
               newJobsCount += inserted;
               statsFor('CareerForce').inserted += inserted;
             }
          });
        });
        
        child.stderr.on('data', (data) => {
          console.error(`[CareerForce Error] ${data.toString()}`);
        });
        
        child.on('close', (code) => {
          if (code && code !== 0) markSourceError('CareerForce', new Error(`Exited with code ${code}`));
          if (onProgress) onProgress(`CareerForce Scraper finished with code ${code}`);
          finish();
        });

        child.on('error', (err) => {
          markSourceError('CareerForce', err);
          console.error(`[CareerForce Spawn Error]`, err);
          if (onProgress) onProgress(`CareerForce Scraper failed to start: ${err.message}`);
          finish();
        });
      });
    } catch (e) {
      markSourceError('CareerForce', e);
      console.error("CareerForce scraper failed", e);
    }
  }

  // 1.5 Dejobs.org Scraper
  if (!targetAtsSlugs || targetAtsSlugs.length === 0) {
    statsFor('Dejobs');
    if (onProgress) onProgress("Starting Dejobs National Scraper...");
    try {
      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'src/scripts/dejobsScraper.ts');
      
      await new Promise<void>((resolve) => {
        const child = spawn('npx', ['tsx', scriptPath, baseQuery], { stdio: ['ignore', 'pipe', 'pipe'] });
        let settled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        const wallClockTimer = setTimeout(() => {
          markSourceError('Dejobs', new Error('Dejobs scraper exceeded its 10-minute limit'));
          child.kill('SIGTERM');
          forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
        }, 10 * 60 * 1000);
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(wallClockTimer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          signal?.removeEventListener('abort', abortChild);
          resolve();
        };
        const abortChild = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', abortChild, { once: true });
        
        child.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter(Boolean);
          lines.forEach((line: string) => {
             if (onProgress) onProgress(`[Dejobs] ${line}`);
             
             // Extract added count from stdout to accurately return newJobsCount
             const match = line.match(/added (\d+) new jobs/);
             if (match && match[1]) {
               const inserted = parseInt(match[1], 10);
               newJobsCount += inserted;
               statsFor('Dejobs').inserted += inserted;
             }
          });
        });
        
        child.stderr.on('data', (data) => {
          console.error(`[Dejobs Error] ${data.toString()}`);
        });
        
        child.on('close', (code) => {
          if (code && code !== 0) markSourceError('Dejobs', new Error(`Exited with code ${code}`));
          if (onProgress) onProgress(`Dejobs Scraper finished with code ${code}`);
          finish();
        });

        child.on('error', (err) => {
          markSourceError('Dejobs', err);
          console.error(`[Dejobs Spawn Error]`, err);
          if (onProgress) onProgress(`Dejobs Scraper failed to start: ${err.message}`);
          finish();
        });
      });
    } catch (e) {
      markSourceError('Dejobs', e);
      console.error("Dejobs scraper failed", e);
    }
  }

  // 1. SerpApi Fetch
  if (serpApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('SerpApi');
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
      if (!serpRes) throw new Error('All configured API keys were rate-limited or rejected');
      if (!serpRes.ok) throw new Error(`HTTP ${serpRes.status}`);
      {
        const data = await serpRes.json();
        const jobs = data.jobs_results || [];
        for (const job of jobs) {
          if (signal?.aborted) break;
          const postedAt = new Date(); // Google jobs with 'date_posted:today' are basically today
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
      markSourceError('SerpApi', e);
      console.error(e);
    }
  }

  // 2. JSearch via RapidAPI
  if (rapidApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('JSearch');
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
      if (!jsearchRes) throw new Error('All configured API keys were rate-limited or rejected');
      if (!jsearchRes.ok) throw new Error(`HTTP ${jsearchRes.status}`);
      {
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
      markSourceError('JSearch', e);
      console.error(e);
    }
  }

  // 3. Indeed via RapidAPI
  if (rapidApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('Indeed');
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
      if (!indeedRes) throw new Error('All configured API keys were rate-limited or rejected');
      if (!indeedRes.ok) throw new Error(`HTTP ${indeedRes.status}`);
      {
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
      markSourceError('Indeed', e);
      console.error(e);
    }
  }

  // 4. LinkedIn Job Search API (RapidAPI)
  if (rapidApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('LinkedIn');
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
      if (!linkedinRes) throw new Error('All configured API keys were rate-limited or rejected');
      if (!linkedinRes.ok) throw new Error(`HTTP ${linkedinRes.status}`);
      {
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
      markSourceError('LinkedIn', e);
      console.error(e);
    }
  }

  // Workday (RapidAPI) removed to save quota

  // 4.6 Glassdoor Jobs API (RapidAPI)
  if (rapidApiKeys.length > 0 && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('Glassdoor (RapidAPI)');
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

      if (!gdRes) throw new Error('All configured API keys were rate-limited or rejected');
      if (!gdRes.ok) throw new Error(`HTTP ${gdRes.status}`);
      {
        const data = await gdRes.json();
        const rawJobs = data.data || data.jobs || [];
        const jobs = Array.isArray(rawJobs) ? rawJobs : [];
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
      markSourceError('Glassdoor (RapidAPI)', e);
      console.error("Glassdoor RapidAPI Error", e);
    }
  }

  // Active Jobs DB (RapidAPI) removed to save quota

  // 5. Direct ATS Ingestion (Greenhouse, Lever, Ashby, Workday)
  if (skipAts) return finishIngestion();
  
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
        "remote",
        "virtual",
        "anywhere",
        "nationwide",
        "distributed",
        "united states",
      ];
      const isLocationMatch = (job: AtsJob): boolean => {
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
        const remoteEvidence = `${job.title || job.name || ''} ${job.description || job.content || ''} ${job.workplaceType || ''}`.toLowerCase();
        return LOCATION_KEYWORDS.some((kw) => locationString.includes(kw)) || /\b(remote|virtual|distributed|work from home)\b/.test(remoteEvidence);
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
            status: { in: ["active", "parked", "blacklisted"] },
            nextCheckDate: { lte: new Date() },
          },
          orderBy: { nextCheckDate: 'asc' },
          take: 500,
        });
      }

      const atsConcurrency = 5;
      for (let batchStart = 0; batchStart < activeBoards.length; batchStart += atsConcurrency) {
        const batch = activeBoards.slice(batchStart, batchStart + atsConcurrency);
        await Promise.all(batch.map(async (board, batchOffset) => {
        const i = batchStart + batchOffset;
        const boardSource = `ATS-${board.platform}`;
        statsFor(boardSource);
        if (onProgress) onProgress(`Searching ATS Boards: [${i + 1}/${activeBoards.length}] ${board.slug}...`);
        if (signal?.aborted) return;
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

        if (!apiUrl) {
          markSourceError(boardSource, new Error(`Unsupported ATS platform: ${board.platform}`));
          return;
        }

        try {
          const res = await fetch(apiUrl, fetchOptions);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const data = await res.json();
          let jobs: AtsJob[] = [];
          if (board.platform === "lever")
            jobs = Array.isArray(data) ? data : [];
          else if (board.platform === "workday") jobs = data.jobPostings || [];
          else if (board.platform === "smartrecruiters") jobs = data.content || [];
          else if (board.platform === "workable") jobs = data.results || [];
          else if (board.platform === "bamboohr") jobs = data.result || [];
          else jobs = data.jobs || [];

          // Workday defaults to 20 rows. Page through a bounded maximum so one
          // large board cannot monopolize the Pi indefinitely.
          if (board.platform === 'workday') {
            const total = Math.min(Number(data.total || data.totalCount || jobs.length), 200);
            for (let offset = jobs.length; offset < total; offset += 20) {
              const [company, tenant] = board.slug.split('::');
              const companyWithoutWd = company.split('.')[0];
              const pageResponse = await fetch(
                `https://${company}.myworkdayjobs.com/wday/cxs/${companyWithoutWd}/${tenant}/jobs`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
                  signal: AbortSignal.timeout(10000),
                },
              );
              if (!pageResponse.ok) throw new Error(`Workday page ${offset}: HTTP ${pageResponse.status}`);
              const pageData = await pageResponse.json();
              const pageJobs = pageData.jobPostings || [];
              jobs.push(...pageJobs);
              if (pageJobs.length < 20) break;
            }
          }

          if (jobs.length === 0) {
            // Empty, but not a failure. Just means no open jobs.
            await prisma.atsCompany.update({
              where: {
                slug_platform: { slug: board.slug, platform: board.platform },
              },
              data: {
                failCount: 0,
                status: 'active',
                nextCheckDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
                lastCheckedAt: new Date(),
                jobsFound: 0,
              },
            });
            return;
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
                const res = await fetch(singleJobUrl, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
                if (res.ok) {
                  const singleJobData = await res.json();
                  if (singleJobData.jobPostingInfo?.jobDescription) {
                    rawDescription = singleJobData.jobPostingInfo.jobDescription;
                  }
                } else {
                  markSourceError(boardSource, new Error(`Workday job detail HTTP ${res.status}`));
                }
              } catch (e) {
                markSourceError(boardSource, e);
                console.error("Failed to fetch Workday job desc:", e);
              }
              // Fallback if the fetch fails
              if (!rawDescription && job.bulletFields) {
                rawDescription = job.bulletFields.join("\n");
              }
            }
            if (board.platform === "lever") {
              if (job.lists && Array.isArray(job.lists)) {
                job.lists.forEach((list) => {
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

            if (!sourceId) {
              markSourceError(boardSource, new Error(`ATS job from ${board.slug} was missing a sourceId`));
              continue;
            }

            const title = job.text || job.title || job.name || job.jobOpeningName || "Unknown Title";
            let company = board.slug; // Fallback
            let locationStr = "Unknown Location";
            let url = job.absolute_url || job.hostedUrl || job.jobUrl || "";
            const locationObject = typeof job.location === 'object' ? job.location : undefined;
            const locationText = typeof job.location === 'string' ? job.location : locationObject?.name;

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
              company = decodeURIComponent(board.slug).split(/[-_ ]+/).map((word: string) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
              locationStr = job.categories?.location || "Unknown";
            } else if (board.platform === "greenhouse") {
              company = data.name || board.slug;
              locationStr = locationObject?.name || locationText || "Unknown";
            } else if (board.platform === "ashby") {
              const decodedSlug = decodeURIComponent(board.slug);
              company = decodedSlug.split(/[-_ ]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              locationStr = locationText || "Unknown";
            } else if (board.platform === "workday") {
              company = board.slug.split("::")[0];
              locationStr = job.locationsText || "Unknown";
            } else if (board.platform === "smartrecruiters") {
              company = data.company?.name || board.slug;
              locationStr = locationObject?.city ? `${locationObject.city}, ${locationObject.region || ''}` : "Unknown";
            } else if (board.platform === "workable") {
              company = board.slug;
              locationStr = locationObject?.city ? `${locationObject.city}, ${locationObject.region || ''}` : "Unknown";
            } else if (board.platform === "bamboohr") {
              company = board.slug;
              locationStr = locationObject?.city || "Unknown";
            }

            const postedValue = job.updated_at || job.createdAt || job.publishedAt;
            const postedAt = postedValue ? new Date(postedValue) : new Date();

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
              status: 'active',
              nextCheckDate: nextCheck,
              lastCheckedAt: new Date(),
              jobsFound: mnJobsFound,
            },
          });
        } catch (err) {
          markSourceError(boardSource, err);
          console.error(`Error fetching ATS board ${board.slug}:`, err);
          // On error, increment fail count
          const newFailCount = board.failCount + 1;
          const newStatus = newFailCount >= 3 ? "blacklisted" : "parked";
          const nextCheck = new Date();
          nextCheck.setDate(nextCheck.getDate() + (newFailCount === 1 ? 1 : newFailCount === 2 ? 7 : 30));

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
        }));
      }
    } catch (e) {
      markSourceError('Direct ATS', e);
      console.error(e);
    }

    return finishIngestion();
  }
// PR 3 Query Separation
// PR 5 Persistent Source Scheduling
// PR 9 Description Recovery Refactor
// PR 10 Add Low-Cost Sources
// PR 11 Common Crawl Incremental Discovery
