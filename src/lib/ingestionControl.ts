import crypto from 'node:crypto';
import os from 'node:os';
import { Prisma, type IngestionTask, type JobPipelineEvent } from '@prisma/client';
import { prisma } from './prisma';

export const JOB_PIPELINE_EVENT_TYPES = [
  'ingested',
  'prefilter_rejected',
  'jd_ready',
  'jd_failed',
  'local_pass',
  'local_reject',
  'ae_pass',
  'ae_reject',
  'user_promote',
  'user_reject',
  'user_lifecycle',
  'user_rescore',
  'duplicate',
  'processing_error',
  'provider_request',
  'score_invalidated',
  'score_replay_queued',
] as const;

export type JobPipelineEventType = typeof JOB_PIPELINE_EVENT_TYPES[number];

export type IngestionCounters = {
  seen: number;
  inserted: number;
  duplicates: number;
  filtered: number;
  processingErrors: number;
  providerErrors: number;
  requests?: number;
};

export const EMPTY_INGESTION_COUNTERS: IngestionCounters = Object.freeze({
  seen: 0,
  inserted: 0,
  duplicates: 0,
  filtered: 0,
  processingErrors: 0,
  providerErrors: 0,
  requests: 0,
});

export function ingestionOutcomes(counts: IngestionCounters): number {
  return counts.inserted + counts.duplicates + counts.filtered + counts.processingErrors;
}

export function ingestionReconciles(counts: IngestionCounters): boolean {
  return counts.seen === ingestionOutcomes(counts);
}

export type IngestionTaskCompletionStatus = 'succeeded' | 'partial' | 'failed' | 'blocked_budget' | 'blocked_circuit' | 'disabled';

export function classifyIngestionTaskCompletion(input: {
  sourceStatuses: readonly ('success' | 'partial' | 'failed' | 'idle')[];
  lastErrors?: readonly (string | null)[];
  circuitOpen?: boolean;
}): IngestionTaskCompletionStatus {
  if (input.sourceStatuses.length === 0) return input.circuitOpen ? 'blocked_circuit' : 'disabled';
  if ((input.lastErrors || []).some((error) => /blocked by .*budget/i.test(error || ''))) return 'blocked_budget';
  if (input.sourceStatuses.some((status) => status === 'failed')) {
    return input.sourceStatuses.some((status) => status === 'success' || status === 'partial') ? 'partial' : 'failed';
  }
  if (input.sourceStatuses.some((status) => status === 'partial')) return 'partial';
  return 'succeeded';
}

export async function settleProviderState(promises: readonly Promise<unknown>[]): Promise<void> {
  await Promise.allSettled(promises);
}

export const GEO_LANES = [
  {
    id: 'msp_metro',
    label: 'Minneapolis–St. Paul / 55405',
    providerLocation: '55405',
    remoteOnly: false,
  },
  {
    id: 'minnesota',
    label: 'Minnesota',
    providerLocation: 'Minnesota',
    remoteOnly: false,
  },
  {
    id: 'upper_midwest',
    label: 'Upper Midwest / regional from Minneapolis',
    providerLocation: 'Upper Midwest',
    remoteOnly: false,
  },
  {
    id: 'us_remote',
    label: 'United States remote',
    providerLocation: 'Remote, United States',
    remoteOnly: true,
  },
] as const;

export type GeoLaneId = typeof GEO_LANES[number]['id'];

export function getGeoLane(id: GeoLaneId | string | undefined) {
  const known = GEO_LANES.find((lane) => lane.id === id);
  return known || {
    id: id || 'unspecified',
    label: id || 'Unspecified',
    providerLocation: '',
    remoteOnly: false,
  };
}

export function normalizeQueryFamily(query: string): string {
  return query
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bmgr\b/g, 'manager')
    .replace(/\bpbm\b/g, 'partner business manager')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_') || 'all';
}

function stableHash(parts: Array<string | number | null | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u001f'))
    .digest('hex');
}

export type IngestionTaskSpec = {
  source: string;
  queryFamily?: string | null;
  searchQuery?: string | null;
  geoLane: string;
  ingestionMode: string;
};

