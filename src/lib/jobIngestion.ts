import { prisma } from "./prisma";
import * as crypto from "crypto";
import { passesPreFilter } from "./jobFiltering";
import { derivePostingFacts } from './postingFacts';
import { extractStructuredBaseCompensation } from './postedCompensation';
import { isEnrichmentSubSource } from './ingestionSourceKind';
import { assessJobInfoLanguage } from './jobLanguage';
import {
  scrapeAtsApi,
  extractJsonLdJobPosting,
  jsonLdCompanyName,
  jsonLdLocationString,
  JSON_LD_FETCH_USER_AGENT,
} from "./atsApi";
import * as cheerio from "cheerio";
import { safeExternalFetch } from './safeExternalFetch';
import { getSerpApiKeys, getRapidApiKeys, fetchWithKeyRotation } from './apiFallback';
import { prismaKeyCooldownStore } from './apiKeyCooldownStore';
import path from 'node:path';
import { resolveRedirectUrl } from './atsRedirect';
import {
  isClosedJobPosting,
  isScorableJobDescription,
  looksLikeInvalidJobDescription,
} from './jobDescriptionQuality';
import { urlMatchesAnyHost } from './urlHost';
import { buildClosedPostingUpdate } from './jdRecoveryPolicy';
import { signalChildProcessGroup } from './childProcessControl';
import { workdayBoardCompanyFallback, workdayHiringOrganizationName } from './workdayCompany';
import { resolveWorkdayPlaceholderLocation, workdayDetailLocation } from './workdayLocation';
import { findAppliedDuplicateEvidence } from './appliedDuplicateStore';

/**
 * Key rotation whose cooldowns survive a restart. Every provider call in this
 * module goes through here; the plain helper stays database-free so the
 * scrapers and unit tests can import it without a Prisma context.
 */
const rotateKeysWithDurableCooldowns: typeof fetchWithKeyRotation = (
  keys,
  fetchFn,
  serviceName,
  options = {},
) => fetchWithKeyRotation(keys, fetchFn, serviceName, { store: prismaKeyCooldownStore, ...options });
import {
  checkpointIngestionTask,
  classifyIngestionTaskCompletion,
  completeIngestionTask,
  evaluateProviderAvailability,
  getGeoLane,
  INGESTION_SCHEDULER_V3_ENABLED,
  ingestionOutcomes,
  ingestionReconciles,
  normalizeQueryFamily,
  recordJobPipelineEvent,
  recordProviderFailure,
  recordProviderSuccess,
  reserveProviderRequest,
  settleProviderState,
  type GeoLaneId,
  type IngestionCounters,
} from './ingestionControl';

type IncomingJob = {
  title?: unknown;
  company?: unknown;
  description?: unknown;
  location?: unknown;
  url?: unknown;
  source?: unknown;
  sourceId?: unknown;
  postedAt?: unknown;
  glassdoorQueryString?: unknown;
  /**
   * A posted-compensation value read directly off structured fields (e.g.
   * Rippling's `payRangeDetails`) rather than regexed out of the description.
   * Takes precedence over whatever `derivePostingFacts` finds in the prose,
   * since the structured source is authoritative.
   */
  postedCompensationOverride?: unknown;
};

type SourceRunCounts = {
  seen: number;
  inserted: number;
  duplicates: number;
  filtered: number;
  /** Job-level normalization/persistence errors; part of the seen denominator. */
  processingErrors: number;
  /** Request/provider failures; deliberately outside the job denominator. */
  requestErrors: number;
  requests: number;
  lastError: string | null;
  providerIncidentId: string | null;
};

const sourceCircuitOpenUntil = new Map<string, number>();
const SOURCE_CIRCUIT_DURATION_MS = 6 * 60 * 60 * 1_000;

/**
 * Raised when an ATS platform throttles us. Distinct from a board being broken:
 * Workable returned 45,233 of these in a week against 190 successful reads, and
 * counting them as board failures would blacklist perfectly good boards.
 */
export class RateLimitedError extends Error {
  constructor(platform: string) {
    super(`${platform} rate-limited this request`);
    this.name = 'RateLimitedError';
  }
}

const platformPausedUntil = new Map<string, number>();
export const PLATFORM_THROTTLE_MS = 60 * 1000;

/** Pauses a whole platform after a 429, honouring Retry-After when offered. */
export function throttlePlatform(
  platform: string,
  retryAfter?: string | null,
  now: number = Date.now(),
): void {
  const seconds = Number.parseInt(retryAfter || '', 10);
  const pause = Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, 15 * 60 * 1000)
    : PLATFORM_THROTTLE_MS;
  platformPausedUntil.set(platform, now + pause);
}

export function platformPauseRemainingMs(platform: string, now: number = Date.now()): number {
  return Math.max(0, (platformPausedUntil.get(platform) || 0) - now);
}

export class IngestionInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestionInterruptedError';
  }
}

function interruptionError(signal: AbortSignal, fallback: string): IngestionInterruptedError {
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : fallback;
  return reason instanceof IngestionInterruptedError ? reason : new IngestionInterruptedError(message);
}

