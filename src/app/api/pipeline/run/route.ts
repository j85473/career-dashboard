import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import fs from 'fs';
import path from 'path';

// Import our logic functions directly
import { ingestJobs } from '@/lib/jobIngestion';
import { scoreJobs } from '@/lib/jobScoring';

// Import the App Router endpoints for JD Extraction
import { POST as jdSubmitPost } from '../../jobs/batch-jd-submit/route';

const STATE_FILE = path.join(process.cwd(), '.pipeline_state.json');

function updateState(state: any) {
  try {
    let current = {};
    if (fs.existsSync(STATE_FILE)) {
      current = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...current, ...state, lastUpdated: Date.now() }));
  } catch (e) {
    console.error('Failed to update pipeline state', e);
  }
}

import { GET as apifySync } from '../apify/route';
import { GET as redditSync } from '../reddit/route';
import { GET as hnSync } from '../hackernews/route';

async function orchestratePipeline() {
  try {
    // 1. Native API Ingestions (Apify, Reddit, Hacker News)
    updateState({ currentStep: 'Ingestion', stepProgress: 'Running Apify Job Sync...', isRunning: true });
    
    try {
      await apifySync();
    } catch (e) { console.error('Apify sync failed:', e); }
      
    updateState({ stepProgress: 'Running Reddit Job Sync...' });
    try {
      await redditSync();
    } catch (e) { console.error('Reddit sync failed:', e); }
      
    updateState({ stepProgress: 'Running Hacker News Job Sync...' });
    try {
      await hnSync();
    } catch (e) { console.error('HN sync failed:', e); }
      
    updateState({ stepProgress: 'Native syncs complete. Running ats-search logic...' });
    
    const ac = new AbortController();
    await ingestJobs((msg) => {
      updateState({ stepProgress: msg });
    }, ac.signal, []);
    
    // 1b. Wildcard Ingestion
    updateState({ currentStep: 'Wildcard Ingestion', stepProgress: 'Running broad wildcard searches...' });
    const wildcardQueries = ['strategy', 'growth', 'operations', 'founding', 'special projects'];
    for (const query of wildcardQueries) {
      if (ac.signal.aborted) break;
      updateState({ stepProgress: `Wildcard: Searching "${query}"...` });
      await ingestJobs((msg) => {
        updateState({ stepProgress: `Wildcard (${query}): ${msg}` });
      }, ac.signal, undefined, query, 'pending_af', true);
    }
    
    // 2. Loop JD Extraction
    updateState({ currentStep: 'JD Extraction', stepProgress: 'Submitting and polling for JD Extraction...' });
    let jdLoopCount = 0;
    while (true) {
      const needsJdCount = await prisma.job.count({ 
        where: { scoringStatus: 'needs_jd', jdBatchId: null, status: { notIn: ['passed', 'dismissed', 'applied', 'archived'] }, scoreAttempts: { lt: 3 } } 
      });
      const processingJdCount = await prisma.job.count({
        where: { scoringStatus: 'needs_jd', jdBatchId: { not: null }, status: { notIn: ['passed', 'dismissed', 'applied', 'archived'] } }
      });

      if (needsJdCount === 0 && processingJdCount === 0) {
        break; // Done with JD Extraction
      }
      if (jdLoopCount > 60) {
        console.warn('JD Extraction loop timed out after 5 minutes.');
        break; // Prevent infinite loop if jobs get stuck in processing
      }

      updateState({ stepProgress: `JD Extraction: ${needsJdCount} queued, ${processingJdCount} processing...` });

      if (needsJdCount > 0) {
        const req = new Request('https://internal-pipeline/api/jobs/batch-jd-submit', { method: 'POST' });
        await jdSubmitPost(req).catch(console.error);
      }


      await new Promise(r => setTimeout(r, 5000));
      jdLoopCount++;
    }

    // 3. AI Evaluation (DeepSeek)
    updateState({ currentStep: 'AI Evaluation', stepProgress: 'Running DeepSeek A/E scoring...' });
    let aiComplete = false;
    while (!aiComplete) {
       const pendingAfCount = await prisma.job.count({
          where: { status: 'pending_af', scoringStatus: 'scored', afBatchId: null }
       });
       const contextUpdateCount = await prisma.job.count({
          where: { status: { in: ['passed', 'applied'] }, contextBatched: false, description: { not: '' } }
       });

       if (pendingAfCount === 0 && contextUpdateCount === 0) {
         break;
       }
       
       updateState({ stepProgress: `AI Evaluation: ${pendingAfCount} jobs, ${contextUpdateCount} context updates queued...` });
       try {
         const { runDeepseekEvaluation } = await import('@/lib/deepseekEvaluator');
         const res = await runDeepseekEvaluation((msg) => {
           updateState({ stepProgress: `AI Evaluation: ${msg}` });
         });
         // If no jobs were processed or an error occurred that didn't throw, prevent infinite loop
         if (res.scoresProcessed === 0 && res.contextJobsProcessed === 0 && !res.contextUpdated) {
            break;
         }
       } catch (err: any) {
         console.error('DeepSeek Evaluation Error:', err);
         updateState({ stepProgress: `AI Evaluation Error: ${err.message}` });
         break; // Stop loop on error
       }
       
       await new Promise(r => setTimeout(r, 2000));
    }

    // 4. Wildcard Evaluation
    updateState({ currentStep: 'Wildcard Evaluation', stepProgress: 'Running Wildcard scoring...' });
    let wildcardComplete = false;
    while (!wildcardComplete) {
       const pendingWildcardCount = await prisma.job.count({
          where: { luckyStatus: 'pending' }
       });

       if (pendingWildcardCount === 0) {
         break;
       }
       
       updateState({ stepProgress: `Wildcard Evaluation: ${pendingWildcardCount} jobs queued...` });
       try {
         const { runLuckyEvaluation } = await import('@/lib/luckyEvaluator');
         const res = await runLuckyEvaluation((msg) => {
           updateState({ stepProgress: `Wildcard Evaluation: ${msg}` });
         });
         // If no jobs were processed or an error occurred that didn't throw, prevent infinite loop
         if (res.scoresProcessed === 0) {
            break;
         }
       } catch (err: any) {
         console.error('Wildcard Evaluation Error:', err);
         updateState({ stepProgress: `Wildcard Evaluation Error: ${err.message}` });
         break; // Stop loop on error
       }
       
       await new Promise(r => setTimeout(r, 2000));
    }

    updateState({ isRunning: false, currentStep: 'Idle', stepProgress: 'Pipeline complete.' });

  } catch (error) {
    console.error('Pipeline failed:', error);
    updateState({ isRunning: false, currentStep: 'Error', stepProgress: String(error) });
  }
}

export async function POST() {
  try {
    let current: any = { isRunning: false };
    if (fs.existsSync(STATE_FILE)) {
      current = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    
    if (current.isRunning && (Date.now() - (current.lastUpdated || 0)) < 1000 * 60 * 30) {
       return NextResponse.json({ message: 'Pipeline already running' }, { status: 400 });
    }

    updateState({ isRunning: true, currentStep: 'Starting...', stepProgress: 'Initializing pipeline' });
    
    // Spawn background promise (fire and forget)
    orchestratePipeline().catch(console.error);

    return NextResponse.json({ message: 'Pipeline started in background' });
  } catch (e: any) {
    return NextResponse.json({ error: 'Failed to start pipeline', details: e.message }, { status: 500 });
  }
}
