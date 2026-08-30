type UnknownRecord = Record<string, unknown>;

type NormalizedTaskSummary = UnknownRecord & {
  activeSearchTasks: number;
  categoryReconciles: boolean;
  runnableNow: number;
  running: number;
  scheduled: number;
  staleLeases: number;
  circuitCooldown: number;
  blockedBudget: number;
  failedAwaitingRetry: number;
  retired: number;
  orchestration: number;
  oldestRunnableSince: string | null;
  nextRunnableAt: string | null;
  latestWatermarkAt: string | null;
  updatedAt: string | null;
};

type NormalizedTask = UnknownRecord & {
  lifecycleStatus: string;
  taskKind: string;
  retiredAt: string | null;
  category: string;
  availableAt: string | null;
  leaseStartedAt: string | null;
  lastStartedAt: string | null;
  cursor: UnknownRecord | null;
};

type NormalizedAtsPath = UnknownRecord & {
  available: boolean;
  enabled: boolean;
  dailyTarget: number;
  attemptedToday: number;
  legacyClaimContactedToday: number;
  newCycleListingContactedToday: number;
  listingContinuationContactedToday: number;
  contactMetricEffectiveAt: string | null;
  v2ActiveBatches: number;
  v2StagingItems: number;
  v2StagingBytes: number;
  v2SegmentBackpressureJobs: number;
  v2SealedSegments: number;
  v2PublishedSegments: number;
  v2ProcessingSegments: number;
  v2ProcessedSegments: number;
  v2PublicationPaused: boolean;
  respondedToday: number;
  synchronizedToday: number;
  processedToday: number;
  failedToday: number;
  remainingJobs: number;
  backpressureJobs: number;
  oldestSynchronizedAt: string | null;
  processedJobsLastHour: number;
  fetchedJobsLastHour: number;
  queuedJobsLastHour: number;
  prequeueDuplicatesLastHour: number;
  deferredWithoutContactLastHour: number;
  lastAttemptedAt: string | null;
  lastRespondedAt: string | null;
  lastSynchronizedAt: string | null;
  lastProcessedAt: string | null;
  queue: UnknownRecord & {
    fetching: number;
    partial: number;
    queued: number;
    processing: number;
    failed: number;
  };
};

type NormalizedStatsTaskPayload<T> = T & {
  operations: UnknownRecord & {
    tasks: UnknownRecord & {
      summary: NormalizedTaskSummary;
      checkpoints: NormalizedTask[];
    };
  };
  inventory: UnknownRecord & {
    atsBoards: UnknownRecord & {
      path: NormalizedAtsPath;
    };
  };
};

const record = (value: unknown): UnknownRecord | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);

const count = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const dateOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return null;
  const milliseconds = new Date(value).getTime();
  // Older scheduler responses used the Unix epoch as a missing-date sentinel.
  return Number.isFinite(milliseconds) && milliseconds >= Date.UTC(2000, 0, 1) ? value : null;
};

const legacyTaskCategory = (task: UnknownRecord): string => {
  if (typeof task.category === 'string') return task.category;
  if (task.isStaleLease === true) return 'staleLease';
  if (task.status === 'running') return 'running';
  if (task.isDue === true) return 'runnableNow';
  if (task.status === 'failed') return 'failedAwaitingRetry';
  return 'scheduled';
};

/**
 * Keeps the Stats client usable while a local dev server or rolling deployment
 * still serves one-release-old scheduler aliases or lacks split-path ATS
 * telemetry entirely.
 */
