import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';

import { Prisma, type AtsCompany, type AtsIngestionBatch } from '@prisma/client';
import * as cheerio from 'cheerio';

import {
  AtsPlatformDeferredError,
  AtsProviderFailureRecordedError,
  RateLimitedError,
  fetchAtsPlatformResponse,
  platformPauseRemainingMs,
} from './jobIngestion';
import {
  ATS_JOB_ENRICHMENT_VERSION,
  enrichAtsListingJob,
  readAtsJobEnrichmentMarker,
} from './atsJobEnrichment';
import {
  ingestionReconciles,
  recordProviderFailure,
  recordProviderSuccess,
  reserveProviderBudgetForSource,
  type IngestionCounters,
} from './ingestionControl';
import { withIngestionTransactionSlot } from './ingestionConcurrency';
import { ATS_SPLIT_INGESTION_ENABLED } from './ingestionTaskCatalog';
import { prisma } from './prisma';
import {
  ATS_RECOVERY_STATUSES,
  ATS_ROTATION_STATUSES,
  atsRotationCycleCutoff,
  isSchedulableBoardSlug,
  nextAtsBoardCheckDateForDay,
  rotationDayFor,
} from './atsRotation';

export { ATS_SPLIT_INGESTION_ENABLED };

export function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const boundedFallback = Math.min(maximum, Math.max(minimum, Math.trunc(fallback)));
  const normalized = value?.trim();
  if (!normalized || !/^[+-]?\d+$/.test(normalized)) return boundedFallback;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return boundedFallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export const ATS_ACQUISITION_CONCURRENCY = boundedInteger(
  process.env.ATS_ACQUISITION_CONCURRENCY, 4, 1, 4,
);
export const ATS_BATCH_PROCESSING_CONCURRENCY = boundedInteger(
  process.env.ATS_BATCH_PROCESSING_CONCURRENCY, 1, 1, 4,
);
export const ATS_BATCH_PROCESSING_CHUNK_SIZE = boundedInteger(
  process.env.ATS_BATCH_PROCESSING_CHUNK_SIZE, 25, 1, 100,
);
export const ATS_ACQUISITION_QUEUE_LIMIT = boundedInteger(
  process.env.ATS_ACQUISITION_QUEUE_LIMIT, 100, 1, 1_000,
);
export const ATS_ACQUISITION_JOB_HIGH_WATERMARK = boundedInteger(
  process.env.ATS_ACQUISITION_JOB_HIGH_WATERMARK, 2_000, 100, 100_000,
);
export const ATS_ACQUISITION_JOB_LOW_WATERMARK = Math.min(
  ATS_ACQUISITION_JOB_HIGH_WATERMARK - 1,
  boundedInteger(process.env.ATS_ACQUISITION_JOB_LOW_WATERMARK, 1_000, 0, 99_999),
);
export const ATS_ACQUISITION_REQUEST_TIMEOUT_MS = boundedInteger(
  process.env.ATS_ACQUISITION_REQUEST_TIMEOUT_MS, 10_000, 1_000, 120_000,
);
export const ATS_ACQUISITION_PAGES_PER_ATTEMPT = boundedInteger(
  process.env.ATS_ACQUISITION_PAGES_PER_ATTEMPT, 2, 1, 20,
);
export const ATS_ENRICHMENT_JOBS_PER_ATTEMPT = 25;
export const ATS_BATCH_LEASE_MS = boundedInteger(
  process.env.ATS_BATCH_LEASE_MS, 1_800_000, 60_000, 6 * 60 * 60_000,
);
export const ATS_ACQUISITION_ATTEMPT_LEASE_MS = boundedInteger(
  process.env.ATS_ACQUISITION_ATTEMPT_LEASE_MS,
  1_800_000,
  Math.max(60_000, ATS_ACQUISITION_REQUEST_TIMEOUT_MS + 60_000),
  6 * 60 * 60_000,
);

const WORKDAY_PAGE_SIZE = 20;
const SMARTRECRUITERS_PAGE_SIZE = 100;
const PAGINATED_PLATFORMS = new Set(['workday', 'smartrecruiters']);
const SAME_DAY_RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000] as const;
const PROCESSING_RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000] as const;
export const ATS_ZERO_PROGRESS_PROCESSING_BACKOFF_MS = 60_000;

type JsonObject = Record<string, unknown>;

export type AtsAcquisitionCursor = {
  offset: number;
  total: number | null;
  listingComplete: boolean;
  enrichmentOffset: number;
  enrichmentVersion: number | null;
};

export type AtsBoardForAcquisition = Pick<
  AtsCompany,
  'slug' | 'platform' | 'status' | 'failCount' | 'retryCount' | 'checkDay'
>;

export type PrefetchedAtsBatch = {
  id: string;
  slug: string;
  platform: string;
  jobs: JsonObject[];
  metadata: JsonObject;
  processingOffset: number;
  totalJobCount: number;
  synchronizedAt: Date | null;
  leaseToken: string;
};

export type AtsAcquisitionOutcome =
  | 'synchronized'
  | 'partial'
  | 'deferred'
  | 'interrupted'
  | 'timeout'
  | 'throttled'
  | 'error';

export type AtsAcquisitionResult = {
  attemptId: string;
  batchId: string;
  outcome: AtsAcquisitionOutcome;
  requestCount: number;
  pageCount: number;
  jobCount: number;
  responded: boolean;
};

export type AtsAcquisitionBackpressureState = {
  active: boolean;
  remainingJobs: number;
};

class AtsHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'AtsHttpError';
  }
}

class AtsProviderBlockedError extends Error {
  constructor(readonly retryAt: Date | null, reason: string) {
    super(`ATS request deferred by ${reason}`);
    this.name = 'AtsProviderBlockedError';
  }
}

class AtsAttemptLeaseLostError extends Error {
  constructor(readonly attemptId: string) {
    super(`ATS acquisition attempt ${attemptId} lost its lease.`);
    this.name = 'AtsAttemptLeaseLostError';
  }
}

const atsWorkerOwner = () => `${os.hostname()}:${process.pid}`;

function withAtsTransaction<T>(action: () => Promise<T>): Promise<T> {
  return withIngestionTransactionSlot(action);
}

function jsonObject(value: Prisma.JsonValue | null | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function jsonJobs(value: Prisma.JsonValue | null | undefined): JsonObject[] {
  if (!Array.isArray(value)) return [];
  const jobs: JsonObject[] = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      jobs.push(entry as JsonObject);
    }
  }
  return jobs;
}

function serializableJobs(value: unknown[]): JsonObject[] {
  return JSON.parse(JSON.stringify(value)) as JsonObject[];
}