export function buildIngestionTaskKey(spec: IngestionTaskSpec): string {
  const family = spec.queryFamily || (spec.searchQuery ? normalizeQueryFamily(spec.searchQuery) : 'all');
  return `ingest:v1:${stableHash([
    spec.source.toLowerCase(),
    family,
    spec.geoLane.toLowerCase(),
    spec.ingestionMode.toLowerCase(),
  ])}`;
}

export type SeededIngestionTask = {
  id: string;
  taskKey: string;
};

/**
 * Idempotently materializes scheduler definitions without claiming a lease,
 * touching counters/watermarks, or invoking a provider. Existing runtime state
 * is deliberately preserved; only the immutable identifying columns are
 * refreshed from the canonical catalog.
 */
export async function seedIngestionTaskSpecs(
  specs: readonly IngestionTaskSpec[],
  options: {
    now?: Date;
    client?: Pick<Prisma.TransactionClient, 'ingestionTask'>;
  } = {},
): Promise<SeededIngestionTask[]> {
  const now = options.now || new Date();
  const client = options.client || prisma;
  const unique = new Map(specs.map((spec) => [buildIngestionTaskKey(spec), spec]));
  const seeded: SeededIngestionTask[] = [];
  for (const [taskKey, spec] of unique) {
    seeded.push(await client.ingestionTask.upsert({
      where: { taskKey },
      update: {
        source: spec.source,
        queryFamily: spec.queryFamily || null,
        searchQuery: spec.searchQuery || null,
        geoLane: spec.geoLane,
        ingestionMode: spec.ingestionMode,
      },
      create: {
        taskKey,
        source: spec.source,
        queryFamily: spec.queryFamily || null,
        searchQuery: spec.searchQuery || null,
        geoLane: spec.geoLane,
        ingestionMode: spec.ingestionMode,
        nextRunAt: now,
      },
      select: { id: true, taskKey: true },
    }));
  }
  return seeded;
}

type FairTaskRow = {
  taskKey: string;
  queryFamily: string | null;
  geoLane: string;
  nextRunAt: Date;
  lastCompletedAt: Date | null;
};

function queryClass(queryFamily: string | null): string {
  if (queryFamily?.startsWith('travel_')) return 'travel';
  if (queryFamily?.startsWith('description_')) return 'description';
  return 'title';
}

/**
 * Old due-time bands always win. Within an hour-wide band, round-robin across
 * query class and geography so a fixed provider budget cannot starve a suffix
 * of the portfolio every day.
 */
export function fairIngestionTaskOrder<T extends FairTaskRow>(rows: readonly T[], now: Date = new Date()): T[] {
  const due = rows.filter((row) => row.nextRunAt.getTime() <= now.getTime());
  const bands = new Map<number, T[]>();
  for (const row of due) {
    const band = Math.floor(row.nextRunAt.getTime() / (60 * 60 * 1000));
    const group = bands.get(band) || [];
    group.push(row);
    bands.set(band, group);
  }
  const result: T[] = [];
  const dayRotation = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  for (const band of [...bands.keys()].sort((a, b) => a - b)) {
    const groups = new Map<string, T[]>();
    for (const row of bands.get(band) || []) {
      const key = `${queryClass(row.queryFamily)}:${row.geoLane}`;
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) =>
        (a.lastCompletedAt?.getTime() || 0) - (b.lastCompletedAt?.getTime() || 0)
        || a.taskKey.localeCompare(b.taskKey));
      if (group.length > 1) {
        const offset = dayRotation % group.length;
        group.push(...group.splice(0, offset));
      }
    }
    const keys = [...groups.keys()].sort();
    if (keys.length > 1) {
      const offset = dayRotation % keys.length;
      keys.push(...keys.splice(0, offset));
    }
    let remaining = true;
    while (remaining) {
      remaining = false;
      for (const key of keys) {
        const next = groups.get(key)?.shift();
        if (!next) continue;
        result.push(next);
        remaining = true;
      }
    }
  }
  return result;
}