export function normalizeStatsTaskContract<T>(payload: T): NormalizedStatsTaskPayload<T> {
  const root = record(payload);
  const operations = record(root?.operations);
  const tasks = record(operations?.tasks);
  const summary = record(tasks?.summary);
  if (!root || !operations || !tasks || !summary) return payload as NormalizedStatsTaskPayload<T>;

  const rawCheckpoints = Array.isArray(tasks.checkpoints) ? tasks.checkpoints : [];
  const checkpoints = rawCheckpoints
    .map(record)
    .filter((task): task is UnknownRecord => task !== null)
    .map((task): NormalizedTask => ({
      ...task,
      lifecycleStatus: typeof task.lifecycleStatus === 'string' ? task.lifecycleStatus : 'active',
      taskKind: typeof task.taskKind === 'string' ? task.taskKind : 'search',
      retiredAt: dateOrNull(task.retiredAt),
      category: legacyTaskCategory(task),
      availableAt: dateOrNull(task.availableAt) ?? dateOrNull(task.nextRunAt),
      leaseStartedAt: dateOrNull(task.leaseStartedAt),
      lastStartedAt: dateOrNull(task.lastStartedAt),
      cursor: record(task.cursor),
    }));

  const activeSearchTasks = count(summary.activeSearchTasks ?? summary.total);
  const runnableNow = count(summary.runnableNow ?? summary.due);
  const running = count(summary.running);
  const staleLeases = count(summary.staleLeases);
  const circuitCooldown = count(summary.circuitCooldown);
  const blockedBudget = count(summary.blockedBudget);
  const failedAwaitingRetry = count(summary.failedAwaitingRetry ?? summary.failed);
  const scheduled = summary.scheduled == null
    ? Math.max(0, activeSearchTasks - runnableNow - running - staleLeases
      - circuitCooldown - blockedBudget - failedAwaitingRetry)
    : count(summary.scheduled);

  const runnableDates = checkpoints
    .map(record)
    .filter((task): task is UnknownRecord => task?.category === 'runnableNow')
    .map((task) => dateOrNull(task.nextRunAt))
    .filter((value): value is string => value !== null)
    .sort();

  const normalizedSummary = {
    ...summary,
    activeSearchTasks,
    // A legacy response cannot prove the newer mutually exclusive categories.
    categoryReconciles: typeof summary.categoryReconciles === 'boolean'
      ? summary.categoryReconciles
      : false,
    runnableNow,
    running,
    scheduled,
    staleLeases,
    circuitCooldown,
    blockedBudget,
    failedAwaitingRetry,
    retired: count(summary.retired),
    orchestration: count(summary.orchestration),
    oldestRunnableSince: dateOrNull(summary.oldestRunnableSince) ?? runnableDates[0] ?? null,
    nextRunnableAt: dateOrNull(summary.nextRunnableAt ?? summary.nextDueAt),
    latestWatermarkAt: dateOrNull(summary.latestWatermarkAt),
    updatedAt: dateOrNull(summary.updatedAt),
  };

  const inventory = record(root.inventory) || {};
  const atsBoards = record(inventory.atsBoards) || {};
  const atsPath = record(atsBoards.path) || {};
  const atsQueue = record(atsPath.queue) || {};
  const normalizedAtsPath: NormalizedAtsPath = {
    ...atsPath,
    available: atsPath.available === true,
    enabled: atsPath.enabled === true,
    dailyTarget: count(atsPath.dailyTarget),
    attemptedToday: count(atsPath.attemptedToday ?? atsPath.legacyClaimContactedToday),
    legacyClaimContactedToday: count(
      atsPath.legacyClaimContactedToday ?? atsPath.attemptedToday,
    ),
    newCycleListingContactedToday: count(atsPath.newCycleListingContactedToday),
    listingContinuationContactedToday: count(atsPath.listingContinuationContactedToday),
    contactMetricEffectiveAt: dateOrNull(atsPath.contactMetricEffectiveAt),
    v2ActiveBatches: count(atsPath.v2ActiveBatches),
    v2StagingItems: count(atsPath.v2StagingItems),
    v2StagingBytes: count(atsPath.v2StagingBytes),
    v2SegmentBackpressureJobs: count(atsPath.v2SegmentBackpressureJobs),
    v2SealedSegments: count(atsPath.v2SealedSegments),
    v2PublishedSegments: count(atsPath.v2PublishedSegments),
    v2ProcessingSegments: count(atsPath.v2ProcessingSegments),
    v2ProcessedSegments: count(atsPath.v2ProcessedSegments),
    v2PublicationPaused: atsPath.v2PublicationPaused === true,
    respondedToday: count(atsPath.respondedToday),
    synchronizedToday: count(atsPath.synchronizedToday),
    processedToday: count(atsPath.processedToday),
    failedToday: count(atsPath.failedToday),
    remainingJobs: count(atsPath.remainingJobs),
    backpressureJobs: count(atsPath.backpressureJobs),
    oldestSynchronizedAt: dateOrNull(atsPath.oldestSynchronizedAt),
    processedJobsLastHour: count(atsPath.processedJobsLastHour),
    fetchedJobsLastHour: count(atsPath.fetchedJobsLastHour),
    queuedJobsLastHour: count(atsPath.queuedJobsLastHour),
    prequeueDuplicatesLastHour: count(atsPath.prequeueDuplicatesLastHour),
    deferredWithoutContactLastHour: count(atsPath.deferredWithoutContactLastHour),
    lastAttemptedAt: dateOrNull(atsPath.lastAttemptedAt),
    lastRespondedAt: dateOrNull(atsPath.lastRespondedAt),
    lastSynchronizedAt: dateOrNull(atsPath.lastSynchronizedAt),
    lastProcessedAt: dateOrNull(atsPath.lastProcessedAt),
    queue: {
      ...atsQueue,
      fetching: count(atsQueue.fetching),
      partial: count(atsQueue.partial),
      queued: count(atsQueue.queued),
      processing: count(atsQueue.processing),
      failed: count(atsQueue.failed),
    },
  };

  return {
    ...root,
    operations: {
      ...operations,
      tasks: {
        ...tasks,
        summary: normalizedSummary,
        checkpoints,
      },
    },
    inventory: {
      ...inventory,
      atsBoards: {
        ...atsBoards,
        path: normalizedAtsPath,
      },
    },
  } as NormalizedStatsTaskPayload<T>;
}