export function advanceAtsResponseState(input: {
  batchRespondedAt: Date | null;
  attemptRespondedAt: Date | null;
  responseAt: Date;
}): { batchRespondedAt: Date; attemptRespondedAt: Date } {
  return {
    batchRespondedAt: input.batchRespondedAt || input.responseAt,
    attemptRespondedAt: input.attemptRespondedAt || input.responseAt,
  };
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ATS_ACQUISITION_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function readAtsAcquisitionCursor(
  value: Prisma.JsonValue | null | undefined,
): AtsAcquisitionCursor {
  const cursor = jsonObject(value);
  return {
    offset: Number.isInteger(cursor.offset) ? Math.max(0, Number(cursor.offset)) : 0,
    total: Number.isInteger(cursor.total) ? Math.max(0, Number(cursor.total)) : null,
    listingComplete: cursor.listingComplete === true,
    enrichmentOffset: Number.isInteger(cursor.enrichmentOffset)
      ? Math.max(0, Number(cursor.enrichmentOffset))
      : 0,
    enrichmentVersion: Number.isInteger(cursor.enrichmentVersion)
      ? Number(cursor.enrichmentVersion)
      : typeof cursor.enrichmentVersion === 'string' && /^\d+$/.test(cursor.enrichmentVersion)
        ? Number(cursor.enrichmentVersion)
        : null,
  };
}

export function hasCurrentAtsJobEnrichment(job: JsonObject, platform: string): boolean {
  const marker = readAtsJobEnrichmentMarker(job);
  if (!marker || marker.version !== ATS_JOB_ENRICHMENT_VERSION) return false;
  return typeof marker.platform !== 'string' || marker.platform === platform;
}

export function currentAtsEnrichmentPrefix(jobs: JsonObject[], platform: string): number {
  const firstMissing = jobs.findIndex((job) => !hasCurrentAtsJobEnrichment(job, platform));
  return firstMissing === -1 ? jobs.length : firstMissing;
}

export function recoverAtsListingCompletion(input: {
  cursor: AtsAcquisitionCursor;
  paginated: boolean;
  persistedPageCount: number;
  jobs: JsonObject[];
  platform: string;
}): AtsAcquisitionCursor {
  if (input.cursor.listingComplete) return input.cursor;
  const legacyListingComplete = (!input.paginated && input.persistedPageCount > 0)
    || (
      input.paginated
      && input.cursor.total !== null
      && input.cursor.offset >= input.cursor.total
    );
  if (!legacyListingComplete) return input.cursor;
  return {
    ...input.cursor,
    listingComplete: true,
    enrichmentOffset: currentAtsEnrichmentPrefix(input.jobs, input.platform),
    enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
  };
}

export function planAtsEnrichmentChunk(
  currentOffset: number,
  jobCount: number,
): { start: number; end: number } {
  const total = Math.max(0, Number.isInteger(jobCount) ? jobCount : 0);
  const start = Math.min(
    Math.max(0, Number.isInteger(currentOffset) ? currentOffset : 0),
    total,
  );
  return {
    start,
    end: Math.min(total, start + ATS_ENRICHMENT_JOBS_PER_ATTEMPT),
  };
}

export function validateAtsEnrichmentQueueReadiness(input: {
  cursor: AtsAcquisitionCursor;
  jobs: JsonObject[];
  platform: string;
  storedJobCount: number;
}): { valid: true } | { valid: false; reason: string; resumeOffset: number } {
  const resumeOffset = currentAtsEnrichmentPrefix(input.jobs, input.platform);
  const invalid = (reason: string) => ({ valid: false as const, reason, resumeOffset });
  if (!input.cursor.listingComplete) {
    return invalid('ATS batch listing completion is not durably recorded.');
  }
  if (input.jobs.length !== input.storedJobCount) {
    return invalid('ATS batch payload length does not match its stored job count.');
  }
  if (input.cursor.enrichmentVersion !== ATS_JOB_ENRICHMENT_VERSION) {
    return invalid('ATS batch enrichment version is not current.');
  }
  if (input.cursor.enrichmentOffset !== input.storedJobCount) {
    return invalid('ATS batch enrichment cursor is incomplete.');
  }
  if (resumeOffset !== input.storedJobCount) {
    return invalid('ATS batch payload contains a raw or stale enrichment marker.');
  }
  return { valid: true };
}

export function buildAtsBoardRequest(board: Pick<AtsCompany, 'slug' | 'platform'>, offset = 0): { url: string; init: RequestInit } {
  const signal = undefined;
  switch (board.platform) {
    case 'workday': {
      const [company, tenant] = board.slug.split('::');
      const companyWithoutWd = company.split('.')[0];
      return {
        url: `https://${company}.myworkdayjobs.com/wday/cxs/${companyWithoutWd}/${tenant}/jobs`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText: '' }),
          signal,
        },
      };
    }
    case 'workable':
      return {
        // Workable documents this public endpoint as the complete account job
        // collection. details=true also carries descriptions in the listing
        // payload, avoiding an avoidable per-posting detail request.
        url: `https://www.workable.com/api/accounts/${board.slug}?details=true`,
        init: { signal },
      };
    case 'greenhouse': return { url: `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`, init: { signal } };
    case 'lever': return { url: `https://api.lever.co/v0/postings/${board.slug}`, init: { signal } };
    case 'ashby': return { url: `https://api.ashbyhq.com/posting-api/job-board/${board.slug}`, init: { signal } };
    case 'smartrecruiters': return {
      url: `https://api.smartrecruiters.com/v1/companies/${board.slug}/postings?limit=${SMARTRECRUITERS_PAGE_SIZE}&offset=${offset}`,
      init: { signal },
    };
    case 'bamboohr': return { url: `https://${board.slug}.bamboohr.com/careers/list`, init: { signal } };
    case 'breezy': return { url: `https://${board.slug}.breezy.hr/json`, init: { signal } };
    case 'teamtailor': return { url: `https://${board.slug}.teamtailor.com/jobs.json`, init: { signal } };
    case 'pinpoint': return { url: `https://${board.slug}.pinpointhq.com/postings.json`, init: { signal } };
    case 'recruitee': return { url: `https://${board.slug}.recruitee.com/api/offers`, init: { signal } };
    case 'rippling': return { url: `https://ats.rippling.com/api/v1/board/${board.slug}/jobs`, init: { signal } };
    case 'personio': return { url: `https://${board.slug}.jobs.personio.de/xml`, init: { signal } };
    default: throw new Error(`Unsupported ATS platform: ${board.platform}`);
  }
}

function metadataFor(platform: string, data: JsonObject): JsonObject {
  if (platform === 'greenhouse') return typeof data.name === 'string' ? { name: data.name } : {};
  if (platform === 'workable') return typeof data.name === 'string' ? { name: data.name } : {};
  if (platform === 'smartrecruiters') return data.company && typeof data.company === 'object' ? { company: data.company } : {};
  return {};
}

function listingSchemaError(platform: string, detail: string): never {
  throw new Error(`${platform} ATS listing schema is invalid: ${detail}`);
}

function listingObject(platform: string, parsed: unknown): JsonObject {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return listingSchemaError(platform, 'expected an object envelope');
  }
  return parsed as JsonObject;
}

function listingJobs(platform: string, value: unknown, field: string): JsonObject[] {
  if (!Array.isArray(value)) {
    return listingSchemaError(platform, `expected ${field} to be an array`);
  }
  if (value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    return listingSchemaError(platform, `expected every ${field} entry to be an object`);
  }
  return serializableJobs(value);
}

function jobsFor(platform: string, parsed: unknown, bodyText: string | null): JsonObject[] {
  if (platform === 'personio') {
    const xml = cheerio.load(bodyText || '', { xmlMode: true });
    const root = xml.root().children().filter((_index, element) => element.type === 'tag').first();
    if (root.length !== 1 || !root.is('workzag-jobs')) {
      return listingSchemaError(platform, 'expected a workzag-jobs XML root');
    }
    return serializableJobs(xml('position').toArray().map((node) => {
      const position = xml(node);
      const offices = [
        position.children('office').first().text().trim(),
        ...position.find('additionalOffices > office').toArray().map((office) => xml(office).text().trim()),
      ].filter(Boolean);
      return {
        id: position.children('id').first().text().trim(),
        name: position.children('name').first().text().trim(),
        location: offices.join('; '),
        description: position.find('jobDescriptions').text().trim(),
        createdAt: position.children('createdAt').first().text().trim() || null,
      };
    }));
  }

  if (platform === 'lever' || platform === 'breezy' || platform === 'rippling') {
    return listingJobs(platform, parsed, 'root');
  }

  const data = listingObject(platform, parsed);
  switch (platform) {
    case 'greenhouse':
    case 'ashby':
      return listingJobs(platform, data.jobs, 'jobs');
    case 'workday':
      return listingJobs(platform, data.jobPostings, 'jobPostings');
    case 'smartrecruiters':
      return listingJobs(platform, data.content, 'content');
    case 'workable':
      return Object.hasOwn(data, 'jobs')
        ? listingJobs(platform, data.jobs, 'jobs')
        : listingJobs(platform, data.results, 'results');
    case 'bamboohr':
      return listingJobs(platform, data.result, 'result');
    case 'teamtailor':
      return listingJobs(platform, data.items, 'items');
    case 'pinpoint':
      return listingJobs(platform, data.data, 'data');
    case 'recruitee':
      return listingJobs(platform, data.offers, 'offers');
    default:
      return listingSchemaError(platform, 'unsupported platform');
  }
}

export function parseAtsListingPayload(
  platform: string,
  parsed: unknown,
  bodyText: string | null = null,
): { jobs: JsonObject[]; metadata: JsonObject; total: number | null } {
  const jobs = jobsFor(platform, parsed, bodyText);
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as JsonObject
    : {};
  const totalValue = platform === 'workday'
    ? Number(data.total ?? data.totalCount)
    : platform === 'smartrecruiters'
      ? Number(data.totalFound)
    : Number.NaN;
  return {
    jobs,
    metadata: metadataFor(platform, data),
    total: Number.isFinite(totalValue) ? Math.max(0, totalValue) : null,
  };
}

function responseMatchesPlatform(platform: string, contentType: string): boolean {
  return platform === 'personio' ? /xml/i.test(contentType) : /json/i.test(contentType);
}

function timeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'TimeoutError' || /timeout|timed out|abort/i.test(message);
}

function providerWideError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof RateLimitedError
    || /HTTP\s+(?:401|403)\b|schema|not iterable|unexpected token|invalid response/i.test(message);
}

async function reserveAtsRequest(source: string): Promise<void> {
  const decision = await reserveProviderBudgetForSource(source);
  if (!decision.allowed) {
    throw new AtsProviderBlockedError(decision.retryAt || null, decision.reason || 'provider control');
  }
}

