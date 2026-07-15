import { NextResponse } from 'next/server';
import { runDeepseekEvaluation } from '@/lib/deepseekEvaluator';
import fs from 'fs';
import path from 'path';

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

async function orchestrateDeepseek() {
  try {
    updateState({ isRunning: true, currentStep: 'AI Evaluation', stepProgress: 'Running DeepSeek A/E scoring...' });
    
    const aiComplete = false;
    while (!aiComplete) {
       try {
         const res = await runDeepseekEvaluation((msg) => {
           updateState({ stepProgress: `AI Evaluation: ${msg}` });
         });
         
         if (res.scoresProcessed === 0 && res.contextJobsProcessed === 0 && !res.contextUpdated) {
            break;
         }
       } catch (err: any) {
         console.error('DeepSeek Evaluation Error:', err);
         updateState({ stepProgress: `AI Evaluation Error: ${err.message}` });
         break;
       }
       
       await new Promise(r => setTimeout(r, 2000));
    }

    updateState({ isRunning: false, currentStep: 'Idle', stepProgress: 'DeepSeek evaluation complete.' });
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

    updateState({ isRunning: true, currentStep: 'Starting...', stepProgress: 'Initializing DeepSeek evaluation' });
    
    orchestrateDeepseek().catch(console.error);

    return NextResponse.json({ message: 'DeepSeek evaluation started in background' });
  } catch (error: any) {
    console.error('DeepSeek Evaluation API Error:', error);
    return NextResponse.json({ error: 'Failed to run DeepSeek evaluation', details: error.message }, { status: 500 });
  }
}
