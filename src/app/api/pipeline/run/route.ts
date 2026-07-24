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
import { processCooldownJobs, enforceRetroactiveCooldowns } from '@/lib/cooldownRecovery';
import { isDeepseekOffPeak } from '@/lib/timeUtils';

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
    let latestDS = 'AI Evaluation: Idle';
    let latestWC = 'Wildcard: Idle';
    
    const updateCombinedTicker = () => {
      updatePipelineState({
        currentStep: 'Pipeline Active (Concurrent)',
        stepProgress: `${latestIngestion} | ${latestLS} | ${latestJD} | ${latestDS} | ${latestWC}`
      });
    };

    const runIngestionLoop = async () => {
      while (true) {
        if (ac.signal.aborted || !readPipelineState().isRunning) break;

        const state = readIngestionState();
        if (Date.now() - state.lastRunTimestamp > 24 * 60 * 60 * 1000) {
          state.lastCompletedStepIndex = -1;
        }

        const steps: { id: string, run: () => Promise<void> }[] = [
          {
            id: 'Apify job sync',
            run: async () => {
              latestIngestion = 'Ingestion: Running Apify Job Sync...'; updateCombinedTicker();
              await runRouteStep('Apify job sync', apifySync);
            }
          },
          {
            id: 'Apify profile sync',
            run: async () => {
              latestIngestion = 'Ingestion: Running Apify LinkedIn Profiles Sync...'; updateCombinedTicker();
              await runRouteStep('Apify profile sync', apifyProfilesSync);
            }
          },
          {
            id: 'Reddit sync',
            run: async () => {
              latestIngestion = 'Ingestion: Running Reddit Job Sync...'; updateCombinedTicker();
              await runRouteStep('Reddit sync', redditSync);
            }
          },
          {
            id: 'Hacker News sync',
            run: async () => {
              latestIngestion = 'Ingestion: Running Hacker News Job Sync...'; updateCombinedTicker();
              await runRouteStep('Hacker News sync', hnSync);
            }
          },
          {
            id: 'GitHub sync',
            run: async () => {
              latestIngestion = 'Ingestion: Running GitHub Job Sync...'; updateCombinedTicker();
              await runRouteStep('GitHub sync', githubSync);
            }
          },
          {
            id: 'Cooldown processing',
            run: async () => {
              latestIngestion = 'Ingestion: Checking for expired Cooldown jobs...'; updateCombinedTicker();
              try {
                await processCooldownJobs((message) => { latestIngestion = `Ingestion: ${message}`; updateCombinedTicker(); });
              } catch (error) {
                recordWarning('Cooldown processing', error);
              }
            }
          },
          {
            id: 'Job verification',
            run: async () => {
              latestIngestion = 'Ingestion: Verifying liveliness of inbox jobs...'; updateCombinedTicker();
              try {
                const { verifyInboxJobsAlive } = await import('@/lib/verifyJobsAlive');
                await verifyInboxJobsAlive((message) => { latestIngestion = `Ingestion: ${message}`; updateCombinedTicker(); });
              } catch (error) {
                recordWarning('Job verification', error);
              }
            }
          }
        ];

        const primaryQueries = ['sales', 'customer success', 'customer success manager', 'channel sales', 'channel sales manager', 'distribution sales', 'distribution sales manager'];
        for (const query of primaryQueries) {
          steps.push({
            id: `ATS Search: ${query}`,
            run: async () => {
              latestIngestion = `Ingestion: ATS Search for "${query}"...`; updateCombinedTicker();
              await ingestJobs((msg) => {
                latestIngestion = `Ingestion ATS (${query}): ${msg}`; updateCombinedTicker();
              }, ac.signal, [], query, 'inbox', false);
            }
          });
        }
        
        // 1b. Wildcard Ingestion
        const wildcardQueries = ['strategy', 'growth', 'operations', 'founding', 'special projects'];
        for (const query of wildcardQueries) {
          steps.push({
            id: `Wildcard Search: ${query}`,
            run: async () => {
              latestIngestion = `Ingestion: Wildcard Search "${query}"...`; updateCombinedTicker();
              await ingestJobs((msg) => {
                latestIngestion = `Ingestion Wildcard (${query}): ${msg}`; updateCombinedTicker();
              }, ac.signal, undefined, query, 'pending_af', true);
            }
          });
        }

        // Local Triage has been extracted to its own concurrent loop

        for (let i = 0; i < steps.length; i++) {
          if (ac.signal.aborted || !readPipelineState().isRunning) break;
          if (i <= state.lastCompletedStepIndex) continue;

          await steps[i].run();

          state.lastCompletedStepIndex = i;
          state.lastRunTimestamp = Date.now();
          writeIngestionState(state);
        }

        if (ac.signal.aborted || !readPipelineState().isRunning) break;

        // Reset state for next iteration
        state.lastCompletedStepIndex = -1;
        state.lastRunTimestamp = Date.now();
        writeIngestionState(state);
        
        // Heartbeat while idle
        latestIngestion = 'Ingestion: Idle (Sleeping)'; updateCombinedTicker();
        await new Promise(r => setTimeout(r, 15 * 60 * 1000)); // Sleep for 15 minutes before running ingestions again
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

    // 3. AI Evaluation (DeepSeek)
    const runDeepseekLoop = async () => {
      let consecutiveDeepseekErrors = 0;
      while (true) {
         if (ac.signal.aborted || !readPipelineState().isRunning) break;
         const pendingAfCount = await prisma.job.count({
            where: { status: { in: ['inbox', 'pending_af'] }, scoringStatus: 'scored', afBatchId: null, aimFitScore: null }
         });
         const contextUpdateCount = await prisma.job.count({
            where: { status: { in: ['passed', 'applied'] }, contextBatched: false, description: { not: '' } }
         });

         if (pendingAfCount === 0 && contextUpdateCount === 0) {
           // Heartbeat while idle
           latestDS = `AI Evaluation: 0 queued`;
           updateCombinedTicker();
           await new Promise(r => setTimeout(r, 15000));
           continue;
         }
         
         const { isOffPeak, reason } = isDeepseekOffPeak();
         if (!isOffPeak) {
           latestDS = `AI Evaluation: Paused for Peak Hours (${reason})`;
           updateCombinedTicker();
           await new Promise(r => setTimeout(r, 60000)); // Sleep for 1 minute
           continue;
         }

         latestDS = `AI Evaluation: ${pendingAfCount} jobs, ${contextUpdateCount} context updates queued`;
         updateCombinedTicker();
         try {
           const { runDeepseekEvaluation } = await import('@/lib/deepseekEvaluator');
           
           const batchPromises = [];
           // Calculate how many batches to run concurrently (up to 3, 5 jobs each)
           const numBatches = Math.min(3, Math.ceil(pendingAfCount / 5) || 1);
           
           for (let i = 0; i < numBatches; i++) {
             batchPromises.push(
               (async () => {
                 // Stagger batch starts by 1.5 seconds to prevent race conditions on Prisma candidate fetching
                 if (i > 0) await new Promise(r => setTimeout(r, i * 1500));
                 return runDeepseekEvaluation((msg) => {
                   latestDS = `AI Evaluation [Batch ${i + 1}/${numBatches}]: ${msg}`;
                   updateCombinedTicker();
                 });
               })()
             );
           }
           
           const results = await Promise.allSettled(batchPromises);
           const rejections = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
           if (rejections.length > 0) {
             throw rejections[0].reason;
           }
           consecutiveDeepseekErrors = 0; // Reset on success
         } catch (err: unknown) {
           consecutiveDeepseekErrors++;
           recordWarning('DeepSeek evaluation', err);
           
           const backoffTime = Math.min(1000 * Math.pow(2, consecutiveDeepseekErrors), 60000);
           latestDS = `AI Evaluation: Retrying in ${backoffTime / 1000}s`;
           updateCombinedTicker();
           await new Promise(r => setTimeout(r, backoffTime));
           
           if (consecutiveDeepseekErrors >= 10) {
             recordWarning('DeepSeek evaluation', new Error('Too many consecutive DeepSeek errors, sleeping before retry.'));
             await new Promise(r => setTimeout(r, 60000)); // Sleep on persistent error, don't break
             consecutiveDeepseekErrors = 0; // Reset and try again
           }
           continue;
         }
         
         await new Promise(r => setTimeout(r, 2000));
      }
    };

    // 4. Wildcard Evaluation
    const runWildcardLoop = async () => {
      let consecutiveWildcardErrors = 0;
      while (true) {
         if (ac.signal.aborted || !readPipelineState().isRunning) break;
         const pendingWildcardCount = await prisma.job.count({
            where: {
              luckyStatus: 'pending',
              status: 'dismissed',
              jdBatchId: null,
              batchJobId: null,
              afBatchId: null,
            }
         });

         if (pendingWildcardCount === 0) {
           // Heartbeat while idle
           latestWC = `Wildcard: 0 queued`;
           updateCombinedTicker();
           await new Promise(r => setTimeout(r, 15000));
           continue;
         }
         
         const { isOffPeak, reason } = isDeepseekOffPeak();
         if (!isOffPeak) {
           latestWC = `Wildcard: Paused for Peak Hours (${reason})`;
           updateCombinedTicker();
           await new Promise(r => setTimeout(r, 60000)); // Sleep for 1 minute
           continue;
         }

         latestWC = `Wildcard: ${pendingWildcardCount} jobs queued`;
         updateCombinedTicker();
         try {
           const { runLuckyEvaluation } = await import('@/lib/luckyEvaluator');
           await runLuckyEvaluation((msg) => {
             latestWC = `Wildcard: ${msg}`;
             updateCombinedTicker();
           });
           consecutiveWildcardErrors = 0; // Reset on success
         } catch (err: unknown) {
           consecutiveWildcardErrors++;
           recordWarning('Wildcard evaluation', err);
           
           const backoffTime = Math.min(1000 * Math.pow(2, consecutiveWildcardErrors), 60000);
           latestWC = `Wildcard: Retrying in ${backoffTime / 1000}s`;
           updateCombinedTicker();
           await new Promise(r => setTimeout(r, backoffTime));
           
           if (consecutiveWildcardErrors >= 10) {
             recordWarning('Wildcard evaluation', new Error('Too many consecutive Wildcard errors, sleeping before retry.'));
             await new Promise(r => setTimeout(r, 60000));
             consecutiveWildcardErrors = 0; // Reset and try again
           }
           continue;
         }
         
         await new Promise(r => setTimeout(r, 2000));
      }
    };

    // 5. Stale Lease Cleanup
    const runStaleLeaseCleanup = async () => {
      while (true) {
        if (ac.signal.aborted || !readPipelineState().isRunning) break;
        
        try {
          // A lease is stale if it's older than 15 minutes.
          const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
          
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
          
          // Clear stale AI Evaluation leases
          await prisma.job.updateMany({
            where: { afBatchId: { not: null }, updatedAt: { lt: fifteenMinutesAgo } },
            data: { afBatchId: null }
          });
          
          // Clear stale Wildcard leases
          await prisma.job.updateMany({
            where: { luckyBatchId: { not: null }, luckyStatus: 'scoring', updatedAt: { lt: fifteenMinutesAgo } },
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
      safeLoop(runDeepseekLoop), 
      safeLoop(runWildcardLoop),
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
