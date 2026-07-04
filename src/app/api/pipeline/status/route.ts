import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join(process.cwd(), '.pipeline_state.json');

export async function GET() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      
      // If it's been running for more than 30 mins without updates, assume it died
      if (state.isRunning && (Date.now() - (state.lastUpdated || 0)) > 1000 * 60 * 30) {
        state.isRunning = false;
        state.currentStep = 'Error';
        state.stepProgress = 'Pipeline timed out or crashed.';
      }

      return NextResponse.json(state);
    }
    return NextResponse.json({ isRunning: false, currentStep: 'Idle', stepProgress: 'No state found' });
  } catch (e: any) {
    return NextResponse.json({ isRunning: false, error: e.message });
  }
}