async function fetchBoardPage(
  board: Pick<AtsCompany, 'slug' | 'platform'>,
  offset: number,
  signal?: AbortSignal,
  onRequestStarted?: () => Promise<void>,
  onResponseReceived?: (input: { status: number; respondedAt: Date }) => Promise<void>,
): Promise<{ status: number; jobs: JsonObject[]; metadata: JsonObject; total: number | null }> {
  const source = `ATS-${board.platform}`;
  const request = buildAtsBoardRequest(board, offset);
  let validatedPayload: ReturnType<typeof parseAtsListingPayload> | null = null;
  const response = await fetchAtsPlatformResponse(board.platform, signal, async () => {
    await reserveAtsRequest(source);
    await onRequestStarted?.();
    return fetch(request.url, { ...request.init, signal: requestSignal(signal) });
  }, {
    onResponse: async (received) => {
      // Contact, response, and synchronization are deliberately distinct.
      // Persist the raw response before status/content/body validation so a
      // 500 or malformed body is not misreported as "never responded". The
      // validation itself remains inside Workable's durable request fence, so
      // the next PID cannot outrun a newly published provider-wide failure.
      await onResponseReceived?.({ status: received.status, respondedAt: new Date() });
      if (received.status === 429) throw new RateLimitedError(board.platform);
      if (!received.ok) throw new AtsHttpError(received.status);

      const contentType = received.headers.get('content-type') || '';
      if (!responseMatchesPlatform(board.platform, contentType)) {
        const expected = board.platform === 'personio' ? 'XML' : 'JSON';
        throw new Error(
          `${board.platform} board returned ${contentType.split(';')[0] || 'an unknown content type'} instead of ${expected} schema`,
        );
      }

      const body = received.clone();
      validatedPayload = board.platform === 'personio'
        ? parseAtsListingPayload(board.platform, {}, await body.text())
        : parseAtsListingPayload(board.platform, await body.json() as unknown);
    },
  });
  if (!validatedPayload) {
    throw new Error(`${board.platform} ATS listing schema validation produced no payload.`);
  }
  const payload = validatedPayload as ReturnType<typeof parseAtsListingPayload>;
  return { status: response.status, ...payload };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

export function payloadHash(metadata: JsonObject, jobs: JsonObject[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson({ metadata, jobs })))
    .digest('hex');
}

export function validateAtsBatchCompletion(input: {
  counters: IngestionCounters;
  fatalError?: string | null;
  storedJobCount: number;
  payloadJobCount: number;
  storedPayloadHash: string | null;
  computedPayloadHash: string;
  payloadPresent: boolean;
  allowProcessingErrors?: boolean;
}): { valid: true } | { valid: false; reason: string } {
  if (input.fatalError) return { valid: false, reason: input.fatalError };
  if (!input.payloadPresent) return { valid: false, reason: 'ATS batch payload is missing.' };
  if (!ingestionReconciles(input.counters)) {
    return { valid: false, reason: 'ATS batch processing counters do not reconcile.' };
  }
  if (input.counters.processingErrors > 0 && !input.allowProcessingErrors) {
    return {
      valid: false,
      reason: `${input.counters.processingErrors} job(s) failed during normalization or persistence.`,
    };
  }
  if (input.payloadJobCount !== input.storedJobCount) {
    return { valid: false, reason: 'ATS batch payload length does not match its stored job count.' };
  }
  if (input.counters.seen !== input.storedJobCount) {
    return { valid: false, reason: 'ATS batch did not produce one processing outcome per stored job.' };
  }
  if (!input.storedPayloadHash || input.storedPayloadHash !== input.computedPayloadHash) {
    return { valid: false, reason: 'ATS batch payload hash integrity check failed.' };
  }
  return { valid: true };
}

export function planAtsProcessingTurn(input: {
  currentOffset: number;
  storedJobCount: number;
  payloadJobCount: number;
  claimedJobCount: number;
  storedCounters: Pick<IngestionCounters, 'inserted' | 'duplicates' | 'filtered' | 'processingErrors'>;
  turnCounters: IngestionCounters;
  interrupted?: boolean;
  fatalError?: string | null;
}): {
  valid: boolean;
  reason: string | null;
  nextOffset: number;
  complete: boolean;
  counters: IngestionCounters;
} {
  const priorSeen = input.storedCounters.inserted
    + input.storedCounters.duplicates
    + input.storedCounters.filtered
    + input.storedCounters.processingErrors;
  const unchanged = {
    seen: priorSeen,
    inserted: input.storedCounters.inserted,
    duplicates: input.storedCounters.duplicates,
    filtered: input.storedCounters.filtered,
    processingErrors: input.storedCounters.processingErrors,
    providerErrors: input.turnCounters.providerErrors,
    requests: input.turnCounters.requests,
  };
  const invalid = (reason: string) => ({
    valid: false,
    reason,
    nextOffset: input.currentOffset,
    complete: false,
    counters: unchanged,
  });

  if (!Number.isInteger(input.currentOffset) || !Number.isInteger(input.storedJobCount)
    || input.currentOffset < 0 || input.storedJobCount < 0
    || input.currentOffset > input.storedJobCount) {
    return invalid('ATS processing cursor is outside the stored payload bounds.');
  }
  if (input.payloadJobCount !== input.storedJobCount) {
    return invalid('ATS batch payload length does not match its stored job count.');
  }
  if (priorSeen !== input.currentOffset) {
    return invalid('ATS processing cursor does not reconcile with its cumulative counters.');
  }
  if ((input.currentOffset < input.storedJobCount && input.claimedJobCount <= 0)
    || input.claimedJobCount > input.storedJobCount - input.currentOffset) {
    return invalid('ATS processing chunk does not match the remaining payload.');
  }
  if (input.fatalError) return invalid(input.fatalError);
  if (!ingestionReconciles(input.turnCounters)) {
    return invalid('ATS processing turn counters do not reconcile.');
  }
  if (input.turnCounters.seen < 0 || input.turnCounters.seen > input.claimedJobCount) {
    return invalid('ATS processing turn outcome count exceeds its claimed chunk.');
  }
  if (!input.interrupted && input.turnCounters.seen !== input.claimedJobCount) {
    return invalid('ATS processing turn did not produce one outcome per claimed job.');
  }
  const nextOffset = input.currentOffset + input.turnCounters.seen;
  if (nextOffset > input.storedJobCount) {
    return invalid('ATS processing cursor is outside the stored payload bounds.');
  }
  const counters = {
    seen: priorSeen + input.turnCounters.seen,
    inserted: input.storedCounters.inserted + input.turnCounters.inserted,
    duplicates: input.storedCounters.duplicates + input.turnCounters.duplicates,
    filtered: input.storedCounters.filtered + input.turnCounters.filtered,
    processingErrors: input.storedCounters.processingErrors + input.turnCounters.processingErrors,
    providerErrors: input.turnCounters.providerErrors,
    requests: input.turnCounters.requests,
  };
  return {
    valid: true,
    reason: null,
    nextOffset,
    complete: nextOffset === input.storedJobCount,
    counters,
  };
}

/**
 * A real pipeline stop and the ATS wall-clock deadline share the interrupted
 * completion path. Only a committed cursor prefix should be immediately
 * runnable; otherwise a deadline can hot-reclaim the same untouched chunk
 * forever without consuming the bounded processing-error retry budget.
 */
export function nextAtsProcessingContinuationAt(input: {
  now: Date;
  interrupted?: boolean;
  cursorAdvanced: boolean;
}): Date {
  return new Date(input.now.getTime() + (
    input.interrupted && !input.cursorAdvanced
      ? ATS_ZERO_PROGRESS_PROCESSING_BACKOFF_MS
      : 0
  ));
}

export function fairAtsBoardsAcrossPlatforms<T extends { platform: string }>(
  rows: readonly T[],
  limit: number,
  rotationSeed = 0,
): T[] {
  const take = Math.max(0, Math.floor(limit));
  if (take === 0) return [];
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    groups.set(row.platform, [...(groups.get(row.platform) || []), row]);
  }
  const platforms = [...groups.keys()].sort();
  if (platforms.length > 1) {
    const offset = Math.abs(Math.floor(rotationSeed)) % platforms.length;
    platforms.push(...platforms.splice(0, offset));
  }
  const selected: T[] = [];
  while (selected.length < take) {
    let progressed = false;
    for (const platform of platforms) {
      const next = groups.get(platform)?.shift();
      if (!next) continue;
      selected.push(next);
      progressed = true;
      if (selected.length >= take) break;
    }
    if (!progressed) break;
  }
  return selected;
}

function prismaErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

export async function reconcileStaleAtsAttempts(
  board: Pick<AtsCompany, 'slug' | 'platform'>,
  now: Date = new Date(),
): Promise<number> {
  const result = await prisma.atsBoardCheckAttempt.updateMany({
    where: {
      slug: board.slug,
      platform: board.platform,
      outcome: 'running',
      leaseExpiresAt: { lte: now },
    },
    data: {
      outcome: 'interrupted',
      heartbeatAt: now,
      leaseExpiresAt: null,
      finishedAt: now,
      error: 'Acquisition attempt lease expired; the durable batch will resume from its last cursor.',
    },
  });
  return result.count;
}

