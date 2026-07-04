import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import fs from 'fs';
import path from 'path';

// Import our logic functions directly
import { ingestJobs } from '@/lib/jobIngestion';
import { scoreJobs } from '@/lib/jobScoring';

// Import the App Router endpoints for JD Extraction
import { POST as jdSubmitPost } from '../../jobs/batch-jd-submit/route';
import { GET as jdStatusGet } from '../../jobs/batch-jd-status/route';

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
        const req = new Request('http://localhost/api/jobs/batch-jd-submit', { method: 'POST' });
        await jdSubmitPost(req).catch(console.error);
      }
      
      if (processingJdCount > 0) {
        const req = new Request('http://localhost/api/jobs/batch-jd-status');
        await jdStatusGet(req).catch(console.error);
      }

      await new Promise(r => setTimeout(r, 5000));
    }

    // 3. Loop Local Heuristic Engine
    updateState({ currentStep: 'Local Scoring', stepProgress: 'Running local heuristic scoring...' });
    const scoringComplete = false;
    while (!scoringComplete) {
       const queuedScoring = await prisma.job.count({
          where: { scoringStatus: 'queued', status: { notIn: ['passed', 'dismissed', 'applied', 'archived'] } }
       });
       if (queuedScoring === 0) break;
       
       updateState({ stepProgress: `Local Scoring: ${queuedScoring} jobs queued...` });
       await scoreJobs((msg) => {
         updateState({ stepProgress: `Local Scoring: ${msg}` });
       }, ac.signal);
       
       const remaining = await prisma.job.count({
          where: { scoringStatus: 'queued', status: { notIn: ['passed', 'dismissed', 'applied', 'archived'] } }
       });
       if (remaining === 0) break;
       await new Promise(r => setTimeout(r, 2000));
    }

    updateState({ isRunning: false, currentStep: 'Idle', stepProgress: 'Pipeline paused before AI Evaluation.' });

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