export async function orderDueIngestionTaskSpecs<T extends IngestionTaskSpec>(
  specs: readonly T[],
  now: Date = new Date(),
): Promise<T[]> {
  const unique = new Map(specs.map((spec) => [buildIngestionTaskKey(spec), spec]));
  try {
    await prisma.ingestionTask.createMany({
      data: [...unique.entries()].map(([taskKey, spec]) => ({
        taskKey,
        source: spec.source,
        queryFamily: spec.queryFamily || null,
        searchQuery: spec.searchQuery || null,
        geoLane: spec.geoLane,
        ingestionMode: spec.ingestionMode,
        nextRunAt: now,
      })),
      skipDuplicates: true,
    });
    const rows = await prisma.ingestionTask.findMany({
      where: { taskKey: { in: [...unique.keys()] }, nextRunAt: { lte: now } },
      select: { taskKey: true, queryFamily: true, geoLane: true, nextRunAt: true, lastCompletedAt: true },
    });
    return fairIngestionTaskOrder(rows, now)
      .map((row) => unique.get(row.taskKey))
      .filter((spec): spec is T => Boolean(spec));
  } catch (error) {
    if (controlSchemaUnavailable(error)) return [...specs];
    throw error;
  }
}

export type CatchUpWindow = {
  windowStart: Date;
  windowEnd: Date;
  isCatchUp: boolean;
};

/**
 * Starts from the last successful watermark with a small overlap. Long outages
 * are bounded so one recovery run cannot monopolize the scheduler indefinitely.
 */
export function deriveCatchUpWindow(
  watermarkAt: Date | null | undefined,
  now: Date = new Date(),
  defaultLookbackMs = 24 * 60 * 60 * 1000,
  maxCatchUpMs = 7 * 24 * 60 * 60 * 1000,
  overlapMs = 2 * 60 * 60 * 1000,
): CatchUpWindow {
  const defaultStart = now.getTime() - defaultLookbackMs;
  const desiredStart = watermarkAt
    ? watermarkAt.getTime() - overlapMs
    : defaultStart;
  const boundedStart = Math.max(desiredStart, now.getTime() - maxCatchUpMs);
  return {
    windowStart: new Date(Math.min(boundedStart, now.getTime())),
    windowEnd: now,
    isCatchUp: Boolean(watermarkAt && watermarkAt.getTime() < defaultStart),
  };
}

export function buildPipelineEventKey(input: {
  eventType: JobPipelineEventType;
  jobId?: string | null;
  taskId?: string | null;
  source?: string | null;
  sourceId?: string | null;
  identityParts?: Array<string | number | null | undefined>;
}): string {
  return `pipeline:v1:${stableHash([
    input.eventType,
    input.jobId,
    input.taskId,
    input.source,
    input.sourceId,
    ...(input.identityParts || []),
  ])}`;
}

export type RecordPipelineEventInput = {
  eventType: JobPipelineEventType;
  jobId?: string | null;
  taskId?: string | null;
  stage?: string | null;
  source?: string | null;
  sourceId?: string | null;
  queryFamily?: string | null;
  geoLane?: string | null;
  details?: Prisma.InputJsonValue;
  occurredAt?: Date;
  identityParts?: Array<string | number | null | undefined>;
};

function prismaCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function controlSchemaUnavailable(error: unknown): boolean {
  return ['P2021', 'P2022'].includes(prismaCode(error) || '');
}

/**
 * Append-only and retry-safe. A duplicate event key returns the original row;
 * a pre-migration database returns null so rollout does not stop ingestion.
 */
export async function recordJobPipelineEvent(
  input: RecordPipelineEventInput,
  client: Pick<Prisma.TransactionClient, 'jobPipelineEvent'> = prisma,
): Promise<JobPipelineEvent | null> {
  const eventKey = buildPipelineEventKey(input);
  try {
    return await client.jobPipelineEvent.upsert({
      where: { eventKey },
      update: {},
      create: {
        eventKey,
        eventType: input.eventType,
        jobId: input.jobId || null,
        taskId: input.taskId || null,
        stage: input.stage || null,
        source: input.source || null,
        sourceId: input.sourceId || null,
        queryFamily: input.queryFamily || null,
        geoLane: input.geoLane || null,
        details: input.details,
        occurredAt: input.occurredAt || new Date(),
      },
    });
  } catch (error) {
    if (controlSchemaUnavailable(error)) return null;
    throw error;
  }
}

export type ClaimedIngestionTask = {
  task: IngestionTask;
  leaseToken: string;
  window: CatchUpWindow;
};