async function loadOrCreateBatch(board: AtsBoardForAcquisition): Promise<AtsIngestionBatch> {
  const existing = await prisma.atsIngestionBatch.findFirst({
    where: { slug: board.slug, platform: board.platform, status: { in: ['fetching', 'partial'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;
  try {
    return await prisma.atsIngestionBatch.create({
      data: {
        slug: board.slug,
        platform: board.platform,
        status: 'fetching',
        payload: [],
        metadata: {},
        cursor: {
          offset: 0,
          total: null,
          listingComplete: false,
          enrichmentOffset: 0,
          enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
        },
      },
    });
  } catch (error) {
    // The database partial unique index is the final authority. If two workers
    // both miss the read, the loser resumes the winner's one active batch.
    if (prismaErrorCode(error) !== 'P2002') throw error;
    const winner = await prisma.atsIngestionBatch.findFirst({
      where: { slug: board.slug, platform: board.platform, status: { in: ['fetching', 'partial'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!winner) throw error;
    return winner;
  }
}

export function nextAtsFailureSchedule(board: AtsBoardForAcquisition, now: Date) {
  if (board.retryCount < SAME_DAY_RETRY_DELAYS_MS.length) {
    return {
      retryCount: board.retryCount + 1,
      failCount: board.failCount,
      status: board.status,
      nextCheckDate: new Date(now.getTime() + SAME_DAY_RETRY_DELAYS_MS[board.retryCount]),
    };
  }
  const failCount = board.failCount + 1;
  const days = failCount === 1 ? 1 : failCount === 2 ? 7 : 30;
  return {
    retryCount: 0,
    failCount,
    status: failCount >= 3 ? 'blacklisted' : 'parked',
    nextCheckDate: new Date(now.getTime() + days * 86_400_000),
  };
}

export function nextAtsBackpressureState(input: {
  active: boolean;
  remainingJobs: number;
  highWatermark?: number;
  lowWatermark?: number;
}): AtsAcquisitionBackpressureState {
  const remainingJobs = Math.max(0, Math.floor(input.remainingJobs));
  const highWatermark = Math.max(
    1,
    Math.floor(input.highWatermark ?? ATS_ACQUISITION_JOB_HIGH_WATERMARK),
  );
  const lowWatermark = Math.min(
    highWatermark - 1,
    Math.max(0, Math.floor(input.lowWatermark ?? ATS_ACQUISITION_JOB_LOW_WATERMARK)),
  );
  return {
    active: input.active ? remainingJobs > lowWatermark : remainingJobs >= highWatermark,
    remainingJobs,
  };
}

export function atsProviderRetryAt(
  retryAt: Date | null | undefined,
  now: Date,
): Date {
  return retryAt && retryAt.getTime() > now.getTime()
    ? retryAt
    : new Date(now.getTime() + 15 * 60_000);
}

export async function acquireAtsBoardBatch(
  board: AtsBoardForAcquisition,
  signal?: AbortSignal,
): Promise<AtsAcquisitionResult> {
  const startedAt = new Date();
  await reconcileStaleAtsAttempts(board, startedAt);
  // A platform circuit is board-independent. Check it before allocating an
  // empty batch and append-only attempt receipt so one open circuit cannot
  // manufacture thousands of zero-contact rows while the scheduler drains
  // the due catalog. The board itself carries the durable retry boundary.
  const providerDecision = await reserveProviderBudgetForSource(`ATS-${board.platform}`);
  if (!providerDecision.allowed) {
    const retryAt = atsProviderRetryAt(providerDecision.retryAt, startedAt);
    await prisma.atsCompany.updateMany({
      where: {
        slug: board.slug,
        platform: board.platform,
        nextCheckDate: { lt: retryAt },
      },
      data: { nextCheckDate: retryAt },
    });
    return {
      attemptId: '',
      batchId: '',
      outcome: 'deferred',
      requestCount: 0,
      pageCount: 0,
      jobCount: 0,
      responded: false,
    };
  }
  const batch = await loadOrCreateBatch(board);
  const leaseOwner = atsWorkerOwner();
  let attempt: Awaited<ReturnType<typeof prisma.atsBoardCheckAttempt.create>>;
  try {
    attempt = await prisma.atsBoardCheckAttempt.create({
      data: {
        slug: board.slug,
        platform: board.platform,
        batchId: batch.id,
        startedAt,
        leaseOwner,
        heartbeatAt: startedAt,
        leaseExpiresAt: new Date(startedAt.getTime() + ATS_ACQUISITION_ATTEMPT_LEASE_MS),
      },
    });
  } catch (error) {
    if (prismaErrorCode(error) !== 'P2002') throw error;
    const activeAttempt = await prisma.atsBoardCheckAttempt.findFirst({
      where: { slug: board.slug, platform: board.platform, outcome: 'running' },
      orderBy: { startedAt: 'desc' },
      select: { id: true, batchId: true },
    });
    return {
      attemptId: activeAttempt?.id || '',
      batchId: activeAttempt?.batchId || batch.id,
      outcome: 'deferred',
      requestCount: 0,
      pageCount: 0,
      jobCount: 0,
      responded: false,
    };
  }
  let requestCount = 0;
  let pageCount = 0;
  let httpStatus: number | null = null;
  let batchRespondedAt = batch.respondedAt;
  let attemptRespondedAt: Date | null = null;
  let metadata = jsonObject(batch.metadata);
  const jobs = jsonJobs(batch.payload);
  const paginated = PAGINATED_PLATFORMS.has(board.platform);
  let cursor = readAtsAcquisitionCursor(batch.cursor);

  // Batches written before the enrichment cursor existed can still have a
  // fully persisted listing page. A non-paginated page is the whole listing;
  // a paginated cursor at its advertised total is complete as well. Recover
  // those checkpoints without re-appending the same listing payload.
  cursor = recoverAtsListingCompletion({
    cursor,
    paginated,
    persistedPageCount: batch.pageCount,
    jobs,
    platform: board.platform,
  });

  const onRequestStarted = async () => {
    const nextRequestCount = requestCount + 1;
    const contactedAt = new Date();
    await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
      const lease = await transaction.atsBoardCheckAttempt.updateMany({
        where: { id: attempt.id, outcome: 'running', leaseOwner },
        data: {
          requestCount: nextRequestCount,
          ...(nextRequestCount === 1 ? { contactedAt } : {}),
          heartbeatAt: contactedAt,
          leaseExpiresAt: new Date(contactedAt.getTime() + ATS_ACQUISITION_ATTEMPT_LEASE_MS),
        },
      });
      if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
      await transaction.atsIngestionBatch.update({
        where: { id: batch.id },
        data: { requestCount: { increment: 1 }, heartbeatAt: contactedAt },
      });
      if (nextRequestCount === 1) {
        await transaction.atsCompany.update({
          where: { slug_platform: { slug: board.slug, platform: board.platform } },
          data: { lastAttemptedAt: contactedAt },
        });
      }
    }));
    requestCount = nextRequestCount;
  };

  const onResponseReceived = async (input: { status: number; respondedAt: Date }) => {
    const responseState = advanceAtsResponseState({
      batchRespondedAt,
      attemptRespondedAt,
      responseAt: input.respondedAt,
    });
    await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
      const lease = await transaction.atsBoardCheckAttempt.updateMany({
        where: { id: attempt.id, outcome: 'running', leaseOwner },
        data: {
          httpStatus: input.status,
          respondedAt: responseState.attemptRespondedAt,
          heartbeatAt: input.respondedAt,
          leaseExpiresAt: new Date(input.respondedAt.getTime() + ATS_ACQUISITION_ATTEMPT_LEASE_MS),
        },
      });
      if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
      await transaction.atsIngestionBatch.update({
        where: { id: batch.id },
        data: { respondedAt: responseState.batchRespondedAt, heartbeatAt: input.respondedAt },
      });
      await transaction.atsCompany.update({
        where: { slug_platform: { slug: board.slug, platform: board.platform } },
        data: { lastRespondedAt: input.respondedAt },
      });
    }));
    httpStatus = input.status;
    batchRespondedAt = responseState.batchRespondedAt;
    attemptRespondedAt = responseState.attemptRespondedAt;
  };

  const finalizePartialAttempt = async (now: Date, lastError: string) => {
    await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
      const lease = await transaction.atsBoardCheckAttempt.updateMany({
        where: { id: attempt.id, outcome: 'running', leaseOwner },
        data: {
          outcome: 'partial',
          httpStatus,
          requestCount,
          pageCount,
          jobCount: jobs.length,
          respondedAt: attemptRespondedAt,
          heartbeatAt: now,
          leaseExpiresAt: null,
          finishedAt: now,
          durationMs: now.getTime() - startedAt.getTime(),
        },
      });
      if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
      await transaction.atsIngestionBatch.update({
        where: { id: batch.id },
        data: {
          status: 'partial',
          payload: jobs as Prisma.InputJsonValue,
          metadata: metadata as Prisma.InputJsonValue,
          cursor: cursor as unknown as Prisma.InputJsonValue,
          jobCount: jobs.length,
          heartbeatAt: now,
          lastError,
        },
      });
      await transaction.atsCompany.update({
        where: { slug_platform: { slug: board.slug, platform: board.platform } },
        data: { nextCheckDate: new Date(now.getTime() + 60_000) },
      });
    }));
  };

  try {
    const pageLimit = paginated ? ATS_ACQUISITION_PAGES_PER_ATTEMPT : 1;
    for (let page = 0; !cursor.listingComplete && page < pageLimit; page++) {
      if (signal?.aborted) throw signal.reason || new Error('ATS acquisition interrupted');
      const offset = paginated ? cursor.offset : 0;
      const result = await fetchBoardPage(
        board,
        offset,
        signal,
        onRequestStarted,
        onResponseReceived,
      );
      pageCount++;
      metadata = { ...metadata, ...result.metadata };
      jobs.push(...result.jobs);

      let listingComplete: boolean;
      let nextOffset = cursor.offset;
      let total = cursor.total;
      if (!paginated) {
        listingComplete = true;
      } else {
        total = cursor.total ?? result.total;
        nextOffset = offset + result.jobs.length;
        const pageSize = board.platform === 'smartrecruiters'
          ? SMARTRECRUITERS_PAGE_SIZE
          : WORKDAY_PAGE_SIZE;
        listingComplete = result.jobs.length < pageSize
          || (total != null && nextOffset >= total);
      }
      cursor = {
        offset: nextOffset,
        total,
        listingComplete,
        enrichmentOffset: 0,
        enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
      };

      const pagePersistedAt = new Date();
      await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
        const lease = await transaction.atsBoardCheckAttempt.updateMany({
          where: { id: attempt.id, outcome: 'running', leaseOwner },
          data: {
            pageCount,
            jobCount: jobs.length,
            heartbeatAt: pagePersistedAt,
            leaseExpiresAt: new Date(pagePersistedAt.getTime() + ATS_ACQUISITION_ATTEMPT_LEASE_MS),
          },
        });
        if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
        await transaction.atsIngestionBatch.update({
          where: { id: batch.id },
          data: {
            payload: jobs as Prisma.InputJsonValue,
            metadata: metadata as Prisma.InputJsonValue,
            cursor: cursor as unknown as Prisma.InputJsonValue,
            pageCount: { increment: 1 },
            jobCount: jobs.length,
            respondedAt: batchRespondedAt,
            heartbeatAt: pagePersistedAt,
          },
        });
      }));
    }

    if (!cursor.listingComplete) {
      const now = new Date();
      await finalizePartialAttempt(now, 'Pagination will resume from the durable cursor.');
      if (attemptRespondedAt) {
        await recordProviderSuccess(`ATS-${board.platform}`, attemptRespondedAt).catch((error) => {
          console.error(`Failed to persist ATS-${board.platform} provider success:`, error);
        });
      }
      return {
        attemptId: attempt.id,
        batchId: batch.id,
        outcome: 'partial',
        requestCount,
        pageCount,
        jobCount: jobs.length,
        responded: Boolean(attemptRespondedAt),
      };
    }

    // Listing completion is a separate durable checkpoint. No detail request is
    // allowed to start until this transaction commits, so a crash can resume
    // enrichment without replaying or duplicating listing pages.
    cursor = {
      ...cursor,
      listingComplete: true,
      enrichmentOffset: currentAtsEnrichmentPrefix(jobs, board.platform),
      enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
    };
    const listingCheckpointAt = new Date();
    await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
      const lease = await transaction.atsBoardCheckAttempt.updateMany({
        where: { id: attempt.id, outcome: 'running', leaseOwner },
        data: {
          pageCount,
          jobCount: jobs.length,
          heartbeatAt: listingCheckpointAt,
          leaseExpiresAt: new Date(listingCheckpointAt.getTime() + ATS_ACQUISITION_ATTEMPT_LEASE_MS),
        },
      });
      if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
      await transaction.atsIngestionBatch.update({
        where: { id: batch.id },
        data: {
          payload: jobs as Prisma.InputJsonValue,
          metadata: metadata as Prisma.InputJsonValue,
          cursor: cursor as unknown as Prisma.InputJsonValue,
          jobCount: jobs.length,
          heartbeatAt: listingCheckpointAt,
        },
      });
    }));

    const enrichmentLimit = planAtsEnrichmentChunk(
      cursor.enrichmentOffset,
      jobs.length,
    ).end;
    while (cursor.enrichmentOffset < enrichmentLimit) {
      if (signal?.aborted) throw signal.reason || new Error('ATS acquisition interrupted');
      const jobIndex = cursor.enrichmentOffset;
      const currentJob = jobs[jobIndex];
      const enriched = hasCurrentAtsJobEnrichment(currentJob, board.platform)
        ? currentJob
        : await enrichAtsListingJob({
            platform: board.platform,
            slug: board.slug,
            job: currentJob,
            signal,
            requestTimeoutMs: ATS_ACQUISITION_REQUEST_TIMEOUT_MS,
            onRequestStarted,
            onResponseReceived,
          });
      const serializable = serializableJobs([enriched])[0];
      if (!serializable || !hasCurrentAtsJobEnrichment(serializable, board.platform)) {
        throw new Error(
          `ATS-${board.platform} enrichment did not return a valid current-version marker for item ${jobIndex}.`,
        );
      }
      jobs[jobIndex] = serializable;
      cursor = {
        ...cursor,
        enrichmentOffset: jobIndex + 1,
        enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
      };

      // The payload replacement and its cursor advance share the attempt
      // heartbeat transaction. A crash between response and this commit can
      // therefore replay at most this one detail request, never a durable prefix.
      const enrichedAt = new Date();
      await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
        const lease = await transaction.atsBoardCheckAttempt.updateMany({
          where: { id: attempt.id, outcome: 'running', leaseOwner },
          data: {
            requestCount,
            jobCount: jobs.length,
            heartbeatAt: enrichedAt,
            leaseExpiresAt: new Date(enrichedAt.getTime() + ATS_ACQUISITION_ATTEMPT_LEASE_MS),
          },
        });
        if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
        await transaction.atsIngestionBatch.update({
          where: { id: batch.id },
          data: {
            payload: jobs as Prisma.InputJsonValue,
            cursor: cursor as unknown as Prisma.InputJsonValue,
            jobCount: jobs.length,
            heartbeatAt: enrichedAt,
          },
        });
      }));
    }

    if (cursor.enrichmentOffset < jobs.length) {
      const now = new Date();
      await finalizePartialAttempt(now, 'Job enrichment will resume from the durable cursor.');
      if (attemptRespondedAt) {
        await recordProviderSuccess(`ATS-${board.platform}`, attemptRespondedAt).catch((error) => {
          console.error(`Failed to persist ATS-${board.platform} provider success:`, error);
        });
      }
      return {
        attemptId: attempt.id,
        batchId: batch.id,
        outcome: 'partial',
        requestCount,
        pageCount,
        jobCount: jobs.length,
        responded: Boolean(attemptRespondedAt),
      };
    }

    const readiness = validateAtsEnrichmentQueueReadiness({
      cursor,
      jobs,
      platform: board.platform,
      storedJobCount: jobs.length,
    });
    if (!readiness.valid) throw new Error(readiness.reason);

    const synchronizedAt = new Date();
    await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
      const lease = await transaction.atsBoardCheckAttempt.updateMany({
        where: { id: attempt.id, outcome: 'running', leaseOwner },
        data: {
          outcome: 'synchronized',
          httpStatus,
          requestCount,
          pageCount,
          jobCount: jobs.length,
          respondedAt: attemptRespondedAt,
          synchronizedAt,
          heartbeatAt: synchronizedAt,
          leaseExpiresAt: null,
          finishedAt: synchronizedAt,
          durationMs: synchronizedAt.getTime() - startedAt.getTime(),
        },
      });
      if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
      await transaction.atsIngestionBatch.update({
        where: { id: batch.id },
        data: {
          status: 'queued',
          payload: jobs as Prisma.InputJsonValue,
          payloadHash: payloadHash(metadata, jobs),
          metadata: metadata as Prisma.InputJsonValue,
          cursor: cursor as unknown as Prisma.InputJsonValue,
          jobCount: jobs.length,
          heartbeatAt: synchronizedAt,
          synchronizedAt,
          lastError: null,
        },
      });
      await transaction.atsCompany.update({
        where: { slug_platform: { slug: board.slug, platform: board.platform } },
        data: {
          failCount: 0,
          retryCount: 0,
          status: 'active',
          nextCheckDate: nextAtsBoardCheckDateForDay(board.checkDay, synchronizedAt),
          lastCheckedAt: synchronizedAt,
          lastSynchronizedAt: synchronizedAt,
          jobsFound: jobs.length,
        },
      });
    }));
    // Provider success belongs to the response boundary, not the later batch
    // synchronization write. A newer 429 from another PID must win this race.
    if (attemptRespondedAt) {
      await recordProviderSuccess(`ATS-${board.platform}`, attemptRespondedAt).catch((error) => {
        console.error(`Failed to persist ATS-${board.platform} provider success:`, error);
      });
    }
    return {
      attemptId: attempt.id,
      batchId: batch.id,
      outcome: 'synchronized',
      requestCount,
      pageCount,
      jobCount: jobs.length,
      responded: Boolean(attemptRespondedAt),
    };
  } catch (error) {
    if (error instanceof AtsAttemptLeaseLostError) {
      return {
        attemptId: attempt.id,
        batchId: batch.id,
        outcome: 'interrupted',
        requestCount,
        pageCount,
        jobCount: jobs.length,
        responded: false,
      };
    }
    const now = new Date();
    if (signal?.aborted) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : 'ATS acquisition interrupted';
      const hasDurableProgress = batch.status === 'partial'
        || batch.pageCount > 0
        || pageCount > 0
        || jobs.length > 0
        || cursor.offset > 0;
      const finalized = await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
        const lease = await transaction.atsBoardCheckAttempt.updateMany({
          where: { id: attempt.id, outcome: 'running', leaseOwner },
          data: {
            outcome: 'interrupted',
            httpStatus,
            requestCount,
            pageCount,
            jobCount: jobs.length,
            respondedAt: attemptRespondedAt,
            heartbeatAt: now,
            leaseExpiresAt: null,
            finishedAt: now,
            durationMs: now.getTime() - startedAt.getTime(),
            error: message,
          },
        });
        if (lease.count !== 1) return false;
        await transaction.atsIngestionBatch.update({
          where: { id: batch.id },
          data: {
            // A raw response or a claimed-but-unstarted board is not durable
            // payload progress. Keep only persisted page/cursor state active;
            // otherwise leave a terminal receipt that cannot consume queue cap.
            status: hasDurableProgress ? 'partial' : 'interrupted',
            payload: jobs as Prisma.InputJsonValue,
            metadata: metadata as Prisma.InputJsonValue,
            cursor: cursor as Prisma.InputJsonValue,
            jobCount: jobs.length,
            heartbeatAt: now,
            lastError: message,
          },
        });
        return true;
      }));
      return {
        attemptId: attempt.id,
        batchId: batch.id,
        outcome: 'interrupted',
        requestCount,
        pageCount,
        jobCount: jobs.length,
        responded: finalized && Boolean(attemptRespondedAt),
      };
    }
    const throttled = error instanceof RateLimitedError;
    const deferred = error instanceof AtsProviderBlockedError || error instanceof AtsPlatformDeferredError;
    const hadResponse = Boolean(attemptRespondedAt);
    const hasDurableProgress = batch.status === 'partial'
      || batch.pageCount > 0
      || pageCount > 0
      || jobs.length > 0
      || cursor.offset > 0;
    const outcome: AtsAcquisitionOutcome = throttled
      ? 'throttled'
      : deferred ? 'deferred' : timeoutError(error) ? 'timeout' : 'error';
    const message = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
    const boardUpdate = error instanceof AtsPlatformDeferredError
      ? {
          nextCheckDate: error.retryAt
            || new Date(now.getTime() + platformPauseRemainingMs(board.platform) + 60_000),
        }
      : deferred
      ? {
          nextCheckDate: error instanceof AtsProviderBlockedError && error.retryAt
            ? error.retryAt
            : new Date(now.getTime() + 15 * 60_000),
        }
      : throttled
      ? {
          nextCheckDate: new Date(now.getTime() + platformPauseRemainingMs(board.platform) + 60_000),
        }
      : nextAtsFailureSchedule(board, now);

    const finalized = await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
      const lease = await transaction.atsBoardCheckAttempt.updateMany({
        where: { id: attempt.id, outcome: 'running', leaseOwner },
        data: {
          outcome,
          httpStatus: error instanceof AtsHttpError ? error.status : httpStatus,
          requestCount,
          pageCount,
          jobCount: jobs.length,
          respondedAt: attemptRespondedAt,
          heartbeatAt: now,
          leaseExpiresAt: null,
          finishedAt: now,
          durationMs: now.getTime() - startedAt.getTime(),
          error: message,
        },
      });
      if (lease.count !== 1) return false;
      await transaction.atsIngestionBatch.update({
        where: { id: batch.id },
        data: {
          // Telemetry-only contact/response timestamps must never turn an
          // otherwise empty failed request into an outstanding payload.
          status: hasDurableProgress ? 'partial' : deferred ? 'deferred' : 'failed',
          payload: jobs as Prisma.InputJsonValue,
          metadata: metadata as Prisma.InputJsonValue,
          cursor: cursor as unknown as Prisma.InputJsonValue,
          jobCount: jobs.length,
          heartbeatAt: now,
          lastError: message,
        },
      });
      await transaction.atsCompany.update({
        where: { slug_platform: { slug: board.slug, platform: board.platform } },
        data: boardUpdate,
      });
      return true;
    }));
    if (!finalized) {
      return {
        attemptId: attempt.id,
        batchId: batch.id,
        outcome: 'interrupted',
        requestCount,
        pageCount,
        jobCount: jobs.length,
        responded: false,
      };
    }
    if (!throttled && !deferred && providerWideError(error)
      && !(error instanceof AtsProviderFailureRecordedError)) {
      await recordProviderFailure({ provider: `ATS-${board.platform}`, error }).catch((controlError) => {
        console.error(`Failed to persist ATS-${board.platform} provider failure:`, controlError);
      });
    }
    return { attemptId: attempt.id, batchId: batch.id, outcome, requestCount, pageCount, jobCount: jobs.length, responded: hadResponse };
  }
}

