import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { isScheduledPipelineRequest } from '@/lib/apiAuth';
import { controlPrisma } from '@/lib/controlPrisma';
import { prisma } from '@/lib/prisma';
import {
  pipelineStopRequested,
  registerActivePipelineAbortController,
  startPipelineLockHeartbeat,
  tryAcquirePipelineLock,
  updatePipelineState,
  waitForPipelineDelay,
} from '@/lib/pipelineState';
import { readDurableIngestionState, writeDurableIngestionState } from '@/lib/ingestionState';
import { reapAbandonedIngestionRuns } from '@/lib/ingestionRunReaper';
import { buildTerminalJdRecoveryUpdate } from '@/lib/jdRecoveryPolicy';
import { recoverStaleLocalScoringLeases } from '@/lib/localScoringLeaseRecovery';

// Import our logic functions directly
import { ingestJobs } from '@/lib/jobIngestion';
import { scoreJobs } from '@/lib/jobScoring';

// Import the App Router endpoints for JD Extraction
import { POST as jdSubmitPost } from '../../jobs/batch-jd-submit/route';

import { POST as apifySync } from '../apify/route';
import { POST as apifyProfilesSync } from '../apify-profiles/route';
import { POST as redditSync } from '../reddit/route';
import { POST as hnSync } from '../hackernews/route';
import { POST as githubSync } from '../github/route';
import { POST as diceSync } from '../dice/route';
import { processCooldownJobs, enforceRetroactiveCooldowns } from '@/lib/cooldownRecovery';
import {
  PRIMARY_JOB_SEARCH_QUERIES,
} from '@/lib/jobSearchQueries';
import {
  claimDueIngestionTask,
  buildIngestionTaskKey,
  completeIngestionTask,
  EMPTY_INGESTION_COUNTERS,
  GEO_LANES,
  INGESTION_SCHEDULER_V3_ENABLED,
  ingestionReconciles,
  normalizeQueryFamily,
  orderDueIngestionTaskSpecs,
  type IngestionCounters,
  type IngestionTaskSpec,
} from '@/lib/ingestionControl';
import {
  ROUTE_SOURCE_TASK_DEFINITIONS,
  USAJOBS_TRAVEL_TASK_DEFINITION,
  ATS_ACTIVE_LOOP_DELAY_MS,
  ATS_BATCH_WALL_CLOCK_MS,
  ATS_BOARD_BATCH_SIZE,
  ATS_CONTINUATION_DELAY_MS,
  ATS_IDLE_LOOP_DELAY_MS,
  ATS_PLATFORM_CONCURRENCY,
  ATS_SPLIT_INGESTION_ENABLED,
  WORKDAY_NEEDS_JD_BACKLOG_LIMIT,
  atsPlatformTaskDefinition,
  careerForceTaskDefinitions,
  paidTaskDefinitions,
  planAtsPlatformBatches,
  standardProviderTaskDefinitions,
} from '@/lib/ingestionTaskCatalog';
import {
  ATS_RECOVERY_STATUSES,
  ATS_ROTATION_STATUSES,
  atsRotationCycleCutoff,
  rotationDayFor,
} from '@/lib/atsRotation';
import {
  ATS_BATCH_LEASE_MS,
  ATS_BATCH_PROCESSING_CONCURRENCY,
  claimNextAtsIngestionBatch,
  completeAtsBatchProcessing,
  failAtsBatchProcessing,
  heartbeatAtsBatchProcessing,
} from '@/lib/atsAcquisition';
import { applyAtsTaskModeTransition } from '@/lib/atsTaskMode';
import { runAtsAcquisitionWorkerProcess } from '@/lib/pipelineWorkerProcess';
import { describeAtsBatchChunk } from '@/lib/pipelineTelemetry';

export const runtime = 'nodejs';