export async function claimDueIngestionTask(
  spec: IngestionTaskSpec,
  options: {
    now?: Date;
    owner?: string;
    leaseMs?: number;
    defaultLookbackMs?: number;
  } = {},
): Promise<ClaimedIngestionTask | null> {
  const now = options.now || new Date();
  const taskKey = buildIngestionTaskKey(spec);
  const leaseToken = crypto.randomUUID();
  const leaseMs = options.leaseMs || 30 * 60 * 1000;
  try {
    let task = await prisma.ingestionTask.findUnique({ where: { taskKey } });
    if (!task) {
      try {
        task = await prisma.ingestionTask.create({
          data: {
            taskKey,
            source: spec.source,
            queryFamily: spec.queryFamily || null,
            searchQuery: spec.searchQuery || null,
            geoLane: spec.geoLane,
            ingestionMode: spec.ingestionMode,
            nextRunAt: now,
          },
        });
      } catch (error) {
        if (prismaCode(error) !== 'P2002') throw error;
        task = await prisma.ingestionTask.findUnique({ where: { taskKey } });
      }
    }
    if (!task) return null;
    if (task.nextRunAt.getTime() > now.getTime()) return null;
    const window = deriveCatchUpWindow(task.watermarkAt, now, options.defaultLookbackMs);
    const claimed = await prisma.ingestionTask.updateMany({
      where: {
        id: task.id,
        nextRunAt: { lte: now },
        OR: [
          { leaseToken: null },
          { leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: 'running',
        leaseToken,
        leaseOwner: options.owner || `${os.hostname()}:${process.pid}`,
        leaseStartedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        lastStartedAt: now,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        attempt: { increment: 1 },
        requestCount: 0,
        seenCount: 0,
        insertedCount: 0,
        duplicateCount: 0,
        filteredCount: 0,
        processingErrorCount: 0,
        providerErrorCount: 0,
        lastError: null,
      },
    });
    if (claimed.count !== 1) return null;
    return {
      task: await prisma.ingestionTask.findUniqueOrThrow({ where: { id: task.id } }),
      leaseToken,
      window,
    };
  } catch (error) {
    if (controlSchemaUnavailable(error)) return null;
    throw error;
  }
}

export async function checkpointIngestionTask(input: {
  taskId: string;
  leaseToken: string;
  counters: IngestionCounters;
  cursor?: Prisma.InputJsonValue;
  now?: Date;
  leaseMs?: number;
}): Promise<boolean> {
  const now = input.now || new Date();
  try {
    const result = await prisma.ingestionTask.updateMany({
      where: { id: input.taskId, leaseToken: input.leaseToken, status: 'running' },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + (input.leaseMs || 30 * 60 * 1000)),
        cursor: input.cursor,
        requestCount: input.counters.requests || 0,
        seenCount: input.counters.seen,
        insertedCount: input.counters.inserted,
        duplicateCount: input.counters.duplicates,
        filteredCount: input.counters.filtered,
        processingErrorCount: input.counters.processingErrors,
        providerErrorCount: input.counters.providerErrors,
      },
    });
    return result.count === 1;
  } catch (error) {
    if (controlSchemaUnavailable(error)) return false;
    throw error;
  }
}