const dueOrder = [
  { lastAttemptedAt: { sort: 'asc' as const, nulls: 'first' as const } },
  { lastCheckedAt: { sort: 'asc' as const, nulls: 'first' as const } },
  { nextCheckDate: 'asc' as const },
  { slug: 'asc' as const },
];

const ACTIVE_ACQUISITION_BATCH_STATUSES = ['fetching', 'partial'] as const;
const OUTSTANDING_BATCH_STATUSES = ['fetching', 'partial', 'queued', 'processing'] as const;
const atsBoardSelection = {
  slug: true,
  platform: true,
  status: true,
  failCount: true,
  retryCount: true,
  checkDay: true,
} as const;

export function planAtsSelectionCapacity(input: {
  selectionLimit: number;
  resumedCount: number;
  outstandingCount: number;
  queueLimit?: number;
  allowNewBatches?: boolean;
}): { resumeLimit: number; newBatchLimit: number } {
  const selectionLimit = Math.max(0, Math.floor(input.selectionLimit));
  const resumedCount = Math.min(selectionLimit, Math.max(0, Math.floor(input.resumedCount)));
  const queueLimit = Math.max(0, Math.floor(input.queueLimit ?? ATS_ACQUISITION_QUEUE_LIMIT));
  const outstandingCount = Math.max(0, Math.floor(input.outstandingCount));
  return {
    // Resuming does not add an outstanding batch and remains allowed at cap.
    resumeLimit: selectionLimit,
    newBatchLimit: input.allowNewBatches === false
      ? 0
      : Math.min(
          selectionLimit - resumedCount,
          Math.max(0, queueLimit - outstandingCount),
        ),
  };
}