async function waitForAbortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal?.aborted) throw interruptionError(signal, 'Ingestion interrupted.');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(interruptionError(signal!, 'Ingestion interrupted.'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export async function waitForPlatformSlot(platform: string, signal?: AbortSignal): Promise<void> {
  const remaining = platformPauseRemainingMs(platform);
  await waitForAbortableDelay(remaining, signal);
}

export function isPermanentSourceFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bHTTP\s+(?:401|403|404)\b|all configured api keys were rate-limited or rejected|invalid api key|endpoint (?:is )?(?:unavailable|not found)/i.test(message);
}

function sourceCircuitIsOpen(source: string): boolean {
  return (sourceCircuitOpenUntil.get(source) || 0) > Date.now();
}

export function ingestionSourceRunStatus(counts: Pick<SourceRunCounts, 'seen' | 'inserted' | 'duplicates' | 'filtered'> & {
  processingErrors?: number;
  requestErrors?: number;
  errors?: number;
}): 'success' | 'partial' | 'failed' | 'idle' {
  const processingErrors = counts.processingErrors || 0;
  const requestErrors = counts.requestErrors ?? counts.errors ?? 0;
  const completedWork = counts.seen;
  // Doing nothing quietly is not success. Arbeitnow reported 232 consecutive
  // successes over a week while returning no jobs at all, because this returned
  // early on the error count without ever asking whether work happened.
  if (requestErrors === 0 && processingErrors === 0 && completedWork === 0) return 'idle';
  if (requestErrors === 0 && processingErrors === 0) return 'success';
  if (completedWork === 0) return 'failed';
  
  const errorRatio = (requestErrors + processingErrors) / (completedWork + requestErrors);
  if (errorRatio > 0.5) return 'failed';
  if (errorRatio > 0.1) return 'partial';
  return 'success';
}

/**
 * A provider that answers requests cleanly and still yields nothing is the
 * shape every parser bug takes. Glassdoor reported success across 203 such runs
 * and JSearch across 66 before either was noticed, because a clean HTTP call
 * over an empty list was indistinguishable from a genuinely quiet query.
 *
 * One such run proves nothing — narrow queries legitimately return nothing. So
 * this does not change a run's status or its schedule; it names the condition on
 * the run and withholds the provider "success" that would otherwise clear the
 * failure counter, letting the existing three-strike path park a source whose
 * response shape has drifted.
 */
/**
 * How long a scraper may keep taking on new work. It stops at this point and
 * exits 0 with a partial summary.
 */
export const SCRAPER_GRACEFUL_BUDGET_MS = Number.parseInt(
  process.env.SCRAPER_GRACEFUL_BUDGET_MS || String(15 * 60 * 1000),
  10,
);
/**
 * Backstop for a child that has stopped responding entirely. It must stay above
 * the graceful budget, or the kill lands mid-work and books a hard failure —
 * which is how Dejobs sat circuit-open for three days.
 */
export const SCRAPER_HARD_KILL_MS = Math.max(
  SCRAPER_GRACEFUL_BUDGET_MS + 5 * 60 * 1000,
  Number.parseInt(process.env.SCRAPER_HARD_KILL_MS || String(20 * 60 * 1000), 10),
);

/**
 * Free-tier RapidAPI budgets, measured from the providers' own
 * `x-ratelimit-requests-*` headers rather than assumed. Every one of these
 * quotas is **monthly**, and the pool is that quota multiplied by the number
 * of rotating keys (18 at time of writing).
 *
 *   indeed12                  25/key/month  -> ~450 pooled
 *   linkedin-job-search-api   25/key/month  -> ~450 pooled
 *   jsearch                  200/key/month  -> ~3,600 pooled
 *   glassdoor-real-time      200/key/month  -> ~3,600 pooled
 *
 * Previously all four were guarded by `dailyLimit: 25` with no monthly cap.
 * For Indeed that daily allowance *equalled the entire monthly quota*, so a
 * single day of normal operation exhausted a key; eighteen days later the pool
 * was dead and every request returned "You have exceeded the MONTHLY quota for
 * Requests on your current plan, BASIC" — which the circuit then read as a
 * provider failure.
 *
 * The daily figure is now roughly the monthly ceiling divided over 31 days, so
 * a source paces itself across the month instead of spending everything in the
 * first week, and the monthly ceiling stops it cleanly before the provider
 * starts answering 403.
 */
const RAPIDAPI_BUDGETS = {
  Indeed: { dailyLimit: 13, monthlyLimit: 400 },
  LinkedIn: { dailyLimit: 13, monthlyLimit: 400 },
  JSearch: { dailyLimit: 103, monthlyLimit: 3_200 },
  'Glassdoor (RapidAPI)': { dailyLimit: 103, monthlyLimit: 3_200 },
} as const;

/**
 * TheMuse pagination.
 *
 * The call used to be a single hard-coded `page=1&category=Sales`, so across
 * 3,262 runs it re-read the same twenty postings 48,328 times and inserted
 * nothing. Only 47 distinct postings were ever observed, because the API's
 * default order is not recency — a new posting lands at an arbitrary position
 * among ~9,000 rather than at the front, so page 1 turns over by roughly one
 * posting a day.
 *
 * Two constraints the API does not document honestly:
 *
 *  - It advertises `page_count: 450` and `total: 8999`, but page 100 and beyond
 *    return **HTTP 400**. Real reach is pages 0-99, i.e. 2,000 per category.
 *    The old code's `if (!res.ok) throw` would turn that 400 into a source
 *    error and eventually open the circuit, so the cap is handled explicitly.
 *  - There is no free-text search. `q=` and `search=` are silently ignored
 *    (both return the unfiltered 407,954), so `category` is the only filter and
 *    it is a fixed enum. Sales and Account Management are the two that match
 *    the target roles; Business Operations, Management, and Retail are welders,
 *    wealth-management associates, and store managers respectively.
 */
const MUSE_CATEGORIES = ['Sales', 'Account Management'] as const;
const MUSE_PAGES_PER_RUN = 5;
/** Pages 0-99 inclusive. Page 100 is HTTP 400, not an empty result set. */
const MUSE_PAGE_LIMIT = 100;
/** Two full sweeps of both categories per day (200 requests each). */
const MUSE_DAILY_REQUEST_LIMIT = 400;

/**
 * Which slice of the catalog this run reads.
 *
 * Advancing on an hourly bucket means the window walks the whole 100-page
 * catalog every 20 hours, while the several runs inside one hour repeat a
 * window and cost only cheap duplicate hits. Deriving it from the clock avoids
 * persisting a cursor for a source this small.
 */
function museWindowStart(now: number): number {
  const hourBucket = Math.floor(now / 3_600_000);
  return (hourBucket * MUSE_PAGES_PER_RUN) % MUSE_PAGE_LIMIT;
}

/**
 * Himalayas query rotation.
 *
 * The call used a single `q: baseQuery`, which defaults to "sales" — and
 * measured against their search endpoint that is the *narrowest* corpus on
 * offer. Total matches for a US recency-sorted search:
 *
 *   sales 79 · channel sales 139 · sales manager 152 · account manager 179
 *   strategic accounts 198 · alliances 213 · partner manager 331
 *   partnerships 381 · territory manager 434 · account executive 518
 *   business development 651 · customer success 689
 *
 * Every one of those returns 10-19 postings in its first page that "sales"
 * never surfaces, so the source was reading a small corner of a board it had
 * full access to. "sales manager" is excluded: it added only 3 unseen rows and
 * is almost entirely covered by the others. "reseller" (8) and "distributor"
 * (11) have tiny corpora but are wholly unseen and directly on target.
 *
 * Paging is deliberately not added. Himalayas sorts by recency, so page one is
 * the new arrivals and deeper pages are history the catalog already holds —
 * unlike TheMuse, whose unordered feed made pagination the only way forward.
 * Breadth of query is the lever here; depth is not.
 */
const HIMALAYAS_ROTATING_QUERIES = [
  'partner manager',
  'channel sales',
  'account manager',
  'business development',
  'partnerships',
  'customer success',
  'strategic accounts',
  'territory manager',
  'alliances',
  'account executive',
  'reseller',
  'distributor',
] as const;

/** Plus `baseQuery`, so a task-configured search is never dropped. */
const HIMALAYAS_QUERIES_PER_RUN = 2;
/** Their docs answer 429 with a 60s backoff and state no explicit ceiling. */
const HIMALAYAS_DAILY_REQUEST_LIMIT = 300;

/**
 * Rotates on an hour bucket, covering all twelve queries every six hours while
 * the several runs inside one hour repeat a window at the cost of cheap
 * duplicate hits.
 */
function himalayasQueryWindow(now: number): string[] {
  const bucket = Math.floor(now / 3_600_000) * HIMALAYAS_QUERIES_PER_RUN;
  return Array.from({ length: HIMALAYAS_QUERIES_PER_RUN }, (_unused, offset) =>
    HIMALAYAS_ROTATING_QUERIES[(bucket + offset) % HIMALAYAS_ROTATING_QUERIES.length]);
}

export function zeroYieldRunError(counts: {
  seen: number;
  requests?: number;
  processingErrors?: number;
  requestErrors?: number;
}, source?: string): string | null {
  const requests = counts.requests || 0;
  if (requests === 0 || counts.seen > 0) return null;
  if ((counts.processingErrors || 0) > 0 || (counts.requestErrors || 0) > 0) return null;
  // A per-posting detail fetcher never reports a seen row — the posting is
  // counted against the parent board source — so this rule fired on every one
  // of its runs and stamped a healthy enrichment pass as zero yield. That also
  // suppressed its provider-success bookkeeping below, which is how a working
  // source drifts toward its circuit for no reason.
  if (source && isEnrichmentSubSource(source)) return null;
  return `Zero yield: ${requests} provider request(s) completed without returning a parsable row.`;
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
  location?: string | {
    name?: string;
    city?: string;
    region?: string;
    province?: string;
    country?: { name?: string };
  };
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
  // Fields specific to the platforms added alongside Greenhouse/Lever/Ashby.
  /** Rippling keys postings by uuid rather than id. */
  uuid?: string;
  /** Breezy, Teamtailor, Pinpoint and Rippling publish an absolute posting URL. */
  url?: string;
  /** Recruitee's public posting URL. */
  careers_url?: string;
  /** Teamtailor carries the posting body on the feed item. */
  content_html?: string;
  /** Recruitee splits the body across description and requirements. */
  requirements?: string;
  /** Rippling's location label. */
  workLocation?: { label?: string };
  city?: string;
  country?: string;
  published_date?: string | Date;
  date_published?: string | Date;
  created_at?: string | Date;
  /** Breezy's posting-page slug, used to build the detail URL when `url` is absent. */
  friendly_id?: string;
  /** Breezy's free-text salary string, e.g. "$150,000 – $170,000 / year". */
  salary?: string;
};

/** Shape of `GET https://ats.rippling.com/api/v1/board/{slug}/jobs/{uuid}`. */
export type RipplingJobDetail = {
  /** An object, not a string — `String(description)` yields `[object Object]`. */
  description?: { company?: string; role?: string } | string | null;
  companyName?: string;
  /** Array; the list call gives a single `workLocation` object instead. */
  workLocations?: string[];
  payRangeDetails?: Array<{
    location?: string;
    currency?: string;
    frequency?: string;
    rangeStart?: number;
    rangeEnd?: number;
    isRemote?: boolean;
  }>;
};

/** Pulled out for direct unit testing of the `{company, role}` object shape. */
export function parseRipplingJobDetail(detail: RipplingJobDetail): {
  rawDescription: string;
  company: string | null;
  location: string | null;
  compensation: string | null;
} {
  const desc = detail?.description;
  const rawDescription = desc && typeof desc === 'object'
    ? [desc.company, desc.role].filter(Boolean).join('\n\n')
    : typeof desc === 'string' ? desc : '';

  const company = typeof detail?.companyName === 'string' && detail.companyName.trim()
    ? detail.companyName.trim()
    : null;

  const location = Array.isArray(detail?.workLocations) && detail.workLocations.length > 0
    ? detail.workLocations.filter(Boolean).join('; ')
    : null;

  const compensation = extractStructuredBaseCompensation(detail?.payRangeDetails);

  return { rawDescription, company, location, compensation };
}

/**
 * Breezy's list `salary` field is free text ("$150,000 – $170,000 / year",
 * "$18 – $24 / hour", "£28,000 – £35,000", or "$55,000 – $80,000" with no
 * period at all) rather than Rippling's structured numeric fields. Parse only
 * the unambiguous shape -- a `$` range with an explicit annual period -- into
 * the same `{currency, frequency, rangeStart, rangeEnd}` shape
 * `payRangeDetails` already carries, and let `extractStructuredBaseCompensation`
 * apply its existing range-sanity rules. Hourly, non-USD, and unlabelled
 * ranges are left null rather than guessed at.
 */
export function parseBreezySalaryRange(salary: string | null | undefined): string | null {
  if (!salary) return null;
  const match = salary.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[-–—]\s*\$?\s*([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  if (!/\/\s*(?:yr|year)\b|\bper\s+year\b|\bannual/i.test(salary)) return null;

  const rangeStart = Number(match[1].replaceAll(',', ''));
  const rangeEnd = Number(match[2].replaceAll(',', ''));
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) return null;

  return extractStructuredBaseCompensation([{ currency: 'USD', frequency: 'YEAR', rangeStart, rangeEnd }]);
}

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
  // Workday discovery slugs use hostname shards such as `3m.wd1` as a
  // fallback company label. The shard identifies Workday infrastructure, not
  // the employer, and must not split `3M` from `3m.wd1` during dedupe.
  const withoutWorkdayShard = (company || '').trim().replace(/\.wd\d+$/i, '');
  return normalizeWords(withoutWorkdayShard)
    .replace(/\b(?:incorporated|corporation|company|limited|inc|corp|llc|ltd|plc)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeTitle(title: string): string {
  // Some sources append a location to the title. Only strip an explicit trailing
  // location segment; do not remove meaningful hyphenated title text.
  const original = (title || '').trim();
  let withoutLocationSuffix = original;
  const knownLocations = new Set(['remote', 'hybrid', 'minneapolis', 'st paul', 'saint paul', 'twin cities']);
  const separators = [' - ', ' | ', ' (', ', '];
  for (const separator of separators) {
    const index = original.lastIndexOf(separator);
    if (index <= 0) continue;
    const rawSuffix = original.slice(index + separator.length);
    let suffixEnd = rawSuffix.length;
    while (suffixEnd > 0 && (rawSuffix[suffixEnd - 1] === ')' || rawSuffix[suffixEnd - 1] === '|')) {
      suffixEnd -= 1;
    }
    const suffix = rawSuffix.slice(0, suffixEnd).trim();
    const normalizedSuffix = suffix.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
    const cityState = suffix.split(',').map((part) => part.trim());
    const looksLikeCityState = cityState.length === 2
      && cityState[0].length > 0
      && cityState[0].length <= 80
      && /^[a-z .]+$/i.test(cityState[0])
      && /^[a-z]{2}$/i.test(cityState[1]);
    if (knownLocations.has(normalizedSuffix) || looksLikeCityState) {
      withoutLocationSuffix = original.slice(0, index).trim();
      break;
    }
  }
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

export function generateV4Fingerprint(title: string, company: string, location: string) {
  const raw = `${normalizeCompany(company)}|${normalizeTitle(title)}|${normalizeJobLocation(location)}`;
  return `v4:${crypto.createHash('sha256').update(raw).digest('hex')}`;
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

export function isConservativeSyndicatedDuplicate(
  existing: DuplicateJobIdentity,
  incoming: DuplicateJobIdentity,
): boolean {
  const isSyndicator = (value: string | null | undefined) => /\b(?:jobgether|talentify|lensa|jobright|ziprecruiter)\b/i.test(value || '');
  if (!isSyndicator(existing.company) && !isSyndicator(incoming.company)) return false;
  const existingTitle = normalizeTitle(existing.title || '');
  const incomingTitle = normalizeTitle(incoming.title || '');
  if (!existingTitle || !incomingTitle || existingTitle !== incomingTitle) return false;
  const existingDescription = descriptionSignature(existing.description);
  const incomingDescription = descriptionSignature(incoming.description);
  return Boolean(existingDescription && existingDescription === incomingDescription);
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

function workdayTenant(host: string, pathSegments: readonly string[]): string | null {
  const jobsHost = host.match(/^([a-z0-9-]+)(?:\.wd\d+)?\.myworkdayjobs\.com$/i);
  if (jobsHost) return jobsHost[1].toLowerCase();

  if (!/(?:^|\.)myworkdaysite\.com$/i.test(host)) return null;

  // Workday's alternate public URL moves the tenant from the hostname into
  // `/recruiting/{tenant}/{site}/...`.
  const recruitingIndex = pathSegments.findIndex((segment) => segment.toLowerCase() === 'recruiting');
  if (recruitingIndex >= 0 && pathSegments.length > recruitingIndex + 1) {
    const tenant = decodeURIComponent(pathSegments[recruitingIndex + 1])
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');
    if (tenant) return tenant;
  }

  const brandedSiteHost = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdaysite\.com$/i);
  return brandedSiteHost ? brandedSiteHost[1].toLowerCase() : null;
}

function workdayRequisitionKey(pathSegments: readonly string[]): string | null {
  const jobIndex = pathSegments.findIndex((segment) => segment.toLowerCase() === 'job');
  if (jobIndex < 0 || pathSegments.length <= jobIndex + 1) return null;

  const tail = pathSegments
    .slice(jobIndex + 1)
    .map((segment) => decodeURIComponent(segment).toLowerCase());
  const finalSegment = tail.at(-1) || '';
  const separatorIndex = finalSegment.lastIndexOf('_');
  if (separatorIndex >= 0) {
    const candidate = finalSegment.slice(separatorIndex + 1);
    if (/^[a-z0-9][a-z0-9-]{2,}$/i.test(candidate) && /\d/.test(candidate)) {
      return `requisition:${candidate}`;
    }
  }

  // Some Workday tenants do not expose a separable requisition suffix. The
  // complete post-`/job/` tail is still stable across the two public hosts and
  // keeps same-location postings distinct.
  return tail.length > 0 ? `path:${tail.join('/')}` : null;
}

function requisitionIdentity(value: string | null | undefined): { host: string; key: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // Resolve Workday before generic query parameters so optional tracking or
    // job-id parameters cannot reintroduce the infrastructure hostname.
    const tenant = workdayTenant(host, pathSegments);
    const workdayKey = tenant ? workdayRequisitionKey(pathSegments) : null;
    if (tenant && workdayKey) {
      return { host: `workday:${tenant}`, key: workdayKey };
    }

    const jobIdParams = new Set(['jobid', 'ghjid', 'requisitionid', 'reqid', 'postingid', 'positionid']);
    for (const [parameter, value] of url.searchParams.entries()) {
      if (!jobIdParams.has(parameter.toLowerCase().replace(/[^a-z0-9]/g, ''))) continue;
      const id = value.trim().toLowerCase();
      if (id) return { host: url.hostname.toLowerCase(), key: id };
    }
    const markers = new Set(['job', 'jobs', 'j', 'position', 'positions', 'requisition', 'requisitions', 'opening', 'openings']);

    for (let index = 0; index < pathSegments.length - 1; index++) {
      if (!markers.has(pathSegments[index].toLowerCase())) continue;
      const id = decodeURIComponent(pathSegments[index + 1]).trim().toLowerCase();
      if (id) return { host, key: id };
    }
    const idSegment = [...pathSegments].reverse().find((segment) => /\d/.test(segment) && /^[a-z0-9_-]{4,}$/i.test(segment));
    return idSegment ? { host, key: idSegment.toLowerCase() } : null;
  } catch {
    return null;
  }
}

/**
 * A unique key is emitted only from stable posting identity, never from display
 * labels. This can safely back a database uniqueness constraint while the
 * legacy title/company/location fingerprint is retired from new writes.
 */
export function generatePostingIdentity(input: {
  source?: string | null;
  sourceId?: string | null;
  canonicalUrl?: string | null;
  url?: string | null;
}): string | null {
  const requisition = requisitionIdentity(input.canonicalUrl || input.url);
  const raw = requisition
    ? `requisition|${requisition.host}|${requisition.key}`
    : input.source?.trim() && input.sourceId?.trim()
      ? `source|${normalizeWords(input.source)}|${input.sourceId.trim().toLowerCase()}`
      : '';
  return raw ? `posting:v1:${crypto.createHash('sha256').update(raw).digest('hex')}` : null;
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

  // A stable job-specific URL or requisition is stronger identity evidence
  // than source-supplied company and location labels. This must run first so a
  // Workday hostname fallback such as `3m.wd1` cannot hide the corresponding
  // employer record (`3M`).
  const existingUrls = [existing.canonicalUrl, existing.url]
    .filter((value): value is string => Boolean(value))
    .map(normalizeUrl);
  const incomingUrls = [incoming.canonicalUrl, incoming.url]
    .filter((value): value is string => Boolean(value))
    .map(normalizeUrl);
  if (existingUrls.some((value) => isStrongJobUrl(value) && incomingUrls.includes(value))) return true;

  const existingRequisition = existingUrls.map(requisitionIdentity).find(Boolean);
  const incomingRequisition = incomingUrls.map(requisitionIdentity).find(Boolean);
  const differentStrongRequisitions = Boolean(
    existingRequisition
    && incomingRequisition
    && (
      existingRequisition.host !== incomingRequisition.host
      || existingRequisition.key !== incomingRequisition.key
    ),
  );
  if (existingRequisition && incomingRequisition && existingRequisition.host === incomingRequisition.host) {
    if (existingRequisition.key === incomingRequisition.key) return true;
    // Do not return false yet; check descriptions after verifying company/title.
  }

  const comp1 = normalizeCompany(existing.company || '');
  const comp2 = normalizeCompany(incoming.company || '');
  const sameCompany = comp1 === comp2 || comp1.replace(/\s+/g, '') === comp2.replace(/\s+/g, '');

  const title1 = normalizeTitle(existing.title || '');
  const title2 = normalizeTitle(incoming.title || '');
  const sameTitle = title1 === title2 || (title2 !== '' && title1.startsWith(title2 + ' ')) || (title1 !== '' && title2.startsWith(title1 + ' '));

  if (!sameCompany || !sameTitle) return false;

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

  // Once exact-description syndication has been ruled out, two distinct strong
  // requisition identities are affirmative evidence of separate postings even
  // when a feed and the employer ATS use different hosts.
  if (differentStrongRequisitions) return false;

  // If descriptions differ (or we can't verify), respect the explicit different IDs
  if (sameSource && existingSourceId && incomingSourceId && existingSourceId !== incomingSourceId) {
    return false;
  }
  
  if (existingRequisition && incomingRequisition && existingRequisition.host === incomingRequisition.host && existingRequisition.key !== incomingRequisition.key) {
    return false;
  }

  // Company/title/location fingerprints are retrieval hints, not proof that two
  // postings are the same requisition. If neither a stable posting identity nor
  // an exact substantial description matched, preserve both records. This is
  // especially important for recurring territory roles that share display
  // labels but have different requisitions (or no description in one feed).
  return false;
}

export async function findLikelyDuplicateJob(input: DuplicateJobIdentity) {
  const title = input.title || '';
  const company = input.company || '';
  const location = input.location || '';
  const canonicalUrl = normalizeUrl(input.canonicalUrl || input.url || '');
  const postingIdentity = generatePostingIdentity({
    source: input.source,
    sourceId: input.sourceId,
    canonicalUrl,
    url: input.url,
  });
  const identityFingerprint = generateV4Fingerprint(title, company, location);
  const oldLocations = [location, 'unknown', 'remote', 'mn', 'st paul', 'us'];
  const fingerprints = [
    generateV4Fingerprint(title, company, location),
    generateFingerprint(title, company),
    ...oldLocations.map(loc => generateV2Fingerprint(title, company, loc)),
    generateLegacyFingerprint(title, company),
    generateLegacyFingerprint(title, company, false),
  ];
  const companyPrefix = company.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3);
  const baseTitleWord = normalizeTitle(title).split(/\s+/).find(w => w.length > 2) || '';
  
  const fuzzyConditions = baseTitleWord && companyPrefix.length >= 3
    ? [{
        company: { startsWith: companyPrefix, mode: 'insensitive' as const },
        title: { contains: baseTitleWord, mode: 'insensitive' as const },
      }]
    : [];

  const recentCutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const candidates = await prisma.job.findMany({
    where: {
      createdAt: { gte: recentCutoff },
      OR: [
        ...(postingIdentity ? [{ postingIdentity }] : []),
        ...(canonicalUrl ? [{ canonicalUrl: { equals: canonicalUrl, mode: 'insensitive' as const } }] : []),
        { identityFingerprint },
        { fingerprint: { in: fingerprints } },
        ...fuzzyConditions,
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const ordinaryMatch = candidates.find((candidate) => isLikelyDuplicatePosting(candidate, input));
  if (ordinaryMatch) return ordinaryMatch;

  // Syndicators sometimes replace the real employer with their own name. Only
  // collapse those records when a substantial normalized description is exact.
  const incomingSignature = descriptionSignature(input.description);
  if (incomingSignature && baseTitleWord) {
    const syndicatedCandidates = await prisma.job.findMany({
      where: {
        createdAt: { gte: recentCutoff },
        title: { contains: baseTitleWord, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const syndicatedMatch = syndicatedCandidates.find((candidate) => isConservativeSyndicatedDuplicate(candidate, input));
    if (syndicatedMatch) return syndicatedMatch;
  }
  const appliedMatch = await findAppliedDuplicateEvidence({
    id: 'incoming-job',
    identityFingerprint,
    status: 'pending_af',
    location,
  });
  if (appliedMatch) return appliedMatch;
  return null;
}


/**
 * Markup that survived one strip because it arrived HTML-escaped.
 *
 * Requires a real tag shape — `</?name ...>` — so job text like "<10% travel"
 * or "salary <100k" is never mistaken for markup and truncated.
 */
const ESCAPED_MARKUP_RESIDUE = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/i;

/** Bounded so a pathological input cannot spin; two passes covers escaping. */
const MAX_HTML_CLEAN_PASSES = 3;

/**
 * Strip markup to readable text, including markup that arrives escaped.
 *
 * Greenhouse's boards API returns `content` HTML-*escaped*:
 *
 *   &lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;Chainguard is...
 *
 * Cheerio parses that as a single text node — there are no elements to remove —
 * and `.text()` then decodes the entities, so a single pass *returns the tags
 * as literal visible text*. Every Greenhouse posting was stored that way, on
 * both the ingestion sweep and the manual re-scrape, giving Aim and Experience
 * a job description made largely of `<div>` and `<p>`.
 *
 * Lever, Ashby and Himalayas send ordinary HTML and are cleaned by the first
 * pass, so this re-runs only while the output still looks like markup rather
 * than assuming any particular provider's encoding.
 */
export function cleanHtmlText(html: string): string {
  let text = cleanHtmlTextOnce(html);
  for (let pass = 1; pass < MAX_HTML_CLEAN_PASSES && ESCAPED_MARKUP_RESIDUE.test(text); pass += 1) {
    const next = cleanHtmlTextOnce(text);
    if (next === text) break;
    text = next;
  }
  return text;
}

function cleanHtmlTextOnce(html: string): string {
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
    // Linear fallback if the HTML parser rejects malformed input.
    let text = '';
    let insideTag = false;
    for (const character of html) {
      if (character === '<') {
        insideTag = true;
      } else if (character === '>') {
        insideTag = false;
        text += ' ';
      } else if (!insideTag) {
        text += character;
      }
    }
    return text.replace(/\s+/g, " ").trim();
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

export type UsaJobsTravelPercentageCode = '8';

/**
 * USAJOBS TravelPercentage is a categorical bucket, not a numeric minimum.
 * Code 8 is the documented "76% or greater" bucket. We intentionally do not
 * expose code 7 here because it means "75% or less", not "at least 75%".
 */
export function buildUsaJobsSearchRequests(input: {
  keyword: string;
  geoLane: GeoLaneId | string;
  travelPercentage?: UsaJobsTravelPercentageCode;
}): Array<{ url: string; remoteOnly: boolean }> {
  const searches = input.geoLane === 'us_remote'
    ? [{ RemoteIndicator: 'true' }]
    : input.geoLane === 'msp_metro'
      ? [{ LocationName: 'Minneapolis, Minnesota' }]
      : input.geoLane === 'upper_midwest'
        ? ['Minnesota', 'Wisconsin', 'Iowa', 'North Dakota', 'South Dakota']
            .map((LocationName) => ({ LocationName }))
        : input.geoLane === 'minnesota'
          ? [{ LocationName: 'Minnesota' }]
          : [{}];

  return searches.map((search) => {
    const params = new URLSearchParams({
      Keyword: input.keyword,
      ResultsPerPage: '100',
      Page: '1',
    });
    Object.entries(search).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    if (input.travelPercentage) params.set('TravelPercentage', input.travelPercentage);
    return {
      url: `https://data.usajobs.gov/api/Search?${params.toString()}`,
      remoteOnly: 'RemoteIndicator' in search,
    };
  });
}

const HIMALAYAS_JUNK_COMPANY_NAMES = new Set(['name', 'unknown company', 'unknown', 'n/a', '-']);

export function isHimalayasJunkCompanyName(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  return !normalized || HIMALAYAS_JUNK_COMPANY_NAMES.has(normalized);
}

export function himalayasCompanySlug(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.hostname !== 'himalayas.app' && !url.hostname.endsWith('.himalayas.app')) return null;
    const match = url.pathname.match(/^\/companies\/([^/]+)/i);
    return match ? decodeURIComponent(match[1]).trim().toLowerCase() || null : null;
  } catch {
    return null;
  }
}

function parseHimalayasCompany(job: Record<string, unknown>): string {
  if (!isHimalayasJunkCompanyName(job.companyName)) return String(job.companyName).trim();

  // Himalayas briefly emitted the literal string "name" for real employers.
  // Its application URL still carried the provider-owned company identifier,
  // so retain that truthful identifier instead of persisting poisoned data.
  // Do not invent brand casing here (for example, nttdata -> NTT DATA).
  const slug = himalayasCompanySlug(job.applicationLink);
  return slug ? slug.replace(/[-_]+/g, ' ') : 'Unknown Company';
}

export function parseHimalayasJob(job: Record<string, unknown>): IncomingJob | null {
  const title = typeof job.title === 'string' ? job.title.trim() : '';
  const guid = typeof job.guid === 'string' || typeof job.guid === 'number' ? String(job.guid) : '';
  if (!title || !guid) return null;
  const restrictions = Array.isArray(job.locationRestrictions) ? job.locationRestrictions : [];
  const restrictionNames = restrictions.map((value) => {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    return typeof record.name === 'string'
      ? record.name.trim()
      : typeof record.alpha2 === 'string' ? record.alpha2.trim() : '';
  }).filter(Boolean);
  /**
   * Himalayas sends `pubDate` as Unix *seconds* (1786928825). Passing that
   * straight to `new Date()`, which expects milliseconds, dated every posting
   * to January 1970 — the dashboard's "Posted over 56 years ago" was a reliable
   * tell that a row came from this source.
   *
   * Switch on magnitude rather than the source's current habit: anything below
   * 1e11 cannot be a plausible millisecond timestamp (1973 and earlier), so it
   * is seconds.
   */
  const pubDateValue = typeof job.pubDate === 'number' || typeof job.pubDate === 'string'
    ? Number(job.pubDate)
    : Number.NaN;
  const pubDate = Number.isFinite(pubDateValue)
    ? new Date(Math.abs(pubDateValue) < 1e11 ? pubDateValue * 1000 : pubDateValue)
    : new Date();
  return {
    title,
    company: parseHimalayasCompany(job),
    description: typeof job.description === 'string' ? job.description : '',
    location: restrictionNames.length > 0 ? restrictionNames.join(', ') : 'Remote / Worldwide',
    url: typeof job.applicationLink === 'string' ? job.applicationLink : '',
    source: 'Himalayas',
    sourceId: guid,
    postedAt: Number.isNaN(pubDate.getTime()) ? new Date() : pubDate,
  };
}

/**
 * Whether this source has already stored this posting.
 *
 * `ingestExternalJob` makes the same check on (source, sourceId) before it
 * touches the canonical URL, so a scraper can ask it from the search-results
 * card alone — before spending a browser navigation to resolve a redirect it
 * already resolved on the run that first saw the job. On CareerForce that is
 * 47 of every 50 cards.
 */
export async function externalJobAlreadyObserved(source: string, sourceId: string): Promise<boolean> {
  if (!sourceId) return false;
  const observation = await prisma.jobSourceObservation.findUnique({
    where: { source_sourceId: { source, sourceId } },
    select: { jobId: true },
  });
  return Boolean(observation);
}

/**
 * JSearch v5 item. `job_uid` is the stable identifier; `job_id` changes on every
 * Search call and must never reach `sourceId`, which dedupe is keyed on.
 */
export function parseJSearchJob(job: Record<string, unknown>): IncomingJob | null {
  const title = typeof job.job_title === 'string' ? job.job_title.trim() : '';
  const sourceId = typeof job.job_uid === 'string' ? job.job_uid.trim() : '';
  if (!title || !sourceId) return null;
  const city = typeof job.job_city === 'string' ? job.job_city : '';
  const state = typeof job.job_state === 'string' ? job.job_state : '';
  const postedAt = typeof job.job_posted_at_datetime_utc === 'string'
    ? new Date(job.job_posted_at_datetime_utc)
    : new Date();
  return {
    title,
    company: typeof job.employer_name === 'string' ? job.employer_name : 'Unknown Company',
    description: typeof job.job_description === 'string' ? job.job_description : '',
    location: `${city}, ${state}`.trim().replace(/^,|,$/g, '') || 'Unknown Location',
    url: typeof job.job_apply_link === 'string' && job.job_apply_link
      ? job.job_apply_link
      : typeof job.job_google_link === 'string' ? job.job_google_link : '',
    source: 'JSearch',
    sourceId,
    postedAt: Number.isNaN(postedAt.getTime()) ? new Date() : postedAt,
  };
}

/**
 * Glassdoor nests each result at `jobListings[].jobview`. The search payload
 * carries no description. Its listing ID and query string authorize the
 * provider's separate `/jobs/details` request, and `jobViewUrl` is
 * site-relative.
 */
export function parseGlassdoorListing(
  listing: Record<string, unknown>,
  now: Date = new Date(),
): IncomingJob | null {
  const view = listing?.jobview as Record<string, unknown> | undefined;
  if (!view || typeof view !== 'object') return null;
  const header = (view.header || {}) as Record<string, unknown>;
  const posting = (view.job || {}) as Record<string, unknown>;
  const employer = (header.employer || {}) as Record<string, unknown>;
  const title = typeof posting.jobTitleText === 'string' && posting.jobTitleText.trim()
    ? posting.jobTitleText.trim()
    : typeof header.normalizedJobTitle === 'string' ? header.normalizedJobTitle.trim() : '';
  const company = typeof employer.name === 'string' && employer.name.trim()
    ? employer.name.trim()
    : typeof header.employerNameFromSearch === 'string' ? header.employerNameFromSearch.trim() : '';
  if (!title || !company) return null;
  let url = '';
  if (typeof header.jobViewUrl === 'string' && header.jobViewUrl) {
    try {
      url = new URL(header.jobViewUrl, 'https://www.glassdoor.com').toString();
    } catch {
      url = '';
    }
  }
  const sourceId = posting.listingId != null
    ? String(posting.listingId)
    : header.adOrderId != null ? String(header.adOrderId) : url;
  if (!sourceId) return null;
  const ageInDays = Number(header.ageInDays);
  return {
    title,
    company,
    description: '',
    location: typeof header.locationName === 'string' && header.locationName.trim()
      ? header.locationName.trim()
      : 'Unknown Location',
    url,
    source: 'Glassdoor (RapidAPI)',
    sourceId,
    glassdoorQueryString: typeof posting.queryString === 'string' ? posting.queryString : '',
    postedAt: Number.isFinite(ageInDays) && ageInDays >= 0
      ? new Date(now.getTime() - ageInDays * 24 * 60 * 60 * 1000)
      : new Date(now.getTime()),
  };
}


/**
 * RemoteOK's feed leads with a legal/attribution notice rather than a job, so
 * the first element is always skipped. Their terms ask for an attribution link
 * back, which the stored canonical URL provides.
 */
export function parseRemoteOkJob(job: Record<string, unknown>): IncomingJob | null {
  if (job.legal) return null;
  const title = typeof job.position === 'string' ? job.position.trim() : '';
  const sourceId = job.id != null ? String(job.id) : (typeof job.slug === 'string' ? job.slug : '');
  if (!title || !sourceId) return null;
  const posted = typeof job.date === 'string' ? new Date(job.date) : new Date();
  const location = typeof job.location === 'string' ? job.location.replace(/,\s*$/, '').trim() : '';
  return {
    title,
    company: typeof job.company === 'string' && job.company.trim() ? job.company.trim() : 'Unknown Company',
    description: typeof job.description === 'string' ? job.description : '',
    // The feed is remote-only; an empty location means remote rather than unknown.
    location: location || 'Remote',
    url: typeof job.url === 'string' && job.url ? job.url
      : typeof job.apply_url === 'string' ? job.apply_url : '',
    source: 'RemoteOK',
    sourceId,
    postedAt: Number.isNaN(posted.getTime()) ? new Date() : posted,
  };
}

/** Jobicy's v2 remote feed. `industry=sales` is rejected with HTTP 400, so the
 *  request is geo-scoped only and titles are filtered locally. */
export function parseJobicyJob(job: Record<string, unknown>): IncomingJob | null {
  const title = typeof job.jobTitle === 'string' ? job.jobTitle.trim() : '';
  const sourceId = job.id != null ? String(job.id) : '';
  if (!title || !sourceId) return null;
  const posted = typeof job.pubDate === 'string' ? new Date(job.pubDate) : new Date();
  const geo = typeof job.jobGeo === 'string' && job.jobGeo.trim() ? job.jobGeo.trim() : 'Remote';
  return {
    title,
    company: typeof job.companyName === 'string' && job.companyName.trim() ? job.companyName.trim() : 'Unknown Company',
    description: typeof job.jobDescription === 'string' ? job.jobDescription
      : typeof job.jobExcerpt === 'string' ? job.jobExcerpt : '',
    location: geo,
    url: typeof job.url === 'string' ? job.url : '',
    source: 'Jobicy',
    sourceId,
    postedAt: Number.isNaN(posted.getTime()) ? new Date() : posted,
  };
}

/** Slug to a human-readable company name, e.g. "acme-corp" -> "Acme Corp". */
function titleCaseSlug(slug: string): string {
  return decodeURIComponent(slug)
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function buildCareerOneStopJobsUrl(input: {
  userId: string;
  keyword: string;
  location: string;
  radius: string;
  days: number;
}): string {
  const pathSegments = [
    input.userId,
    input.keyword,
    input.location,
    input.radius,
    'acquisitiondate',
    'DESC',
    '0',
    '100',
    String(input.days),
  ].map(encodeURIComponent).join('/');
  return `https://api.careeronestop.org/v2/jobsearch/${pathSegments}?enableJobDescriptionSnippet=true`;
}

export function parseCareerOneStopJob(job: Record<string, unknown>): IncomingJob | null {
  const sourceId = typeof job.JvId === 'string' || typeof job.JvId === 'number' ? String(job.JvId) : '';
  const title = typeof job.JobTitle === 'string' ? job.JobTitle.trim() : '';
  if (!sourceId || !title) return null;
  const acquisitionDate = typeof job.AcquisitionDate === 'string' || typeof job.AcquisitionDate === 'number'
    ? new Date(job.AcquisitionDate)
    : new Date();
  return {
    title,
    company: typeof job.Company === 'string' ? job.Company : 'Unknown Company',
    description: typeof job.DescriptionSnippet === 'string' ? job.DescriptionSnippet : '',
    location: typeof job.Location === 'string' && job.Location.trim() ? job.Location : 'Unknown Location',
    url: typeof job.URL === 'string' ? job.URL : '',
    source: 'CareerOneStop',
    sourceId,
    postedAt: Number.isNaN(acquisitionDate.getTime()) ? new Date() : acquisitionDate,
  };
}

export function remoteFeedLocation(region: unknown): string {
  return typeof region === 'string' && region.trim()
    ? `Remote / ${region.trim()}`
    : 'Remote / Location unspecified';
}

export type ProviderGeoPlan = {
  lane: string;
  location: string;
  radius: string;
  querySuffix: string;
  remoteOnly: boolean;
};

/** Explicit provider input mapping; no task may silently query another lane. */
export function providerGeoPlan(provider: string, laneId: GeoLaneId | string): ProviderGeoPlan {
  const base = laneId === 'msp_metro'
    ? { location: '55405', radius: '75', querySuffix: '', remoteOnly: false }
    : laneId === 'minnesota'
      ? { location: 'Minnesota', radius: '200', querySuffix: '', remoteOnly: false }
      : laneId === 'upper_midwest'
        ? { location: 'Minneapolis, MN', radius: '500', querySuffix: 'Upper Midwest regional', remoteOnly: false }
        : laneId === 'us_remote'
          ? { location: 'United States', radius: '0', querySuffix: 'remote', remoteOnly: true }
          : { location: '', radius: '0', querySuffix: '', remoteOnly: false };

  if (provider === 'SerpApi') {
    return { ...base, lane: laneId, location: laneId === 'msp_metro' ? 'Minneapolis, Minnesota, United States' : base.location };
  }
  if (provider === 'Adzuna') {
    return {
      ...base,
      lane: laneId,
      location: laneId === 'msp_metro' ? 'Minneapolis, Minnesota' : base.location,
      // Adzuna matches `what` against title and body, so a descriptive suffix
      // is searched literally. "channel sales Upper Midwest regional" matched
      // nothing at all; the same query without it returns 385 across the same
      // 500-mile radius, which is what the lane was meant to cover.
      querySuffix: laneId === 'upper_midwest' ? '' : base.querySuffix,
    };
  }
  return { ...base, lane: laneId };
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
  searchQuery?: string | null;
  ingestionMode?: string | null;
  taskId?: string | null;
  queryFamily?: string | null;
  geoLane?: string | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
};

export type ExternalIngestOutcome = 'inserted' | 'filtered' | 'duplicate';

export type ExternalIngestionRunCounters = IngestionCounters;

export type ExternalIngestionContext = {
  taskId: string | null;
  queryFamily: string | null;
  geoLane: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  ingestionMode: string;
};

export function emptyExternalIngestionCounters(): ExternalIngestionRunCounters {
  return {
    seen: 0,
    inserted: 0,
    duplicates: 0,
    filtered: 0,
    processingErrors: 0,
    providerErrors: 0,
    requests: 0,
  };
}

/** Each observed candidate receives exactly one mutually-exclusive outcome. */
export function countExternalIngestionOutcome(
  counters: ExternalIngestionRunCounters,
  outcome: ExternalIngestOutcome | 'processing_error',
): void {
  counters.seen++;
  if (outcome === 'inserted') counters.inserted++;
  else if (outcome === 'duplicate') counters.duplicates++;
  else if (outcome === 'filtered') counters.filtered++;
  else counters.processingErrors++;
}

function validContextDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Reads only bounded scheduler provenance from an internal route request. */
export function externalIngestionContext(
  request: Request | undefined,
  ingestionMode: string,
): ExternalIngestionContext {
  const headers = request?.headers;
  const taskIdValue = headers?.get('x-ingestion-task-id') || null;
  return {
    taskId: taskIdValue && /^[0-9a-f-]{36}$/i.test(taskIdValue) ? taskIdValue : null,
    queryFamily: headers?.get('x-ingestion-query-family')?.slice(0, 200) || null,
    geoLane: headers?.get('x-ingestion-geo-lane')?.slice(0, 100) || null,
    windowStart: validContextDate(headers?.get('x-ingestion-window-start') || null),
    windowEnd: validContextDate(headers?.get('x-ingestion-window-end') || null),
    ingestionMode,
  };
}

export async function persistExternalIngestionSourceRun(input: {
  source: string;
  counters: ExternalIngestionRunCounters;
  context: ExternalIngestionContext;
  startedAt: Date;
  error?: string | null;
  providerIncidentId?: string | null;
  status?: 'success' | 'partial' | 'failed' | 'idle' | 'disabled';
}): Promise<'success' | 'partial' | 'failed' | 'idle' | 'disabled'> {
  if (!ingestionReconciles(input.counters)) {
    throw new Error(
      `${input.source} ingestion counters do not reconcile: seen=${input.counters.seen}, outcomes=${ingestionOutcomes(input.counters)}`,
    );
  }
  const status = input.status || ingestionSourceRunStatus({
    seen: input.counters.seen,
    inserted: input.counters.inserted,
    duplicates: input.counters.duplicates,
    filtered: input.counters.filtered,
    processingErrors: input.counters.processingErrors,
    requestErrors: input.counters.providerErrors,
  });
  const finishedAt = new Date();
  await prisma.ingestionSourceRun.create({
    data: {
      source: input.source,
      status,
      seenCount: input.counters.seen,
      insertedCount: input.counters.inserted,
      duplicateCount: input.counters.duplicates,
      filteredCount: input.counters.filtered,
      errorCount: input.counters.processingErrors + input.counters.providerErrors,
      processingErrorCount: input.counters.processingErrors,
      requestErrorCount: input.counters.providerErrors,
      reconciled: true,
      error: input.error?.slice(0, 1000) || null,
      providerIncidentId: input.providerIncidentId || null,
      taskId: input.context.taskId,
      queryFamily: input.context.queryFamily,
      geoLane: input.context.geoLane,
      windowStart: input.context.windowStart,
      windowEnd: input.context.windowEnd,
      watermarkAt: status === 'success' || status === 'idle' ? input.context.windowEnd || finishedAt : null,
      ingestionMode: input.context.ingestionMode,
      checkpoint: { phase: 'finished', requests: input.counters.requests || 0 },
      startedAt: input.startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - input.startedAt.getTime(),
    },
  });
  return status;
}

/** Shared normalization path for API-backed sources that run outside ingestJobs. */
export async function ingestExternalJob(
  input: ExternalJobInput,
  initialStatus = 'pending_af',
): Promise<ExternalIngestOutcome> {
  const attribution = {
    searchQuery: input.searchQuery || null,
    ingestionMode: input.ingestionMode || 'external',
    queryFamily: input.queryFamily || (input.searchQuery ? normalizeQueryFamily(input.searchQuery) : null),
    geoLane: input.geoLane || null,
    windowStart: input.windowStart || null,
    windowEnd: input.windowEnd || null,
    taskId: input.taskId || null,
  };
  const title = input.title.trim() || 'Unknown Title';
  const company = input.company.trim() || 'Unknown Company';
  const description = cleanHtmlText(input.description || '');
  const location = input.location?.trim() || 'Unknown Location';
  const canonicalUrl = normalizeUrl(input.url);
  const identityFingerprint = generateV4Fingerprint(title, company, location);
  const sourceId = input.sourceId.trim();
  const postingIdentity = generatePostingIdentity({
    source: input.source,
    sourceId,
    canonicalUrl,
    url: input.url,
  });
  const machineInitialStatus = initialStatus === 'pending_af' ? initialStatus : 'pending_af';
  if (!sourceId) throw new Error('sourceId is required');

  const observation = await prisma.jobSourceObservation.findUnique({
    where: { source_sourceId: { source: input.source, sourceId } },
  });
  if (observation) {
    await recordJobPipelineEvent({
      eventType: 'duplicate',
      jobId: observation.jobId,
      taskId: input.taskId,
      stage: 'ingestion',
      source: input.source,
      sourceId,
      queryFamily: attribution.queryFamily,
      geoLane: input.geoLane,
      details: { reason: 'source_observation' },
      identityParts: [input.windowEnd?.toISOString() || 'external'],
    });
    return 'duplicate';
  }

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
    await prisma.$transaction(async (tx) => {
      await tx.jobSourceObservation.upsert({
        where: { source_sourceId: { source: input.source, sourceId } },
        update: { url: input.url, ...attribution },
        create: { jobId: existing.id, source: input.source, sourceId, url: input.url, ...attribution },
      });
      await recordJobPipelineEvent({
        eventType: 'duplicate',
        jobId: existing.id,
        taskId: input.taskId,
        stage: 'ingestion',
        source: input.source,
        sourceId,
        queryFamily: attribution.queryFamily,
        geoLane: input.geoLane,
        details: { reason: 'stable_identity' },
        identityParts: [input.windowEnd?.toISOString() || 'external'],
      }, tx);
    });
    return 'duplicate';
  }

  const filter = passesPreFilter({ title, company, description, location, url: input.url });
  const jdReady = isScorableJobDescription(description);
  // Local Triage already has the final description in hand here, so the posted
  // facts are read off it in the same step rather than in a later pass.
  const postingFacts = derivePostingFacts(description);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
        title,
        company,
        description,
        ...postingFacts,
        location,
        url: input.url,
        canonicalUrl,
        source: input.source,
        sourceId,
        // Leave the legacy unique candidate fingerprint null. It cannot safely
        // distinguish two real requisitions with identical display labels.
        fingerprint: null,
        identityFingerprint,
        postingIdentity,
        postedAt: input.postedAt && !Number.isNaN(input.postedAt.getTime()) ? input.postedAt : new Date(),
        status: filter.passes ? machineInitialStatus : 'archived',
        passReason: filter.passes ? null : filter.reason,
        scoringStatus: filter.passes ? (jdReady ? 'queued' : 'needs_jd') : 'skipped',
        observations: { create: { source: input.source, sourceId, url: input.url, ...attribution } },
        },
      });
      await recordJobPipelineEvent({
        eventType: filter.passes ? 'ingested' : 'prefilter_rejected',
        jobId: job.id,
        taskId: input.taskId,
        stage: 'ingestion',
        source: input.source,
        sourceId,
        queryFamily: attribution.queryFamily,
        geoLane: input.geoLane,
        details: filter.passes ? { initialStatus: machineInitialStatus, jdReady } : { reason: filter.reason },
        identityParts: [input.windowEnd?.toISOString() || 'external'],
      }, tx);
      if (filter.passes && jdReady) {
        await recordJobPipelineEvent({
          eventType: 'jd_ready',
          jobId: job.id,
          taskId: input.taskId,
          stage: 'jd',
          source: input.source,
          sourceId,
          queryFamily: attribution.queryFamily,
          geoLane: input.geoLane,
          identityParts: [input.windowEnd?.toISOString() || 'external', 'ingestion'],
        }, tx);
      }
      return job;
    });
    void created;
    return filter.passes ? 'inserted' : 'filtered';
  } catch (error) {
    if (hasPrismaCode(error, 'P2002')) return 'duplicate';
    throw error;
  }
}

export async function resolveCanonicalUrl(job: { company?: string | null; title?: string | null; url?: string | null }): Promise<string | null> {
  const isAggregator = urlMatchesAnyHost(job.url, [
    'adzuna.com',
    'indeed.com',
    'linkedin.com',
    'jsearch.p.rapidapi.com',
  ]);
  
  if (isAggregator && job.url) {
    try {
      const directUrl = await resolveRedirectUrl(job.url, 5000);
      if (directUrl && directUrl !== job.url) return directUrl;
    } catch {}
  }
  
  return job.url || null;
}

export type DetailProviderControl = {
  beforeRequest: (provider: string) => Promise<void>;
  success: (provider: string) => void;
  failure: (provider: string, error: unknown) => void;
};

type DetailResponse = Pick<Response, 'ok' | 'status' | 'json'>;

/**
 * Records transport success independently from whether the provider happened
 * to include a usable description. Non-2xx responses remain provider failures;
 * a valid 2xx response with an empty result is successful request telemetry and
 * returns null so the caller can continue to its fail-soft web/JD fallback.
 */
export async function processDetailProviderResponse(
  provider: string,
  response: DetailResponse | null,
  extractDescription: (payload: unknown) => unknown,
  onSuccess?: (provider: string) => void,
): Promise<string | null> {
  if (!response) throw new Error(`${provider} returned no response`);
  if (!response.ok) throw new Error(`${provider} HTTP ${response.status}`);

  onSuccess?.(provider);
  const payload = await response.json();
  const description = extractDescription(payload);
  return typeof description === 'string' && description.trim()
    ? description.trim()
    : null;
}

export const GLASSDOOR_SOURCE = 'Glassdoor (RapidAPI)';

export function isLegacyHiddenGlassdoorJdFailure(job: {
  source?: string | null;
  status?: string | null;
  scoringStatus?: string | null;
  passReason?: string | null;
  scoreError?: string | null;
}): boolean {
  if (
    job.source !== GLASSDOOR_SOURCE
    || job.status !== 'dismissed'
    || job.scoringStatus !== 'failed'
  ) return false;

  const diagnostic = `${job.passReason || ''} ${job.scoreError || ''}`;
  return /\b(?:jd recovery|failed to fetch jd|error calling jina)\b/i.test(diagnostic);
}

export function glassdoorQueryString(
  explicitQueryString: string | null | undefined,
  jobUrl: string | null | undefined,
): string | null {
  const explicit = explicitQueryString?.trim();
  if (explicit) return explicit;
  if (!jobUrl) return null;
  try {
    const parsed = new URL(jobUrl);
    return urlMatchesAnyHost(jobUrl, ['glassdoor.com']) && parsed.search.length > 1
      ? parsed.search.slice(1)
      : null;
  } catch {
    return null;
  }
}

export function buildGlassdoorDetailsUrl(listingId: string, queryString: string): string {
  const params = new URLSearchParams({ listingId, queryString });
  return `https://glassdoor-real-time.p.rapidapi.com/jobs/details?${params.toString()}`;
}

export function extractGlassdoorDetailDescription(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const job = (data as { job?: unknown }).job;
  if (!job || typeof job !== 'object') return null;
  const description = (job as { description?: unknown }).description;
  return typeof description === 'string' && description.trim() ? description.trim() : null;
}

export async function fetchGlassdoorJobDescription(job: {
  source?: string | null;
  sourceId?: string | null;
  url?: string | null;
  glassdoorQueryString?: string | null;
}, providerControl?: DetailProviderControl): Promise<string | null> {
  if (job.source !== GLASSDOOR_SOURCE || !job.sourceId) return null;
  const queryString = glassdoorQueryString(job.glassdoorQueryString, job.url);
  const rapidKeys = getRapidApiKeys();
  if (!queryString || rapidKeys.length === 0) return null;

  try {
    const response = await rotateKeysWithDurableCooldowns(rapidKeys, async (key) => budgetedProviderAttempt(
      GLASSDOOR_SOURCE,
      providerControl?.beforeRequest || (async (provider) => {
        const decision = await reserveProviderRequest({ provider, dailyLimit: 25 });
        if (!decision.allowed) throw new Error(`${provider} request blocked by ${decision.reason}`);
      }),
      () => fetch(buildGlassdoorDetailsUrl(job.sourceId!, queryString), {
        headers: {
          'X-RapidAPI-Key': key,
          'X-RapidAPI-Host': 'glassdoor-real-time.p.rapidapi.com',
        },
        signal: AbortSignal.timeout(30_000),
      }),
    ), 'Glassdoor');
    const description = await processDetailProviderResponse(
      GLASSDOOR_SOURCE,
      response,
      extractGlassdoorDetailDescription,
      providerControl?.success,
    );
    return description ? cleanHtmlText(description) : null;
  } catch (error) {
    providerControl?.failure(GLASSDOOR_SOURCE, error);
    return null;
  }
}

export async function budgetedProviderAttempt<T>(
  provider: string,
  beforeRequest: (provider: string) => Promise<void>,
  request: () => Promise<T>,
): Promise<T> {
  await beforeRequest(provider);
  return request();
}

export async function tryFetchFullDescription(job: {

  url?: string | null;
  resolvedUrl?: string | null;
  source?: string | null;
  sourceId?: string | null;
  company?: string | null;
  title?: string | null;
  glassdoorQueryString?: string | null;
}, providerControl?: DetailProviderControl): Promise<string | null> {
  const rapidKeys = getRapidApiKeys();

  // Glassdoor search results intentionally omit the JD. The paired details
  // endpoint is authoritative and must be used instead of sending the
  // provider's anti-bot tracking URL to canonical scraping or Jina.
  if (job.source === GLASSDOOR_SOURCE) {
    return fetchGlassdoorJobDescription(job, providerControl);
  }

  // Attempt API-based fetching first for perfect reliability
  if (job.source === "Indeed" && job.sourceId && rapidKeys.length > 0) {
    try {
      const res = await rotateKeysWithDurableCooldowns(rapidKeys, async (key) => budgetedProviderAttempt(
        'Indeed Details',
        providerControl?.beforeRequest || (async (provider) => {
          const decision = await reserveProviderRequest({ provider, dailyLimit: 25 });
          if (!decision.allowed) throw new Error(`${provider} request blocked by ${decision.reason}`);
        }),
        () => fetch(
        `https://indeed12.p.rapidapi.com/job/${job.sourceId}`,
        {
          headers: {
            "X-RapidAPI-Key": key,
            "X-RapidAPI-Host": "indeed12.p.rapidapi.com",
          },
        },
        )), 'Indeed12_Details');
      const description = await processDetailProviderResponse(
        'Indeed Details',
        res,
        (payload) => (payload as { description?: unknown } | null)?.description,
        providerControl?.success,
      );
      if (description) return cleanHtmlText(description);
    } catch (error) {
      providerControl?.failure('Indeed Details', error);
    }
  }

  // JSearch Details is unreachable by design since the v5 change and is left
  // disabled rather than deleted, so the reason survives with the code.
  //
  // The endpoint only accepts a `job_id` from the *same* Search call. We persist
  // `job_uid` (the stable id), and a job_uid lookup returns HTTP 200 with an
  // empty `data` array — a silent no-op that still spends a request. Pre-v5 ids
  // are rejected outright. The Search response already carries the full
  // `job_description`, so this path adds nothing even when it works.
  const JSEARCH_DETAILS_ENABLED = false;
  if (JSEARCH_DETAILS_ENABLED && job.source === "JSearch" && job.sourceId && rapidKeys.length > 0) {
    try {
      const res = await rotateKeysWithDurableCooldowns(rapidKeys, async (key) => budgetedProviderAttempt(
        'JSearch Details',
        providerControl?.beforeRequest || (async (provider) => {
          const decision = await reserveProviderRequest({ provider, dailyLimit: 25 });
          if (!decision.allowed) throw new Error(`${provider} request blocked by ${decision.reason}`);
        }),
        () => fetch(
        `https://jsearch.p.rapidapi.com/job-details?job_id=${job.sourceId}`,
        {
          headers: {
            "X-RapidAPI-Key": key,
            "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
          },
        },
        )), 'JSearch_Details');
      const description = await processDetailProviderResponse(
        'JSearch Details',
        res,
        (payload) => (payload as { data?: Array<{ job_description?: unknown }> } | null)?.data?.[0]?.job_description,
        providerControl?.success,
      );
      if (description) return description;
    } catch (error) {
      providerControl?.failure('JSearch Details', error);
    }
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
        
        if (bodyText.length > 500 && !looksLikeInvalidJobDescription(bodyText) && !(bodyText.startsWith('{') && bodyText.endsWith('}'))) {
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
    if (text.length > 500 && !looksLikeInvalidJobDescription(text)) return text;
    return null;
  } catch {
    // Ignore fetch error
  }

  return null;
}

export interface IngestionOptions {
  useStandard?: boolean;
  usePaidApis?: boolean;
  useCareerforce?: boolean;
  // The LinkedIn RapidAPI source binds the query to `title:`, so body-text
  // phrases ("two-tier distribution", "sell-through") return nothing there.
  // Set this when running a description-language query to skip that call
  // instead of burning quota on a guaranteed-empty search.
  skipTitleOnlySources?: boolean;
  /** Durable scheduler/task provenance. */
  taskId?: string;
  taskKey?: string;
  taskLeaseToken?: string;
  taskCadenceMs?: number;
  taskProvider?: string;
  taskContinuationDelayMs?: number;
  taskWindowStart?: Date;
  taskWindowEnd?: Date;
  queryFamily?: string;
  geoLane?: GeoLaneId | string;
  /** Query-independent sources are fetched once per interval, not per title. */
  includeQueryIndependentSources?: boolean;
  /** One durable task owns one concrete provider. */
  sourceAllowList?: readonly string[];
  sourceDenyList?: readonly string[];
  /** USAJOBS categorical travel bucket; currently only 8 = 76% or greater. */
  usaJobsTravelPercentage?: UsaJobsTravelPercentageCode;
  /** Bounded ATS batch progress and Workday description-deferral policy. */
  atsPlatform?: string;
  atsBatchWallClockMs?: number;
  deferWorkdayDescriptions?: boolean;
}

export async function ingestJobs(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  targetAtsSlugs?: {slug: string, platform: string}[],
  searchQuery?: string,
  initialStatus: string = 'pending_af',
  skipAts: boolean = false,
  options: IngestionOptions = { useStandard: true, usePaidApis: true, useCareerforce: true }
): Promise<number> {
  const serpApiKeys = getSerpApiKeys();
  const rapidApiKeys = getRapidApiKeys();
  const ingestionMode = targetAtsSlugs && targetAtsSlugs.length > 0
    ? 'ats'
    : [options.useStandard && 'standard', options.usePaidApis && 'paid', options.useCareerforce && 'careerforce']
      .filter(Boolean)
      .join('+') || 'direct';
  const queryFamily = options.queryFamily || normalizeQueryFamily(searchQuery || 'sales');
  const geoLane = getGeoLane(options.geoLane);
  const attribution = {
    searchQuery: searchQuery || null,
    ingestionMode,
    queryFamily,
    geoLane: geoLane.id,
    windowStart: options.taskWindowStart || null,
    windowEnd: options.taskWindowEnd || null,
    taskId: options.taskId || null,
  };

  let newJobsCount = 0;
  const ingestionStartedAt = new Date();
  const sourceStats = new Map<string, SourceRunCounts>();
  const sourceRunIds = new Map<string, Promise<string | null>>();
  const runIdentity = options.taskWindowEnd?.toISOString() || ingestionStartedAt.toISOString();
  const atsBatchStartedAt = options.atsPlatform ? ingestionStartedAt : null;
  const atsDeadlineMs = options.atsPlatform && options.atsBatchWallClockMs != null
    && Number.isFinite(options.atsBatchWallClockMs) && options.atsBatchWallClockMs > 0
    ? options.atsBatchWallClockMs
    : null;
  const atsDeadlineController = atsDeadlineMs == null ? null : new AbortController();
  let ingestionInterruptionReason: string | null = null;
  const atsDeadlineTimer = atsDeadlineController && atsDeadlineMs != null
    ? setTimeout(() => {
        const error = new IngestionInterruptedError(`ATS turn reached its ${atsDeadlineMs}ms wall-clock deadline.`);
        ingestionInterruptionReason = error.message;
        atsDeadlineController.abort(error);
      }, atsDeadlineMs)
    : null;
  const atsTurnSignal = options.atsPlatform
    ? signal && atsDeadlineController
      ? AbortSignal.any([signal, atsDeadlineController.signal])
      : signal || atsDeadlineController?.signal
    : undefined;
  const atsRequestSignal = (timeoutMs: number) => atsTurnSignal
    ? AbortSignal.any([atsTurnSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const captureAtsInterruption = (): IngestionInterruptedError | null => {
    if (atsDeadlineController && atsDeadlineMs != null && atsBatchStartedAt
      && Date.now() - atsBatchStartedAt.getTime() >= atsDeadlineMs
      && !atsDeadlineController.signal.aborted) {
      const deadlineError = new IngestionInterruptedError(`ATS turn reached its ${atsDeadlineMs}ms wall-clock deadline.`);
      ingestionInterruptionReason ||= deadlineError.message;
      atsDeadlineController.abort(deadlineError);
    }
    if (!atsTurnSignal?.aborted) return null;
    const error = signal?.aborted
      ? interruptionError(signal, 'Pipeline stop interrupted the ATS turn.')
      : interruptionError(atsTurnSignal, 'ATS turn interrupted.');
    ingestionInterruptionReason ||= error.message;
    return error;
  };
  const throwIfAtsInterrupted = () => {
    const error = captureAtsInterruption();
    if (error) throw error;
  };
  const atsProgress = options.atsPlatform ? {
    platform: options.atsPlatform,
    selectedCount: targetAtsSlugs?.length || 0,
    completedCount: 0,
    remainingDueCount: 0,
    currentBoard: null as string | null,
    batchStartedAt: ingestionStartedAt.toISOString(),
    lastUpdateAt: ingestionStartedAt.toISOString(),
  } : null;
  let checkpointInFlight: Promise<void> | null = null;
  let lastCheckpointAt = 0;
  const pendingProviderState: Promise<unknown>[] = [];
  const providerStateChains = new Map<string, Promise<unknown>>();
  const providerSuccesses = new Set<string>();
  const providerFailures = new Set<string>();
  const providerStateErrors: Error[] = [];
  const sourceEnabled = (source: string) => (
    (!options.sourceAllowList || options.sourceAllowList.includes(source))
    && (!options.sourceDenyList || !options.sourceDenyList.includes(source))
  );

  function aggregateCounters(): IngestionCounters {
    const total: IngestionCounters = {
      seen: 0,
      inserted: 0,
      duplicates: 0,
      filtered: 0,
      processingErrors: 0,
      providerErrors: 0,
      requests: 0,
    };
    for (const stats of sourceStats.values()) {
      total.seen += stats.seen;
      total.inserted += stats.inserted;
      total.duplicates += stats.duplicates;
      total.filtered += stats.filtered;
      total.processingErrors += stats.processingErrors;
      total.providerErrors += stats.requestErrors;
      total.requests = (total.requests || 0) + stats.requests;
    }
    return total;
  }

  async function persistCheckpoint(force = false) {
    const counters = aggregateCounters();
    const now = Date.now();
    if (!force && counters.seen % 25 !== 0 && now - lastCheckpointAt < 30_000) return;
    if (checkpointInFlight) {
      if (force) await checkpointInFlight;
      else return;
    }
    checkpointInFlight = (async () => {
      lastCheckpointAt = now;
      if (options.taskId && options.taskLeaseToken) {
        await checkpointIngestionTask({
          taskId: options.taskId,
          leaseToken: options.taskLeaseToken,
          counters,
          cursor: atsProgress
            ? { runIdentity, ...atsProgress, lastUpdateAt: new Date(now).toISOString() }
            : { runIdentity, updatedAt: new Date(now).toISOString() },
        });
      }
      await Promise.all(Array.from(sourceStats.entries()).map(async ([source, stats]) => {
        const runId = await sourceRunIds.get(source);
        if (!runId) return;
        const reconciled = ingestionReconciles({
          seen: stats.seen,
          inserted: stats.inserted,
          duplicates: stats.duplicates,
          filtered: stats.filtered,
          processingErrors: stats.processingErrors,
          providerErrors: stats.requestErrors,
        });
        await prisma.ingestionSourceRun.update({
          where: { id: runId },
          data: {
            status: 'running',
            seenCount: stats.seen,
            insertedCount: stats.inserted,
            duplicateCount: stats.duplicates,
            filteredCount: stats.filtered,
            errorCount: stats.processingErrors + stats.requestErrors,
            processingErrorCount: stats.processingErrors,
            requestErrorCount: stats.requestErrors,
            providerIncidentId: stats.providerIncidentId,
            reconciled,
            error: stats.lastError,
            checkpoint: { runIdentity, updatedAt: new Date(now).toISOString() },
          },
        }).catch((error) => console.error(`Failed to checkpoint ${source}:`, error));
      }));
    })().finally(() => { checkpointInFlight = null; });
    await checkpointInFlight;
  }

  function statsFor(source: string) {
    const existing = sourceStats.get(source);
    if (existing) return existing;
    const created: SourceRunCounts = {
      seen: 0,
      inserted: 0,
      duplicates: 0,
      filtered: 0,
      processingErrors: 0,
      requestErrors: 0,
      requests: 0,
      lastError: null,
      providerIncidentId: null,
    };
    sourceStats.set(source, created);
    sourceRunIds.set(source, prisma.ingestionSourceRun.create({
      data: {
        source,
        status: 'running',
        ...attribution,
        watermarkAt: options.taskWindowEnd || null,
        checkpoint: { runIdentity, phase: 'started' },
        // Zero observed candidates has a valid zero-outcome denominator. Mark
        // the durable row explicitly so rollout-era writers never inherit the
        // migration's legacy-only `reconciled=false` default.
        processingErrorCount: 0,
        requestErrorCount: 0,
        reconciled: true,
        startedAt: ingestionStartedAt,
      },
      select: { id: true },
    }).then((run) => run.id).catch((error) => {
      console.error(`Failed to start ${source} telemetry:`, error);
      return null;
    }));
    return created;
  }

  function enqueueProviderState(source: string, action: () => Promise<unknown>) {
    const previous = providerStateChains.get(source) || Promise.resolve();
    const next = previous
      .then(action, action)
      .catch((error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (INGESTION_SCHEDULER_V3_ENABLED) {
          providerStateErrors.push(failure);
          const stats = statsFor(source);
          stats.requestErrors++;
          stats.lastError = `Provider control persistence failed: ${failure.message}`.slice(0, 500);
        }
        console.error(`Failed to persist ${source} provider state:`, error);
      });
    providerStateChains.set(source, next);
    pendingProviderState.push(next);
  }

  function markSourceError(source: string, error: unknown) {
    const stats = statsFor(source);
    stats.requestErrors++;
    stats.lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    // Budget state is already durable and carries the exact UTC reset. Turning
    // quota exhaustion into a generic six-hour circuit would delay a task past
    // that authoritative reset.
    if (INGESTION_SCHEDULER_V3_ENABLED && /blocked by .*budget|daily_budget|monthly_budget/i.test(stats.lastError)) return;
    if (isPermanentSourceFailure(error)) {
      sourceCircuitOpenUntil.set(source, Date.now() + SOURCE_CIRCUIT_DURATION_MS);
    }
    providerFailures.add(source);
    enqueueProviderState(source, async () => {
      stats.providerIncidentId = await recordProviderFailure({
        provider: source,
        error,
        taskKey: options.taskKey,
        queryFamily,
        geoLane: geoLane.id,
      });
    });
  }

  function markSourceSuccess(source: string) {
    if (INGESTION_SCHEDULER_V3_ENABLED) providerSuccesses.add(source);
    else enqueueProviderState(source, () => recordProviderSuccess(source));
  }

  async function reserveSourceRequest(
    source: string,
    defaults: { dailyLimit?: number | null; monthlyLimit?: number | null } = {},
  ) {
    const stats = statsFor(source);
    const envPrefix = source.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const configuredDaily = Number.parseInt(process.env[`${envPrefix}_DAILY_LIMIT`] || '', 10);
    const configuredMonthly = Number.parseInt(process.env[`${envPrefix}_MONTHLY_LIMIT`] || '', 10);
    const decision = await reserveProviderRequest({
      provider: source,
      dailyLimit: Number.isFinite(configuredDaily) ? configuredDaily : defaults.dailyLimit,
      monthlyLimit: Number.isFinite(configuredMonthly) ? configuredMonthly : defaults.monthlyLimit,
    });
    if (!decision.allowed) {
      throw new Error(`${source} request blocked by ${decision.reason}`);
    }
    stats.requests++;
    await recordJobPipelineEvent({
      eventType: 'provider_request',
      taskId: options.taskId,
      stage: 'provider',
      source,
      queryFamily,
      geoLane: geoLane.id,
      details: { requestNumber: stats.requests },
      identityParts: [runIdentity, stats.requests],
    });
  }

  // Rehydrate open circuits before deciding which providers to call. The
  // in-memory map is only a fast mirror; ProviderCircuit remains authoritative.
  try {
    const openCircuits = await prisma.providerCircuit.findMany({
      where: { state: 'open', openUntil: { gt: new Date() } },
      select: { provider: true, openUntil: true },
    });
    for (const circuit of openCircuits) {
      if (circuit.openUntil) sourceCircuitOpenUntil.set(circuit.provider, circuit.openUntil.getTime());
    }
  } catch (error) {
    if (!hasPrismaCode(error, 'P2021') && !hasPrismaCode(error, 'P2022')) {
      console.error('Failed to hydrate provider circuits:', error);
    }
  }

  async function finishIngestion() {
    if (atsDeadlineTimer) clearTimeout(atsDeadlineTimer);
    captureAtsInterruption();
    if (signal?.aborted) {
      ingestionInterruptionReason ||= interruptionError(signal, 'Pipeline stop interrupted ingestion.').message;
    }
    const finishedAt = new Date();
    if (atsProgress) {
      atsProgress.currentBoard = null;
      atsProgress.lastUpdateAt = finishedAt.toISOString();
      atsProgress.remainingDueCount = await prisma.atsCompany.count({
        where: {
          platform: atsProgress.platform,
          status: { in: ['active', 'parked', 'blacklisted'] },
          nextCheckDate: { lte: finishedAt },
        },
      });
    }
    // Computed before the success sweep below: a zero-yield run must not clear
    // the provider's failure counter, or a drifted parser resets its own alarm
    // on every pass and never accumulates toward the circuit.
    const zeroYieldErrors = new Map<string, string>();
    if (!ingestionInterruptionReason) {
      for (const [source, stats] of sourceStats.entries()) {
        const error = zeroYieldRunError(stats, source);
        if (error) zeroYieldErrors.set(source, error);
      }
    }
    if (INGESTION_SCHEDULER_V3_ENABLED) {
      for (const source of providerSuccesses) {
        if (providerFailures.has(source) || zeroYieldErrors.has(source)) continue;
        enqueueProviderState(source, () => recordProviderSuccess(source, finishedAt));
      }
      // Diagnostic, deliberately not punitive. An empty result set is a real
      // answer for some (source, query, lane) combinations — Adzuna returns
      // HTTP 200 with zero results for the us_remote and upper_midwest lanes,
      // which it does not recognise as places. Opening the circuit on that
      // would park a provider that works perfectly in its other two lanes. The
      // condition is recorded on the run and withheld from the provider's
      // success sweep, so a drifted parser cannot keep clearing its own alarm.
      for (const [source, error] of zeroYieldErrors) {
        if (providerFailures.has(source)) continue;
        console.warn(`[${source}] ${error}`);
      }
    }
    await settleProviderState(pendingProviderState);
    await persistCheckpoint(true);
    if (sourceStats.size > 0) {
      const summary = Array.from(sourceStats.entries())
        .map(([source, stats]) => `${source}: ${stats.inserted} new, ${stats.duplicates} duplicate, ${stats.filtered} filtered, ${stats.processingErrors} processing errors, ${stats.requestErrors} request errors / ${stats.seen} seen`)
        .join(' | ');
      onProgress?.(`Source summary — ${summary}`);

      try {
        await Promise.all(Array.from(sourceStats.entries()).map(async ([source, stats]) => {
          const runId = await sourceRunIds.get(source);
          if (!runId) return;
          const sourceStatus = ingestionInterruptionReason ? 'partial' : ingestionSourceRunStatus(stats);
          const sourceError = stats.lastError || ingestionInterruptionReason || zeroYieldErrors.get(source) || null;
          await prisma.ingestionSourceRun.update({
            where: { id: runId },
            data: {
              status: sourceStatus,
              seenCount: stats.seen,
              insertedCount: stats.inserted,
              duplicateCount: stats.duplicates,
              filteredCount: stats.filtered,
              errorCount: stats.processingErrors + stats.requestErrors,
              processingErrorCount: stats.processingErrors,
              requestErrorCount: stats.requestErrors,
              providerIncidentId: stats.providerIncidentId,
              reconciled: ingestionReconciles({
                seen: stats.seen,
                inserted: stats.inserted,
                duplicates: stats.duplicates,
                filtered: stats.filtered,
                processingErrors: stats.processingErrors,
                providerErrors: stats.requestErrors,
              }),
              error: sourceError,
              checkpoint: { runIdentity, phase: ingestionInterruptionReason ? 'interrupted' : 'finished' },
              watermarkAt: sourceStatus === 'success' ? finishedAt : null,
              finishedAt,
              durationMs: finishedAt.getTime() - ingestionStartedAt.getTime(),
            },
          });
        }));
      } catch (error) {
        console.error('Failed to persist ingestion source telemetry:', error);
      }
    }
    if (options.taskId && options.taskKey && options.taskLeaseToken && options.taskCadenceMs != null) {
      const counters = aggregateCounters();
      // Detail enrichment is fail-soft: its own source run/incident remains
      // visible, but a successful parent search can advance its watermark and
      // route the job to needs_jd for later recovery.
      const taskSourceStats = Array.from(sourceStats.entries())
        .filter(([source]) => !source.endsWith(' Details'))
        .map(([, stats]) => stats);
      const statuses = taskSourceStats.map(ingestionSourceRunStatus);
      const allowedSource = options.sourceAllowList?.[0];
      let taskStatus = classifyIngestionTaskCompletion({
        sourceStatuses: statuses,
        lastErrors: taskSourceStats.map((stats) => stats.lastError),
        circuitOpen: Boolean(allowedSource && sourceCircuitIsOpen(allowedSource)),
      });
      if (ingestionInterruptionReason) taskStatus = 'partial';
      if (INGESTION_SCHEDULER_V3_ENABLED && providerStateErrors.length && (taskStatus === 'succeeded' || taskStatus === 'disabled')) taskStatus = 'partial';
      let providerRetryAt: Date | null = null;
      const taskProvider = options.taskProvider || allowedSource;
      if ((taskStatus === 'blocked_budget' || taskStatus === 'blocked_circuit') && taskProvider) {
        const circuit = await prisma.providerCircuit.findUnique({ where: { provider: taskProvider } });
        if (circuit) {
          const availability = evaluateProviderAvailability({ ...circuit, now: finishedAt });
          providerRetryAt = availability.retryAt || null;
          if (!availability.allowed) taskStatus = availability.reason === 'circuit_open' ? 'blocked_circuit' : 'blocked_budget';
        }
      }
      await completeIngestionTask({
        taskId: options.taskId,
        taskKey: options.taskKey,
        leaseToken: options.taskLeaseToken,
        status: taskStatus,
        counters,
        cadenceMs: options.taskCadenceMs,
        providerRetryAt,
        continuationDelayMs: atsProgress
          ? (atsProgress.remainingDueCount ? (options.taskContinuationDelayMs ?? 60_000) : null)
          : options.taskContinuationDelayMs,
        watermarkAt: options.taskWindowEnd || finishedAt,
        cursor: atsProgress
          ? { runIdentity, phase: ingestionInterruptionReason ? 'interrupted' : 'finished', ...atsProgress }
          : { runIdentity, phase: ingestionInterruptionReason ? 'interrupted' : 'finished' },
        error: [
          ...Array.from(sourceStats.values()).map((stats) => stats.lastError).filter(Boolean),
          ingestionInterruptionReason,
        ].filter(Boolean).join(' | ').slice(0, 1000) || null,
      });
    }
    return newJobsCount;
  }

  async function processJobInternal(jobData: IncomingJob): Promise<"inserted" | "duplicate" | "skipped" | "error" | void> {
    if (signal?.aborted) return;
    let title = typeof jobData.title === 'string' && jobData.title.trim() ? jobData.title.trim() : 'Unknown Title';
    let company = typeof jobData.company === 'string' && jobData.company.trim() ? jobData.company.trim() : 'Unknown Company';
    let description = typeof jobData.description === 'string' ? jobData.description : '';
    const location = typeof jobData.location === 'string' && jobData.location.trim()
      ? jobData.location.trim()
      : 'Unknown Location';
    const rawUrl = typeof jobData.url === 'string' ? jobData.url : '';
    const source = typeof jobData.source === 'string' ? jobData.source : 'Unknown';
    const sourceId = jobData.sourceId;
    const candidatePostedAt = jobData.postedAt instanceof Date ? jobData.postedAt : new Date(String(jobData.postedAt || ''));
    const postedAt = Number.isNaN(candidatePostedAt.getTime()) ? new Date() : candidatePostedAt;

    description = cleanHtmlText(description || "");
    const postingClosed = isClosedJobPosting(description);

    const stats = statsFor(source || 'Unknown');
    stats.seen++;
    if (sourceId == null || !String(sourceId).trim()) {
      stats.processingErrors++;
      stats.lastError = 'Job was missing a sourceId';
      await recordJobPipelineEvent({
        eventType: 'processing_error',
        taskId: options.taskId,
        stage: 'ingestion',
        source,
        queryFamily,
        geoLane: geoLane.id,
        details: { error: stats.lastError },
        identityParts: [runIdentity, title, company, rawUrl],
      });
      return 'error';
    }

    const canonicalUrl = normalizeUrl(rawUrl);
    let identityFingerprint = generateV4Fingerprint(title, company, location);

    // 1. Exact Source + SourceId in observations
    const obs = await prisma.jobSourceObservation.findUnique({
      where: { source_sourceId: { source, sourceId: sourceId.toString() } },
    });
    if (obs) {
      if (postingClosed) {
        await prisma.job.updateMany({
          where: { id: obs.jobId, status: { in: ['pending_af', 'inbox'] } },
          data: buildClosedPostingUpdate(),
        });
      }
      // A current Glassdoor search can safely revive only the legacy rows that
      // were hidden by terminal JD/Jina failure. This is deliberately bounded
      // to rediscovered live listings; ordinary dismissals and the historical
      // backlog are untouched.
      if (source === GLASSDOOR_SOURCE) {
        const observedJob = await prisma.job.findUnique({ where: { id: obs.jobId } });
        if (observedJob && isLegacyHiddenGlassdoorJdFailure(observedJob)) {
          const revived = await prisma.job.updateMany({
            where: {
              id: observedJob.id,
              source: GLASSDOOR_SOURCE,
              status: 'dismissed',
              scoringStatus: 'failed',
            },
            data: {
              status: 'pending_af',
              scoringStatus: 'needs_jd',
              scoreAttempts: 0,
              scoreError: null,
              passReason: null,
              jdBatchId: null,
              batchJobId: null,
            },
          });
          if (revived.count === 1) {
            await recordJobPipelineEvent({
              eventType: 'jd_recovery_requeued',
              jobId: observedJob.id,
              taskId: options.taskId,
              stage: 'jd',
              source,
              sourceId: sourceId.toString(),
              queryFamily,
              geoLane: geoLane.id,
              details: { reason: 'rediscovered_legacy_glassdoor_jd_failure' },
              identityParts: [runIdentity],
            });
          }
        }
      }
      await recordJobPipelineEvent({
        eventType: 'duplicate',
        jobId: obs.jobId,
        taskId: options.taskId,
        stage: 'ingestion',
        source,
        sourceId: sourceId.toString(),
        queryFamily,
        geoLane: geoLane.id,
        details: { reason: 'source_observation' },
        identityParts: [runIdentity],
      });
      stats.duplicates++;
      return 'duplicate';
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
        await prisma.$transaction(async (tx) => {
          await tx.jobSourceObservation.create({
            data: {
              jobId: existingJob.id,
              source,
              sourceId: sourceId.toString(),
              url: rawUrl,
              ...attribution,
            },
          });
          await recordJobPipelineEvent({
            eventType: 'duplicate',
            jobId: existingJob.id,
            taskId: options.taskId,
            stage: 'ingestion',
            source,
            sourceId: sourceId.toString(),
            queryFamily,
            geoLane: geoLane.id,
            details: { reason: 'stable_identity' },
            identityParts: [runIdentity],
          }, tx);
        });
      } catch (error: unknown) {
        if (!hasPrismaCode(error, 'P2002')) throw error;
      }
      stats.duplicates++;
      return 'duplicate';
    }

    let finalDescription = description || "";
    let finalCanonicalUrl = canonicalUrl;
    let manualAts: string | undefined = undefined;

    // This is intentionally language-only: the title and any provider snippet
    // are enough to stop an affirmative non-English posting before ingestion
    // spends an ATS/details request. Sparse or ambiguous metadata proceeds.
    const availableLanguage = assessJobInfoLanguage({ title, description: finalDescription });

    // Glassdoor exposes the complete title/company/location tuple in search.
    // Run the existing description-independent local gate before consuming a
    // second paid request for `/jobs/details`. Geography is intentionally not
    // decided here; that remains owned by the downstream Aim evaluation.
    const glassdoorMetadataFilter = source === GLASSDOOR_SOURCE
      ? passesPreFilter({
          title,
          company,
          description: '',
          location,
          url: rawUrl,
        })
      : null;

    const isAggregator = urlMatchesAnyHost(rawUrl, [
      'adzuna.com',
      'indeed.com',
      'jsearch.p.rapidapi.com',
      'linkedin.com',
    ]);

    if (
      glassdoorMetadataFilter?.passes !== false
      && !availableLanguage.isAffirmativelyNonEnglish
      && !options.deferWorkdayDescriptions
      && (finalDescription.length < 400 || isAggregator)
    ) {
      let resolvedUrl = null;
      if (isAggregator && rawUrl) {
        try {
          const directUrl = await resolveRedirectUrl(rawUrl, 3000);
          if (directUrl && directUrl !== rawUrl && !urlMatchesAnyHost(directUrl, ['adzuna.com', 'jsearch.p.rapidapi.com'])) {
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
         if (atsResult.text) finalDescription = atsResult.text;
         manualAts = atsResult.ats;
         if (atsResult.title) {
            title = atsResult.title;
         }
         if (atsResult.company) {
            company = atsResult.company;
         } else if (atsResult.atsSlug) {
            const lowerCompany = company.toLowerCase();
            if (/job-boards|greenhouse\.io|lever\.co|ashbyhq/i.test(lowerCompany)) {
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
      }
      if (!atsResult?.text) {
         const scraped = await tryFetchFullDescription({
           url: rawUrl,
           resolvedUrl,
           source,
           sourceId: sourceId.toString(),
           company,
           title,
           glassdoorQueryString: typeof jobData.glassdoorQueryString === 'string'
             ? jobData.glassdoorQueryString
             : null,
         }, {
           beforeRequest: (provider) => reserveSourceRequest(provider, { dailyLimit: 25 }),
           success: markSourceSuccess,
           failure: markSourceError,
         });
         if (scraped && scraped.length > finalDescription.length) {
           finalDescription = scraped;
         }
      }
    }

    finalCanonicalUrl = normalizeUrl(finalCanonicalUrl);
    identityFingerprint = generateV4Fingerprint(title, company, location);
    const postingIdentity = generatePostingIdentity({
      source,
      sourceId: sourceId.toString(),
      canonicalUrl: finalCanonicalUrl,
      url: rawUrl,
    });
    const enrichedPostingClosed = isClosedJobPosting(finalDescription);

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
      await prisma.$transaction(async (tx) => {
        await tx.jobSourceObservation.upsert({
          where: { source_sourceId: { source, sourceId: sourceId.toString() } },
          update: { url: rawUrl, ...attribution },
          create: {
            jobId: enrichedDuplicate.id,
            source,
            sourceId: sourceId.toString(),
            url: rawUrl,
            ...attribution,
          },
        });
        await recordJobPipelineEvent({
          eventType: 'duplicate',
          jobId: enrichedDuplicate.id,
          taskId: options.taskId,
          stage: 'ingestion',
          source,
          sourceId: sourceId.toString(),
          queryFamily,
          geoLane: geoLane.id,
          details: { reason: 'enriched_stable_identity' },
          identityParts: [runIdentity],
        }, tx);
      });
      stats.duplicates++;
      return 'duplicate';
    }

    
    const preFilterResult = glassdoorMetadataFilter?.passes === false
      ? glassdoorMetadataFilter
      : passesPreFilter({
          title,
          company,
          description: finalDescription,
          location,
          url: rawUrl,
        });

    // Derived once from the enriched description and spread into every create
    // below, so an archived job carries the same posted facts as a live one and
    // a later status change never has to recompute them. A structured override
    // (Rippling's payRangeDetails) wins over whatever the prose extractor found,
    // since it is read directly off the source rather than guessed from text.
    const structuredCompensation = typeof jobData.postedCompensationOverride === 'string'
      ? jobData.postedCompensationOverride
      : null;
    const enrichedPostingFacts = {
      ...derivePostingFacts(finalDescription),
      ...(structuredCompensation ? { postedCompensation: structuredCompensation } : {}),
    };

    if (!enrichedPostingClosed && !preFilterResult.passes) {
      // Save as archived so we don't process it, but we keep the observation
      try {
        await prisma.$transaction(async (tx) => {
          const created = await tx.job.create({
            data: {
            title,
            company,
            description: finalDescription,
            ...enrichedPostingFacts,
            location,
            url: rawUrl,
            source,
            sourceId: sourceId.toString(),
            canonicalUrl: finalCanonicalUrl,
            manualAts,
            fingerprint: null,
            identityFingerprint,
            postingIdentity,
            postedAt,
            status: "archived",
            passReason: preFilterResult.reason,
            scoringStatus: "skipped",
            observations: {
              create: {
                source,
                sourceId: sourceId.toString(),
                url: rawUrl,
                ...attribution,
              },
            },
            },
          });
          await recordJobPipelineEvent({
            eventType: 'prefilter_rejected',
            jobId: created.id,
            taskId: options.taskId,
            stage: 'prefilter',
            source,
            sourceId: sourceId.toString(),
            queryFamily,
            geoLane: geoLane.id,
            details: { reason: preFilterResult.reason },
            identityParts: [runIdentity],
          }, tx);
        });
        stats.filtered++;
      } catch (error: unknown) {
        if (!hasPrismaCode(error, 'P2002')) throw error;
        await recordJobPipelineEvent({
          eventType: 'duplicate',
          taskId: options.taskId,
          stage: 'ingestion',
          source,
          sourceId: sourceId.toString(),
          queryFamily,
          geoLane: geoLane.id,
          details: { reason: 'concurrent_identity' },
          identityParts: [runIdentity],
        });
        stats.duplicates++;
        return 'duplicate';
      }
      return 'skipped';
    }

    // New Job! Save as pending_af for batch processing

    // Direct ATS adapters read the provider's structured posting-description
    // field. Do not mistake non-English or unusually headed complete postings
    // for missing JDs; terminal, short, and visibly truncated content still
    // fails the shared quality gate.
    const needsJd = !enrichedPostingClosed && !isScorableJobDescription(finalDescription, { structuredSource: true });
    const machineInitialStatus = enrichedPostingClosed
      ? 'dismissed'
      : initialStatus === 'pending_af' ? initialStatus : 'pending_af';

    try {
      const created = await prisma.$transaction(async (tx) => {
        const job = await tx.job.create({
          data: {
          title,
          company,
          description: finalDescription,
          ...enrichedPostingFacts,
          location,
          url: rawUrl,
          source,
          sourceId: sourceId.toString(),
          canonicalUrl: finalCanonicalUrl,
          manualAts,
          fingerprint: null,
          identityFingerprint,
          postingIdentity,
          postedAt,
          status: machineInitialStatus,
          scoringStatus: enrichedPostingClosed ? 'skipped' : needsJd ? 'needs_jd' : 'queued',
          ...(enrichedPostingClosed ? { passReason: 'Job posting is closed.' } : {}),
          observations: {
            create: {
              source,
              sourceId: sourceId.toString(),
              url: rawUrl,
              ...attribution,
            },
          },
          },
        });
        await recordJobPipelineEvent({
          eventType: 'ingested',
          jobId: job.id,
          taskId: options.taskId,
          stage: 'ingestion',
          source,
          sourceId: sourceId.toString(),
          queryFamily,
          geoLane: geoLane.id,
          details: { initialStatus: machineInitialStatus, needsJd, postingClosed: enrichedPostingClosed },
          identityParts: [runIdentity],
        }, tx);
        if (!needsJd && !enrichedPostingClosed) {
          await recordJobPipelineEvent({
            eventType: 'jd_ready',
            jobId: job.id,
            taskId: options.taskId,
            stage: 'jd',
            source,
            sourceId: sourceId.toString(),
            queryFamily,
            geoLane: geoLane.id,
            identityParts: [runIdentity, 'ingestion'],
          }, tx);
        }
        return job;
      });
      void created;
      newJobsCount++;
      stats.inserted++;
      return 'inserted';
    } catch (error: unknown) {
      if (!hasPrismaCode(error, 'P2002')) throw error;
      await recordJobPipelineEvent({
        eventType: 'duplicate',
        taskId: options.taskId,
        stage: 'ingestion',
        source,
        sourceId: sourceId.toString(),
        queryFamily,
        geoLane: geoLane.id,
        details: { reason: 'concurrent_identity' },
        identityParts: [runIdentity],
      });
      stats.duplicates++;
      return 'duplicate';
    }
  }

  async function processJob(jobData: IncomingJob): Promise<'inserted' | 'duplicate' | 'skipped' | 'error' | void> {
    const source = typeof jobData.source === 'string' && jobData.source.trim()
      ? jobData.source.trim()
      : 'Unknown';
    try {
      return await processJobInternal(jobData);
    } catch (error) {
      const stats = statsFor(source);
      stats.processingErrors++;
      stats.lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      await recordJobPipelineEvent({
        eventType: 'processing_error',
        taskId: options.taskId,
        stage: 'ingestion',
        source,
        sourceId: typeof jobData.sourceId === 'string' ? jobData.sourceId : null,
        queryFamily,
        geoLane: geoLane.id,
        details: { error: stats.lastError },
        identityParts: [runIdentity, typeof jobData.url === 'string' ? jobData.url : ''],
      });
      console.error(`Error processing ${source} job:`, error);
      return 'error';
    } finally {
      void persistCheckpoint().catch((error) => console.error('Failed to persist ingestion checkpoint:', error));
    }
  }

  // BROAD SEARCH
  const baseQuery = searchQuery || "sales";
  // Geography is a deterministic task dimension. Never randomly choose a lane:
  // randomness made coverage impossible to measure and left silent gaps.

  // 0. BioSpace RSS Scraper
  if (options.useStandard && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    if (sourceEnabled('BioSpace') && !sourceCircuitIsOpen('BioSpace')) {
    statsFor('BioSpace');
    if (onProgress) onProgress("Searching BioSpace RSS...");
    try {
      await reserveSourceRequest('BioSpace');
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
          
          let company = "Unknown Company";
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

          let location = "Unknown Location";
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
      markSourceSuccess('BioSpace');
    } catch (e) {
       markSourceError('BioSpace', e);
       console.error("BioSpace scraper failed", e);
    }
    }

    // 0.1 The Muse API (query-independent; once per scheduled interval)
    if (options.includeQueryIndependentSources !== false && sourceEnabled('TheMuse') && !sourceCircuitIsOpen('TheMuse')) {
      statsFor('TheMuse');
      if (onProgress) onProgress("Searching The Muse API...");
      try {
        const windowStart = museWindowStart(Date.now());
        // A budget stop is a healthy outcome, not a provider fault: the source
        // answered fine, we simply chose not to spend more requests today.
        let museReachedProvider = false;
        let museBudgetStopped = false;

        for (const category of MUSE_CATEGORIES) {
          if (museBudgetStopped) break;
          for (let offset = 0; offset < MUSE_PAGES_PER_RUN; offset += 1) {
            const page = (windowStart + offset) % MUSE_PAGE_LIMIT;
            try {
              await reserveSourceRequest('TheMuse', { dailyLimit: MUSE_DAILY_REQUEST_LIMIT });
            } catch {
              museBudgetStopped = true;
              break;
            }

            const museUrl = `https://www.themuse.com/api/public/jobs?page=${page}`
              + `&category=${encodeURIComponent(category)}`;
            const museRes = await fetch(museUrl);
            // Past the undocumented depth cap. End of range, not a failure.
            if (museRes.status === 400) break;
            if (!museRes.ok) throw new Error(`HTTP ${museRes.status}`);
            museReachedProvider = true;

            const data = await museRes.json();
            const jobs = data.results || [];
            for (const job of jobs) {
              const location = job.locations && job.locations.length > 0 ? job.locations[0].name : "Unknown Location";
              if (!/\b(us|usa|u\.s\.|united states|remote|flexible)\b|,\s*[A-Z]{2}\b/i.test(location)) continue;

              try {
                await processJob({
                  title: job.name,
                  company: job.company?.name || "Unknown Company",
                  description: job.contents,
                  location,
                  url: job.refs?.landing_page || String(job.id),
                  source: 'TheMuse',
                  sourceId: String(job.id),
                  postedAt: job.publication_date ? new Date(job.publication_date) : new Date(),
                });
              } catch (err) {
                console.error("Error processing single job:", err);
              }
            }
          }
        }

        if (museReachedProvider || museBudgetStopped) markSourceSuccess('TheMuse');
      } catch (e) {
        markSourceError('TheMuse', e);
        console.error("The Muse scraper failed", e);
      }
    }

    // 0.2 Himalayas API
    if (sourceEnabled('Himalayas') && !sourceCircuitIsOpen('Himalayas')) {
    statsFor('Himalayas');
    if (onProgress) onProgress("Searching Himalayas API...");
    try {
      // baseQuery first so a task-configured search always runs, then the
      // rotating window. Deduplicated in case baseQuery is already in the list.
      const himalayasQueries = [...new Set([baseQuery, ...himalayasQueryWindow(Date.now())])];
      // A budget stop is a healthy outcome, not a provider fault.
      let himalayasReachedProvider = false;
      let himalayasBudgetStopped = false;

      for (const query of himalayasQueries) {
        try {
          await reserveSourceRequest('Himalayas', { dailyLimit: HIMALAYAS_DAILY_REQUEST_LIMIT });
        } catch {
          himalayasBudgetStopped = true;
          break;
        }

        const himalayasParams = new URLSearchParams({
          q: query,
          country: 'US',
          sort: 'recent',
          page: '1',
        });
        const himalayasRes = await fetch(`https://himalayas.app/jobs/api/search?${himalayasParams}`);
        // Documented backoff. Stop the sweep rather than spending the rest of
        // the window on requests that will be refused.
        if (himalayasRes.status === 429) break;
        if (!himalayasRes.ok) throw new Error(`HTTP ${himalayasRes.status}`);
        himalayasReachedProvider = true;

        const data = await himalayasRes.json();
        const jobs = data.jobs || [];
        for (const job of jobs) {
          const parsed = parseHimalayasJob(job);
          if (!parsed) continue;
          try {
            await processJob(parsed);
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }

      if (himalayasReachedProvider || himalayasBudgetStopped) markSourceSuccess('Himalayas');
    } catch (e) {
      markSourceError('Himalayas', e);
      console.error("Himalayas scraper failed", e);
    }
    }

    // 0.3 Remotive API
    if (sourceEnabled('Remotive') && !sourceCircuitIsOpen('Remotive')) {
    statsFor('Remotive');
    if (onProgress) onProgress("Searching Remotive API...");
    try {
      await reserveSourceRequest('Remotive');
      const remotiveRes = await fetch(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(baseQuery)}&limit=50`);
      if (!remotiveRes.ok) throw new Error(`HTTP ${remotiveRes.status}`);
      {
        const data = await remotiveRes.json();
        const jobs = data.jobs || [];
        for (const job of jobs) {
          const location = job.candidate_required_location || "Remote / Location unspecified";
          if (!/\b(us|usa|u\.s\.|united states|worldwide|anywhere|remote)\b/i.test(location)) continue;

          try {
            await processJob({
            title: job.title,
            company: job.company_name || "Unknown Company",
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
      markSourceSuccess('Remotive');
    } catch (e) {
      markSourceError('Remotive', e);
      console.error("Remotive scraper failed", e);
    }
    }

    // 0.3 RemoteOK public feed (query-independent; free, no key).
    if (options.includeQueryIndependentSources !== false && sourceEnabled('RemoteOK') && !sourceCircuitIsOpen('RemoteOK')) {
      statsFor('RemoteOK');
      onProgress?.('Searching RemoteOK feed...');
      try {
        await reserveSourceRequest('RemoteOK');
        const response = await fetch('https://remoteok.com/api', {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-dashboard)' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const items = Array.isArray(payload) ? payload : [];
        for (const item of items) {
          if (signal?.aborted) break;
          const parsed = parseRemoteOkJob(item);
          if (!parsed) continue;
          try {
            await processJob(parsed);
          } catch (err) {
            console.error('Error processing single job:', err);
          }
        }
        markSourceSuccess('RemoteOK');
      } catch (e) {
        markSourceError('RemoteOK', e);
        console.error('RemoteOK ingestion failed', e);
      }
    }

    // 0.35 Jobicy remote feed (query-independent; free, no key).
    if (options.includeQueryIndependentSources !== false && sourceEnabled('Jobicy') && !sourceCircuitIsOpen('Jobicy')) {
      statsFor('Jobicy');
      onProgress?.('Searching Jobicy feed...');
      try {
        await reserveSourceRequest('Jobicy');
        const response = await fetch('https://jobicy.com/api/v2/remote-jobs?count=50&geo=usa', {
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const items = Array.isArray(payload?.jobs) ? payload.jobs : [];
        for (const item of items) {
          if (signal?.aborted) break;
          const parsed = parseJobicyJob(item);
          if (!parsed) continue;
          try {
            await processJob(parsed);
          } catch (err) {
            console.error('Error processing single job:', err);
          }
        }
        markSourceSuccess('Jobicy');
      } catch (e) {
        markSourceError('Jobicy', e);
        console.error('Jobicy ingestion failed', e);
      }
    }

    // 0.4 Arbeitnow API (query-independent; once per scheduled interval)
    if (options.includeQueryIndependentSources !== false && sourceEnabled('Arbeitnow') && !sourceCircuitIsOpen('Arbeitnow')) {
      statsFor('Arbeitnow');
      if (onProgress) onProgress("Searching Arbeitnow API...");
      try {
      await reserveSourceRequest('Arbeitnow');
      const arbeitRes = await fetch("https://www.arbeitnow.com/api/job-board-api");
      if (!arbeitRes.ok) throw new Error(`HTTP ${arbeitRes.status}`);
      {
        const data = await arbeitRes.json();
        const jobs = data.data || [];
        for (const job of jobs) {
          if (!job.title.toLowerCase().includes("sales") && !job.title.toLowerCase().includes("account executive") && !job.title.toLowerCase().includes("district manager") && !job.title.toLowerCase().includes("regional manager")) continue;
          
          const location = job.location || "Unknown Location";
          if (!/\b(us|usa|u\.s\.|united states)\b/i.test(location)) continue;

          try {
            await processJob({
            title: job.title,
            company: job.company_name || "Unknown Company",
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
      markSourceSuccess('Arbeitnow');
      } catch (e) {
        markSourceError('Arbeitnow', e);
        console.error("Arbeitnow scraper failed", e);
      }
    }

    // 0.5 We Work Remotely official sales/marketing RSS. The feed is already
    // remote-only and query-independent, so fetch it exactly once per interval.
    if (options.includeQueryIndependentSources !== false && sourceEnabled('WeWorkRemotely') && !sourceCircuitIsOpen('WeWorkRemotely')) {
      statsFor('WeWorkRemotely');
      onProgress?.('Searching We Work Remotely sales RSS...');
      try {
        await reserveSourceRequest('WeWorkRemotely');
        const response = await fetch('https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss', {
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const xml = await response.text();
        const $ = cheerio.load(xml, { xmlMode: true });
        for (const item of $('item').slice(0, 100).toArray()) {
          const node = $(item);
          const rawTitle = node.find('title').text().trim();
          const separator = rawTitle.indexOf(':');
          const company = separator > 0 ? rawTitle.slice(0, separator).trim() : 'Unknown Company';
          const title = separator > 0 ? rawTitle.slice(separator + 1).trim() : rawTitle;
          const url = node.find('link').text().trim();
          const sourceId = node.find('guid').text().trim() || url;
          const region = node.find('region').text().trim() || node.find('location').text().trim();
          await processJob({
            title,
            company,
            description: node.find('description').text(),
            location: remoteFeedLocation(region),
            url,
            source: 'WeWorkRemotely',
            sourceId,
            postedAt: node.find('pubDate').text() ? new Date(node.find('pubDate').text()) : new Date(),
          });
        }
        markSourceSuccess('WeWorkRemotely');
      } catch (error) {
        markSourceError('WeWorkRemotely', error);
        console.error('We Work Remotely ingestion failed:', error);
      }
    }
  }

  // Optional official/first-party aggregators. These run independently of
  // SerpApi/RapidAPI so a missing paid-search key no longer disables ingestion.
  if (options.useStandard && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    const careerOneStopUserId = process.env.CAREERONESTOP_USER_ID;
    const careerOneStopToken = process.env.CAREERONESTOP_API_TOKEN;
    if (sourceEnabled('CareerOneStop') && careerOneStopUserId && careerOneStopToken && !sourceCircuitIsOpen('CareerOneStop')) {
      statsFor('CareerOneStop');
      onProgress?.('Searching CareerOneStop Jobs V2 canary...');
      try {
        await reserveSourceRequest('CareerOneStop');
        const windowStart = options.taskWindowStart || new Date(Date.now() - 24 * 60 * 60 * 1000);
        const days = Math.max(1, Math.min(30, Math.ceil((Date.now() - windowStart.getTime()) / (24 * 60 * 60 * 1000))));
        const plan = providerGeoPlan('CareerOneStop', geoLane.id);
        const location = plan.location;
        const radius = plan.radius;
        const keyword = [baseQuery, plan.querySuffix].filter(Boolean).join(' ');
        const requestUrl = buildCareerOneStopJobsUrl({
          userId: careerOneStopUserId,
          keyword,
          location,
          radius,
          days,
        });
        const response = await fetch(requestUrl, {
          headers: { Authorization: `Bearer ${careerOneStopToken}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const jobs = Array.isArray(data.Jobs)
          ? data.Jobs
          : Array.isArray(data.jobs) ? data.jobs : [];
        for (const job of jobs) {
          const parsed = parseCareerOneStopJob(job);
          if (parsed) await processJob(parsed);
        }
        markSourceSuccess('CareerOneStop');
      } catch (error) {
        markSourceError('CareerOneStop', error);
        console.error('CareerOneStop ingestion failed:', error);
      }
    }

    const adzunaAppId = process.env.ADZUNA_APP_ID;
    const adzunaAppKey = process.env.ADZUNA_APP_KEY;
    if (sourceEnabled('Adzuna') && adzunaAppId && adzunaAppKey && !sourceCircuitIsOpen('Adzuna')) {
      if (adzunaAppId === '9bac44d3' || adzunaAppKey === '3a25ae905ca0217c578cca270cac955e') {
        console.warn('Skipping Adzuna: Using documentation placeholder API keys. Please update .env with valid credentials.');
      } else {
        statsFor('Adzuna');
        onProgress?.('Searching Adzuna...');
      try {
        for (let page = 1; page <= 2; page++) {
          await reserveSourceRequest('Adzuna', { dailyLimit: 80, monthlyLimit: 2_500 });
          const plan = providerGeoPlan('Adzuna', geoLane.id);
          const params = new URLSearchParams({
            app_id: adzunaAppId,
            app_key: adzunaAppKey,
            results_per_page: '50',
            what: [baseQuery, plan.querySuffix].filter(Boolean).join(' '),
            where: plan.location,
            max_days_old: '7',
            sort_by: 'date',
          });
          // A zero radius is Adzuna's "no distance constraint", but sending
          // distance=0 is rejected outright with HTTP 400 — the us_remote lane
          // failed on every single request that way. Omit the parameter instead.
          if (plan.radius && plan.radius !== '0') params.set('distance', plan.radius);
          const response = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/${page}?${params}&content-type=application/json`, {
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
              location: job.location?.display_name || 'Unknown Location',
              url: job.redirect_url || '',
              source: 'Adzuna',
              sourceId: String(job.id || job.redirect_url || ''),
              postedAt: job.created ? new Date(job.created) : new Date(),
            });
          }
          if (jobs.length < 50) break;
        }
        markSourceSuccess('Adzuna');
      } catch (error) {
        markSourceError('Adzuna', error);
        console.error('Adzuna ingestion failed:', error);
      }
      }
    }

    const usaJobsKey = process.env.USAJOBS_API_KEY;
    const usaJobsUserAgent = process.env.USAJOBS_USER_AGENT;
    if (sourceEnabled('USAJOBS') && usaJobsKey && usaJobsUserAgent && !sourceCircuitIsOpen('USAJOBS')) {
      statsFor('USAJOBS');
      onProgress?.('Searching USAJOBS...');
      try {
        const searches = buildUsaJobsSearchRequests({
          keyword: baseQuery,
          geoLane: geoLane.id,
          travelPercentage: options.usaJobsTravelPercentage,
        });
        for (const search of searches) {
          await reserveSourceRequest('USAJOBS');
          const response = await fetch(search.url, {
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
              location: locations.join(', ') || (search.remoteOnly ? 'Remote / United States' : 'Unknown Location'),
              url: descriptor.PositionURI || '',
              source: 'USAJOBS',
              sourceId: String(descriptor.PositionID || descriptor.PositionURI || ''),
              postedAt: descriptor.PublicationStartDate ? new Date(descriptor.PublicationStartDate) : new Date(),
            });
          }
        }
        markSourceSuccess('USAJOBS');
      } catch (error) {
        markSourceError('USAJOBS', error);
        console.error('USAJOBS ingestion failed:', error);
      }
    }
  }

  // 1. CareerForce MN Scraper
  if (options.useCareerforce && sourceEnabled('CareerForce') && !sourceCircuitIsOpen('CareerForce') && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('CareerForce');
    if (onProgress) onProgress("Starting CareerForce MN Stealth Scraper...");
    try {
      await reserveSourceRequest('CareerForce');
      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'src/scripts/careerForceScraper.ts');
      
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, baseQuery], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          // The child stops taking new work at this budget and exits cleanly
          // with a partial summary. The kill timer below is only a backstop for
          // a child that has stopped responding at all.
          env: { ...process.env, SCRAPER_BUDGET_MS: String(SCRAPER_GRACEFUL_BUDGET_MS) },
        });
        let settled = false;
        let interruptedByStop = false;
        let terminationStarted = false;
        let terminationErrorRecorded = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        const terminateChild = (cause: 'stop' | 'timeout') => {
          if (terminationStarted) return;
          terminationStarted = true;
          if (cause === 'stop') {
            interruptedByStop = true;
            ingestionInterruptionReason ||= signal
              ? interruptionError(signal, 'Pipeline stop interrupted CareerForce ingestion.').message
              : 'Pipeline stop interrupted CareerForce ingestion.';
          } else {
            terminationErrorRecorded = true;
            markSourceError('CareerForce', new Error(`CareerForce scraper did not exit within its ${SCRAPER_HARD_KILL_MS}ms backstop`));
          }
          signalChildProcessGroup(child, 'SIGTERM');
          forceKillTimer = setTimeout(() => signalChildProcessGroup(child, 'SIGKILL'), 5_000);
        };
        const wallClockTimer = setTimeout(() => terminateChild('timeout'), SCRAPER_HARD_KILL_MS);
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(wallClockTimer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          signal?.removeEventListener('abort', abortChild);
          resolve();
        };
        const abortChild = () => terminateChild('stop');
        signal?.addEventListener('abort', abortChild, { once: true });
        if (signal?.aborted) abortChild();
        
        child.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter(Boolean);
          lines.forEach((line: string) => {
             if (onProgress) onProgress(`[CareerForce] ${line}`);
             
             const summaryMatch = line.match(/^INGESTION_SUMMARY\s+(\{.*\})$/);
             if (summaryMatch?.[1]) {
               try {
                 const summary = JSON.parse(summaryMatch[1]);
                 const stats = statsFor('CareerForce');
                 stats.seen = Number(summary.seen) || 0;
                 stats.inserted = Number(summary.inserted) || 0;
                 stats.duplicates = Number(summary.duplicates) || 0;
                 stats.filtered = Number(summary.filtered) || 0;
                 stats.processingErrors = Number(summary.processingErrors) || 0;
                 newJobsCount += stats.inserted;
                 // Running out of time is an early finish, not a fault. It must
                 // not reach markSourceError, or the provider circuit opens on
                 // a run that ingested real jobs.
                 if (summary.budgetExhausted) {
                   onProgress?.(`CareerForce Scraper stopped early on its time budget after ingesting ${stats.inserted} job(s).`);
                 }
               } catch (error) {
                 markSourceError('CareerForce', new Error(`Invalid scraper summary: ${String(error)}`));
               }
             }
          });
        });
        
        child.stderr.on('data', (data) => {
          console.error(`[CareerForce Error] ${data.toString()}`);
        });
        
        child.on('close', (code, closeSignal) => {
          if (interruptedByStop) {
            onProgress?.('CareerForce Scraper interrupted by pipeline stop.');
          } else if (code === 0) markSourceSuccess('CareerForce');
          else if (!terminationErrorRecorded) markSourceError('CareerForce', new Error(`Exited with ${code == null ? `signal ${closeSignal || 'unknown'}` : `code ${code}`}`));
          if (onProgress) onProgress(`CareerForce Scraper finished with code ${code}`);
          finish();
        });

        child.on('error', (err) => {
          if (!interruptedByStop && !terminationErrorRecorded) markSourceError('CareerForce', err);
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
  if (options.useStandard && sourceEnabled('Dejobs') && !sourceCircuitIsOpen('Dejobs') && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('Dejobs');
    if (onProgress) onProgress("Starting Dejobs National Scraper...");
    try {
      await reserveSourceRequest('Dejobs');
      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'src/scripts/dejobsScraper.ts');
      
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, baseQuery], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          // The child stops taking new work at this budget and exits cleanly
          // with a partial summary. The kill timer below is only a backstop for
          // a child that has stopped responding at all.
          env: { ...process.env, SCRAPER_BUDGET_MS: String(SCRAPER_GRACEFUL_BUDGET_MS) },
        });
        let settled = false;
        let interruptedByStop = false;
        let terminationStarted = false;
        let terminationErrorRecorded = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        const terminateChild = (cause: 'stop' | 'timeout') => {
          if (terminationStarted) return;
          terminationStarted = true;
          if (cause === 'stop') {
            interruptedByStop = true;
            ingestionInterruptionReason ||= signal
              ? interruptionError(signal, 'Pipeline stop interrupted Dejobs ingestion.').message
              : 'Pipeline stop interrupted Dejobs ingestion.';
          } else {
            terminationErrorRecorded = true;
            markSourceError('Dejobs', new Error(`Dejobs scraper did not exit within its ${SCRAPER_HARD_KILL_MS}ms backstop`));
          }
          signalChildProcessGroup(child, 'SIGTERM');
          forceKillTimer = setTimeout(() => signalChildProcessGroup(child, 'SIGKILL'), 5_000);
        };
        const wallClockTimer = setTimeout(() => terminateChild('timeout'), SCRAPER_HARD_KILL_MS);
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(wallClockTimer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          signal?.removeEventListener('abort', abortChild);
          resolve();
        };
        const abortChild = () => terminateChild('stop');
        signal?.addEventListener('abort', abortChild, { once: true });
        if (signal?.aborted) abortChild();
        
        child.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter(Boolean);
          lines.forEach((line: string) => {
             if (onProgress) onProgress(`[Dejobs] ${line}`);
             
             const summaryMatch = line.match(/^INGESTION_SUMMARY\s+(\{.*\})$/);
             if (summaryMatch?.[1]) {
               try {
                 const summary = JSON.parse(summaryMatch[1]);
                 const stats = statsFor('Dejobs');
                 stats.seen = Number(summary.seen) || 0;
                 stats.inserted = Number(summary.inserted) || 0;
                 stats.duplicates = Number(summary.duplicates) || 0;
                 stats.filtered = Number(summary.filtered) || 0;
                 stats.processingErrors = Number(summary.processingErrors) || 0;
                 newJobsCount += stats.inserted;
                 // Running out of time is an early finish, not a fault. It must
                 // not reach markSourceError, or the provider circuit opens on
                 // a run that ingested real jobs.
                 if (summary.budgetExhausted) {
                   onProgress?.(`Dejobs Scraper stopped early on its time budget after ingesting ${stats.inserted} job(s).`);
                 }
               } catch (error) {
                 markSourceError('Dejobs', new Error(`Invalid scraper summary: ${String(error)}`));
               }
             }
          });
        });
        
        child.stderr.on('data', (data) => {
          console.error(`[Dejobs Error] ${data.toString()}`);
        });
        
        child.on('close', (code, closeSignal) => {
          if (interruptedByStop) {
            onProgress?.('Dejobs Scraper interrupted by pipeline stop.');
          } else if (code === 0) markSourceSuccess('Dejobs');
          else if (!terminationErrorRecorded) markSourceError('Dejobs', new Error(`Exited with ${code == null ? `signal ${closeSignal || 'unknown'}` : `code ${code}`}`));
          if (onProgress) onProgress(`Dejobs Scraper finished with code ${code}`);
          finish();
        });

        child.on('error', (err) => {
          if (!interruptedByStop && !terminationErrorRecorded) markSourceError('Dejobs', err);
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
  if (options.usePaidApis && sourceEnabled('SerpApi') && serpApiKeys.length > 0 && !sourceCircuitIsOpen('SerpApi') && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('SerpApi');
    if (onProgress) onProgress("Searching SerpApi (Google Jobs)...");
    try {
      const plan = providerGeoPlan('SerpApi', geoLane.id);
      const serpParams = new URLSearchParams({
        engine: "google_jobs",
        q: [baseQuery, plan.querySuffix].filter(Boolean).join(' '),
        location: plan.location,
        chips: "date_posted:today", // Last 24 hours
      });

      const serpRes = await rotateKeysWithDurableCooldowns(serpApiKeys, async (key) => {
        await reserveSourceRequest('SerpApi', { dailyLimit: 25, monthlyLimit: 1_000 });
        const fetchParams = new URLSearchParams(serpParams);
        fetchParams.set("api_key", key);
        return fetch(
          `https://serpapi.com/search.json?${fetchParams.toString()}`,
          { signal: AbortSignal.timeout(30000) }
        );
      }, 'SerpApi');
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
      markSourceSuccess('SerpApi');
    } catch (e) {
      markSourceError('SerpApi', e);
      console.error(e);
    }
  }

  // 2. JSearch via RapidAPI
  if (options.usePaidApis && sourceEnabled('JSearch') && rapidApiKeys.length > 0 && !sourceCircuitIsOpen('JSearch') && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('JSearch');
    if (onProgress) onProgress("Searching JSearch...");
    try {
      let page = 1;
      while (page <= 5) {
        const plan = providerGeoPlan('JSearch', geoLane.id);
        const jsearchParams = new URLSearchParams({
          query: `${[baseQuery, plan.querySuffix].filter(Boolean).join(' ')} in ${plan.location}`,
          page: page.toString(),
          num_pages: "1",
          date_posted: "today",
        });

        const jsearchRes = await rotateKeysWithDurableCooldowns(rapidApiKeys, async (key) => {
          await reserveSourceRequest('JSearch', RAPIDAPI_BUDGETS.JSearch);
          return fetch(
            `https://jsearch.p.rapidapi.com/search-v2?${jsearchParams.toString()}`,
            {
              method: "GET",
              headers: {
                "X-RapidAPI-Key": key,
                "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
              },
              signal: AbortSignal.timeout(30000),
            }
          );
        }, 'JSearch');
        if (!jsearchRes) throw new Error('All configured API keys were rate-limited or rejected');
        if (!jsearchRes.ok) throw new Error(`HTTP ${jsearchRes.status}`);
        
        const data = await jsearchRes.json();
        // v5 nests results under `data.jobs` alongside a `cursor`. Reading
        // `data.data` yielded an object, so `.length` was undefined, the guard
        // below never fired, and `for...of` threw "is not iterable" — the
        // source has never ingested a row.
        const jobs = Array.isArray(data?.data?.jobs) ? data.data.jobs : [];
        if (jobs.length === 0) break;

        for (const job of jobs) {
          if (signal?.aborted) break;
          const parsed = parseJSearchJob(job);
          if (!parsed) continue;
          try {
            void await processJob(parsed);
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
        page++;
      }
      markSourceSuccess('JSearch');
    } catch (e) {
      markSourceError('JSearch', e);
      console.error(e);
    }
  }

  // 3. Indeed via RapidAPI
  if (options.usePaidApis && sourceEnabled('Indeed') && rapidApiKeys.length > 0 && !sourceCircuitIsOpen('Indeed') && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('Indeed');
    if (onProgress) onProgress("Searching Indeed...");
    try {
      const plan = providerGeoPlan('Indeed', geoLane.id);
      const indeedParams = new URLSearchParams({
        query: [baseQuery, plan.querySuffix].filter(Boolean).join(' '),
        location: plan.location,
        radius: plan.radius,
        fromage: "1", // Last 24 hours
        sort: "date",
      });

      const indeedRes = await rotateKeysWithDurableCooldowns(rapidApiKeys, async (key) => {
        await reserveSourceRequest('Indeed', RAPIDAPI_BUDGETS.Indeed);
        return fetch(
          `https://indeed12.p.rapidapi.com/jobs/search?${indeedParams.toString()}`,
          {
            headers: {
              "X-RapidAPI-Key": key,
              "X-RapidAPI-Host": "indeed12.p.rapidapi.com",
            },
            signal: AbortSignal.timeout(30000),
          }
        );
      }, 'Indeed12');
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
            description: job.description || job.snippet || "",
            location: job.location || "Unknown Location",
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
      markSourceSuccess('Indeed');
    } catch (e) {
      markSourceError('Indeed', e);
      console.error(e);
    }
  }

  // 4. LinkedIn Job Search API (RapidAPI)
  if (options.usePaidApis && sourceEnabled('LinkedIn') && !options.skipTitleOnlySources && rapidApiKeys.length > 0 && !sourceCircuitIsOpen('LinkedIn') && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('LinkedIn');
    if (onProgress) onProgress("Searching LinkedIn...");
    try {
      let page = 1;
      while (page <= 5) {
        const plan = providerGeoPlan('LinkedIn', geoLane.id);
        const linkedinParams = new URLSearchParams({
          // v4 spells this "24h"; "past_24_hours" was the v1 form.
          time_frame: "24h",
          limit: "20",
          offset: ((page - 1) * 20).toString(),
          description_format: "text",
          title: [baseQuery, plan.querySuffix].filter(Boolean).join(' '),
          location: plan.location,
        });

        const linkedinRes = await rotateKeysWithDurableCooldowns(rapidApiKeys, async (key) => {
          await reserveSourceRequest('LinkedIn', RAPIDAPI_BUDGETS.LinkedIn);
          return fetch(
            // v1 (/active-job) stopped serving on 3 Aug 2026.
            `https://linkedin-job-search-api.p.rapidapi.com/active-jb?${linkedinParams.toString()}`,
            {
              headers: {
                "X-RapidAPI-Key": key,
                "X-RapidAPI-Host": "linkedin-job-search-api.p.rapidapi.com",
              },
              signal: AbortSignal.timeout(30000),
            }
          );
        }, 'LinkedInJobSearch');
        if (!linkedinRes) throw new Error('All configured API keys were rate-limited or rejected');
        if (!linkedinRes.ok) throw new Error(`HTTP ${linkedinRes.status}`);
        
        const data = await linkedinRes.json();
        // v4 returns a bare array. Reading `data.data` here yielded undefined,
        // so every page looked empty and the source never recorded a single
        // job — a failure entirely separate from the v1 sunset.
        const jobs = Array.isArray(data) ? data : (data.data || []);
        if (jobs.length === 0) break;
        
        for (const job of jobs) {
          if (signal?.aborted) break;
          try {
            /**
             * v4 renamed nearly every field this mapping read, and the old
             * names were left in place. Of what was requested only `title` and
             * `url` still resolved — company, description, location and the
             * posted date all came back undefined, so every posting was stored
             * as "Unknown Company" in "Unknown Location" with no body, which
             * the prefilter and JD gate then rightly discarded. That is how
             * 3,349 lifetime runs produced exactly one job.
             *
             * `description_text` is what the `description_format: "text"`
             * parameter above actually populates; `locations_derived` holds the
             * resolved place strings. Legacy names are retained as fallbacks.
             */
            const result = await processJob({
              title: job.title,
              company: job.organization || job.company?.name || job.company_name || "Unknown Company",
              description: job.description_text || job.description || "",
              location: job.locations_derived?.[0]
                || job.locations?.[0]?.address?.addressLocality
                || job.location
                || "Unknown Location",
              url: job.url || job.job_url || "",
              source: "LinkedIn",
              sourceId: String(job.id ?? job.job_id ?? job.linkedin_id ?? ""),
              postedAt: job.date_posted
                ? new Date(job.date_posted)
                : job.posted_date ? new Date(job.posted_date) : new Date(),
            });
            void result;
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
        
        page++;
      }
      markSourceSuccess('LinkedIn');
    } catch (e) {
      markSourceError('LinkedIn', e);
      console.error(e);
    }
  }

  // Workday (RapidAPI) removed to save quota

  // 4.6 Glassdoor Jobs API (RapidAPI)
  if (options.usePaidApis && sourceEnabled('Glassdoor (RapidAPI)') && rapidApiKeys.length > 0 && !sourceCircuitIsOpen('Glassdoor (RapidAPI)') && (!targetAtsSlugs || targetAtsSlugs.length === 0)) {
    statsFor('Glassdoor (RapidAPI)');
    if (onProgress) onProgress("Searching Glassdoor Jobs (RapidAPI)...");
    try {
      const plan = providerGeoPlan('Glassdoor (RapidAPI)', geoLane.id);
      const gdParams = new URLSearchParams({
        query: [baseQuery, plan.querySuffix].filter(Boolean).join(' '),
        location: plan.location,
        fromAge: "1"
      });

      const gdRes = await rotateKeysWithDurableCooldowns(rapidApiKeys, async (key) => {
        await reserveSourceRequest('Glassdoor (RapidAPI)', RAPIDAPI_BUDGETS['Glassdoor (RapidAPI)']);
        return fetch(
          `https://glassdoor-real-time.p.rapidapi.com/jobs/search?${gdParams.toString()}`,
          {
            headers: {
              "X-RapidAPI-Key": key,
              "X-RapidAPI-Host": "glassdoor-real-time.p.rapidapi.com",
            },
            signal: AbortSignal.timeout(30000),
          }
        );
      }, 'Glassdoor');

      if (!gdRes) throw new Error('All configured API keys were rate-limited or rejected');
      if (!gdRes.ok) throw new Error(`HTTP ${gdRes.status}`);
      {
        const data = await gdRes.json();
        // Results are nested at data.jobListings[].jobview. The previous
        // `data.data || data.jobs || []` read the wrapper object, Array.isArray
        // rejected it, and every run reported success over an empty list.
        const listings = Array.isArray(data?.data?.jobListings) ? data.data.jobListings : [];
        for (const listing of listings) {
          if (signal?.aborted) break;
          const parsed = parseGlassdoorListing(listing);
          if (!parsed) continue;
          try {
            await processJob(parsed);
          } catch (err) {
            console.error("Error processing single job:", err);
          }
        }
      }
      markSourceSuccess('Glassdoor (RapidAPI)');
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
            status: { in: ["active", "parked", "blacklisted"] },
            nextCheckDate: { lte: new Date() },
            OR: targetAtsSlugs.map(t => ({ slug: t.slug, platform: t.platform })),
          },
          orderBy: { nextCheckDate: 'asc' },
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
        if (captureAtsInterruption()) break;
        if (atsBatchStartedAt && atsDeadlineMs != null
          && Date.now() - atsBatchStartedAt.getTime() >= atsDeadlineMs) {
          ingestionInterruptionReason ||= `ATS turn reached its ${atsDeadlineMs}ms wall-clock deadline.`;
          break;
        }
        const batch = activeBoards.slice(batchStart, batchStart + atsConcurrency);
        await Promise.all(batch.map(async (board, batchOffset) => {
        const i = batchStart + batchOffset;
        const boardSource = `ATS-${board.platform}`;
        let boardAttemptCompleted = false;
        if (atsProgress) {
          atsProgress.currentBoard = `${board.platform}:${board.slug}`;
          atsProgress.lastUpdateAt = new Date().toISOString();
        }
        statsFor(boardSource);
        if (onProgress) onProgress(`Searching ATS Boards: [${i + 1}/${activeBoards.length}] ${board.slug}...`);
        if (captureAtsInterruption()) return;
        let apiUrl = "";
        let fetchOptions: RequestInit = { signal: atsRequestSignal(10_000) };

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
            signal: atsRequestSignal(10_000),
          };
        } else if (board.platform === "workable") {
          apiUrl = `https://apply.workable.com/api/v3/accounts/${board.slug}/jobs`;
          fetchOptions = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [] }),
            signal: atsRequestSignal(10_000),
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
        else if (board.platform === "breezy")
          apiUrl = `https://${board.slug}.breezy.hr/json`;
        else if (board.platform === "teamtailor")
          apiUrl = `https://${board.slug}.teamtailor.com/jobs.json`;
        else if (board.platform === "pinpoint")
          apiUrl = `https://${board.slug}.pinpointhq.com/postings.json`;
        else if (board.platform === "recruitee")
          apiUrl = `https://${board.slug}.recruitee.com/api/offers`;
        else if (board.platform === "rippling")
          apiUrl = `https://ats.rippling.com/api/v1/board/${board.slug}/jobs`;
        else if (board.platform === "personio")
          apiUrl = `https://${board.slug}.jobs.personio.de/xml`;

        if (!apiUrl) {
          markSourceError(boardSource, new Error(`Unsupported ATS platform: ${board.platform}`));
          return;
        }

        try {
          throwIfAtsInterrupted();
          await waitForPlatformSlot(board.platform, atsTurnSignal);
          throwIfAtsInterrupted();
          await reserveSourceRequest(boardSource);
          const res = await fetch(apiUrl, fetchOptions);
          throwIfAtsInterrupted();
          if (res.status === 429) {
            // Being throttled is not a broken board. Back the whole platform
            // off so the crawl slows down instead of being refused, and let the
            // caller record it without counting toward the blacklist.
            throttlePlatform(board.platform, res.headers.get("retry-after"));
            throw new RateLimitedError(board.platform);
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          // A retired board is not a 404: BambooHR answers a dead slug with
          // HTTP 200 and an HTML landing page, so res.ok passes and .json()
          // failed with "Unexpected token '<'" — a parser error standing in for
          // "this board no longer exists".
          const contentType = res.headers.get('content-type') || '';
          // Personio publishes XML by design; every other board here is JSON,
          // so a non-JSON body from them means the board is gone.
          const expectsXml = board.platform === 'personio';
          if (!expectsXml && !/json/i.test(contentType)) {
            throw new Error(
              `${board.platform} board returned ${contentType.split(';')[0] || 'an unknown content type'} instead of JSON (board retired or access blocked)`,
            );
          }
          if (expectsXml && !/xml/i.test(contentType)) {
            throw new Error(
              `personio board returned ${contentType.split(';')[0] || 'an unknown content type'} instead of XML (board retired or access blocked)`,
            );
          }

          const data = expectsXml ? {} : await res.json();
          throwIfAtsInterrupted();
          let jobs: AtsJob[] = [];
          if (expectsXml) {
            // <workzag-jobs><position>…</position></workzag-jobs>
            const xml = cheerio.load(await res.text(), { xmlMode: true });
            jobs = xml('position').toArray().map((node) => {
              const position = xml(node);
              const offices = [
                position.children('office').first().text().trim(),
                ...position.find('additionalOffices > office').toArray()
                  .map((office) => xml(office).text().trim()),
              ].filter(Boolean);
              return {
                id: position.children('id').first().text().trim(),
                name: position.children('name').first().text().trim(),
                location: offices.join('; '),
                description: position.find('jobDescriptions').text().trim(),
                createdAt: position.children('createdAt').first().text().trim() || undefined,
              } as AtsJob;
            });
          }
          else if (board.platform === "lever")
            jobs = Array.isArray(data) ? data : [];
          else if (board.platform === "workday") jobs = data.jobPostings || [];
          else if (board.platform === "smartrecruiters") jobs = data.content || [];
          else if (board.platform === "workable") jobs = data.results || [];
          else if (board.platform === "bamboohr") jobs = data.result || [];
          else if (board.platform === "breezy" || board.platform === "rippling")
            jobs = Array.isArray(data) ? data : [];
          else if (board.platform === "teamtailor") jobs = data.items || [];
          else if (board.platform === "pinpoint") jobs = data.data || [];
          else if (board.platform === "recruitee") jobs = data.offers || [];
          else jobs = data.jobs || [];

          // Workday defaults to 20 rows. Page through a bounded maximum so one
          // large board cannot monopolize the Pi indefinitely.
          if (board.platform === 'workday') {
            const total = Math.min(Number(data.total || data.totalCount || jobs.length), 200);
            for (let offset = jobs.length; offset < total; offset += 20) {
              throwIfAtsInterrupted();
              const [company, tenant] = board.slug.split('::');
              const companyWithoutWd = company.split('.')[0];
              await waitForPlatformSlot(board.platform, atsTurnSignal);
              throwIfAtsInterrupted();
              await reserveSourceRequest(boardSource);
              const pageResponse = await fetch(
                `https://${company}.myworkdayjobs.com/wday/cxs/${companyWithoutWd}/${tenant}/jobs`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
                  signal: atsRequestSignal(10_000),
                },
              );
              throwIfAtsInterrupted();
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
            markSourceSuccess(boardSource);
            boardAttemptCompleted = true;
            return;
          }

          // Process jobs
          let mnJobsFound = 0;
          for (const job of jobs) {
            throwIfAtsInterrupted();
            // Preserve broad fetch coverage and let the shared prefilter own
            // the final location decision. Count all fetched postings in the
            // reconciled denominator instead of silently discarding them here.
            const coarseLocationMatch = isLocationMatch(job);
            mnJobsFound++;
            // Populated by the Rippling detail fetch below when it succeeds;
            // used further down to override the slug-derived company and the
            // list call's single workLocation, and to feed the structured
            // compensation override into processJob.
            let ripplingCompany: string | null = null;
            let ripplingLocation: string | null = null;
            let ripplingCompensation: string | null = null;
            // Populated by the Breezy detail fetch and salary parse below;
            // same role as the Rippling trio above.
            let breezyCompany: string | null = null;
            let breezyLocation: string | null = null;
            let breezyCompensation: string | null = null;
            // Workday's list endpoint emits only "<N> Locations" for a
            // multi-site requisition. Its detail response carries the actual
            // primary plus every additional location; keep that authoritative
            // value for the platform-specific mapping below.
            let workdayCompany: string | null = null;
            let workdayLocation: string | null = null;
            if (board.platform === 'breezy') {
              breezyCompensation = parseBreezySalaryRange(job.salary);
            }

            // Strip HTML tags for clean text to save tokens
            let rawDescription =
              job.content || job.description || job.descriptionPlain
              // Teamtailor's feed item carries the posting body as content_html;
              // Recruitee splits it across description and requirements.
              || job.content_html
              || [job.description, job.requirements].filter(Boolean).join('\n\n')
              || "";
            if (board.platform === "workday" && job.externalPath && !options.deferWorkdayDescriptions) {
              const [company, tenant] = board.slug.split("::");
              const companyWithoutWd = company.split(".")[0];
              const singleJobUrl = `https://${company}.myworkdayjobs.com/wday/cxs/${companyWithoutWd}/${tenant}${job.externalPath}`;
              const detailSource = `${boardSource} Details`;
              try {
                await waitForPlatformSlot(board.platform, atsTurnSignal);
                throwIfAtsInterrupted();
                await reserveSourceRequest(detailSource);
                const res = await fetch(singleJobUrl, { headers: { "Accept": "application/json" }, signal: atsRequestSignal(10_000) });
                throwIfAtsInterrupted();
                if (res.ok) {
                  markSourceSuccess(detailSource);
                  const singleJobData = await res.json();
                  if (singleJobData.jobPostingInfo?.jobDescription) {
                    rawDescription = singleJobData.jobPostingInfo.jobDescription;
                  }
                  workdayCompany = workdayHiringOrganizationName(singleJobData.hiringOrganization);
                  workdayLocation = workdayDetailLocation(singleJobData.jobPostingInfo);
                } else {
                  markSourceError(detailSource, new Error(`Workday job detail HTTP ${res.status}`));
                }
              } catch (e) {
                if (captureAtsInterruption()) throw e;
                markSourceError(detailSource, e);
                console.error("Failed to fetch Workday job desc:", e);
              }
              // Fallback if the fetch fails
              if (!rawDescription && job.bulletFields) {
                rawDescription = job.bulletFields.join("\n");
              }
            } else if (board.platform === 'workday' && !rawDescription && job.bulletFields) {
              rawDescription = job.bulletFields.join("\n");
            }

            /**
             * SmartRecruiters and Workable publish no posting body on their
             * list endpoints at all — verified against both APIs, the list item
             * carries only identity and location fields. Every job from these
             * two platforms was therefore stored with an empty description,
             * routed to `needs_jd`, put through Jina recovery against the
             * public posting page, and finally rejected as "no usable role
             * duties". That single gap accounts for 914 of the ~2,000 jobs
             * sitting in Action Needed.
             *
             * Both expose the body on a per-posting detail call, so fetch it
             * the way Workday already does. Failure stays non-fatal: an empty
             * description simply falls through to the existing JD recovery path
             * exactly as it does today.
             */
            if (board.platform === "smartrecruiters" && !rawDescription && job.id) {
              const detailSource = `${boardSource} Details`;
              try {
                await waitForPlatformSlot(board.platform, atsTurnSignal);
                throwIfAtsInterrupted();
                await reserveSourceRequest(detailSource);
                const res = await fetch(
                  `https://api.smartrecruiters.com/v1/companies/${board.slug}/postings/${job.id}`,
                  { headers: { "Accept": "application/json" }, signal: atsRequestSignal(10_000) },
                );
                throwIfAtsInterrupted();
                if (res.ok) {
                  markSourceSuccess(detailSource);
                  const detail = await res.json();
                  // companyDescription is left out on purpose: it is boilerplate
                  // marketing that inflates length without describing the role,
                  // which is exactly what the 650-character gate exists to catch.
                  const sections = detail?.jobAd?.sections || {};
                  rawDescription = [
                    sections.jobDescription?.text,
                    sections.qualifications?.text,
                    sections.additionalInformation?.text,
                  ].filter(Boolean).join("\n\n");
                } else {
                  markSourceError(detailSource, new Error(`SmartRecruiters posting detail HTTP ${res.status}`));
                }
              } catch (e) {
                if (captureAtsInterruption()) throw e;
                markSourceError(detailSource, e);
                console.error("Failed to fetch SmartRecruiters job desc:", e);
              }
            }

            if (board.platform === "workable" && !rawDescription && job.shortcode) {
              const detailSource = `${boardSource} Details`;
              try {
                await waitForPlatformSlot(board.platform, atsTurnSignal);
                throwIfAtsInterrupted();
                await reserveSourceRequest(detailSource);
                // v1 deliberately: the v3 detail route matching the v3 list
                // endpoint used above answers 404, while v1 returns the body.
                const res = await fetch(
                  `https://apply.workable.com/api/v1/accounts/${board.slug}/jobs/${job.shortcode}`,
                  { headers: { "Accept": "application/json" }, signal: atsRequestSignal(10_000) },
                );
                throwIfAtsInterrupted();
                if (res.ok) {
                  markSourceSuccess(detailSource);
                  const detail = await res.json();
                  rawDescription = [detail?.description, detail?.requirements, detail?.benefits]
                    .filter(Boolean).join("\n\n");
                } else {
                  markSourceError(detailSource, new Error(`Workable job detail HTTP ${res.status}`));
                }
              } catch (e) {
                if (captureAtsInterruption()) throw e;
                markSourceError(detailSource, e);
                console.error("Failed to fetch Workable job desc:", e);
              }
            }

            /**
             * BambooHR's `/careers/list` is identity-only in the same way, and
             * its stuck jobs all carry a zero-length description. The body
             * lives at `/careers/{id}/detail` under `result.jobOpening`.
             *
             * Audited alongside this: greenhouse, lever, ashby, pinpoint and
             * recruitee all do publish a body on the list item, so they need no
             * detail call. Teamtailor's feed item does too, via content_html
             * above. Breezy is the other confirmed gap (0ch descriptions), fixed
             * below via its posting page's JSON-LD block instead of a JSON
             * detail route -- it exposes none (`/json/{id}` 302s, `/p/{id}.json`
             * returns HTML).
             */
            if (board.platform === "bamboohr" && !rawDescription && job.id) {
              const detailSource = `${boardSource} Details`;
              try {
                await waitForPlatformSlot(board.platform, atsTurnSignal);
                throwIfAtsInterrupted();
                await reserveSourceRequest(detailSource);
                const res = await fetch(
                  `https://${board.slug}.bamboohr.com/careers/${job.id}/detail`,
                  { headers: { "Accept": "application/json" }, signal: atsRequestSignal(10_000) },
                );
                throwIfAtsInterrupted();
                if (res.ok) {
                  markSourceSuccess(detailSource);
                  const detail = await res.json();
                  rawDescription = detail?.result?.jobOpening?.description || detail?.result?.description || "";
                } else {
                  markSourceError(detailSource, new Error(`BambooHR job detail HTTP ${res.status}`));
                }
              } catch (e) {
                if (captureAtsInterruption()) throw e;
                markSourceError(detailSource, e);
                console.error("Failed to fetch BambooHR job desc:", e);
              }
            }

            /**
             * Breezy has no JSON detail route, but its posting page embeds a
             * schema.org JobPosting JSON-LD block -- a web standard, not a
             * Breezy feature, hence the shared extractor in atsApi.ts rather
             * than one-off parsing here. Also carries the real company name
             * (the list call gives only the board slug, title-cased --
             * "Seeknow" instead of "Seek Now") and a city+state location, more
             * useful for the geography gate than the list's city+country.
             */
            if (board.platform === "breezy" && !rawDescription) {
              const detailUrl = job.url
                || (job.friendly_id ? `https://${board.slug}.breezy.hr/p/${job.friendly_id}` : null);
              if (detailUrl) {
                const detailSource = `${boardSource} Details`;
                try {
                  await waitForPlatformSlot(board.platform, atsTurnSignal);
                  throwIfAtsInterrupted();
                  await reserveSourceRequest(detailSource);
                  // Breezy's pages sit behind CloudFront; a request with no
                  // User-Agent at all (safeExternalFetch's default) gets a WAF
                  // 403 instead of the page, verified live.
                  const res = await safeExternalFetch(detailUrl, {
                    headers: { 'User-Agent': JSON_LD_FETCH_USER_AGENT },
                    signal: atsRequestSignal(10_000),
                  });
                  throwIfAtsInterrupted();
                  if (res.ok) {
                    markSourceSuccess(detailSource);
                    const html = await res.text();
                    const jobPosting = extractJsonLdJobPosting(html);
                    if (jobPosting && typeof jobPosting.description === 'string') {
                      rawDescription = jobPosting.description;
                      breezyCompany = jsonLdCompanyName(jobPosting.hiringOrganization);
                      breezyLocation = jsonLdLocationString(jobPosting.jobLocation);
                    }
                  } else {
                    markSourceError(detailSource, new Error(`Breezy job detail HTTP ${res.status}`));
                  }
                } catch (e) {
                  if (captureAtsInterruption()) throw e;
                  markSourceError(detailSource, e);
                  console.error("Failed to fetch Breezy job desc:", e);
                }
              }
            }

            /**
             * Rippling's list call is identity-only, same defect class as
             * SmartRecruiters/Workable above: uuid, name, department, url,
             * workLocation and nothing else. The detail call also carries the
             * real company name (list items are labelled by board slug, e.g.
             * "ampersandbrands" instead of "Lolli & Pops - Hammond's Candies"),
             * the full workLocations array, and structured pay.
             */
            if (board.platform === "rippling" && !rawDescription && job.uuid) {
              const detailSource = `${boardSource} Details`;
              try {
                await waitForPlatformSlot(board.platform, atsTurnSignal);
                throwIfAtsInterrupted();
                await reserveSourceRequest(detailSource);
                const res = await fetch(
                  `https://ats.rippling.com/api/v1/board/${board.slug}/jobs/${job.uuid}`,
                  { headers: { "Accept": "application/json" }, signal: atsRequestSignal(10_000) },
                );
                throwIfAtsInterrupted();
                if (res.ok) {
                  markSourceSuccess(detailSource);
                  const detail = await res.json();
                  const parsed = parseRipplingJobDetail(detail);
                  rawDescription = parsed.rawDescription;
                  ripplingCompany = parsed.company;
                  ripplingLocation = parsed.location;
                  ripplingCompensation = parsed.compensation;
                } else {
                  markSourceError(detailSource, new Error(`Rippling job detail HTTP ${res.status}`));
                }
              } catch (e) {
                if (captureAtsInterruption()) throw e;
                markSourceError(detailSource, e);
                console.error("Failed to fetch Rippling job desc:", e);
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
            // Rippling has no `id`; its postings are keyed by uuid.
            if (board.platform === "rippling" && job.uuid) sourceId = String(job.uuid);

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
            } else if (["breezy", "teamtailor", "pinpoint", "rippling"].includes(board.platform)) {
              // Each publishes an absolute posting URL on the list item itself.
              url = job.url || url;
            } else if (board.platform === "recruitee") {
              url = job.careers_url || job.url || url;
            } else if (board.platform === "personio") {
              url = `https://${board.slug}.jobs.personio.de/job/${job.id}`;
            }

            // Parse platform specifics
            if (board.platform === "lever") {
              company = decodeURIComponent(board.slug).split(/[-_ ]+/).map((word: string) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
              locationStr = job.categories?.location || "Unknown Location";
            } else if (board.platform === "greenhouse") {
              company = data.name || board.slug;
              locationStr = locationObject?.name || locationText || "Unknown Location";
            } else if (board.platform === "ashby") {
              const decodedSlug = decodeURIComponent(board.slug);
              company = decodedSlug.split(/[-_ ]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              locationStr = locationText || "Unknown Location";
            } else if (board.platform === "workday") {
              // The hostname shard (`.wd501`) identifies Workday
              // infrastructure, not the employer. Prefer the detail response's
              // exact hiring entity; when it is absent, retain only the
              // provider-owned tenant as a bounded readable fallback.
              company = workdayCompany || workdayBoardCompanyFallback(board.slug);
              const workdayLocationsText = job.locationsText || "Unknown Location";
              // Prefer the complete location list from the detail response.
              // When details are deferred or unavailable, retain the safe URL
              // primary + placeholder fallback rather than inventing sites.
              locationStr = workdayLocation
                ?? resolveWorkdayPlaceholderLocation(workdayLocationsText, job.externalPath)
                ?? workdayLocationsText;
            } else if (board.platform === "smartrecruiters") {
              company = data.company?.name || board.slug;
              locationStr = locationObject?.city ? `${locationObject.city}, ${locationObject.region || ''}` : "Unknown Location";
            } else if (board.platform === "workable") {
              company = board.slug;
              locationStr = locationObject?.city ? `${locationObject.city}, ${locationObject.region || ''}` : "Unknown Location";
            } else if (board.platform === "breezy") {
              // The slug-derived name is always a guess ("Seeknow"); prefer
              // the JSON-LD's real hiringOrganization.name when the detail
              // fetch found one.
              company = breezyCompany || titleCaseSlug(board.slug);
              // location is an object: { city, country: { name } }
              const listLocation = [locationObject?.city, locationObject?.country?.name]
                .filter(Boolean).join(', ') || "Unknown Location";
              // The JSON-LD's city+state reads correctly against the
              // geography gate's state-code matching; the list's city+country
              // does not. jsonLdLocationString never returns a country-only
              // value, so this never trades a real location for a worse one.
              locationStr = breezyLocation || listLocation;
            } else if (board.platform === "teamtailor") {
              company = titleCaseSlug(board.slug);
              // The JSON Feed item carries no location field; the prefilter and
              // JD stage resolve it from content_html.
              locationStr = locationText || "Unknown Location";
            } else if (board.platform === "pinpoint") {
              company = titleCaseSlug(board.slug);
              locationStr = locationObject?.name
                || [locationObject?.city, locationObject?.province].filter(Boolean).join(', ')
                || "Unknown Location";
            } else if (board.platform === "recruitee") {
              company = titleCaseSlug(board.slug);
              // Recruitee sends location as a formatted string already.
              locationStr = locationText || [job.city, job.country].filter(Boolean).join(', ') || "Unknown Location";
            } else if (board.platform === "rippling") {
              // Prefer the detail call's real companyName and workLocations
              // array over the slug-derived name and the list call's single
              // workLocation object.
              company = ripplingCompany || titleCaseSlug(board.slug);
              locationStr = ripplingLocation || job.workLocation?.label || "Unknown Location";
            } else if (board.platform === "personio") {
              company = titleCaseSlug(board.slug);
              // Offices are already joined from the XML above.
              locationStr = locationText || "Unknown Location";
            } else if (board.platform === "bamboohr") {
              company = board.slug;
              locationStr = locationObject?.city || "Unknown Location";
            }

            const postedValue = job.updated_at || job.createdAt || job.publishedAt
              // Breezy, Teamtailor and Recruitee each name this differently.
              || job.published_date || job.date_published || job.created_at;
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
              postedCompensationOverride: ripplingCompensation || breezyCompensation,
            });
            throwIfAtsInterrupted();
            void coarseLocationMatch; // recorded by the shared prefilter outcome
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
          markSourceSuccess(boardSource);
          boardAttemptCompleted = true;
        } catch (err) {
          if (captureAtsInterruption()) return;
          const providerWide = err instanceof RateLimitedError
            || /HTTP\s+(?:401|403)\b|schema|not iterable|unexpected token|invalid response/i.test(
              err instanceof Error ? err.message : String(err),
            );
          if (providerWide) markSourceError(boardSource, err);
          else {
            const stats = statsFor(boardSource);
            stats.requestErrors++;
            stats.lastError = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
          }
          if (err instanceof RateLimitedError) {
            // The board is fine; we asked too fast. Retry it soon and leave
            // failCount alone so throttling can never blacklist a live board.
            const retrySoon = new Date(Date.now() + platformPauseRemainingMs(board.platform) + 60_000);
            await prisma.atsCompany.update({
              where: { slug_platform: { slug: board.slug, platform: board.platform } },
              data: { nextCheckDate: retrySoon, lastCheckedAt: new Date() },
            });
            boardAttemptCompleted = true;
            return;
          }
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
          boardAttemptCompleted = true;
        } finally {
          if (atsProgress && boardAttemptCompleted) {
            atsProgress.completedCount++;
            atsProgress.lastUpdateAt = new Date().toISOString();
          }
        }
        }));
        await persistCheckpoint(true);
        if (captureAtsInterruption()) break;
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