async function orchestratePipeline(releaseLock: () => void) {
  // A run now lasts as long as the process, so this cannot grow without bound.
  const WARNING_RETENTION = 50;
  const warnings: string[] = [];
  let warningCount = 0;
  const recordWarning = (step: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    warningCount++;
    warnings.push(`${step}: ${message}`);
    if (warnings.length > WARNING_RETENTION) warnings.splice(0, warnings.length - WARNING_RETENTION);
    console.error(`${step} failed:`, error);
  };
  const runRouteStep = async (step: string, action: (req: Request) => Promise<Response>) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await action(new Request('http://localhost') as any);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
      }
    } catch (error) {
      recordWarning(step, error);
    }
  };
  const ac = new AbortController();
  const clearActiveAbortController = registerActivePipelineAbortController(ac);
  if (!clearActiveAbortController) {
    // This process already owns a live pipeline. Starting a second one here
    // would leave the first untrackable by Stop while it still held leases.
    console.error('Refusing to start a second pipeline in a process that already owns one.');
    await releaseLock();
    return;
  }
  const stopLockHeartbeat = startPipelineLockHeartbeat();
  try {
    
    let latestIngestion = 'Ingestion: Starting...';
    let latestAtsAcquisition = 'ATS acquisition: Starting...';
    let latestAtsProcessing = 'ATS processing: Starting...';
    let latestLS = 'Local Scoring: Idle';
    let latestJD = 'JD Extraction: Idle';
    
    const updateCombinedTicker = () => {
      updatePipelineState({
        currentStep: 'Pipeline Active (Concurrent)',
        stepProgress: `${latestIngestion} | ${latestAtsAcquisition} | ${latestAtsProcessing} | ${latestLS} | ${latestJD}`
      });
    };

    const atsTaskMode = await prisma.$transaction((transaction) => applyAtsTaskModeTransition(
      transaction,
      { splitEnabled: ATS_SPLIT_INGESTION_ENABLED },
    ));
    latestAtsAcquisition = ATS_SPLIT_INGESTION_ENABLED
      ? `ATS acquisition: Split process mode (${atsTaskMode.activated} activated, ${atsTaskMode.retired} retired)`
      : `ATS acquisition: Legacy fallback mode (${atsTaskMode.activated} activated, ${atsTaskMode.retired} retired)`;
    updateCombinedTicker();

    const runDurableIngestionTask = async (
      spec: IngestionTaskSpec,
      intervalMs: number,
      action: (claim: NonNullable<Awaited<ReturnType<typeof claimDueIngestionTask>>>) => Promise<void>,
    ) => {
      const claim = await claimDueIngestionTask(spec);
      if (!claim) return false;
      try {
        await action(claim);
      } catch (error) {
        await completeIngestionTask({
          taskId: claim.task.id,
          taskKey: claim.task.taskKey,
          leaseToken: claim.leaseToken,
          status: 'failed',
          counters: {
            seen: 0,
            inserted: 0,
            duplicates: 0,
            filtered: 0,
            processingErrors: 0,
            providerErrors: 1,
            requests: 0,
          },
          cadenceMs: intervalMs,
          error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        });
        // The failure is durably recorded on the task above, so rethrowing adds
        // no information — it only widens the blast radius. It used to escape
        // the ingestion loop, reject the Promise.all below, and tear down local
        // scoring, JD extraction and lease cleanup over one flaky provider.
        // A deliberate stop still propagates: it is not a provider fault.
        if (ac.signal.aborted || await pipelineStopRequested()) throw error;
        recordWarning(`${spec.source} ingestion`, error);
      }
      return true;
    };

    const runDurableRouteSource = async (
      spec: IngestionTaskSpec,
      intervalMs: number,
      action: (request: Request) => Promise<Response>,
    ) => runDurableIngestionTask(spec, intervalMs, async (claim) => {
      const response = await action(new Request('http://localhost', {
        method: 'POST',
        headers: {
          'x-ingestion-task-id': claim.task.id,
          'x-ingestion-query-family': spec.queryFamily || 'all',
          'x-ingestion-geo-lane': spec.geoLane,
          'x-ingestion-window-start': claim.window.windowStart.toISOString(),
          'x-ingestion-window-end': claim.window.windowEnd.toISOString(),
        },
      }));
      const payload = await response.json().catch(() => null) as {
        ingestionStatus?: 'success' | 'partial' | 'failed' | 'idle' | 'disabled';
        ingestionCounters?: IngestionCounters;
        details?: string;
        error?: string;
      } | null;
      const counters = payload?.ingestionCounters;
      if (!counters || !ingestionReconciles(counters)) {
        throw new Error(`${spec.source} route returned missing or irreconcilable ingestion counters`);
      }
      const taskStatus = payload?.ingestionStatus === 'success' || payload?.ingestionStatus === 'idle'
        ? 'succeeded'
        : payload?.ingestionStatus === 'disabled'
          ? 'disabled'
          : payload?.ingestionStatus === 'partial' ? 'partial' : 'failed';
      await completeIngestionTask({
        taskId: claim.task.id,
        taskKey: claim.task.taskKey,
        leaseToken: claim.leaseToken,
        status: taskStatus,
        counters,
        cadenceMs: intervalMs,
        watermarkAt: claim.window.windowEnd,
        cursor: { phase: 'finished', sourceStatus: payload?.ingestionStatus || null },
        error: payload?.details || payload?.error || null,
      });
      if (!response.ok) {
        recordWarning(spec.source, payload?.details || payload?.error || `HTTP ${response.status}`);
      }
    });

    /**
     * ATS network acquisition runs under one attached child PID. The child owns
     * listing and per-posting detail calls plus durable enriched batch receipts;
     * this parent owns network-free normalization/persistence, the global ticker,
     * lock, supervision, and final run state.
     */
    const runAtsAcquisitionProcess = async () => {
      await runAtsAcquisitionWorkerProcess({
        signal: ac.signal,
        shouldStop: pipelineStopRequested,
        onReady: (pid) => {
          latestAtsAcquisition = `ATS acquisition PID ${pid}: Ready`;
          updateCombinedTicker();
        },
        onProgress: (pid, message) => {
          latestAtsAcquisition = `ATS acquisition PID ${pid}: ${message}`;
          updateCombinedTicker();
        },
        onWarning: (pid, message) => recordWarning(`ATS acquisition PID ${pid}`, message),
        onFatal: (pid, message) => {
          latestAtsAcquisition = `ATS acquisition PID ${pid}: Fatal — ${message}`;
          updateCombinedTicker();
        },
      });
    };

    /** Consumes durable ATS listing batches independently of endpoint coverage. */
    const runAtsBatchProcessingLoop = async () => {
      while (true) {
        if (ac.signal.aborted || await pipelineStopRequested()) break;
        const claims: NonNullable<Awaited<ReturnType<typeof claimNextAtsIngestionBatch>>>[] = [];
        for (let index = 0; index < ATS_BATCH_PROCESSING_CONCURRENCY; index++) {
          const claim = await claimNextAtsIngestionBatch();
          if (!claim) break;
          claims.push(claim);
        }
        if (claims.length === 0) {
          latestAtsProcessing = 'ATS processing: Waiting for synchronized batches...';
          updateCombinedTicker();
          await waitForPipelineDelay(ATS_ACTIVE_LOOP_DELAY_MS, ac.signal);
          continue;
        }

        const processingResults = await Promise.allSettled(claims.map(async (batch) => {
          const processingController = new AbortController();
          const processingSignal = AbortSignal.any([ac.signal, processingController.signal]);
          const heartbeatIntervalMs = Math.max(10_000, Math.min(60_000, Math.floor(ATS_BATCH_LEASE_MS / 3)));
          let heartbeatInFlight: Promise<void> | null = null;
          const heartbeatTimer = setInterval(() => {
            if (heartbeatInFlight) return;
            heartbeatInFlight = heartbeatAtsBatchProcessing({
              batchId: batch.id,
              leaseToken: batch.leaseToken,
            }).then((retained) => {
              if (!retained && !processingController.signal.aborted) {
                processingController.abort(new Error(`ATS batch ${batch.id} lost its processing lease.`));
              }
            }).catch((error) => recordWarning('ATS batch heartbeat', error)).finally(() => {
              heartbeatInFlight = null;
            });
          }, heartbeatIntervalMs);
          try {
            latestAtsProcessing = `ATS processing: ${describeAtsBatchChunk(batch)}`;
            updateCombinedTicker();
            await ingestJobs(
              (message) => { latestAtsProcessing = `ATS processing: ${message}`; updateCombinedTicker(); },
              processingSignal,
              [{ slug: batch.slug, platform: batch.platform }],
              'sales',
              'pending_af',
              false,
              {
                useStandard: false,
                usePaidApis: false,
                useCareerforce: false,
                queryFamily: 'all',
                geoLane: 'source_posted_location',
                atsPlatform: batch.platform,
                atsBatchWallClockMs: ATS_BATCH_WALL_CLOCK_MS,
                prefetchedAtsBatch: batch,
              },
            );
          } catch (error) {
            const stopping = ac.signal.aborted || await pipelineStopRequested();
            if (stopping) {
              const retained = await completeAtsBatchProcessing({
                batchId: batch.id,
                leaseToken: batch.leaseToken,
                counters: EMPTY_INGESTION_COUNTERS,
                interrupted: true,
                error: error instanceof Error ? error.message : String(error),
              });
              if (!retained) {
                recordWarning('ATS batch stop recovery', `Batch ${batch.id} no longer held its processing lease.`);
              }
              return;
            }
            const retained = await failAtsBatchProcessing({
              batchId: batch.id,
              leaseToken: batch.leaseToken,
              error,
            });
            if (!retained) {
              throw new Error(`ATS batch ${batch.id} lost its processing lease while recording failure.`);
            }
            recordWarning('ATS batch processing', error);
          } finally {
            clearInterval(heartbeatTimer);
            const pendingHeartbeat = heartbeatInFlight;
            if (pendingHeartbeat) await pendingHeartbeat;
          }
        }));
        const rejected = processingResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        // Join every claimed batch before restarting the supervisor or releasing
        // the global pipeline lock. This prevents sibling persistence work from
        // continuing after the run has advertised quiescence.
        if (rejected) throw rejected.reason;
      }
    };

    /**
     * Kill-switch fallback for the original per-platform ATS worker. It used to
     * sit behind every
     * paid, CareerForce, and source-feed task in the general ingestion loop,
     * then sleep with that loop for fifteen minutes. Three independent
     * platform turns sustain the 6,200-board daily goal while each individual
     * provider remains bounded by its own board concurrency and throttle.
     */
    const runLegacyAtsIngestionLoop = async () => {
      while (true) {
        if (ac.signal.aborted || await pipelineStopRequested()) break;
        let claimedAnyTurn = false;
        try {
          const rotationNow = new Date();
          const today = rotationDayFor(rotationNow);
          let tier: 'assigned' | 'catch_up' | 'recovery' | 'legacy' = 'assigned';
          let dueWhere: Prisma.AtsCompanyWhereInput;

          if (INGESTION_SCHEDULER_V3_ENABLED) {
            // The fixed weekday is authoritative. Catch-up cannot spend a slot
            // until today's entire cohort is clear, and failing boards cannot
            // compete with either active tier.
            dueWhere = {
              status: { in: [...ATS_ROTATION_STATUSES] },
              nextCheckDate: { lte: rotationNow },
              checkDay: today,
            };
            let dueCount = await prisma.atsCompany.count({ where: dueWhere });
            if (dueCount === 0) {
              tier = 'catch_up';
              dueWhere = {
                status: { in: [...ATS_ROTATION_STATUSES] },
                nextCheckDate: { lte: rotationNow },
                checkDay: { not: today },
                OR: [
                  { lastCheckedAt: null },
                  { lastCheckedAt: { lt: atsRotationCycleCutoff(rotationNow) } },
                ],
              };
              dueCount = await prisma.atsCompany.count({ where: dueWhere });
            }
            if (dueCount === 0) {
              tier = 'recovery';
              dueWhere = {
                status: { in: [...ATS_RECOVERY_STATUSES] },
                nextCheckDate: { lte: rotationNow },
              };
            }
          } else {
            tier = 'legacy';
            dueWhere = {
              status: { in: ['active', 'parked', 'blacklisted'] },
              nextCheckDate: { lte: rotationNow },
            };
          }

          const boardTurns: Array<{
            platform: string;
            boards: Array<{ slug: string; platform: string }>;
            remainingDueCount: number;
            tier: typeof tier;
          }> = [];

          if (INGESTION_SCHEDULER_V3_ENABLED) {
            const duePlatforms = await prisma.atsCompany.groupBy({
              by: ['platform'],
              where: dueWhere,
              _count: { _all: true },
              orderBy: { platform: 'asc' },
            });
            const platformSpecs = await orderDueIngestionTaskSpecs(
              duePlatforms.map((row) => atsPlatformTaskDefinition(row.platform).spec),
            );
            const dueCounts = Object.fromEntries(duePlatforms.map((row) => [row.platform, row._count._all]));
            const turns = planAtsPlatformBatches(
              dueCounts,
              platformSpecs.map((spec) => spec.source.replace(/^ATS-/, '')),
              ATS_BOARD_BATCH_SIZE,
            );
            for (const turn of turns) {
              const boards = await prisma.atsCompany.findMany({
                where: { ...dueWhere, platform: turn.platform },
                orderBy: [
                  { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
                  { nextCheckDate: 'asc' },
                  { slug: 'asc' },
                ],
                take: turn.selectedCount,
                select: { slug: true, platform: true },
              });
              if (boards.length) boardTurns.push({
                platform: turn.platform,
                boards,
                remainingDueCount: Math.max(0, dueCounts[turn.platform] - boards.length),
                tier,
              });
            }
          } else {
            // Exact v2 fallback while the v3 feature gate is off: preserve the
            // former global oldest-1,000 snapshot and its platform grouping.
            const dueBoards = await prisma.atsCompany.findMany({
              where: dueWhere,
              orderBy: [{ nextCheckDate: 'asc' }, { slug: 'asc' }],
              take: 1_000,
              select: { slug: true, platform: true },
            });
            const grouped = new Map<string, typeof dueBoards>();
            for (const board of dueBoards) grouped.set(board.platform, [...(grouped.get(board.platform) || []), board]);
            for (const [platform, boards] of grouped) {
              boardTurns.push({ platform, boards, remainingDueCount: 0, tier });
            }
          }

          const runTurn = async (turn: typeof boardTurns[number]) => {
            const { platform, boards } = turn;
            const needsJdBacklog = platform === 'workday' && INGESTION_SCHEDULER_V3_ENABLED
              ? await prisma.job.count({ where: { scoringStatus: 'needs_jd', status: { in: ['pending_af', 'inbox'] } } })
              : 0;
            const atsDefinition = atsPlatformTaskDefinition(platform);
            const claimed = await runDurableIngestionTask(atsDefinition.spec, atsDefinition.intervalMs, async (claim) => {
              latestIngestion = `ATS ${turn.tier}: ${boards.length} ${platform} boards (goal 6,200/day)...`;
              updateCombinedTicker();
              await ingestJobs(
                (msg) => { latestIngestion = `ATS-${platform} (${turn.tier}): ${msg}`; updateCombinedTicker(); },
                ac.signal,
                boards,
                'sales',
                'pending_af',
                false,
                {
                  useStandard: false,
                  usePaidApis: false,
                  useCareerforce: false,
                  queryFamily: 'all',
                  geoLane: 'source_posted_location',
                  taskId: claim.task.id,
                  taskKey: claim.task.taskKey,
                  taskLeaseToken: claim.leaseToken,
                  taskWindowStart: claim.window.windowStart,
                  taskWindowEnd: claim.window.windowEnd,
                  taskCadenceMs: atsDefinition.intervalMs,
                  taskProvider: atsDefinition.spec.source,
                  taskContinuationDelayMs: INGESTION_SCHEDULER_V3_ENABLED && turn.remainingDueCount > 0
                    ? ATS_CONTINUATION_DELAY_MS
                    : undefined,
                  atsPlatform: platform,
                  atsBatchWallClockMs: INGESTION_SCHEDULER_V3_ENABLED ? ATS_BATCH_WALL_CLOCK_MS : undefined,
                  deferWorkdayDescriptions: INGESTION_SCHEDULER_V3_ENABLED
                    && needsJdBacklog < WORKDAY_NEEDS_JD_BACKLOG_LIMIT,
                },
              );
            });
            return claimed;
          };

          // A worker pool, not fixed Promise.all chunks: one throttled platform
          // must not leave the other slots idle while it finishes its turn.
          const turnQueue = [...boardTurns];
          const workerCount = Math.min(ATS_PLATFORM_CONCURRENCY, turnQueue.length);
          await Promise.all(Array.from({ length: workerCount }, async () => {
            while (turnQueue.length && !ac.signal.aborted && !await pipelineStopRequested()) {
              const turn = turnQueue.shift();
              if (!turn) return;
              const claimed = await runTurn(turn);
              if (claimed) claimedAnyTurn = true;
            }
          }));
        } catch (error) {
          recordWarning('ATS ingestion', error);
        }

        latestIngestion = claimedAnyTurn ? 'ATS: Scheduling next platform turns...' : 'ATS: Waiting for due weekday boards...';
        updateCombinedTicker();
        await waitForPipelineDelay(
          claimedAnyTurn ? ATS_ACTIVE_LOOP_DELAY_MS : ATS_IDLE_LOOP_DELAY_MS,
          ac.signal,
        );
      }
    };

    const runIngestionLoop = async () => {
      while (true) {
        if (ac.signal.aborted || await pipelineStopRequested()) break;

        const state = await readDurableIngestionState();
        const now = Date.now();
        const primaryQueries = PRIMARY_JOB_SEARCH_QUERIES;

        // 1. APIFY profile sync - Once a day (4 AM target). The job dataset
        // itself runs through a durable source-specific task below.
        const today4am = new Date();
        today4am.setHours(4, 0, 0, 0);
        const isPast4am = now >= today4am.getTime();
        const ranTodayAfter4am = state.lastRunApify >= today4am.getTime();
        
        // If we haven't run today after 4 AM, AND it's past 4 AM (or we haven't run in 24 hours at all as a fallback)
        if ((isPast4am && !ranTodayAfter4am) || (now - state.lastRunApify > 24 * 60 * 60 * 1000)) {
          if (ac.signal.aborted || await pipelineStopRequested()) break;
          latestIngestion = 'Ingestion: Running Apify LinkedIn Profiles Sync (Daily)...'; updateCombinedTicker();
          await runRouteStep('Apify profile sync', apifyProfilesSync);
          
          state.lastRunApify = Date.now();
          await writeDurableIngestionState(state);
        }

        // Source routes use the same durable lease/window/counter contract as
        // the native adapters. Seed the complete portfolio before claiming so
        // no route is polled once per loop or hidden behind a resettable file
        // timestamp. Low-signal routes return explicit disabled evidence.
        const routeActionBySource: Record<string, (request: Request) => Promise<Response>> = {
          'LinkedIn (Apify)': apifySync,
          'Dice (Apify)': diceSync,
          'Reddit hiring posts': redditSync,
          'Hacker News hiring thread': hnSync,
          'GitHub hiring issues': githubSync,
        };
        const routeSources = ROUTE_SOURCE_TASK_DEFINITIONS.map((definition) => ({
          ...definition,
          action: routeActionBySource[definition.spec.source],
        }));
        const routeSourceByKey = new Map(routeSources.map((source) => [buildIngestionTaskKey(source.spec), source]));
        const dueRouteSourceSpecs = await orderDueIngestionTaskSpecs(routeSources.map((source) => source.spec));
        for (const spec of dueRouteSourceSpecs) {
          if (ac.signal.aborted || await pipelineStopRequested()) break;
          const routeSource = routeSourceByKey.get(buildIngestionTaskKey(spec));
          if (!routeSource) continue;
          latestIngestion = `Ingestion: ${routeSource.spec.source}...`; updateCombinedTicker();
          await runDurableRouteSource(routeSource.spec, routeSource.intervalMs, routeSource.action);
        }

        // 2. CareerForce tasks carry their own 12-hour nextRunAt.
        if (!ac.signal.aborted && !await pipelineStopRequested()) {
          if (ac.signal.aborted || await pipelineStopRequested()) break;
          for (const definition of careerForceTaskDefinitions()) {
            if (ac.signal.aborted || await pipelineStopRequested()) break;
            const query = definition.spec.searchQuery || 'sales';
            latestIngestion = `Ingestion: CareerForce Search for "${query}" (12h)...`; updateCombinedTicker();
            await runDurableIngestionTask(definition.spec, definition.intervalMs, async (claim) => {
              await ingestJobs(
                (msg) => { latestIngestion = `Ingestion CareerForce (${query}): ${msg}`; updateCombinedTicker(); },
                ac.signal,
                [],
                query,
                'pending_af',
                true,
                {
                  useStandard: false,
                  usePaidApis: false,
                  useCareerforce: true,
                  sourceAllowList: ['CareerForce'],
                  queryFamily: normalizeQueryFamily(query),
                  geoLane: 'minnesota',
                  taskId: claim.task.id,
                  taskKey: claim.task.taskKey,
                  taskLeaseToken: claim.leaseToken,
                  taskWindowStart: claim.window.windowStart,
                  taskWindowEnd: claim.window.windowEnd,
                  taskCadenceMs: definition.intervalMs,
                  taskProvider: definition.spec.source,
                },
              );
            });
          }
        }

        // 3. Paid tasks carry source-specific durable nextRunAt/budget state.
        if (!ac.signal.aborted && !await pipelineStopRequested()) {
          if (ac.signal.aborted || await pipelineStopRequested()) break;
          // High-travel and channel-language discovery receives a bounded,
          // explicit share of body-aware quota; LinkedIn is title-only.
          const paidRuns = paidTaskDefinitions();
          const paidRunByKey = new Map(paidRuns.map((run) => [buildIngestionTaskKey(run.spec), run]));
          const orderedPaidSpecs = await orderDueIngestionTaskSpecs(paidRuns.map((run) => run.spec));
          for (const spec of orderedPaidSpecs) {
            if (ac.signal.aborted || await pipelineStopRequested()) break;
            const run = paidRunByKey.get(buildIngestionTaskKey(spec));
            if (!run) continue;
            const { provider, query, familyPrefix, intervalMs } = run;
            const lane = GEO_LANES.find((candidate) => candidate.id === spec.geoLane);
            if (!lane) continue;
            const queryFamily = spec.queryFamily || normalizeQueryFamily(query);
            latestIngestion = `Ingestion: ${provider} ${lane.label} — "${query}"...`; updateCombinedTicker();
            await runDurableIngestionTask(spec, intervalMs, async (claim) => {
              await ingestJobs(
                (msg) => { latestIngestion = `${provider} (${lane.id}/${query}): ${msg}`; updateCombinedTicker(); },
                ac.signal,
                [],
                query,
                'pending_af',
                true,
                {
                  useStandard: false,
                  usePaidApis: true,
                  useCareerforce: false,
                  skipTitleOnlySources: familyPrefix !== '',
                  sourceAllowList: [provider],
                  queryFamily,
                  geoLane: lane.id,
                  taskId: claim.task.id,
                  taskKey: claim.task.taskKey,
                  taskLeaseToken: claim.leaseToken,
                  taskWindowStart: claim.window.windowStart,
                  taskWindowEnd: claim.window.windowEnd,
                  taskCadenceMs: intervalMs,
                  taskProvider: spec.source,
                },
              );
            });
          }

        }

        // 4. Free/source-feed tasks carry their own 8/12/24-hour cadences.
        if (!ac.signal.aborted && !await pipelineStopRequested()) {
          if (ac.signal.aborted || await pipelineStopRequested()) break;
          
          // These four route handlers are migrated to durable source-specific
          // task claims below; do not poll them directly on every loop.

          const runStandardProvider = async (
            provider: string,
            queries: readonly string[],
            lanes: readonly { id: string; label: string }[],
            intervalMs: number,
            queryIndependent = false,
          ) => {
            const runs = standardProviderTaskDefinitions({
              provider,
              queries,
              lanes,
              intervalMs,
              queryIndependent,
            }).map((definition) => ({
              ...definition,
              lane: lanes.find((candidate) => candidate.id === definition.spec.geoLane),
              query: definition.spec.searchQuery || 'sales',
            })).filter((run): run is typeof run & { lane: { id: string; label: string } } => Boolean(run.lane));
            const byKey = new Map(runs.map((run) => [buildIngestionTaskKey(run.spec), run]));
            const ordered = await orderDueIngestionTaskSpecs(runs.map((run) => run.spec));
            for (const spec of ordered) {
              if (ac.signal.aborted || await pipelineStopRequested()) return;
              const run = byKey.get(buildIngestionTaskKey(spec));
              if (!run) continue;
              const { lane, query } = run;
              const queryFamily = spec.queryFamily || (queryIndependent ? 'all' : normalizeQueryFamily(query));
              latestIngestion = `Ingestion: ${provider} ${lane.label} — "${query}"...`; updateCombinedTicker();
              await runDurableIngestionTask(spec, intervalMs, async (claim) => {
                  await ingestJobs(
                    (msg) => { latestIngestion = `${provider} (${lane.id}/${query}): ${msg}`; updateCombinedTicker(); },
                    ac.signal,
                    [],
                    query,
                    'pending_af',
                    true,
                    {
                      useStandard: true,
                      usePaidApis: false,
                      useCareerforce: false,
                      sourceAllowList: [provider],
                      queryFamily,
                      geoLane: lane.id,
                      taskId: claim.task.id,
                      taskKey: claim.task.taskKey,
                      taskLeaseToken: claim.leaseToken,
                      taskWindowStart: claim.window.windowStart,
                      taskWindowEnd: claim.window.windowEnd,
                      taskCadenceMs: intervalMs,
                      taskProvider: spec.source,
                      includeQueryIndependentSources: queryIndependent,
                    },
                  );
              });
            }
          };
          const sourceFeedLane = [{ id: 'source_feed', label: 'source-owned coverage' }] as const;
          const remoteLane = GEO_LANES.filter((lane) => lane.id === 'us_remote');

          // Source-specific refresh cadences: no multi-provider task can let one
          // source failure move another source's watermark.
          await runStandardProvider('TheMuse', ['sales'], sourceFeedLane, 24 * 60 * 60 * 1000, true);
          await runStandardProvider('Arbeitnow', ['sales'], sourceFeedLane, 24 * 60 * 60 * 1000, true);
          await runStandardProvider('WeWorkRemotely', ['sales'], remoteLane, 24 * 60 * 60 * 1000, true);
          // Free, keyless remote feeds; one request each per interval.
          await runStandardProvider('RemoteOK', ['sales'], remoteLane, 12 * 60 * 60 * 1000, true);
          await runStandardProvider('Jobicy', ['sales'], remoteLane, 12 * 60 * 60 * 1000, true);
          await runStandardProvider('Himalayas', primaryQueries, remoteLane, 24 * 60 * 60 * 1000);
          await runStandardProvider('Remotive', primaryQueries, remoteLane, 24 * 60 * 60 * 1000);
          await runStandardProvider('BioSpace', primaryQueries, sourceFeedLane, 8 * 60 * 60 * 1000);
          await runStandardProvider('Dejobs', primaryQueries, sourceFeedLane, 12 * 60 * 60 * 1000);
          if (process.env.CAREERONESTOP_USER_ID && process.env.CAREERONESTOP_API_TOKEN) {
            // CareerOneStop is deliberately a one-request/day canary until its
            // yield and description quality are measured against the existing
            // portfolio. Do not multiply it across every title and geo lane.
            const careerOneStopCanaryLane = GEO_LANES.filter((lane) => lane.id === 'msp_metro');
            await runStandardProvider('CareerOneStop', ['channel sales'], careerOneStopCanaryLane, 24 * 60 * 60 * 1000);
          }
          if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) {
            await runStandardProvider('Adzuna', primaryQueries, GEO_LANES, 24 * 60 * 60 * 1000);
          }
          if (process.env.USAJOBS_API_KEY && process.env.USAJOBS_USER_AGENT) {
            // One bounded, source-specific canary for USAJOBS' categorical
            // TravelPercentage=8 bucket (76% or greater). It runs before the
            // broader title portfolio so high-travel discovery has a small,
            // deterministic share instead of being starved by suffix order.
            const usaJobsTravelSpec = USAJOBS_TRAVEL_TASK_DEFINITION.spec;
            await runDurableIngestionTask(usaJobsTravelSpec, USAJOBS_TRAVEL_TASK_DEFINITION.intervalMs, async (claim) => {
              await ingestJobs(
                (msg) => { latestIngestion = `USAJOBS travel canary: ${msg}`; updateCombinedTicker(); },
                ac.signal,
                [],
                'channel sales',
                'pending_af',
                true,
                {
                  useStandard: true,
                  usePaidApis: false,
                  useCareerforce: false,
                  sourceAllowList: ['USAJOBS'],
                  queryFamily: 'travel_76_percent_or_greater',
                  geoLane: 'minnesota',
                  taskId: claim.task.id,
                  taskKey: claim.task.taskKey,
                  taskLeaseToken: claim.leaseToken,
                  taskWindowStart: claim.window.windowStart,
                  taskWindowEnd: claim.window.windowEnd,
                  taskCadenceMs: USAJOBS_TRAVEL_TASK_DEFINITION.intervalMs,
                  taskProvider: usaJobsTravelSpec.source,
                  usaJobsTravelPercentage: '8',
                },
              );
            });
            await runStandardProvider('USAJOBS', primaryQueries, GEO_LANES, 24 * 60 * 60 * 1000);
          }


          latestIngestion = 'Ingestion: Checking for expired Cooldown jobs...'; updateCombinedTicker();
          try { await processCooldownJobs((msg) => { latestIngestion = `Ingestion: ${msg}`; updateCombinedTicker(); }); } catch (error) { recordWarning('Cooldown processing', error); }

          latestIngestion = 'Ingestion: Verifying liveliness of inbox jobs...'; updateCombinedTicker();
          try {
            const { verifyInboxJobsAlive } = await import('@/lib/verifyJobsAlive');
            await verifyInboxJobsAlive((msg) => { latestIngestion = `Ingestion: ${msg}`; updateCombinedTicker(); });
          } catch (error) { recordWarning('Job verification', error); }

          latestIngestion = 'Ingestion: Checking Inbox review window...'; updateCombinedTicker();
          try {
            const { expireStaleInboxJobs } = await import('@/lib/inboxEnteredAt');
            await expireStaleInboxJobs((msg) => { latestIngestion = `Ingestion: ${msg}`; updateCombinedTicker(); });
          } catch (error) { recordWarning('Inbox review window', error); }

        }

        // Heartbeat while idle
        latestIngestion = 'Ingestion: Idle (Sleeping)'; updateCombinedTicker();
        await waitForPipelineDelay(15 * 60 * 1000, ac.signal); // Sleep for 15 minutes before checking again
      }
    };

    // 2. Loop JD Extraction
    const runJDExtraction = async () => {
      let jdLoopCount = 0;
      while (true) {
        if (ac.signal.aborted || await pipelineStopRequested()) break;
        // A service restart can interrupt an extraction after its lease is
        // claimed. Release only leases older than the bounded batch window,
        // while still charging the failed attempt.
        const staleLeaseCutoff = new Date(Date.now() - 5 * 60 * 1000);
        await prisma.job.updateMany({
          where: {
            scoringStatus: 'needs_jd',
            jdBatchId: { not: null },
            status: { in: ['pending_af', 'inbox'] },
            scoreAttempts: { lt: 2 },
            updatedAt: { lt: staleLeaseCutoff },
          },
          data: {
            jdBatchId: null,
            scoreAttempts: { increment: 1 },
            scoreError: 'JD recovery lease expired after an interrupted batch.',
          },
        });
        await prisma.job.updateMany({
          where: {
            scoringStatus: 'needs_jd',
            jdBatchId: { not: null },
            status: { in: ['pending_af', 'inbox'] },
            scoreAttempts: { gte: 2 },
            updatedAt: { lt: staleLeaseCutoff },
          },
          data: {
            jdBatchId: null,
            ...buildTerminalJdRecoveryUpdate('JD recovery lease expired after an interrupted batch.'),
          },
        });
        const needsJdCount = await prisma.job.count({ 
            where: { scoringStatus: 'needs_jd', jdBatchId: null, status: { in: ['pending_af', 'inbox'] }, scoreAttempts: { lt: 3 } }
        });
        const processingJdCount = await prisma.job.count({
          where: { scoringStatus: 'needs_jd', jdBatchId: { not: null }, status: { in: ['pending_af', 'inbox'] } }
        });

        if (needsJdCount === 0 && processingJdCount === 0) {
          // Heartbeat while idle
          latestJD = `JD Extraction: 0 queued`;
          updateCombinedTicker();
          await waitForPipelineDelay(15_000, ac.signal);
          continue;
        }
        
        if (jdLoopCount > 60) {
          // Reset loop count if we are actively making progress, else just warn
          jdLoopCount = 0;
        }

        latestJD = `JD Extraction: ${needsJdCount} queued, ${processingJdCount} processing`;
        updateCombinedTicker();

        if (needsJdCount > 0 && processingJdCount === 0) {
          const req = new Request('https://internal-pipeline/api/jobs/batch-jd-submit', {
            method: 'POST',
            signal: ac.signal,
          });
          try {
            const response = await jdSubmitPost(req);
            if (!response.ok) {
              const body = await response.text().catch(() => '');
              throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
            }
          } catch (error) {
            recordWarning('JD extraction submit', error);
            latestJD = `JD Extraction: Retrying...`;
            updateCombinedTicker();
            await waitForPipelineDelay(10_000, ac.signal);
            jdLoopCount += 2;
            continue;
          }
        }

        await waitForPipelineDelay(5_000, ac.signal);
        jdLoopCount++;
      }
    };

    // 5. Stale Lease Cleanup
    const runStaleLeaseCleanup = async () => {
      while (true) {
        if (ac.signal.aborted || await pipelineStopRequested()) break;
        
        try {
          const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
          const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
          
          // Clear stale JD Batch leases
          await prisma.job.updateMany({
            where: { jdBatchId: { not: null }, updatedAt: { lt: fifteenMinutesAgo } },
            data: { jdBatchId: null }
          });
          
          const recoveredLocalScoringLeases = await recoverStaleLocalScoringLeases();
          if (recoveredLocalScoringLeases > 0) {
            console.warn(`Recovered ${recoveredLocalScoringLeases} stale local-scoring lease(s).`);
          }
          
          // Clear only legacy automated evaluation leases. Native Antigravity
          // leases are owned by a durable request and must be recovered only
          // through the manifest-aware native release path.
          await prisma.job.updateMany({
            where: {
              afBatchId: { not: null },
              AND: [
                { NOT: { afBatchId: { startsWith: 'manual_export_' } } },
                { NOT: { afBatchId: { startsWith: 'native_' } } },
              ],
              updatedAt: { lt: fifteenMinutesAgo },
            },
            data: { afBatchId: null }
          });
          
          // Clear manual_export leases older than 2 hours
          await prisma.job.updateMany({
            where: { afBatchId: { startsWith: 'manual_export_' }, updatedAt: { lt: twoHoursAgo } },
            data: { afBatchId: null }
          });

          // Run rows left open by a process that died mid-ingestion. Nothing
          // reaped these before, so they accumulated and skewed every
          // per-source success rate computed from the table.
          const reaped = await reapAbandonedIngestionRuns();
          if (reaped > 0) console.warn(`Closed ${reaped} abandoned ingestion source run(s).`);

        } catch (error) {
          recordWarning('Stale lease cleanup', error);
        }
        
        // Run cleanup every 5 minutes
        await waitForPipelineDelay(5 * 60 * 1000, ac.signal);
      }
    };

    const runLocalScoringLoop = async () => {
      while (true) {
        if (ac.signal.aborted || await pipelineStopRequested()) break;
        try {
          const processed = await scoreJobs((message) => { 
            latestLS = `Local Scoring: ${message}`; updateCombinedTicker(); 
          }, ac.signal);
          
          if (processed === 0) {
            latestLS = 'Local Scoring: Idle'; updateCombinedTicker();
            await waitForPipelineDelay(5_000, ac.signal);
          } else {
            await waitForPipelineDelay(1_000, ac.signal);
          }
        } catch (error) {
          recordWarning('Local Scoring', error);
          await waitForPipelineDelay(5_000, ac.signal);
        }
      }
    };

    // Reconcile at startup as well as at natural completion. A pipeline can run
    // continuously or be stopped for deployment, so an end-only sweep is not a
    // reliable admission boundary.
    try {
      await enforceRetroactiveCooldowns((message) => updatePipelineState({ stepProgress: message }));
    } catch (error) {
      recordWarning('Startup cooldown enforcement', error);
    }

    updatePipelineState({ currentStep: 'Evaluating', stepProgress: 'Starting concurrent evaluation phases...' });
    
    // Each loop is supervised on its own. Previously these were joined with
    // Promise.all, so the first one to throw rejected the join and took the
    // other three down with it — a provider error could stop local scoring, JD
    // extraction and lease cleanup, none of which it had anything to do with.
    // Restarts are unbounded on purpose: a permanently dead loop is the exact
    // failure being removed, and the backoff caps the cost of a hot one.
    const superviseLoop = async (name: string, loopFn: () => Promise<void>) => {
      let consecutiveFailures = 0;
      while (true) {
        if (ac.signal.aborted || await pipelineStopRequested()) return;
        try {
          await loopFn();
          return; // A clean return means the loop saw the stop itself.
        } catch (error) {
          if (ac.signal.aborted) return;
          consecutiveFailures++;
          recordWarning(`${name} loop (restart ${consecutiveFailures})`, error);
          const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.min(consecutiveFailures - 1, 6));
          await waitForPipelineDelay(backoffMs, ac.signal);
        }
      }
    };

    const atsSourceSupervisor = ATS_SPLIT_INGESTION_ENABLED
      ? superviseLoop('ATS Acquisition Process', runAtsAcquisitionProcess)
      : superviseLoop('ATS Legacy Ingestion', runLegacyAtsIngestionLoop);
    await Promise.allSettled([
      superviseLoop('Source Ingestion', runIngestionLoop),
      atsSourceSupervisor,
      // Drain synchronized split-mode batches even after the kill switch is
      // changed back. Otherwise durable work produced before fallback would
      // remain stranded forever.
      superviseLoop('ATS Batch Processing', runAtsBatchProcessingLoop),
      superviseLoop('Local Scoring', runLocalScoringLoop),
      superviseLoop('JD Extraction', runJDExtraction),
      superviseLoop('Stale Lease Cleanup', runStaleLeaseCleanup),
    ]);

    const stopped = ac.signal.aborted || await pipelineStopRequested();
    const pauseState = stopped
      ? await controlPrisma.pipelineState.findUnique({
        where: { id: 'global' },
        select: { schedulePaused: true, pausedUntil: true },
      })
      : null;
    const schedulePaused = pauseState?.schedulePaused === true;
    const pausedUntil = pauseState?.pausedUntil ?? null;
    if (!stopped) {
      try {
        await enforceRetroactiveCooldowns((message) => updatePipelineState({ stepProgress: message }));
      } catch (error) {
        recordWarning('Cooldown enforcement', error);
      }
    }

    updatePipelineState(stopped
      ? schedulePaused
        ? {
          isRunning: false,
          currentStep: 'Paused',
          stepProgress: pausedUntil
            ? `Pipeline stopped cleanly. Scheduled runs resume automatically at ${pausedUntil.toISOString()} unless resumed sooner.`
            : 'Pipeline stopped cleanly. Scheduled runs are paused until manually resumed.',
        }
        : { isRunning: false, currentStep: 'Idle', stepProgress: 'Pipeline stopped cleanly.' }
      : warningCount > 0
        ? {
          isRunning: false,
          currentStep: 'Warning',
          stepProgress: `Pipeline completed with ${warningCount} warning(s), most recent first: ${[...warnings].reverse().join(' | ').slice(0, 1500)}`,
        }
        : { isRunning: false, currentStep: 'Idle', stepProgress: 'Pipeline complete.' });

  } catch (error) {
    console.error('Pipeline failed:', error);
    updatePipelineState({ isRunning: false, currentStep: 'Error', stepProgress: String(error) });
  } finally {
    ac.abort();
    stopLockHeartbeat();
    clearActiveAbortController();
    await releaseLock();
  }
}

