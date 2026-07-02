import { NextResponse } from 'next/server';
import { runDiscovery, setLogger, cancelDiscovery } from '../../../../scripts/discoverATS';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

const LOG_FILE = path.join(process.cwd(), 'data', 'discover_logs.txt');

// Track state in the Node process global so it persists across API requests
const globalState = global as any;

export async function GET() {
  let logs: string[] = [];
  try {
    if (fs.existsSync(LOG_FILE)) {
      const content = fs.readFileSync(LOG_FILE, 'utf-8');
      logs = content.split('\n').filter(Boolean);
      // Keep only last 200 lines to keep the UI snappy
      logs = logs.slice(-200);
    }
  } catch (e) {
    // Ignore read errors
  }

  return NextResponse.json({
    isRunning: !!globalState.isDiscoveryRunning,
    logs,
  });
}

export async function POST() {
  try {
    if (globalState.isDiscoveryRunning) {
      return NextResponse.json({ error: 'Discovery is already running' }, { status: 400 });
    }

    globalState.isDiscoveryRunning = true;
    
    // Ensure data dir exists
    const dataDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Reset log file
    fs.writeFileSync(LOG_FILE, '[System] Starting Native ATS Discovery Process...\n');

    setLogger((msg: string) => {
      try {
        fs.appendFileSync(LOG_FILE, msg + '\n');
      } catch(e) {}
    });

    // Run in background (do not await)
    runDiscovery()
      .then(() => {
        fs.appendFileSync(LOG_FILE, '\n[Discovery process completed successfully]\n');
      })
      .catch((err: any) => {
        fs.appendFileSync(LOG_FILE, `\n[Process error: ${err.message}]\n`);
      })
      .finally(() => {
        globalState.isDiscoveryRunning = false;
        setLogger(null);
      });

    return NextResponse.json({ status: 'started' });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, stack: e.stack }, { status: 500 });
  }
}

export async function DELETE() {
  if (globalState.isDiscoveryRunning) {
    cancelDiscovery();
    fs.appendFileSync(LOG_FILE, '\n[System] Discovery process cancelled by user.\n');
    globalState.isDiscoveryRunning = false;
  }
  return NextResponse.json({ status: 'stopped' });
}