async function fairBoardsForTier(
  where: Prisma.AtsCompanyWhereInput,
  limit: number,
  rotationSeed: number,
): Promise<AtsBoardForAcquisition[]> {
  if (limit <= 0) return [];
  const platformRows = await prisma.atsCompany.findMany({
    where,
    distinct: ['platform'],
    orderBy: { platform: 'asc' },
    select: { platform: true },
  });
  if (platformRows.length === 0) return [];
  // Invalid discovery slugs are filtered after retrieval. A bounded overfetch
  // prevents a few bad rows from consuming a platform's entire fair share.
  const perPlatformTake = Math.min(1_000, Math.max(20, limit * 4));
  const platformBoards = await Promise.all(platformRows.map(({ platform }) => (
    prisma.atsCompany.findMany({
      where: { AND: [where, { platform }] },
      orderBy: dueOrder,
      take: perPlatformTake,
      select: atsBoardSelection,
    })
  )));
  return fairAtsBoardsAcrossPlatforms(
    platformBoards.flat().filter((row) => isSchedulableBoardSlug(row.slug)),
    limit,
    rotationSeed,
  );
}

export async function selectDueAtsBoards(
  limit: number,
  now: Date = new Date(),
  options: { allowNewBatches?: boolean } = {},
): Promise<AtsBoardForAcquisition[]> {
  const selected: AtsBoardForAcquisition[] = [];
  const take = Math.max(0, Math.floor(limit));
  if (take === 0) return selected;
  const today = rotationDayFor(now);
  const remaining = () => take - selected.length;
  const append = (rows: AtsBoardForAcquisition[], allowance = remaining()) => {
    let appended = 0;
    for (const row of rows) {
      if (selected.length >= take || appended >= allowance) break;
      selected.push(row);
      appended++;
    }
    return appended;
  };

  const tiers: Prisma.AtsCompanyWhereInput[] = [
    {
      status: { in: [...ATS_ROTATION_STATUSES] },
      nextCheckDate: { lte: now },
      checkDay: today,
    },
    {
      status: { in: [...ATS_ROTATION_STATUSES] },
      nextCheckDate: { lte: now },
      checkDay: { not: today },
      OR: [
        { lastCheckedAt: null },
        { lastCheckedAt: { lt: atsRotationCycleCutoff(now) } },
      ],
    },
    {
      status: { in: [...ATS_RECOVERY_STATUSES] },
      nextCheckDate: { lte: now },
    },
  ];
  const rotationSeed = Math.floor(now.getTime() / 86_400_000);

  // First drain durable partial/fetching payloads. This priority is global;
  // within the resume phase, assigned-day, catch-up, and recovery tiers remain
  // strict, and each tier rotates fairly across ATS platforms.
  for (let tierIndex = 0; tierIndex < tiers.length && remaining() > 0; tierIndex++) {
    append(await fairBoardsForTier({
      AND: [
        tiers[tierIndex],
        { ingestionBatches: { some: { status: { in: [...ACTIVE_ACQUISITION_BATCH_STATUSES] } } } },
      ],
    }, remaining(), rotationSeed + tierIndex));
  }

  // New boards consume capacity across acquisition and processing states. A
  // backlog of partial JSON payloads therefore cannot grow without bound, but
  // already-started batches above can still make progress when the cap is full.
  const outstanding = await prisma.atsIngestionBatch.count({
    where: { status: { in: [...OUTSTANDING_BATCH_STATUSES] } },
  });
  let newCapacity = planAtsSelectionCapacity({
    selectionLimit: take,
    resumedCount: selected.length,
    outstandingCount: outstanding,
    allowNewBatches: options.allowNewBatches,
  }).newBatchLimit;
  for (let tierIndex = 0; tierIndex < tiers.length && newCapacity > 0; tierIndex++) {
    const appended = append(await fairBoardsForTier({
      AND: [
        tiers[tierIndex],
        { ingestionBatches: { none: { status: { in: [...ACTIVE_ACQUISITION_BATCH_STATUSES] } } } },
      ],
    }, newCapacity, rotationSeed + tiers.length + tierIndex), newCapacity);
    newCapacity -= appended;
  }
  return selected;
}

