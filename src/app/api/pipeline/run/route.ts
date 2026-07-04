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

async function orchestratePipeline() {
  try {
    // 1. Ingestion
    updateState({ currentStep: 'Ingestion', stepProgress: 'Running ats-search logic...', isRunning: true });
    
    const ac = new AbortController();
    await ingestJobs((msg) => {
      updateState({ stepProgress: msg });
    }, ac.signal, []);
    
    // 2. Loop JD Extraction
    updateState({ currentStep: 'JD Extraction', stepProgress: 'Submitting and polling for JD Extraction...' });
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

      updateState({ stepProgress: `JD Extraction: ${needsJdCount} queued, ${processingJdCount} processing...` });

      if (needsJdCount > 0) {
        const req = new Request('https://internal-pipeline/api/jobs/batch-jd-submit', { method: 'POST' });
        await jdSubmitPost(req).catch(console.error);
      }


      await new Promise(r => setTimeout(r, 5000));
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