export async function POST(request: Request) {
  try {
    const scheduledRequest = isScheduledPipelineRequest(request);
    if (!scheduledRequest) {
      // A manual start is the explicit resume, and it clears the expiry with it.
      await controlPrisma.pipelineState.upsert({
        where: { id: 'global' },
        update: { schedulePaused: false, pausedUntil: null },
        create: { id: 'global', schedulePaused: false, pausedUntil: null },
      });
    }

    const releaseLock = await tryAcquirePipelineLock(
      controlPrisma,
      Date.now(),
      { requireScheduleEnabled: scheduledRequest },
    );
    if (!releaseLock) {
       if (scheduledRequest) {
         const paused = await controlPrisma.pipelineState.findUnique({
           where: { id: 'global' },
           select: { schedulePaused: true, pausedUntil: true },
         });
         // Only report a pause that is actually still holding the scheduler;
         // an elapsed one did not cause this refusal.
         const pauseInForce = paused?.schedulePaused === true
           && !(paused.pausedUntil != null && paused.pausedUntil.getTime() <= Date.now());
         if (pauseInForce) {
           return NextResponse.json({
             message: 'Pipeline schedule is paused.',
             paused: true,
             pausedUntil: paused?.pausedUntil?.toISOString() ?? null,
           });
         }
       }
       return NextResponse.json({ message: 'Pipeline already running' }, { status: 400 });
    }

    try {
      updatePipelineState({ isRunning: true, currentStep: 'Starting...', stepProgress: 'Initializing pipeline' });
    } catch (error) {
      await releaseLock();
      throw error;
    }
    
    // Spawn background promise (fire and forget)
    orchestratePipeline(releaseLock).catch(console.error);

    return NextResponse.json({ message: 'Pipeline started in background' });
  } catch (error: unknown) {
    return NextResponse.json({ error: 'Failed to start pipeline', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
