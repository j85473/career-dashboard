import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { tryAcquirePipelineLock, updatePipelineState } from '@/lib/pipelineState';

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
import { shouldContinueDeepseekEvaluation } from '@/lib/scoringState';

async function orchestratePipeline(releaseLock: () => void) {
  const warnings: string[] = [];
  const recordWarning = (step: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${step}: ${message}`);
    console.error(`${step} failed:`, error);
  };
  const runRouteStep = async (step: string, action: () => Promise<Response>) => {
    try {
      const response = await action();
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
      }
    } catch (error) {
      recordWarning(step, error);
    }
  };

  try {
    // 1. Native API Ingestions (Apify, Reddit, Hacker News)
    updatePipelineState({ currentStep: 'Ingestion', stepProgress: 'Running Apify Job Sync...', isRunning: true });
    
    await runRouteStep('Apify job sync', apifySync);

    updatePipelineState({ stepProgress: 'Running Apify LinkedIn Profiles Sync...' });
    await runRouteStep('Apify profile sync', apifyProfilesSync);
      
    updatePipelineState({ stepProgress: 'Running Reddit Job Sync...' });
    await runRouteStep('Reddit sync', redditSync);
      
    updatePipelineState({ stepProgress: 'Running Hacker News Job Sync...' });
    await runRouteStep('Hacker News sync', hnSync);
      
    updatePipelineState({ stepProgress: 'Running GitHub Job Sync...' });
    await runRouteStep('GitHub sync', githubSync);

    updatePipelineState({ stepProgress: 'Checking for expired Cooldown jobs...' });
    try {
      await processCooldownJobs((message) => updatePipelineState({ stepProgress: message }));
    } catch (error) {
      recordWarning('Cooldown processing', error);
    }
      
    updatePipelineState({ stepProgress: 'Native syncs complete. Running ats-search logic...' });
    
    const ac = new AbortController();
    const primaryQueries = ['sales', 'customer success', 'customer success manager', 'channel sales', 'channel sales manager', 'distribution sales', 'distribution sales manager'];
    for (const query of primaryQueries) {
      if (ac.signal.aborted) break;
      updatePipelineState({ stepProgress: `Native syncs complete. Running ats-search logic for "${query}"...` });
      await ingestJobs((msg) => {
        updatePipelineState({ stepProgress: `ATS Search (${query}): ${msg}` });
      }, ac.signal, [], query, 'inbox', false);
    }
    
    // 1b. Wildcard Ingestion
    updatePipelineState({ currentStep: 'Wildcard Ingestion', stepProgress: 'Running broad wildcard searches...' });
    const wildcardQueries = ['strategy', 'growth', 'operations', 'founding', 'special projects'];
    for (const query of wildcardQueries) {
      if (ac.signal.aborted) break;
      updatePipelineState({ stepProgress: `Wildcard: Searching "${query}"...` });
      await ingestJobs((msg) => {
        updatePipelineState({ stepProgress: `Wildcard (${query}): ${msg}` });
      }, ac.signal, undefined, query, 'pending_af', true);
    }

    // Run once before JD extraction so the local resolver can identify any
    // deceptively truncated descriptions and place them in needs_jd.
    updatePipelineState({ currentStep: 'Local Triage', stepProgress: 'Running initial deterministic triage...' });
    for (let localPass = 0; localPass < 20; localPass++) {
      const processed = await scoreJobs((message) => updatePipelineState({ stepProgress: message }), ac.signal);
      if (processed === 0) break;
    }
    
    // 2. Loop JD Extraction
    updatePipelineState({ currentStep: 'JD Extraction', stepProgress: 'Submitting and polling for JD Extraction...' });
    let jdLoopCount = 0;
    while (true) {
      const needsJdCount = await prisma.job.count({ 
          where: { scoringStatus: 'needs_jd', jdBatchId: null, status: { in: ['pending_af', 'inbox'] }, scoreAttempts: { lt: 3 } }
      });
      const processingJdCount = await prisma.job.count({
        where: { scoringStatus: 'needs_jd', jdBatchId: { not: null }, status: { in: ['pending_af', 'inbox'] } }
      });

      if (needsJdCount === 0 && processingJdCount === 0) {
        break; // Done with JD Extraction
      }
      if (jdLoopCount > 60) {
        recordWarning('JD extraction', new Error('Timed out after 5 minutes.'));
        break; // Prevent infinite loop if jobs get stuck in processing
      }

      updatePipelineState({ currentStep: 'JD Extraction', stepProgress: `JD Extraction: ${needsJdCount} queued, ${processingJdCount} processing...` });

      if (needsJdCount > 0) {
        const req = new Request('https://internal-pipeline/api/jobs/batch-jd-submit', { method: 'POST' });
        try {
          const response = await jdSubmitPost(req);
          if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
          }
          // Reset loop count if we made progress? Let's just rely on the 60 loop limit over time.
        } catch (error) {
          recordWarning('JD extraction submit', error);
          updatePipelineState({ currentStep: 'JD Extraction (Retrying)', stepProgress: `Waiting 10s before retrying JD extraction...` });
          // Wait 10 seconds on error before retrying to prevent rapid failure loop
          await new Promise(r => setTimeout(r, 10000));
          jdLoopCount += 2; // Increment loop count more for errors to ensure we don't exceed time limits
          continue;
        }
      }


      await new Promise(r => setTimeout(r, 5000));
      jdLoopCount++;
    }

    // Deterministic/local triage is intentionally separate from the DeepSeek
    // Aim/Experience score. It supplies a cheap baseline and resume suggestion
    // while leaving aimFitScore null so uncertain jobs still reach the LLM.
    updatePipelineState({ currentStep: 'Local Triage', stepProgress: 'Running deterministic local triage...' });
    for (let localPass = 0; localPass < 20; localPass++) {
      const processed = await scoreJobs((message) => updatePipelineState({ stepProgress: message }), ac.signal);
      if (processed === 0) break;
    }

    // 3. AI Evaluation (DeepSeek)
    updatePipelineState({ currentStep: 'AI Evaluation', stepProgress: 'Running DeepSeek A/E scoring...' });
    const aiComplete = false;
    let consecutiveDeepseekErrors = 0;
    while (!aiComplete) {
       const pendingAfCount = await prisma.job.count({
          where: { status: { in: ['inbox', 'pending_af'] }, scoringStatus: 'scored', afBatchId: null, aimFitScore: null }
       });
       const contextUpdateCount = await prisma.job.count({
          where: { status: { in: ['passed', 'applied'] }, contextBatched: false, description: { not: '' } }
       });

       if (pendingAfCount === 0 && contextUpdateCount === 0) {
         break;
       }
       
       updatePipelineState({ currentStep: 'AI Evaluation', stepProgress: `AI Evaluation: ${pendingAfCount} jobs, ${contextUpdateCount} context updates queued...` });
       try {
         const { runDeepseekEvaluation } = await import('@/lib/deepseekEvaluator');
         const res = await runDeepseekEvaluation((msg) => {
           updatePipelineState({ stepProgress: `AI Evaluation: ${msg}` });
         });
         consecutiveDeepseekErrors = 0; // Reset on success
         if (!shouldContinueDeepseekEvaluation(res)) {
            break;
         }
       } catch (err: unknown) {
         consecutiveDeepseekErrors++;
         recordWarning('DeepSeek evaluation', err);
         
         const backoffTime = Math.min(1000 * Math.pow(2, consecutiveDeepseekErrors), 60000);
         updatePipelineState({ currentStep: 'AI Evaluation (Retrying)', stepProgress: `Waiting ${backoffTime / 1000}s before retrying DeepSeek...` });
         await new Promise(r => setTimeout(r, backoffTime));
         
         if (consecutiveDeepseekErrors >= 10) {
           recordWarning('DeepSeek evaluation', new Error('Too many consecutive DeepSeek errors, stopping evaluation.'));
           break; // Stop loop on persistent error
         }
         continue;
       }
       
       await new Promise(r => setTimeout(r, 2000));
    }

    // 4. Wildcard Evaluation
    updatePipelineState({ currentStep: 'Wildcard Evaluation', stepProgress: 'Running Wildcard scoring...' });
    const wildcardComplete = false;
    let consecutiveWildcardErrors = 0;
    while (!wildcardComplete) {
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
         break;
       }
       
       updatePipelineState({ currentStep: 'Wildcard Evaluation', stepProgress: `Wildcard Evaluation: ${pendingWildcardCount} jobs queued...` });
       try {
         const { runLuckyEvaluation } = await import('@/lib/luckyEvaluator');
         const res = await runLuckyEvaluation((msg) => {
           updatePipelineState({ stepProgress: `Wildcard Evaluation: ${msg}` });
         });
         consecutiveWildcardErrors = 0; // Reset on success
         if (res.scoresProcessed === 0 && res.staleClaimsReleased === 0) {
            break;
         }
       } catch (err: unknown) {
         consecutiveWildcardErrors++;
         recordWarning('Wildcard evaluation', err);
         
         const backoffTime = Math.min(1000 * Math.pow(2, consecutiveWildcardErrors), 60000);
         updatePipelineState({ currentStep: 'Wildcard Evaluation (Retrying)', stepProgress: `Waiting ${backoffTime / 1000}s before retrying Wildcard...` });
         await new Promise(r => setTimeout(r, backoffTime));
         
         if (consecutiveWildcardErrors >= 10) {
           recordWarning('Wildcard evaluation', new Error('Too many consecutive Wildcard errors, stopping evaluation.'));
           break; // Stop loop on error
         }
         continue;
       }
       
       await new Promise(r => setTimeout(r, 2000));
    }

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