export async function atsQueueDepth(): Promise<number> {
  return prisma.atsIngestionBatch.count({ where: { status: { in: ['queued', 'processing'] } } });
}

export async function atsOutstandingJobCount(): Promise<number> {
  const outstanding = await prisma.atsIngestionBatch.aggregate({
    where: { status: { in: [...OUTSTANDING_BATCH_STATUSES] } },
    _sum: { jobCount: true, processingOffset: true },
  });
  return Math.max(
    0,
    (outstanding._sum.jobCount || 0) - (outstanding._sum.processingOffset || 0),
  );
}

export function cursorForQueuedAtsEnrichmentRecovery(input: {
  cursor: AtsAcquisitionCursor;
  jobs: JsonObject[];
  platform: string;
}): AtsAcquisitionCursor {
  return {
    ...input.cursor,
    // A queued/processing batch was produced only after the old acquisition
    // path had finished listing. Preserve that durable fact while routing its
    // raw payload back through the new enrichment phase.
    listingComplete: true,
    enrichmentOffset: currentAtsEnrichmentPrefix(input.jobs, input.platform),
    enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
  };
}

async function returnClaimedAtsBatchToEnrichment(input: {
  batchId: string;
  slug: string;
  platform: string;
  leaseToken: string;
  cursor: AtsAcquisitionCursor;
  jobs: JsonObject[];
  reason: string;
  now: Date;
}): Promise<boolean> {
  const cursor = cursorForQueuedAtsEnrichmentRecovery(input);
  const claimedWhere = {
    id: input.batchId,
    leaseToken: input.leaseToken,
    status: 'processing',
    leaseExpiresAt: { gt: input.now },
  } as const;
  const releasedLease = {
    nextProcessAt: null,
    leaseToken: null,
    leaseOwner: null,
    leaseStartedAt: null,
    heartbeatAt: input.now,
    leaseExpiresAt: null,
  } as const;
  try {
    return await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
      const activeSibling = await transaction.atsIngestionBatch.findFirst({
        where: {
          id: { not: input.batchId },
          slug: input.slug,
          platform: input.platform,
          status: { in: [...ACTIVE_ACQUISITION_BATCH_STATUSES] },
        },
        select: { id: true },
      });
      const retained = await transaction.atsIngestionBatch.updateMany({
        where: claimedWhere,
        data: {
          status: activeSibling ? 'failed' : 'partial',
          cursor: cursor as unknown as Prisma.InputJsonValue,
          ...releasedLease,
          lastError: (activeSibling
            ? `${input.reason} A newer active acquisition batch ${activeSibling.id} owns recovery; this payload is retained.`
            : input.reason).slice(0, 1000),
        },
      });
      if (retained.count !== 1) return false;
      if (!activeSibling) {
        await transaction.atsCompany.update({
          where: { slug_platform: { slug: input.slug, platform: input.platform } },
          data: { nextCheckDate: input.now },
        });
      }
      return true;
    }));
  } catch (error) {
    if (prismaErrorCode(error) !== 'P2002') throw error;
    // A sibling may become active after the read but before the status update.
    // The partial unique index correctly rejects that race. Clear this already
    // committed processing lease in a fail-closed receipt so it cannot strand
    // processing or discard the retained raw payload.
    const retained = await prisma.atsIngestionBatch.updateMany({
      where: claimedWhere,
      data: {
        status: 'failed',
        cursor: cursor as unknown as Prisma.InputJsonValue,
        ...releasedLease,
        lastError: `${input.reason} A concurrent acquisition batch owns recovery; this payload is retained.`.slice(0, 1000),
      },
    });
    return retained.count === 1;
  }
}

export async function claimNextAtsIngestionBatch(
  now: Date = new Date(),
): Promise<PrefetchedAtsBatch | null> {
  const candidate = await prisma.atsIngestionBatch.findFirst({
    where: {
      payload: { not: Prisma.DbNull },
      OR: [
        {
          status: 'queued',
          OR: [{ nextProcessAt: null }, { nextProcessAt: { lte: now } }],
        },
        { status: 'processing', leaseExpiresAt: { lte: now } },
      ],
    },
    // Untouched batches (null nextProcessAt) get one bounded chunk before a
    // continuation can return. This prevents one huge board monopolizing the
    // single persistence consumer while keeping retries time-ordered.
    orderBy: [
      { nextProcessAt: { sort: 'asc', nulls: 'first' } },
      { synchronizedAt: 'asc' },
      { createdAt: 'asc' },
    ],
  });
  if (!candidate) return null;

  const leaseToken = randomUUID();
  const claimed = await prisma.atsIngestionBatch.updateMany({
    where: {
      id: candidate.id,
      OR: [
        {
          status: 'queued',
          OR: [{ nextProcessAt: null }, { nextProcessAt: { lte: now } }],
        },
        { status: 'processing', leaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      status: 'processing',
      leaseToken,
      leaseOwner: `${os.hostname()}:${process.pid}`,
      leaseStartedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + ATS_BATCH_LEASE_MS),
      nextProcessAt: null,
      lastError: null,
    },
  });
  if (claimed.count !== 1) return null;
  const batch = await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: candidate.id } });
  const allJobs = jsonJobs(batch.payload);
  const acquisitionCursor = readAtsAcquisitionCursor(batch.cursor);
  const processingOffset = batch.processingOffset;
  const priorSeen = batch.insertedCount
    + batch.duplicateCount
    + batch.filteredCount
    + batch.processingErrorCount;
  const structuralIntegrityError = batch.payload === null
    ? 'ATS batch payload is missing before processing.'
    : allJobs.length !== batch.jobCount
      ? 'ATS batch payload length does not match its stored job count before processing.'
      : !batch.payloadHash || payloadHash(jsonObject(batch.metadata), allJobs) !== batch.payloadHash
        ? 'ATS batch payload hash integrity check failed before processing.'
        : processingOffset < 0 || processingOffset > batch.jobCount || priorSeen !== processingOffset
          ? 'ATS batch processing cursor does not reconcile before processing.'
          : null;
  if (structuralIntegrityError) {
    const retained = await releaseAtsProcessingLeaseForRetry({
      batchId: batch.id,
      leaseToken,
      processingAttemptCount: batch.processingAttemptCount,
      error: structuralIntegrityError,
      now,
    });
    if (!retained) throw new Error(`ATS batch ${batch.id} lost its lease during pre-processing validation.`);
    return null;
  }
  const enrichmentReadiness = validateAtsEnrichmentQueueReadiness({
    cursor: acquisitionCursor,
    jobs: allJobs,
    platform: batch.platform,
    storedJobCount: batch.jobCount,
  });
  if (!enrichmentReadiness.valid) {
    const retained = await returnClaimedAtsBatchToEnrichment({
      batchId: batch.id,
      slug: batch.slug,
      platform: batch.platform,
      leaseToken,
      cursor: acquisitionCursor,
      jobs: allJobs,
      reason: `${enrichmentReadiness.reason} Batch retained for acquisition enrichment.`,
      now,
    });
    if (!retained) throw new Error(`ATS batch ${batch.id} lost its lease while returning to enrichment.`);
    return null;
  }
  return {
    id: batch.id,
    slug: batch.slug,
    platform: batch.platform,
    jobs: allJobs.slice(processingOffset, processingOffset + ATS_BATCH_PROCESSING_CHUNK_SIZE),
    metadata: jsonObject(batch.metadata),
    processingOffset,
    totalJobCount: batch.jobCount,
    synchronizedAt: batch.synchronizedAt,
    leaseToken,
  };
}

export async function heartbeatAtsBatchProcessing(input: {
  batchId: string;
  leaseToken: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now || new Date();
  const result = await prisma.atsIngestionBatch.updateMany({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      status: 'processing',
      leaseExpiresAt: { gt: now },
    },
    data: {
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + ATS_BATCH_LEASE_MS),
    },
  });
  return result.count === 1;
}

