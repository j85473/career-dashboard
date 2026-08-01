import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { tryAcquirePipelineLock, updatePipelineState, readPipelineState } from '@/lib/pipelineState';
import { readIngestionState, writeIngestionState } from '@/lib/ingestionState';

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

    const runIngestionLoop = async () => {
      while (true) {
        if (ac.signal.aborted || !readPipelineState().isRunning) break;

        const state = readIngestionState();
        const now = Date.now();
        const primaryQueries = ['account manager', 'territory manager', 'field sales', 'strategic account executive', 'customer success', 'customer success manager', 'channel sales', 'channel sales manager', 'distribution sales', 'distribution sales manager', 'district manager', 'regional manager'];
        const wildcardQueries = ['strategy', 'growth', 'operations', 'founding', 'special projects'];

        // 1. APIFY - Once a day (4 AM target)
        const today4am = new Date();
        today4am.setHours(4, 0, 0, 0);
        const isPast4am = now >= today4am.getTime();
        const ranTodayAfter4am = state.lastRunApify >= today4am.getTime();
        
        // If we haven't run today after 4 AM, AND it's past 4 AM (or we haven't run in 24 hours at all as a fallback)
        if ((isPast4am && !ranTodayAfter4am) || (now - state.lastRunApify > 24 * 60 * 60 * 1000)) {
          if (ac.signal.aborted || !readPipelineState().isRunning) break;
          latestIngestion = 'Ingestion: Running Apify Job Sync (Daily)...'; updateCombinedTicker();
          await runRouteStep('Apify job sync', apifySync);
          
          latestIngestion = 'Ingestion: Running Apify LinkedIn Profiles Sync (Daily)...'; updateCombinedTicker();
          await runRouteStep('Apify profile sync', apifyProfilesSync);
          
          state.lastRunApify = Date.now();
          writeIngestionState(state);
        }

        // 2. CareerForce - Twice a day (Every 12 hours)
        if (now - state.lastRunCareerforce > 12 * 60 * 60 * 1000) {
          if (ac.signal.aborted || !readPipelineState().isRunning) break;
          for (const query of primaryQueries) {
            latestIngestion = `Ingestion: CareerForce Search for "${query}" (12h)...`; updateCombinedTicker();
            await ingestJobs((msg) => { latestIngestion = `Ingestion CareerForce (${query}): ${msg}`; updateCombinedTicker(); }, ac.signal, [], query, 'inbox', true, { useStandard: false, usePaidApis: false, useCareerforce: true });
          }
          state.lastRunCareerforce = Date.now();
          writeIngestionState(state);
        }

        // 3. Paid APIs (Rapid, SerpApi) - Once a day (Every 24 hours)
        if (now - state.lastRunPaidApis > 24 * 60 * 60 * 1000) {
          if (ac.signal.aborted || !readPipelineState().isRunning) break;
          for (const query of primaryQueries) {
            latestIngestion = `Ingestion: Paid APIs Search for "${query}" (24h)...`; updateCombinedTicker();
            await ingestJobs((msg) => { latestIngestion = `Ingestion Paid APIs (${query}): ${msg}`; updateCombinedTicker(); }, ac.signal, [], query, 'inbox', true, { useStandard: false, usePaidApis: true, useCareerforce: false });
          }
          for (const query of wildcardQueries) {
            latestIngestion = `Ingestion: Paid APIs Wildcard Search "${query}" (24h)...`; updateCombinedTicker();
            await ingestJobs((msg) => { latestIngestion = `Ingestion Paid APIs Wildcard (${query}): ${msg}`; updateCombinedTicker(); }, ac.signal, [], query, 'pending_af', true, { useStandard: false, usePaidApis: true, useCareerforce: false });
          }
          state.lastRunPaidApis = Date.now();
          writeIngestionState(state);
        }

        // 4. ATS APIs - 6 times a day (Every 4 hours). Split active boards into 6 chunks.
        if (now - state.lastRunAts > 4 * 60 * 60 * 1000) {
          if (ac.signal.aborted || !readPipelineState().isRunning) break;
          try {
            const activeBoards = await prisma.atsCompany.findMany({
              where: { status: { in: ["active", "parked", "blacklisted"] } },
              orderBy: { slug: 'asc' }
            });
            const numChunks = 6;
            const chunkSize = Math.ceil(activeBoards.length / numChunks);
            const chunkIndex = state.atsIndex % numChunks;
            const targetAtsSlugs = activeBoards.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize);

            if (targetAtsSlugs.length > 0) {
              for (const query of primaryQueries) {
                latestIngestion = `Ingestion: ATS Search for "${query}" (Chunk ${chunkIndex + 1}/${numChunks})...`; updateCombinedTicker();
                await ingestJobs((msg) => { latestIngestion = `Ingestion ATS (${query}): ${msg}`; updateCombinedTicker(); }, ac.signal, targetAtsSlugs, query, 'inbox', false, { useStandard: false, usePaidApis: false, useCareerforce: false });
              }
              for (const query of wildcardQueries) {
                latestIngestion = `Ingestion: ATS Wildcard Search for "${query}" (Chunk ${chunkIndex + 1}/${numChunks})...`; updateCombinedTicker();
                await ingestJobs((msg) => { latestIngestion = `Ingestion ATS Wildcard (${query}): ${msg}`; updateCombinedTicker(); }, ac.signal, targetAtsSlugs, query, 'pending_af', false, { useStandard: false, usePaidApis: false, useCareerforce: false });
              }
            }
            state.lastRunAts = Date.now();
            state.atsIndex = (chunkIndex + 1) % numChunks;
            writeIngestionState(state);
          } catch (error) {
            recordWarning('ATS Ingestion Chunk', error);
          }
        }

        // 5. Standard Ingestion - 3 times a day (Every 8 hours)
        if (now - state.lastRunStandard > 8 * 60 * 60 * 1000) {
          if (ac.signal.aborted || !readPipelineState().isRunning) break;
          
          latestIngestion = 'Ingestion: Running Dice Job Sync...'; updateCombinedTicker();
          await runRouteStep('Dice sync', diceSync);
          latestIngestion = 'Ingestion: Running Reddit Job Sync...'; updateCombinedTicker();
          await runRouteStep('Reddit sync', redditSync);
          latestIngestion = 'Ingestion: Running Hacker News Job Sync...'; updateCombinedTicker();
          await runRouteStep('Hacker News sync', hnSync);
          latestIngestion = 'Ingestion: Running GitHub Job Sync...'; updateCombinedTicker();
          await runRouteStep('GitHub sync', githubSync);

          for (const query of primaryQueries) {
            latestIngestion = `Ingestion: Standard Free Search for "${query}" (8h)...`; updateCombinedTicker();
            await ingestJobs((msg) => { latestIngestion = `Ingestion Standard (${query}): ${msg}`; updateCombinedTicker(); }, ac.signal, [], query, 'inbox', true, { useStandard: true, usePaidApis: false, useCareerforce: false });
          }
          for (const query of wildcardQueries) {
            latestIngestion = `Ingestion: Standard Free Wildcard Search "${query}" (8h)...`; updateCombinedTicker();
            await ingestJobs((msg) => { latestIngestion = `Ingestion Standard Wildcard (${query}): ${msg}`; updateCombinedTicker(); }, ac.signal, [], query, 'pending_af', true, { useStandard: true, usePaidApis: false, useCareerforce: false });
          }

          latestIngestion = 'Ingestion: Checking for expired Cooldown jobs...'; updateCombinedTicker();
          try { await processCooldownJobs((msg) => { latestIngestion = `Ingestion: ${msg}`; updateCombinedTicker(); }); } catch (error) { recordWarning('Cooldown processing', error); }

          latestIngestion = 'Ingestion: Verifying liveliness of inbox jobs...'; updateCombinedTicker();
          try {
            const { verifyInboxJobsAlive } = await import('@/lib/verifyJobsAlive');
            await verifyInboxJobsAlive((msg) => { latestIngestion = `Ingestion: ${msg}`; updateCombinedTicker(); });
          } catch (error) { recordWarning('Job verification', error); }

          state.lastRunStandard = Date.now();
          writeIngestionState(state);
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
        if (ac.signal.aborted || !readPipelineState().isRunning) break;
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



    // 5. Stale Lease Cleanup
    const runStaleLeaseCleanup = async () => {
      while (true) {
        if (ac.signal.aborted || !readPipelineState().isRunning) break;
        
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
          
          // Clear automated AI Evaluation leases (excluding manual_export)
          await prisma.job.updateMany({
            where: { afBatchId: { not: null }, NOT: { afBatchId: { startsWith: 'manual_export_' } }, updatedAt: { lt: fifteenMinutesAgo } },
            data: { afBatchId: null }
          });
          
          // Clear automated Wildcard leases (excluding manual_export)
          await prisma.job.updateMany({
            where: { luckyBatchId: { not: null }, NOT: { luckyBatchId: { startsWith: 'manual_export_' } }, luckyStatus: 'scoring', updatedAt: { lt: fifteenMinutesAgo } },
            data: { luckyBatchId: null, luckyStatus: 'pending' }
          });

          // Clear manual_export leases older than 2 hours
          await prisma.job.updateMany({
            where: { afBatchId: { startsWith: 'manual_export_' }, updatedAt: { lt: twoHoursAgo } },
            data: { afBatchId: null }
          });

          await prisma.job.updateMany({
            where: { luckyBatchId: { startsWith: 'manual_export_' }, luckyStatus: 'scoring', updatedAt: { lt: twoHoursAgo } },
            data: { luckyBatchId: null, luckyStatus: 'pending' }
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
        if (ac.signal.aborted || !readPipelineState().isRunning) break;
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
    releaseLock();
  }
}

export async function POST() {
  try {
    const releaseLock = tryAcquirePipelineLock();
    if (!releaseLock) {
       return NextResponse.json({ message: 'Pipeline already running' }, { status: 400 });
    }

    try {
      updatePipelineState({ isRunning: true, currentStep: 'Starting...', stepProgress: 'Initializing pipeline' });
    } catch (error) {
      releaseLock();
      throw error;
    }
    
    // Spawn background promise (fire and forget)
    orchestratePipeline(releaseLock).catch(console.error);

    return NextResponse.json({ message: 'Pipeline started in background' });
  } catch (error: unknown) {
    return NextResponse.json({ error: 'Failed to start pipeline', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
