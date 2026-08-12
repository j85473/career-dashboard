import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { tryAcquirePipelineLock, updatePipelineState, pipelineStopRequested } from '@/lib/pipelineState';
import { readDurableIngestionState, writeDurableIngestionState } from '@/lib/ingestionState';

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
  GEO_LANES,
  ingestionReconciles,
  normalizeQueryFamily,
  orderDueIngestionTaskSpecs,
  type IngestionCounters,
  type IngestionTaskSpec,
} from '@/lib/ingestionControl';
import { createNativeScoringRequest } from '@/lib/nativeScoringRequest';
import { AUTO_NATIVE_SCORING_POLL_MS, shouldAutoRequestNativeScoring } from '@/lib/nativeScoringAutoRequest';
import {
  NATIVE_AE_TASK_DEFINITION,
  ROUTE_SOURCE_TASK_DEFINITIONS,
  USAJOBS_TRAVEL_TASK_DEFINITION,
  atsPlatformTaskDefinition,
  careerForceTaskDefinitions,
  paidTaskDefinitions,
  standardProviderTaskDefinitions,
} from '@/lib/ingestionTaskCatalog';


async function orchestratePipeline(releaseLock: () => void) {
  const warnings: string[] = [];
  const recordWarning = (step: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${step}: ${message}`);
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
  try {
    
    let latestIngestion = 'Ingestion: Starting...';
    let latestLS = 'Local Scoring: Idle';
    let latestJD = 'JD Extraction: Idle';
    
    const updateCombinedTicker = () => {
      updatePipelineState({
        currentStep: 'Pipeline Active (Concurrent)',
        stepProgress: `${latestIngestion} | ${latestLS} | ${latestJD}`
      });
    };

    const runDurableIngestionTask = async (
      spec: IngestionTaskSpec,
      intervalMs: number,
      action: (claim: NonNullable<Awaited<ReturnType<typeof claimDueIngestionTask>>>, nextRunAt: Date) => Promise<void>,
    ) => {
      const claim = await claimDueIngestionTask(spec);
      if (!claim) return false;
      const nextRunAt = new Date(Date.now() + intervalMs);
      try {
        await action(claim, nextRunAt);
      } catch (error) {
        await completeIngestionTask({
          taskId: claim.task.id,
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
          nextRunAt: new Date(Date.now() + Math.min(intervalMs, 30 * 60 * 1000)),
          error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        });
        throw error;
      }
      return true;
    };

    const runDurableRouteSource = async (
      spec: IngestionTaskSpec,
      intervalMs: number,
      action: (request: Request) => Promise<Response>,
    ) => runDurableIngestionTask(spec, intervalMs, async (claim, nextRunAt) => {
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
        leaseToken: claim.leaseToken,
        status: taskStatus,
        counters,
        nextRunAt: taskStatus === 'succeeded' || taskStatus === 'disabled'
          ? nextRunAt
          : new Date(Date.now() + Math.min(intervalMs, 30 * 60 * 1000)),
        watermarkAt: claim.window.windowEnd,
        cursor: { phase: 'finished', sourceStatus: payload?.ingestionStatus || null },
        error: payload?.details || payload?.error || null,
      });
      if (!response.ok) {
        recordWarning(spec.source, payload?.details || payload?.error || `HTTP ${response.status}`);
      }
    });

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
            const query = definition.spec.searchQuery || 'sales';
            latestIngestion = `Ingestion: CareerForce Search for "${query}" (12h)...`; updateCombinedTicker();
            await runDurableIngestionTask(definition.spec, definition.intervalMs, async (claim, nextRunAt) => {
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
                  taskLeaseToken: claim.leaseToken,
                  taskWindowStart: claim.window.windowStart,
                  taskWindowEnd: claim.window.windowEnd,
                  taskNextRunAt: nextRunAt,
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
            await runDurableIngestionTask(spec, intervalMs, async (claim, nextRunAt) => {
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
                  taskLeaseToken: claim.leaseToken,
                  taskWindowStart: claim.window.windowStart,
                  taskWindowEnd: claim.window.windowEnd,
                  taskNextRunAt: nextRunAt,
                },
              );
            });
          }

        }

        // 4. ATS APIs. Only boards whose nextCheckDate is due are selected;
        // blacklisted/parked boards in backoff are never swept early. Durable
        // task nextRunAt, not the legacy portfolio timestamp, owns cadence.
        if (!ac.signal.aborted && !await pipelineStopRequested()) {
          if (ac.signal.aborted || await pipelineStopRequested()) break;
          try {
            const dueBoards = await prisma.atsCompany.findMany({
              where: {
                status: { in: ['active', 'parked', 'blacklisted'] },
                nextCheckDate: { lte: new Date() },
              },
              orderBy: [{ nextCheckDate: 'asc' }, { slug: 'asc' }],
              take: 1_000,
              select: { slug: true, platform: true },
            });
            const boardsByPlatform = new Map<string, typeof dueBoards>();
            for (const board of dueBoards) {
              const group = boardsByPlatform.get(board.platform) || [];
              group.push(board);
              boardsByPlatform.set(board.platform, group);
            }
            for (const [platform, boards] of boardsByPlatform) {
              const atsDefinition = atsPlatformTaskDefinition(platform);
              await runDurableIngestionTask(atsDefinition.spec, atsDefinition.intervalMs, async (claim, nextRunAt) => {
                latestIngestion = `Ingestion: ${boards.length} due ${platform} boards...`; updateCombinedTicker();
                await ingestJobs(
                  (msg) => { latestIngestion = `Ingestion ATS-${platform}: ${msg}`; updateCombinedTicker(); },
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
                    taskLeaseToken: claim.leaseToken,
                    taskWindowStart: claim.window.windowStart,
                    taskWindowEnd: claim.window.windowEnd,
                    taskNextRunAt: nextRunAt,
                  },
                );
              });
            }
          } catch (error) {
            recordWarning('ATS ingestion', error);
          }
        }

        // 5. Free/source-feed tasks carry their own 8/12/24-hour cadences.
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
              await runDurableIngestionTask(spec, intervalMs, async (claim, nextRunAt) => {
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
                      taskLeaseToken: claim.leaseToken,
                      taskWindowStart: claim.window.windowStart,
                      taskWindowEnd: claim.window.windowEnd,
                      taskNextRunAt: nextRunAt,
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
            await runDurableIngestionTask(usaJobsTravelSpec, USAJOBS_TRAVEL_TASK_DEFINITION.intervalMs, async (claim, nextRunAt) => {
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
                  taskLeaseToken: claim.leaseToken,
                  taskWindowStart: claim.window.windowStart,
                  taskWindowEnd: claim.window.windowEnd,
                  taskNextRunAt: nextRunAt,
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

        }

        // Heartbeat while idle
        latestIngestion = 'Ingestion: Idle (Sleeping)'; updateCombinedTicker();
        await new Promise(r => setTimeout(r, 15 * 60 * 1000)); // Sleep for 15 minutes before checking again
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
            scoreAttempts: 3,
            scoringStatus: 'failed',
            status: 'dismissed',
            scoreError: 'JD recovery lease expired after an interrupted batch.',
            passReason: 'JD recovery failed after 3 attempts. Manual review required.',
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
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }
        
        if (jdLoopCount > 60) {
          // Reset loop count if we are actively making progress, else just warn
          jdLoopCount = 0;
        }

        latestJD = `JD Extraction: ${needsJdCount} queued, ${processingJdCount} processing`;
        updateCombinedTicker();

        if (needsJdCount > 0 && processingJdCount === 0) {
          const req = new Request('https://internal-pipeline/api/jobs/batch-jd-submit', { method: 'POST' });
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
            await new Promise(r => setTimeout(r, 10000));
            jdLoopCount += 2;
            continue;
          }
        }

        await new Promise(r => setTimeout(r, 5000));
        jdLoopCount++;
      }
    };

    const runAutomaticNativeScoring = async () => {
      while (true) {
        if (ac.signal.aborted || await pipelineStopRequested()) break;
        const claim = await claimDueIngestionTask(
          NATIVE_AE_TASK_DEFINITION.spec,
          { defaultLookbackMs: AUTO_NATIVE_SCORING_POLL_MS },
        );
        if (!claim) {
          await new Promise((resolve) => setTimeout(resolve, 15_000));
          continue;
        }
        const checkedAt = new Date();
        try {
          const eligibleWhere = {
            status: 'pending_af',
            scoringStatus: 'scored',
            aimFitScore: null,
            jdBatchId: null,
            batchJobId: null,
            afBatchId: null,
          } as const;
          const [activeRequest, eligibleCount, oldestEligible] = await Promise.all([
            prisma.nativeScoringRequest.findUnique({ where: { activeKey: 'global' } }),
            prisma.job.count({ where: eligibleWhere }),
            prisma.job.findFirst({
              where: eligibleWhere,
              orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
              select: { updatedAt: true },
            }),
          ]);
          const decision = shouldAutoRequestNativeScoring({
            eligibleCount,
            oldestEligibleAt: oldestEligible?.updatedAt,
            activeRequestStatus: activeRequest?.status,
            now: checkedAt,
          });
          if (decision.create) {
            // `resumeFailed:false` keeps hard failures visible in Action Needed
            // instead of retrying them every minute.
            await createNativeScoringRequest('pipeline', prisma, { resumeFailed: false });
          }
          await completeIngestionTask({
            taskId: claim.task.id,
            leaseToken: claim.leaseToken,
            status: 'succeeded',
            counters: {
              seen: 0,
              inserted: 0,
              duplicates: 0,
              filtered: 0,
              processingErrors: 0,
              providerErrors: 0,
              requests: decision.create ? 1 : 0,
            },
            nextRunAt: new Date(checkedAt.getTime() + AUTO_NATIVE_SCORING_POLL_MS),
            watermarkAt: checkedAt,
            cursor: {
              eligibleCount,
              oldestEligibleAt: oldestEligible?.updatedAt.toISOString() || null,
              threshold: 3,
              maxWaitMinutes: 15,
              decision: decision.reason,
              activeRequestStatus: activeRequest?.status || null,
            },
          });
        } catch (error) {
          await completeIngestionTask({
            taskId: claim.task.id,
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
            nextRunAt: new Date(Date.now() + 5 * 60 * 1000),
            error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
          });
          recordWarning('Automatic native scoring request', error);
        }
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
          
          // Clear stale Local Scoring leases
          await prisma.job.updateMany({
            where: { batchJobId: { not: null }, scoringStatus: 'scoring', updatedAt: { lt: fifteenMinutesAgo } },
            data: { batchJobId: null, scoringStatus: 'queued' }
          });
          
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

        } catch (error) {
          recordWarning('Stale lease cleanup', error);
        }
        
        // Run cleanup every 5 minutes
        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
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
            await new Promise(r => setTimeout(r, 5000));
          } else {
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch (error) {
          recordWarning('Local Scoring', error);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    };

    updatePipelineState({ currentStep: 'Evaluating', stepProgress: 'Starting concurrent evaluation phases...' });
    
    const safeLoop = (loopFn: () => Promise<void>) => loopFn().catch(e => {
      if (ac.signal.aborted) return; // Ignore errors if we're aborting
      throw e;
    });

    await Promise.all([
      safeLoop(runIngestionLoop), 
      safeLoop(runLocalScoringLoop),
      safeLoop(runJDExtraction), 
      safeLoop(runAutomaticNativeScoring),
      safeLoop(runStaleLeaseCleanup)
    ]);

    try {
      await enforceRetroactiveCooldowns((message) => updatePipelineState({ stepProgress: message }));
    } catch (error) {
      recordWarning('Cooldown enforcement', error);
    }

    updatePipelineState(warnings.length > 0
      ? {
          isRunning: false,
          currentStep: 'Warning',
          stepProgress: `Pipeline completed with ${warnings.length} warning(s): ${warnings.join(' | ').slice(0, 1500)}`,
        }
      : { isRunning: false, currentStep: 'Idle', stepProgress: 'Pipeline complete.' });

  } catch (error) {
    console.error('Pipeline failed:', error);
    updatePipelineState({ isRunning: false, currentStep: 'Error', stepProgress: String(error) });
  } finally {
    ac.abort();
    await releaseLock();
  }
}

export async function POST() {
  try {
    const releaseLock = await tryAcquirePipelineLock();
    if (!releaseLock) {
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
