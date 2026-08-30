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
  markAtsListingsWithoutDetail,
  readAtsJobEnrichmentMarker,
} from './atsJobEnrichment';
import {
  ingestionReconciles,
  recordJobPipelineEvent,
  recordProviderFailure,
  recordProviderSuccess,
  reserveProviderBudgetForSource,
  withProviderTransactionRetry,
  type IngestionCounters,
} from './ingestionControl';
import { withIngestionTransactionSlot } from './ingestionConcurrency';
import { ATS_SPLIT_INGESTION_ENABLED } from './ingestionTaskCatalog';
import { prisma } from './prisma';
import { boardSlugFromJobUrl } from './atsBoardYield';
import {
  ATS_PREQUEUE_COMPACTION_METADATA_KEY,
  atsBatchHasProcessingProvenance,
  atsListingSourceId,
  planAtsPrequeueCompaction,
  readAtsPrequeueCompactionMarker,
  validateAtsPrequeueCompactionCheckpoint,
  type AtsObservedSourceState,
  type AtsPrequeueCompactionMarker,
} from './atsPrequeueCompaction';
import {
  ATS_INGESTION_EXCLUDED_BOARDS,
  ATS_RECOVERY_STATUSES,
  ATS_ROTATION_STATUSES,
  atsBoardIngestionExclusion,
  atsRotationCycleCutoff,
  isAtsBoardEnabledForIngestion,
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
/** Cursor/checkpoint size for one claim; jobs are still persisted individually. */
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
/**
 * Detail requests one attempt will make before yielding its board slot.
 *
 * Held at 25 by default. This is now a slot-pressure knob rather than a
 * payload-cost one: with ATS_ENRICHMENT_CHECKPOINT_ITEMS amortizing the payload
 * rewrite over the whole chunk, a larger chunk costs roughly its extra detail
 * requests and nothing more, and finishes a large board in proportionally fewer
 * turns. Raising it makes turns longer and lumpier, so it trades scheduling
 * granularity for fewer continuations.
 */
export const ATS_ENRICHMENT_JOBS_PER_ATTEMPT = boundedInteger(
  process.env.ATS_ENRICHMENT_JOBS_PER_ATTEMPT, 25, 1, 200,
);
/**
 * How many enriched items share one durable payload checkpoint.
 *
 * Every enrichment item used to rewrite the batch's whole JSONB payload in its
 * own interactive transaction. Measured on the live catalog, that made a full
 * 25-item chunk cost 4.5s per item on a 500-job board and 13.8s per item on a
 * 3,500-job board, against a fixed detail-request cost of about 2.9s -- so the
 * payload rewrite, not the provider, was most of the enrichment budget. It also
 * funneled 25 payload-sized transactions per chunk through the two-wide
 * INGESTION_TRANSACTION_CONCURRENCY semaphore that all four acquisition workers
 * share.
 *
 * The item loop now heartbeats the attempt lease per item (a scalar write) and
 * rewrites the payload once per checkpoint. The chunk boundary always flushes,
 * so durable state at the end of an attempt is byte-for-byte what it was
 * before; the only difference is *within* a chunk, where a crash now replays at
 * most this many detail requests instead of none. Nothing is discarded by that
 * replay -- an already-enriched item is re-fetched, not dropped. Setting this to
 * 1 restores the previous per-item checkpoint exactly.
 */
export const ATS_ENRICHMENT_CHECKPOINT_ITEMS = boundedInteger(
  process.env.ATS_ENRICHMENT_CHECKPOINT_ITEMS, 25, 1, 100,
);
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
const ATS_OBSERVATION_LOOKUP_CHUNK_SIZE = 500;
/**
 * Explicit bounds for ATS transactions whose duration scales with payload size.
 *
 * These rewrite the whole accumulated listing payload, so a large board runs
 * past Prisma's 5s interactive default and dies mid-listing -- observed as
 * "5237 ms passed" on a 2,952-job board, which then left a permanently partial
 * batch. INGESTION_TRANSACTION_CONCURRENCY caps concurrent holders at two, and
 * maxWait matches the pool's own timeout, so this widens no resource ceiling.
 */
const ATS_PAYLOAD_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;
/** Marker writes are small but must not inherit Prisma's implicit 5s bounds. */
const ATS_MARKER_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;
const ATS_INTERNAL_CONTROL_RETRY_MS = 60_000;
const ATS_INTERNAL_CONTROL_RETRY_JITTER_MS = 15_000;

type AtsTransactionPhase =
  | 'request_marker'
  | 'response_marker'
  | 'page_checkpoint'
  | 'item_heartbeat'
  | 'compaction_checkpoint'
  | 'item_checkpoint'
  | 'finalizer';

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
  handoffKind?: 'legacy_batch';
  id: string;
  slug: string;
  platform: string;
  jobs: JsonObject[];
  metadata: JsonObject;
  processingOffset: number;
  totalJobCount: number;
  synchronizedAt: Date | null;
  leaseToken: string;
  /**
   * Payload facts this claim verified against the stored row before handing
   * the chunk over: the payload's own length and its recomputed hash. The
   * completion receipt re-reads the cheap `jobCount` and `payloadHash` columns
   * and requires both to still equal these, which pins the batch to the bytes
   * that were actually processed without detoasting the payload again.
   */
  verifiedPayloadJobCount: number;
  verifiedPayloadHash: string;
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

export type AtsAcquisitionBackpressureTelemetry = AtsAcquisitionBackpressureState & {
  highWatermark: number;
  lowWatermark: number;
  /**
   * The rest of the backlog, reported alongside the gate but deliberately not
   * part of it. `remainingJobs` keeps its exact meaning -- the persistence-stage
   * count the watermarks compare against -- because acquisition-stage jobs must
   * never trip a gate that exists to protect persistence.
   */
  enrichmentJobs: number;
  listingJobs: number;
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

class AtsCompactionCheckpointUncertainError extends Error {
  constructor(readonly recoveryError: unknown) {
    super('ATS prequeue compaction may have committed, but its durable checkpoint could not be verified.');
    this.name = 'AtsCompactionCheckpointUncertainError';
  }
}

class AtsInternalControlError extends Error {
  constructor(
    readonly transactionPhase: AtsTransactionPhase,
    readonly controlError: unknown,
  ) {
    const detail = controlError instanceof Error ? controlError.message : String(controlError);
    super(`ATS internal ${transactionPhase} transaction failed: ${detail}`, { cause: controlError });
    this.name = 'AtsInternalControlError';
  }
}

const atsWorkerOwner = () => `${os.hostname()}:${process.pid}`;

function withAtsTransaction<T>(action: () => Promise<T>): Promise<T> {
  return withIngestionTransactionSlot(action);
}

async function withAtsAcquisitionTransaction<T>(input: {
  transactionPhase: AtsTransactionPhase;
  action: (transaction: Prisma.TransactionClient) => Promise<T>;
  options: typeof ATS_PAYLOAD_TRANSACTION_OPTIONS;
}): Promise<T> {
  try {
    return await withAtsTransaction(() => prisma.$transaction(input.action, input.options));
  } catch (error) {
    if (error instanceof AtsAttemptLeaseLostError) throw error;
    throw new AtsInternalControlError(input.transactionPhase, error);
  }
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

type DurableAtsCompactionCheckpoint = {
  jobs: JsonObject[];
  marker: AtsPrequeueCompactionMarker;
  metadata: JsonObject;
  cursor: AtsAcquisitionCursor;
};

function durableAtsCompactionCheckpoint(
  batch: {
    payload: Prisma.JsonValue | null;
    metadata: Prisma.JsonValue | null;
    cursor: Prisma.JsonValue | null;
    jobCount: number;
  },
  platform: string,
  boardSlug: string,
): DurableAtsCompactionCheckpoint | null {
  const metadata = jsonObject(batch.metadata);
  const marker = readAtsPrequeueCompactionMarker(metadata);
  if (!marker) return null;
  const jobs = jsonJobs(batch.payload);
  const cursor = readAtsAcquisitionCursor(batch.cursor);
  validateAtsPrequeueCompactionCheckpoint({
    marker,
    platform,
    boardSlug,
    listingComplete: cursor.listingComplete,
    payloadJobCount: jobs.length,
    storedJobCount: batch.jobCount,
  });
  return { jobs, marker, metadata, cursor };
}

async function observedAtsSourceStates(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  platform: string,
  jobs: JsonObject[],
): Promise<AtsObservedSourceState[]> {
  const sourceIds = Array.from(new Set(
    jobs.map((job) => atsListingSourceId(platform, job)).filter((value): value is string => Boolean(value)),
  )).sort();
  const observations: AtsObservedSourceState[] = [];
  for (let offset = 0; offset < sourceIds.length; offset += ATS_OBSERVATION_LOOKUP_CHUNK_SIZE) {
    const chunk = sourceIds.slice(offset, offset + ATS_OBSERVATION_LOOKUP_CHUNK_SIZE);
    const rows = await client.$queryRaw<Array<{
      sourceId: string;
      jobId: string;
      jobStatus: string | null;
      jobUpdatedAt: Date | string;
      observationUrl: string | null;
    }>>(Prisma.sql`
      SELECT
        observation."sourceId" AS "sourceId",
        observation."jobId" AS "jobId",
        job."status" AS "jobStatus",
        job."updatedAt" AS "jobUpdatedAt",
        observation."url" AS "observationUrl"
      FROM "JobSourceObservation" observation
      INNER JOIN "Job" job ON job."id" = observation."jobId"
      WHERE observation."source" = ${`ATS-${platform}`}
        AND observation."sourceId" IN (${Prisma.join(chunk)})
      ORDER BY observation."sourceId" ASC, observation."jobId" ASC
      FOR SHARE OF job
    `);
    observations.push(...rows.map((row) => ({
      sourceId: row.sourceId,
      jobId: row.jobId,
      jobStatus: row.jobStatus,
      jobUpdatedAt: new Date(row.jobUpdatedAt).toISOString(),
      boardSlug: boardSlugFromJobUrl(row.observationUrl, platform),
    })));
  }
  return observations;
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

export function atsListingPageSize(platform: string): number | null {
  if (platform === 'workday') return WORKDAY_PAGE_SIZE;
  if (platform === 'smartrecruiters') return SMARTRECRUITERS_PAGE_SIZE;
  return null;
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

export function isAtsTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'TimeoutError' || /timeout|timed out|abort/i.test(message);
}

export function isAtsProviderWideError(error: unknown): boolean {
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

export async function fetchAtsBoardPage(
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
    where: {
      slug: board.slug,
      platform: board.platform,
      writerMode: 'legacy',
      status: { in: ['fetching', 'partial'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;
  try {
    return await prisma.atsIngestionBatch.create({
      data: {
        slug: board.slug,
        platform: board.platform,
        writerMode: 'legacy',
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
      where: {
        slug: board.slug,
        platform: board.platform,
        writerMode: 'legacy',
        status: { in: ['fetching', 'partial'] },
      },
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

export function nextAtsInternalControlRetryAt(now: Date, jitterKey = ''): Date {
  let hash = 0;
  for (const character of jitterKey) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  const jitter = jitterKey ? hash % (ATS_INTERNAL_CONTROL_RETRY_JITTER_MS + 1) : 0;
  return new Date(now.getTime() + ATS_INTERNAL_CONTROL_RETRY_MS + jitter);
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
  if (atsBoardIngestionExclusion(board)) {
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
  const initialCursor = readAtsAcquisitionCursor(batch.cursor);
  const workKind = !initialCursor.listingComplete
    ? batch.pageCount === 0 ? 'coverage_listing' : 'listing_continuation'
    : 'enrichment';
  const leaseOwner = atsWorkerOwner();
  let attempt: Awaited<ReturnType<typeof prisma.atsBoardCheckAttempt.create>>;
  try {
    attempt = await prisma.atsBoardCheckAttempt.create({
      data: {
        slug: board.slug,
        platform: board.platform,
        batchId: batch.id,
        workKind,
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
  let fetchedJobCount = jobs.length;
  let compactionMarker: AtsPrequeueCompactionMarker | null = null;
  const batchHasProcessingProgress = atsBatchHasProcessingProvenance(batch);
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
    await withAtsAcquisitionTransaction({
      transactionPhase: 'request_marker',
      options: ATS_MARKER_TRANSACTION_OPTIONS,
      action: async (transaction) => {
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
      },
    });
    requestCount = nextRequestCount;
  };

  const onResponseReceived = async (input: { status: number; respondedAt: Date }) => {
    const responseState = advanceAtsResponseState({
      batchRespondedAt,
      attemptRespondedAt,
      responseAt: input.respondedAt,
    });
    await withAtsAcquisitionTransaction({
      transactionPhase: 'response_marker',
      options: ATS_MARKER_TRANSACTION_OPTIONS,
      action: async (transaction) => {
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
      },
    });
    httpStatus = input.status;
    batchRespondedAt = responseState.batchRespondedAt;
    attemptRespondedAt = responseState.attemptRespondedAt;
  };

  const finalizePartialAttempt = async (now: Date, lastError: string) => {
    await withAtsAcquisitionTransaction({
      transactionPhase: 'finalizer',
      options: ATS_PAYLOAD_TRANSACTION_OPTIONS,
      action: async (transaction) => {
        const lease = await transaction.atsBoardCheckAttempt.updateMany({
          where: { id: attempt.id, outcome: 'running', leaseOwner },
          data: {
            outcome: 'partial',
            httpStatus,
            requestCount,
            pageCount,
            jobCount: fetchedJobCount,
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
      },
    });
  };

  try {
    compactionMarker = readAtsPrequeueCompactionMarker(metadata);
    if (compactionMarker) {
      validateAtsPrequeueCompactionCheckpoint({
        marker: compactionMarker,
        platform: board.platform,
        boardSlug: board.slug,
        listingComplete: cursor.listingComplete,
        payloadJobCount: jobs.length,
        storedJobCount: batch.jobCount,
      });
      fetchedJobCount = compactionMarker.fetchedJobCount;
    }
    const pageLimit = paginated ? ATS_ACQUISITION_PAGES_PER_ATTEMPT : 1;
    for (let page = 0; !cursor.listingComplete && page < pageLimit; page++) {
      if (signal?.aborted) throw signal.reason || new Error('ATS acquisition interrupted');
      const offset = paginated ? cursor.offset : 0;
      const result = await fetchAtsBoardPage(
        board,
        offset,
        signal,
        onRequestStarted,
        onResponseReceived,
      );
      pageCount++;
      metadata = { ...metadata, ...result.metadata };
      jobs.push(...result.jobs);
      fetchedJobCount = jobs.length;

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
      await withAtsAcquisitionTransaction({
        transactionPhase: 'page_checkpoint',
        options: ATS_PAYLOAD_TRANSACTION_OPTIONS,
        action: async (transaction) => {
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
        },
      });
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
    await withAtsAcquisitionTransaction({
      transactionPhase: 'page_checkpoint',
      options: ATS_PAYLOAD_TRANSACTION_OPTIONS,
      action: async (transaction) => {
        const lease = await transaction.atsBoardCheckAttempt.updateMany({
          where: { id: attempt.id, outcome: 'running', leaseOwner },
          data: {
            pageCount,
            jobCount: fetchedJobCount,
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
      },
    });

    if (!compactionMarker) {
      // A legacy batch may have been returned from processing to acquisition
      // for enrichment repair. Its payload ordinals already own durable audit
      // meaning, so checkpoint a no-op plan instead of removing any prefix.
      let checkpoint: DurableAtsCompactionCheckpoint;
      try {
        checkpoint = await withProviderTransactionRetry(() =>
          withAtsAcquisitionTransaction({
            transactionPhase: 'compaction_checkpoint',
            options: ATS_PAYLOAD_TRANSACTION_OPTIONS,
            action: async (transaction) => {
            // A retry after an uncertain commit must adopt the checkpoint that
            // already won instead of creating a second telemetry receipt.
            const durableBatch = await transaction.atsIngestionBatch.findUniqueOrThrow({
              where: { id: batch.id },
              select: { payload: true, metadata: true, cursor: true, jobCount: true },
            });
            const existingCheckpoint = durableAtsCompactionCheckpoint(
              durableBatch,
              board.platform,
              board.slug,
            );
            if (existingCheckpoint) return existingCheckpoint;

            // Lock every matched Job through the checkpoint. A lifecycle
            // change cannot race the decision and accidentally omit a newly
            // active row from this board cycle.
            const observations = batchHasProcessingProgress
              ? []
              : await observedAtsSourceStates(transaction, board.platform, jobs);
            const plan = planAtsPrequeueCompaction({
              platform: board.platform,
              boardSlug: board.slug,
              jobs,
              observations,
            });
            const compactedAt = new Date();
            const nextMarker: AtsPrequeueCompactionMarker = {
              ...plan.marker,
              completedAt: compactedAt.toISOString(),
            };
            const nextMetadata = {
              ...metadata,
              [ATS_PREQUEUE_COMPACTION_METADATA_KEY]: nextMarker,
            };
            const nextCursor = {
              ...cursor,
              enrichmentOffset: currentAtsEnrichmentPrefix(plan.jobs, board.platform),
              enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
            };
            const lease = await transaction.atsBoardCheckAttempt.updateMany({
              where: { id: attempt.id, outcome: 'running', leaseOwner },
              data: {
                jobCount: nextMarker.fetchedJobCount,
                heartbeatAt: compactedAt,
                leaseExpiresAt: new Date(compactedAt.getTime() + ATS_ACQUISITION_ATTEMPT_LEASE_MS),
              },
            });
            if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
            await transaction.atsIngestionBatch.update({
              where: { id: batch.id },
              data: {
                payload: plan.jobs as Prisma.InputJsonValue,
                metadata: nextMetadata as Prisma.InputJsonValue,
                cursor: nextCursor as unknown as Prisma.InputJsonValue,
                jobCount: plan.jobs.length,
                heartbeatAt: compactedAt,
              },
            });
            if (nextMarker.prequeueExactDuplicateCount > 0) {
              await recordJobPipelineEvent({
                eventType: 'duplicate',
                stage: 'ingestion',
                source: `ATS-${board.platform}`,
                details: {
                  reason: 'prequeue_exact_source_compaction',
                  atsBatchId: batch.id,
                  fetchedJobCount: nextMarker.fetchedJobCount,
                  queuedJobCount: nextMarker.queuedJobCount,
                  prequeueExactDuplicateCount: nextMarker.prequeueExactDuplicateCount,
                  compactedIdentityHash: nextMarker.compactedIdentityHash,
                },
                occurredAt: compactedAt,
                identityParts: [batch.id, 'prequeue_exact_source_compaction_v1'],
              }, transaction);
              // Preserve the existing ingestion-funnel denominator with one
              // aggregate run receipt rather than one downstream transaction
              // per known duplicate. Its counters reconcile exactly.
              await transaction.ingestionSourceRun.upsert({
                where: { id: `ats-prequeue:${batch.id}` },
                update: {},
                create: {
                  id: `ats-prequeue:${batch.id}`,
                  source: `ATS-${board.platform}`,
                  status: 'success',
                  seenCount: nextMarker.prequeueExactDuplicateCount,
                  duplicateCount: nextMarker.prequeueExactDuplicateCount,
                  reconciled: true,
                  ingestionMode: 'ats_prequeue_compaction',
                  watermarkAt: compactedAt,
                  checkpoint: {
                    phase: 'prequeue_compaction',
                    atsBatchId: batch.id,
                    fetchedJobCount: nextMarker.fetchedJobCount,
                    queuedJobCount: nextMarker.queuedJobCount,
                    compactedIdentityHash: nextMarker.compactedIdentityHash,
                  },
                  startedAt,
                  finishedAt: compactedAt,
                  durationMs: compactedAt.getTime() - startedAt.getTime(),
                },
              });
            }
            return {
              jobs: plan.jobs,
              marker: nextMarker,
              metadata: nextMetadata,
              cursor: nextCursor,
            };
            },
          }),
        );
      } catch (error) {
        // A dropped connection can hide a successful commit from this process.
        // Re-read before the generic error finalizer gets any chance to write
        // the old raw payload back over the durable compacted checkpoint.
        let durableBatch: {
          payload: Prisma.JsonValue | null;
          metadata: Prisma.JsonValue | null;
          cursor: Prisma.JsonValue | null;
          jobCount: number;
        } | null;
        try {
          durableBatch = await prisma.atsIngestionBatch.findUnique({
            where: { id: batch.id },
            select: { payload: true, metadata: true, cursor: true, jobCount: true },
          });
        } catch (recoveryError) {
          throw new AtsCompactionCheckpointUncertainError(recoveryError);
        }
        let recovered: DurableAtsCompactionCheckpoint | null;
        try {
          recovered = durableBatch
            ? durableAtsCompactionCheckpoint(durableBatch, board.platform, board.slug)
            : null;
        } catch (recoveryError) {
          throw new AtsCompactionCheckpointUncertainError(recoveryError);
        }
        if (!recovered) throw error;
        checkpoint = recovered;
      }
      compactionMarker = checkpoint.marker;
      fetchedJobCount = compactionMarker.fetchedJobCount;
      jobs.splice(0, jobs.length, ...checkpoint.jobs);
      metadata = checkpoint.metadata;
      cursor = checkpoint.cursor;
    }

    const enrichmentLimit = planAtsEnrichmentChunk(
      cursor.enrichmentOffset,
      jobs.length,
    ).end;

    // Resolve the whole bounded chunk's no-request outcomes before the first
    // detail call. This preserves provider order and the prefix cursor while
    // replacing up to 25 marker-only heartbeats/checkpoints with one fenced
    // payload write. Detail-required items remain untouched and still pass
    // through the normal request/response receipt boundary below.
    const markerChunkStart = cursor.enrichmentOffset;
    const markerChunk = markAtsListingsWithoutDetail({
      platform: board.platform,
      slug: board.slug,
      jobs: jobs.slice(markerChunkStart, enrichmentLimit),
    });
    if (markerChunk.markedCount > 0) {
      jobs.splice(markerChunkStart, markerChunk.jobs.length, ...markerChunk.jobs);
      cursor = {
        ...cursor,
        enrichmentOffset: Math.min(
          enrichmentLimit,
          currentAtsEnrichmentPrefix(jobs, board.platform),
        ),
        enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
      };
      const markersPersistedAt = new Date();
      const markerCheckpointCursor = cursor;
      await withAtsAcquisitionTransaction({
        transactionPhase: 'item_checkpoint',
        options: ATS_PAYLOAD_TRANSACTION_OPTIONS,
        action: async (transaction) => {
          const lease = await transaction.atsBoardCheckAttempt.updateMany({
            where: { id: attempt.id, outcome: 'running', leaseOwner },
            data: {
              requestCount,
              jobCount: fetchedJobCount,
              heartbeatAt: markersPersistedAt,
              leaseExpiresAt: new Date(
                markersPersistedAt.getTime() + ATS_ACQUISITION_ATTEMPT_LEASE_MS,
              ),
            },
          });
          if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
          await transaction.atsIngestionBatch.update({
            where: { id: batch.id },
            data: {
              payload: jobs as Prisma.InputJsonValue,
              cursor: markerCheckpointCursor as unknown as Prisma.InputJsonValue,
              jobCount: jobs.length,
              heartbeatAt: markersPersistedAt,
            },
          });
        },
      });
    }

    // Items enriched in memory whose payload rewrite is still pending. The
    // durable cursor never runs ahead of the durable payload: both advance
    // together inside the checkpoint transaction below.
    let unflushedEnrichedItems = 0;
    let durableEnrichmentOffset = cursor.enrichmentOffset;
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
      let nextEnrichmentOffset = jobIndex + 1;
      while (
        nextEnrichmentOffset < enrichmentLimit
        && hasCurrentAtsJobEnrichment(jobs[nextEnrichmentOffset], board.platform)
      ) {
        nextEnrichmentOffset++;
      }
      cursor = {
        ...cursor,
        enrichmentOffset: nextEnrichmentOffset,
        enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
      };

      // The payload replacement and its cursor advance share one transaction, so
      // the durable cursor can never claim an item the durable payload lacks. A
      // crash between a response and the next checkpoint replays at most
      // ATS_ENRICHMENT_CHECKPOINT_ITEMS detail requests and drops nothing.
      // Network results between checkpoints pay only a scalar lease heartbeat;
      // marker-only results already shared the bounded checkpoint above.
      unflushedEnrichedItems += nextEnrichmentOffset - jobIndex;
      const enrichedAt = new Date();
      const checkpointDue = unflushedEnrichedItems >= ATS_ENRICHMENT_CHECKPOINT_ITEMS
        || cursor.enrichmentOffset >= enrichmentLimit;
      const leaseData = {
        requestCount,
        jobCount: fetchedJobCount,
        heartbeatAt: enrichedAt,
        leaseExpiresAt: new Date(enrichedAt.getTime() + ATS_ACQUISITION_ATTEMPT_LEASE_MS),
      };
      if (!checkpointDue) {
        await withAtsAcquisitionTransaction({
          transactionPhase: 'item_heartbeat',
          options: ATS_MARKER_TRANSACTION_OPTIONS,
          action: async (transaction) => {
            const lease = await transaction.atsBoardCheckAttempt.updateMany({
              where: { id: attempt.id, outcome: 'running', leaseOwner },
              data: leaseData,
            });
            if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
          },
        });
        continue;
      }
      const checkpointCursor = cursor;
      await withAtsAcquisitionTransaction({
        transactionPhase: 'item_checkpoint',
        options: ATS_PAYLOAD_TRANSACTION_OPTIONS,
        action: async (transaction) => {
          const lease = await transaction.atsBoardCheckAttempt.updateMany({
            where: { id: attempt.id, outcome: 'running', leaseOwner },
            data: leaseData,
          });
          if (lease.count !== 1) throw new AtsAttemptLeaseLostError(attempt.id);
          await transaction.atsIngestionBatch.update({
            where: { id: batch.id },
            data: {
              payload: jobs as Prisma.InputJsonValue,
              cursor: checkpointCursor as unknown as Prisma.InputJsonValue,
              jobCount: jobs.length,
              heartbeatAt: enrichedAt,
            },
          });
        },
      });
      unflushedEnrichedItems = 0;
      durableEnrichmentOffset = checkpointCursor.enrichmentOffset;
    }
    if (unflushedEnrichedItems > 0) {
      throw new Error(
        `ATS-${board.platform} enrichment left ${unflushedEnrichedItems} item(s) past the durable cursor at offset ${durableEnrichmentOffset}.`,
      );
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
        jobCount: fetchedJobCount,
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
    const processingCompleteAtSynchronization = jobs.length === 0;
    await withAtsAcquisitionTransaction({
      transactionPhase: 'finalizer',
      options: ATS_PAYLOAD_TRANSACTION_OPTIONS,
      action: async (transaction) => {
      const lease = await transaction.atsBoardCheckAttempt.updateMany({
        where: { id: attempt.id, outcome: 'running', leaseOwner },
        data: {
          outcome: 'synchronized',
          httpStatus,
          requestCount,
          pageCount,
          jobCount: fetchedJobCount,
          respondedAt: attemptRespondedAt,
          synchronizedAt,
          ...(processingCompleteAtSynchronization ? { processedAt: synchronizedAt } : {}),
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
          status: processingCompleteAtSynchronization ? 'processed' : 'queued',
          payload: processingCompleteAtSynchronization
            ? Prisma.DbNull
            : jobs as Prisma.InputJsonValue,
          payloadHash: payloadHash(metadata, jobs),
          metadata: metadata as Prisma.InputJsonValue,
          cursor: cursor as unknown as Prisma.InputJsonValue,
          jobCount: jobs.length,
          ...(processingCompleteAtSynchronization ? { processedAt: synchronizedAt } : {}),
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
          ...(processingCompleteAtSynchronization ? { lastProcessedAt: synchronizedAt } : {}),
          jobsFound: fetchedJobCount,
        },
      });
      },
    });
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
      jobCount: fetchedJobCount,
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
        jobCount: fetchedJobCount,
        responded: false,
      };
    }
    const now = new Date();
    if (error instanceof AtsCompactionCheckpointUncertainError) {
      // Never let an uncertain commit fall through to a batch finalizer that
      // carries the old raw in-memory payload. Release only this attempt; the
      // next turn will adopt whichever durable batch checkpoint actually won.
      const message = error.message.slice(0, 1000);
      const finalized = await prisma.atsBoardCheckAttempt.updateMany({
        where: { id: attempt.id, outcome: 'running', leaseOwner },
        data: {
          outcome: 'interrupted',
          httpStatus,
          requestCount,
          pageCount,
          jobCount: fetchedJobCount,
          respondedAt: attemptRespondedAt,
          heartbeatAt: now,
          leaseExpiresAt: null,
          finishedAt: now,
          durationMs: now.getTime() - startedAt.getTime(),
          transactionPhase: 'compaction_checkpoint',
          failureScope: 'internal_control',
          error: message,
        },
      }).then((result) => result.count === 1).catch(() => false);
      return {
        attemptId: attempt.id,
        batchId: batch.id,
        outcome: 'interrupted',
        requestCount,
        pageCount,
        jobCount: fetchedJobCount,
        responded: finalized && Boolean(attemptRespondedAt),
      };
    }
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
            jobCount: fetchedJobCount,
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
      }, ATS_PAYLOAD_TRANSACTION_OPTIONS));
      return {
        attemptId: attempt.id,
        batchId: batch.id,
        outcome: 'interrupted',
        requestCount,
        pageCount,
        jobCount: fetchedJobCount,
        responded: finalized && Boolean(attemptRespondedAt),
      };
    }
    const internalControl = error instanceof AtsInternalControlError;
    const throttled = error instanceof RateLimitedError;
    const deferred = error instanceof AtsProviderBlockedError || error instanceof AtsPlatformDeferredError;
    const hadResponse = Boolean(attemptRespondedAt);
    const hasDurableProgress = batch.status === 'partial'
      || batch.pageCount > 0
      || pageCount > 0
      || jobs.length > 0
      || cursor.offset > 0;
    const outcome: AtsAcquisitionOutcome = internalControl
      ? 'error'
      : throttled
      ? 'throttled'
      : deferred ? 'deferred' : isAtsTimeoutError(error) ? 'timeout' : 'error';
    const message = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
    const boardUpdate = internalControl
      ? { nextCheckDate: nextAtsInternalControlRetryAt(now, attempt.id) }
      : error instanceof AtsPlatformDeferredError
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
          jobCount: fetchedJobCount,
          respondedAt: attemptRespondedAt,
          heartbeatAt: now,
          leaseExpiresAt: null,
          finishedAt: now,
          durationMs: now.getTime() - startedAt.getTime(),
          transactionPhase: internalControl ? error.transactionPhase : null,
          failureScope: internalControl
            ? 'internal_control'
            : throttled || deferred ? 'provider_control' : 'provider',
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
    }, ATS_PAYLOAD_TRANSACTION_OPTIONS));
    if (!finalized) {
      return {
        attemptId: attempt.id,
        batchId: batch.id,
        outcome: 'interrupted',
        requestCount,
        pageCount,
        jobCount: fetchedJobCount,
        responded: false,
      };
    }
    if (!internalControl && !throttled && !deferred && isAtsProviderWideError(error)
      && !(error instanceof AtsProviderFailureRecordedError)) {
      await recordProviderFailure({ provider: `ATS-${board.platform}`, error }).catch((controlError) => {
        console.error(`Failed to persist ATS-${board.platform} provider failure:`, controlError);
      });
    }
    return { attemptId: attempt.id, batchId: batch.id, outcome, requestCount, pageCount, jobCount: fetchedJobCount, responded: hadResponse };
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
/**
 * Batches whose jobs are actually waiting on the persistence side of the split.
 * A fetching/partial batch is still listing, so its processingOffset is zero by
 * construction and every job it has listed would read as downstream pressure
 * before anything downstream has been handed the work.
 */
const PROCESSING_BACKLOG_BATCH_STATUSES = ['queued', 'processing'] as const;

/**
 * Materialize explicit product exclusions without deleting retained payloads.
 * This runs before backlog measurement so an excluded board cannot hold the
 * acquisition loop in backpressure after a restart.
 */
export async function reconcileAtsIngestionExclusions(
  now: Date = new Date(),
): Promise<{ boards: number; batches: number; attempts: number }> {
  const reconciled = { boards: 0, batches: 0, attempts: 0 };
  for (const excluded of ATS_INGESTION_EXCLUDED_BOARDS) {
    const result = await withAtsTransaction(() => prisma.$transaction(async (transaction) => {
      const attempts = await transaction.atsBoardCheckAttempt.updateMany({
        where: {
          slug: { equals: excluded.slug, mode: 'insensitive' },
          platform: { equals: excluded.platform, mode: 'insensitive' },
          outcome: 'running',
          board: { acquisitionEngine: 'legacy' },
        },
        data: {
          outcome: 'interrupted',
          leaseOwner: null,
          heartbeatAt: now,
          leaseExpiresAt: null,
          finishedAt: now,
          error: excluded.reason,
        },
      });
      const batches = await transaction.atsIngestionBatch.updateMany({
        where: {
          slug: { equals: excluded.slug, mode: 'insensitive' },
          platform: { equals: excluded.platform, mode: 'insensitive' },
          writerMode: 'legacy',
          status: { in: [...OUTSTANDING_BATCH_STATUSES] },
        },
        data: {
          status: 'excluded',
          nextProcessAt: null,
          leaseToken: null,
          leaseOwner: null,
          leaseStartedAt: null,
          heartbeatAt: now,
          leaseExpiresAt: null,
          lastError: excluded.reason,
        },
      });
      const boards = await transaction.atsCompany.updateMany({
        where: {
          slug: { equals: excluded.slug, mode: 'insensitive' },
          platform: { equals: excluded.platform, mode: 'insensitive' },
          acquisitionEngine: 'legacy',
          status: { not: 'excluded' },
        },
        data: { status: 'excluded' },
      });
      return { boards: boards.count, batches: batches.count, attempts: attempts.count };
    }));
    reconciled.boards += result.boards;
    reconciled.batches += result.batches;
    reconciled.attempts += result.attempts;
  }
  return reconciled;
}
const atsBoardSelection = {
  slug: true,
  platform: true,
  status: true,
  failCount: true,
  retryCount: true,
  checkDay: true,
} as const;

/**
 * The share of one turn's board slots continuations may hold.
 *
 * Resumption used to take the whole turn. That is correct for *capacity* -- a
 * resumed board adds no outstanding batch -- but a turn has a second scarce
 * resource the capacity cap never modeled: its board slots. A board mid-
 * enrichment costs tens of seconds per attempt while a fresh board synchronizes
 * in about nine, so once the catalog holds a full turn's worth of partial
 * batches, continuations set both the turn's length and its composition, and
 * new-board throughput stops responding to free capacity.
 *
 * Reserving the majority of each turn for new boards shortens the turn enough
 * that continuations still receive as many attempts per day as they did when
 * they owned every slot -- they are spread over more, faster turns rather than
 * withheld. No partial batch is dropped, deprioritized across days, or made
 * ineligible; only its share of any single turn is bounded.
 */
export const ATS_RESUME_SELECTION_SHARE = Math.min(1, Math.max(0, Number.parseFloat(
  process.env.ATS_RESUME_SELECTION_SHARE || '0.35',
) || 0.35));

/**
 * Slots continuations may take this turn.
 *
 * Under backpressure new boards are barred entirely, so there is no new-board
 * work to protect and resumption keeps the full turn -- draining durable
 * payloads is then the only way out of backpressure. At least one slot is
 * always reserved for resumption so a partial batch can never be frozen.
 */
export function atsResumeSelectionLimit(
  selectionLimit: number,
  allowNewBatches?: boolean,
): number {
  const limit = Math.max(0, Math.floor(selectionLimit));
  if (limit === 0) return 0;
  if (allowNewBatches === false) return limit;
  return Math.min(limit, Math.max(1, Math.round(limit * ATS_RESUME_SELECTION_SHARE)));
}

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
    // Resuming does not add an outstanding batch, so the queue cap never bounds
    // it. Its own share of the turn's board slots does.
    resumeLimit: atsResumeSelectionLimit(selectionLimit, input.allowNewBatches),
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
    platformBoards.flat().filter(isAtsBoardEnabledForIngestion),
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
      acquisitionEngine: 'legacy',
      status: { in: [...ATS_ROTATION_STATUSES] },
      nextCheckDate: { lte: now },
      checkDay: today,
    },
    {
      acquisitionEngine: 'legacy',
      status: { in: [...ATS_ROTATION_STATUSES] },
      nextCheckDate: { lte: now },
      checkDay: { not: today },
      OR: [
        { lastCheckedAt: null },
        { lastCheckedAt: { lt: atsRotationCycleCutoff(now) } },
      ],
    },
    {
      acquisitionEngine: 'legacy',
      status: { in: [...ATS_RECOVERY_STATUSES] },
      nextCheckDate: { lte: now },
    },
  ];
  const rotationSeed = Math.floor(now.getTime() / 86_400_000);

  // Drain durable partial/fetching payloads. This priority is global; within
  // the resume phase, assigned-day, catch-up, and recovery tiers remain strict,
  // and each tier rotates fairly across ATS platforms.
  const appendResumableBoards = async (capacity: number) => {
    let resumeCapacity = Math.min(capacity, remaining());
    for (let tierIndex = 0; tierIndex < tiers.length && resumeCapacity > 0; tierIndex++) {
      const appended = append(await fairBoardsForTier({
        AND: [
          tiers[tierIndex],
          {
            ingestionBatches: { some: {
              writerMode: 'legacy',
              status: { in: [...ACTIVE_ACQUISITION_BATCH_STATUSES] },
            } },
          },
          ...(selected.length > 0
            ? [{ NOT: { OR: selected.map((row) => ({ slug: row.slug, platform: row.platform })) } }]
            : []),
        ],
      }, resumeCapacity, rotationSeed + tierIndex), resumeCapacity);
      resumeCapacity -= appended;
    }
  };

  // Resumption keeps its first claim on the turn but no longer keeps every slot
  // in it.
  await appendResumableBoards(atsResumeSelectionLimit(take, options.allowNewBatches));

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
        {
          ingestionBatches: { none: {
            status: { in: [...ACTIVE_ACQUISITION_BATCH_STATUSES] },
          } },
        },
      ],
    }, newCapacity, rotationSeed + tiers.length + tierIndex), newCapacity);
    newCapacity -= appended;
  }

  // Capacity the new-board tiers could not use belongs back to resumption. The
  // share above is a floor under new-board throughput, not a ceiling on drain:
  // when the day's cohort is exhausted or the queue cap is full, continuations
  // reclaim the whole turn exactly as they did before.
  if (remaining() > 0) await appendResumableBoards(remaining());
  return selected;
}

export async function atsQueueDepth(): Promise<number> {
  return prisma.atsIngestionBatch.count({
    where: {
      writerMode: 'legacy',
      status: { in: [...PROCESSING_BACKLOG_BATCH_STATUSES] },
    },
  });
}

/**
 * Job backpressure protects the persistence stage, so it measures only the
 * processing backlog. Acquisition-stage payload growth is bounded separately
 * by ATS_ACQUISITION_QUEUE_LIMIT, which caps outstanding batches by count --
 * the bound that can survive a single board larger than the whole watermark.
 */
export async function atsOutstandingJobCount(): Promise<number> {
  const outstanding = await prisma.atsIngestionBatch.aggregate({
    where: {
      writerMode: 'legacy',
      status: { in: [...PROCESSING_BACKLOG_BATCH_STATUSES] },
    },
    _sum: { jobCount: true, processingOffset: true },
  });
  return Math.max(
    0,
    (outstanding._sum.jobCount || 0) - (outstanding._sum.processingOffset || 0),
  );
}

/**
 * Where ATS work is actually queued, split by the stage that owns it.
 *
 * The backpressure gate measures only `persistenceJobs`, and that number is
 * structurally small -- the persistence stage keeps up. Reported alone it reads
 * reassuring at exactly the moment acquisition is choking on its own listing and
 * enrichment backlog, which is where jobs really accumulate. These three sums are
 * the honest picture of one board-payload lifecycle:
 *
 *   listing     -> pagination is not finished; more pages are still to come
 *   enrichment  -> listing is complete, per-posting detail is still being fetched
 *   persistence -> the payload is synchronized and awaiting downstream job writes
 *
 * One scan, three columns, so the loop pays no extra round trip for the detail.
 * `cursor` is a separate small JSONB column from `payload`; reading it here does
 * not detoast a board's payload the way selecting `payload` would.
 */
export type AtsBacklogSnapshot = {
  persistenceJobs: number;
  enrichmentJobs: number;
  listingJobs: number;
};

export async function atsBacklogSnapshot(): Promise<AtsBacklogSnapshot> {
  const [row] = await prisma.$queryRaw<Array<{
    persistenceJobs: bigint;
    enrichmentJobs: bigint;
    listingJobs: bigint;
  }>>`
    SELECT
      COALESCE(SUM(GREATEST(batch."jobCount" - batch."processingOffset", 0))
        FILTER (WHERE batch.status IN ('queued', 'processing')), 0)::bigint AS "persistenceJobs",
      COALESCE(SUM(GREATEST(
        batch."jobCount" - CASE
          WHEN batch.cursor ->> 'enrichmentOffset' ~ '^[0-9]+$'
            THEN (batch.cursor ->> 'enrichmentOffset')::bigint
          ELSE 0
        END, 0))
        FILTER (WHERE batch.status IN ('fetching', 'partial')
          AND batch.cursor ->> 'listingComplete' = 'true'), 0)::bigint AS "enrichmentJobs",
      COALESCE(SUM(GREATEST(batch."jobCount", 0))
        FILTER (WHERE batch.status IN ('fetching', 'partial')
          AND COALESCE(batch.cursor ->> 'listingComplete', 'false') <> 'true'), 0)::bigint AS "listingJobs"
    FROM "AtsIngestionBatch" batch
    WHERE batch."writerMode" = 'legacy'
      AND batch.status IN ('queued', 'processing', 'fetching', 'partial')
  `;
  const count = (value: bigint | null | undefined) => Math.max(0, Number(value ?? 0));
  return {
    persistenceJobs: count(row?.persistenceJobs),
    enrichmentJobs: count(row?.enrichmentJobs),
    listingJobs: count(row?.listingJobs),
  };
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
    writerMode: 'legacy',
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
          writerMode: 'legacy',
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
    // Only the id is needed to attempt the claim. Selecting every column here
    // detoasted the whole payload a second time for each 25-job chunk.
    select: { id: true },
    where: {
      writerMode: 'legacy',
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
      writerMode: 'legacy',
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
  const computedPayloadHash = payloadHash(jsonObject(batch.metadata), allJobs);
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
      : !batch.payloadHash || computedPayloadHash !== batch.payloadHash
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
    verifiedPayloadJobCount: allJobs.length,
    verifiedPayloadHash: computedPayloadHash,
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
      writerMode: 'legacy',
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
      writerMode: 'legacy',
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
  /** Payload facts `claimNextAtsIngestionBatch` verified for this lease. */
  verifiedPayloadJobCount: number;
  verifiedPayloadHash: string;
  interrupted?: boolean;
  fatalError?: string | null;
  error?: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now || new Date();
  // The payload is deliberately not selected. Reading it here detoasted the
  // whole board a third time for every 25-job chunk — about 80MB of reads and
  // 30 full canonical-JSON hashes to persist one 364-job board. The claim
  // already hashed those exact bytes under this lease; the scalar `jobCount`
  // and `payloadHash` columns re-read below are compared against that receipt
  // and pinned in every write's WHERE clause, so drift still fails closed.
  const batch = await prisma.atsIngestionBatch.findFirst({
    where: {
      id: input.batchId,
      writerMode: 'legacy',
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
      payloadHash: true,
      insertedCount: true,
      duplicateCount: true,
      filteredCount: true,
      processingErrorCount: true,
    },
  });
  if (!batch) return false;
  if (batch.payloadHash !== input.verifiedPayloadHash
    || batch.jobCount !== input.verifiedPayloadJobCount) {
    return releaseAtsProcessingLeaseForRetry({
      batchId: input.batchId,
      leaseToken: input.leaseToken,
      processingAttemptCount: batch.processingAttemptCount,
      error: 'ATS batch payload changed between its processing claim and completion.',
      now,
    });
  }
  const payloadJobCount = input.verifiedPayloadJobCount;
  const claimedJobCount = Math.min(
    ATS_BATCH_PROCESSING_CHUNK_SIZE,
    Math.max(0, payloadJobCount - batch.processingOffset),
  );
  const turn = planAtsProcessingTurn({
    currentOffset: batch.processingOffset,
    storedJobCount: batch.jobCount,
    payloadJobCount,
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
        writerMode: 'legacy',
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
        writerMode: 'legacy',
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
    payloadJobCount,
    storedPayloadHash: batch.payloadHash,
    computedPayloadHash: input.verifiedPayloadHash,
    // The claim rejects a null payload before handing over a chunk, and the
    // hash equality checked above proves this is still that same payload.
    payloadPresent: true,
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
        writerMode: 'legacy',
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
      writerMode: 'legacy',
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