export async function completeIngestionTask(input: {
  taskId: string;
  leaseToken: string;
  status: 'succeeded' | 'partial' | 'failed' | 'blocked_budget' | 'blocked_circuit' | 'disabled';
  counters: IngestionCounters;
  nextRunAt: Date;
  watermarkAt?: Date | null;
  cursor?: Prisma.InputJsonValue;
  error?: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now || new Date();
  try {
    const result = await prisma.ingestionTask.updateMany({
      where: { id: input.taskId, leaseToken: input.leaseToken },
      data: {
        status: input.status,
        nextRunAt: input.nextRunAt,
        watermarkAt: input.status === 'succeeded' ? input.watermarkAt : undefined,
        cursor: input.cursor,
        requestCount: input.counters.requests || 0,
        seenCount: input.counters.seen,
        insertedCount: input.counters.inserted,
        duplicateCount: input.counters.duplicates,
        filteredCount: input.counters.filtered,
        processingErrorCount: input.counters.processingErrors,
        providerErrorCount: input.counters.providerErrors,
        lastError: input.error || null,
        lastCompletedAt: now,
        heartbeatAt: now,
        leaseToken: null,
        leaseOwner: null,
        leaseStartedAt: null,
        leaseExpiresAt: null,
      },
    });
    return result.count === 1;
  } catch (error) {
    if (controlSchemaUnavailable(error)) return false;
    throw error;
  }
}

export type ProviderBudgetDecision = {
  allowed: boolean;
  dailyUsed: number;
  monthlyUsed: number;
  reason?: 'circuit_open' | 'daily_budget' | 'monthly_budget';
};

export function evaluateProviderBudget(input: {
  state: string;
  openUntil?: Date | null;
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  dailyUsed: number;
  monthlyUsed: number;
  now?: Date;
}): ProviderBudgetDecision {
  const now = input.now || new Date();
  if (input.state === 'open' && input.openUntil && input.openUntil.getTime() > now.getTime()) {
    return { allowed: false, dailyUsed: input.dailyUsed, monthlyUsed: input.monthlyUsed, reason: 'circuit_open' };
  }
  if (input.dailyLimit != null && input.dailyUsed >= input.dailyLimit) {
    return { allowed: false, dailyUsed: input.dailyUsed, monthlyUsed: input.monthlyUsed, reason: 'daily_budget' };
  }
  if (input.monthlyLimit != null && input.monthlyUsed >= input.monthlyLimit) {
    return { allowed: false, dailyUsed: input.dailyUsed, monthlyUsed: input.monthlyUsed, reason: 'monthly_budget' };
  }
  return { allowed: true, dailyUsed: input.dailyUsed + 1, monthlyUsed: input.monthlyUsed + 1 };
}

function utcBudgetKeys(now: Date) {
  const iso = now.toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

/** Best-effort durable request reservation. Missing rollout tables fail open. */
export async function reserveProviderRequest(input: {
  provider: string;
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  now?: Date;
}): Promise<ProviderBudgetDecision> {
  const now = input.now || new Date();
  const keys = utcBudgetKeys(now);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
      let record = await tx.providerCircuit.upsert({
        where: { provider: input.provider },
        update: {
          dailyLimit: input.dailyLimit ?? undefined,
          monthlyLimit: input.monthlyLimit ?? undefined,
        },
        create: {
          provider: input.provider,
          dailyLimit: input.dailyLimit ?? null,
          monthlyLimit: input.monthlyLimit ?? null,
          budgetDay: keys.day,
          budgetMonth: keys.month,
        },
      });
      if (record.budgetDay !== keys.day || record.budgetMonth !== keys.month) {
        record = await tx.providerCircuit.update({
          where: { provider: input.provider },
          data: {
            dailyUsed: record.budgetDay === keys.day ? record.dailyUsed : 0,
            monthlyUsed: record.budgetMonth === keys.month ? record.monthlyUsed : 0,
            budgetDay: keys.day,
            budgetMonth: keys.month,
          },
        });
      }
      const decision = evaluateProviderBudget({ ...record, now });
      if (!decision.allowed) return decision;
      await tx.providerCircuit.update({
        where: { provider: input.provider },
        data: { dailyUsed: { increment: 1 }, monthlyUsed: { increment: 1 } },
      });
      return decision;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      // Serializable isolation makes the read/check/increment a real quota
      // reservation across the Pi and Mac. Retry only serialization conflicts.
      if (prismaCode(error) === 'P2034' && attempt < 2) continue;
      if (controlSchemaUnavailable(error)) return { allowed: true, dailyUsed: 0, monthlyUsed: 0 };
      throw error;
    }
  }
  throw new Error(`Could not reserve ${input.provider} budget after serialization retries`);
}

export function classifyProviderFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/all configured api keys were rate-limited or rejected|cooling/i.test(message)) return 'keys_exhausted';
  if (/HTTP\s+429|rate.?limit/i.test(message)) return 'rate_limited';
  if (/HTTP\s+(?:401|403)|invalid api key|unauthorized|forbidden/i.test(message)) return 'credentials';
  if (/HTTP\s+404|endpoint.*(?:unavailable|not found)/i.test(message)) return 'endpoint_unavailable';
  if (/schema|not iterable|unexpected token|invalid response/i.test(message)) return 'response_schema';
  if (/blocked by .*budget|daily_budget|monthly_budget/i.test(message)) return 'budget_exhausted';
  if (/timeout|timed out|abort/i.test(message)) return 'timeout';
  return 'provider_error';
}