async function releaseAtsProcessingLeaseForRetry(input: {
  batchId: string;
  leaseToken: string;
  processingAttemptCount: number;
  error: string;
  now: Date;
}): Promise<boolean> {
  const processingAttemptCount = input.processingAttemptCount + 1;
  const terminal = processingAttemptCount > PROCESSING_RETRY_DELAYS_MS.length;
  const retryDelay = PROCESSING_RETRY_DELAYS_MS[Math.min(
    input.processingAttemptCount,
    PROCESSING_RETRY_DELAYS_MS.length - 1,
  )];
  const result = await prisma.atsIngestionBatch.updateMany({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      status: 'processing',
      leaseExpiresAt: { gt: input.now },
    },
    data: {
      status: terminal ? 'failed' : 'queued',
      processingAttemptCount,
      nextProcessAt: terminal ? null : new Date(input.now.getTime() + retryDelay),
      leaseToken: null,
      leaseOwner: null,
      leaseStartedAt: null,
      heartbeatAt: input.now,
      leaseExpiresAt: null,
      lastError: input.error.slice(0, 1000),
    },
  });
  return result.count === 1;
}

export async function completeAtsBatchProcessing(input: {
  batchId: string;
  leaseToken: string;
  counters: IngestionCounters;
  interrupted?: boolean;
  fatalError?: string | null;
  error?: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now || new Date();
  const batch = await prisma.atsIngestionBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      status: 'processing',
      leaseExpiresAt: { gt: now },
    },
    select: {
      slug: true,
      platform: true,
      processingAttemptCount: true,
      processingOffset: true,
      jobCount: true,
      payload: true,
      payloadHash: true,
      metadata: true,
      insertedCount: true,
      duplicateCount: true,
      filteredCount: true,
      processingErrorCount: true,
    },
  });
  if (!batch) return false;
  const jobs = jsonJobs(batch.payload);
  const metadata = jsonObject(batch.metadata);
  const claimedJobCount = Math.min(
    ATS_BATCH_PROCESSING_CHUNK_SIZE,
    Math.max(0, jobs.length - batch.processingOffset),
  );
  const turn = planAtsProcessingTurn({
    currentOffset: batch.processingOffset,
    storedJobCount: batch.jobCount,
    payloadJobCount: jobs.length,
    claimedJobCount,
    storedCounters: {
      inserted: batch.insertedCount,
      duplicates: batch.duplicateCount,
      filtered: batch.filteredCount,
      processingErrors: batch.processingErrorCount,
    },
    turnCounters: input.counters,
    interrupted: input.interrupted,
    fatalError: input.fatalError,
  });
  if (!turn.valid) {
    const detail = input.error && input.error !== turn.reason ? input.error : null;
    return releaseAtsProcessingLeaseForRetry({
      batchId: input.batchId,
      leaseToken: input.leaseToken,
      processingAttemptCount: batch.processingAttemptCount,
      error: [turn.reason, detail].filter(Boolean).join(' | '),
      now,
    });
  }

  if (input.interrupted && input.counters.processingErrors > 0) {
    // A stop is not an attempt budget. Re-run this bounded chunk so a transient
    // job error observed immediately before shutdown is never quarantined merely
    // because the process was asked to stop.
    const released = await prisma.atsIngestionBatch.updateMany({
      where: {
        id: input.batchId,
        leaseToken: input.leaseToken,
        status: 'processing',
        leaseExpiresAt: { gt: now },
        processingOffset: batch.processingOffset,
      },
      data: {
        status: 'queued',
        nextProcessAt: nextAtsProcessingContinuationAt({
          now,
          interrupted: true,
          cursorAdvanced: false,
        }),
        leaseToken: null,
        leaseOwner: null,
        leaseStartedAt: null,
        heartbeatAt: now,
        leaseExpiresAt: null,
        lastError: input.error || 'Interrupted processing chunk contained a job error and will retry intact.',
      },
    });
    return released.count === 1;
  }

  if (input.counters.processingErrors > 0
    && batch.processingAttemptCount < PROCESSING_RETRY_DELAYS_MS.length) {
    // Give transient normalization/persistence faults two ordinary retries.
    // On the third observed failure, the bad item remains a reconciled,
    // auditable processingError outcome and the cursor advances so one malformed
    // provider row cannot strand every later job in the board.
    return releaseAtsProcessingLeaseForRetry({
      batchId: input.batchId,
      leaseToken: input.leaseToken,
      processingAttemptCount: batch.processingAttemptCount,
      error: [
        `${input.counters.processingErrors} job(s) failed during normalization or persistence.`,
        input.error,
      ].filter(Boolean).join(' | '),
      now,
    });
  }

  if (!turn.complete) {
    const advanced = await prisma.atsIngestionBatch.updateMany({
      where: {
        id: input.batchId,
        leaseToken: input.leaseToken,
        status: 'processing',
        leaseExpiresAt: { gt: now },
        processingOffset: batch.processingOffset,
        jobCount: batch.jobCount,
        payloadHash: batch.payloadHash,
      },
      data: {
        status: 'queued',
        processingOffset: turn.nextOffset,
        insertedCount: turn.counters.inserted,
        duplicateCount: turn.counters.duplicates,
        filteredCount: turn.counters.filtered,
        processingErrorCount: turn.counters.processingErrors,
        processingAttemptCount: 0,
        nextProcessAt: nextAtsProcessingContinuationAt({
          now,
          interrupted: input.interrupted,
          cursorAdvanced: turn.nextOffset > batch.processingOffset,
        }),
        leaseToken: null,
        leaseOwner: null,
        leaseStartedAt: null,
        heartbeatAt: now,
        leaseExpiresAt: null,
        lastError: input.error || (input.interrupted
          ? 'Processing interrupted after a durable chunk prefix; remaining jobs returned to the queue.'
          : null),
      },
    });
    return advanced.count === 1;
  }

  const validation = validateAtsBatchCompletion({
    counters: turn.counters,
    storedJobCount: batch.jobCount,
    payloadJobCount: jobs.length,
    storedPayloadHash: batch.payloadHash,
    computedPayloadHash: payloadHash(metadata, jobs),
    payloadPresent: batch.payload !== null,
    allowProcessingErrors: true,
  });
  if (!validation.valid) {
    const detail = input.error && input.error !== validation.reason ? input.error : null;
    return releaseAtsProcessingLeaseForRetry({
      batchId: input.batchId,
      leaseToken: input.leaseToken,
      processingAttemptCount: batch.processingAttemptCount,
      error: [validation.reason, detail].filter(Boolean).join(' | '),
      now,
    });
  }

  const completedWithErrors = turn.counters.processingErrors > 0;
  return withAtsTransaction(() => prisma.$transaction(async (transaction) => {
    const result = await transaction.atsIngestionBatch.updateMany({
      where: {
        id: input.batchId,
        leaseToken: input.leaseToken,
        status: 'processing',
        leaseExpiresAt: { gt: now },
        jobCount: batch.jobCount,
        payloadHash: batch.payloadHash,
        processingOffset: batch.processingOffset,
      },
      data: {
        status: completedWithErrors ? 'failed' : 'processed',
        // The queue body is temporary. Persisted jobs, hash, counters, and the
        // append-only attempt receipt remain after successful consumption.
        ...(completedWithErrors ? {} : { payload: Prisma.DbNull }),
        insertedCount: turn.counters.inserted,
        duplicateCount: turn.counters.duplicates,
        filteredCount: turn.counters.filtered,
        processingErrorCount: turn.counters.processingErrors,
        processingOffset: turn.nextOffset,
        processedAt: now,
        nextProcessAt: null,
        leaseToken: null,
        leaseOwner: null,
        leaseStartedAt: null,
        heartbeatAt: now,
        leaseExpiresAt: null,
        lastError: completedWithErrors
          ? `${turn.counters.processingErrors} job(s) quarantined after bounded retries; payload retained.`
          : input.error || null,
      },
    });
    if (result.count !== 1) return false;
    await transaction.atsBoardCheckAttempt.updateMany({
      where: { batchId: input.batchId, processedAt: null },
      data: { processedAt: now },
    });
    await transaction.atsCompany.update({
      where: { slug_platform: { slug: batch.slug, platform: batch.platform } },
      data: { lastProcessedAt: now },
    });
    return true;
  }));
}

export async function failAtsBatchProcessing(input: {
  batchId: string;
  leaseToken: string;
  error: unknown;
  now?: Date;
}): Promise<boolean> {
  const now = input.now || new Date();
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const batch = await prisma.atsIngestionBatch.findFirst({
    where: {
      id: input.batchId,
      leaseToken: input.leaseToken,
      status: 'processing',
      leaseExpiresAt: { gt: now },
    },
    select: { processingAttemptCount: true },
  });
  if (!batch) return false;
  return releaseAtsProcessingLeaseForRetry({
    batchId: input.batchId,
    leaseToken: input.leaseToken,
    processingAttemptCount: batch.processingAttemptCount,
    error: message,
    now,
  });
}