export function providerFailurePolicy(
  classification: string,
  priorFailures: number,
  now: Date = new Date(),
): { state: 'closed' | 'open'; consecutiveFailures: number; openUntil: Date | null } {
  const consecutiveFailures = priorFailures + 1;
  const hardFailure = [
    'keys_exhausted',
    'rate_limited',
    'credentials',
    'endpoint_unavailable',
    'response_schema',
    'budget_exhausted',
  ].includes(classification);
  if (hardFailure) {
    return {
      state: 'open',
      consecutiveFailures,
      openUntil: new Date(now.getTime() + 6 * 60 * 60 * 1000),
    };
  }
  if (consecutiveFailures < 3) {
    return { state: 'closed', consecutiveFailures, openUntil: null };
  }
  const cooldownMs = Math.min(
    2 * 60 * 60 * 1000,
    15 * 60 * 1000 * (2 ** (consecutiveFailures - 3)),
  );
  return { state: 'open', consecutiveFailures, openUntil: new Date(now.getTime() + cooldownMs) };
}

export function providerSuccessState(now: Date = new Date()) {
  return {
    state: 'closed' as const,
    openUntil: null,
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: now,
  };
}

export async function recordProviderFailure(input: {
  provider: string;
  error: unknown;
  taskKey?: string | null;
  queryFamily?: string | null;
  geoLane?: string | null;
  now?: Date;
  openForMs?: number;
}): Promise<string | null> {
  const now = input.now || new Date();
  const classification = classifyProviderFailure(input.error);
  const message = (input.error instanceof Error ? input.error.message : String(input.error)).slice(0, 500);
  const incidentKey = `incident:v1:${stableHash([input.provider, classification, now.toISOString().slice(0, 10)])}`;
  const affectedTaskKey = input.taskKey || `${input.queryFamily || 'all'}:${input.geoLane || 'all'}`;
  try {
    return await prisma.$transaction(async (tx) => {
      const previousCircuit = await tx.providerCircuit.findUnique({
        where: { provider: input.provider },
        select: { consecutiveFailures: true },
      });
      const policy = providerFailurePolicy(classification, previousCircuit?.consecutiveFailures || 0, now);
      await tx.providerCircuit.upsert({
        where: { provider: input.provider },
        update: {
          state: policy.state,
          openUntil: input.openForMs
            ? new Date(now.getTime() + input.openForMs)
            : policy.openUntil,
          consecutiveFailures: policy.consecutiveFailures,
          lastError: message,
          lastFailureAt: now,
        },
        create: {
          provider: input.provider,
          state: policy.state,
          openUntil: input.openForMs
            ? new Date(now.getTime() + input.openForMs)
            : policy.openUntil,
          consecutiveFailures: policy.consecutiveFailures,
          lastError: message,
          lastFailureAt: now,
        },
      });
      const incident = await tx.providerIncident.upsert({
        where: { incidentKey },
        update: {
          status: 'open',
          message,
          occurrenceCount: { increment: 1 },
          lastSeenAt: now,
          resolvedAt: null,
        },
        create: {
          incidentKey,
          provider: input.provider,
          classification,
          message,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      });
      await tx.providerIncidentAffectedTask.createMany({
        data: [{
          incidentId: incident.id,
          taskKey: affectedTaskKey,
          queryFamily: input.queryFamily || null,
          geoLane: input.geoLane || null,
          firstSeenAt: now,
        }],
        skipDuplicates: true,
      });
      const affectedQueryCount = await tx.providerIncidentAffectedTask.count({
        where: { incidentId: incident.id },
      });
      await tx.providerIncident.update({
        where: { id: incident.id },
        data: { affectedQueryCount },
      });
      return incident.id;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (controlSchemaUnavailable(error)) return null;
    throw error;
  }
}

export async function recordProviderSuccess(provider: string, now: Date = new Date()): Promise<void> {
  const success = providerSuccessState(now);
  try {
    await prisma.$transaction([
      prisma.providerCircuit.upsert({
        where: { provider },
        update: {
          ...success,
        },
        create: { provider, ...success },
      }),
      prisma.providerIncident.updateMany({
        where: { provider, status: 'open' },
        data: { status: 'resolved', resolvedAt: now, lastSeenAt: now },
      }),
    ]);
  } catch (error) {
    if (!controlSchemaUnavailable(error)) throw error;
  }
}
