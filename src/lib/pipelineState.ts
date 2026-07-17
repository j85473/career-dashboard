import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type PipelineState = {
  isRunning: boolean;
  currentStep: string;
  stepProgress: string;
  lastUpdated: number;
};

// This is runtime state, not a build input. Keep Turbopack from tracing the
// project root while still resolving the same absolute path in production.
const RUNTIME_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'runtime');
const STATE_FILE = process.env.PIPELINE_STATE_FILE || path.join(RUNTIME_DIR, 'pipeline-state.json');
const LOCK_FILE = `${STATE_FILE}.lock`;
const LOCK_TIMEOUT_MS = 30 * 60 * 1000;
let ownedLockToken: string | null = null;

const IDLE_STATE: PipelineState = {
  isRunning: false,
  currentStep: 'Idle',
  stepProgress: 'No pipeline run has started.',
  lastUpdated: 0,
};

function ensureRuntimeDirectory() {
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(STATE_FILE), { recursive: true });
}

export function readPipelineState(): PipelineState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ STATE_FILE, 'utf8'),
    ) as Partial<PipelineState>;
    return {
      isRunning: parsed.isRunning === true,
      currentStep: typeof parsed.currentStep === 'string' ? parsed.currentStep : IDLE_STATE.currentStep,
      stepProgress: typeof parsed.stepProgress === 'string' ? parsed.stepProgress : IDLE_STATE.stepProgress,
      lastUpdated: typeof parsed.lastUpdated === 'number' ? parsed.lastUpdated : 0,
    };
  } catch {
    return { ...IDLE_STATE };
  }
}

export function updatePipelineState(patch: Partial<Omit<PipelineState, 'lastUpdated'>>): PipelineState {
  ensureRuntimeDirectory();
  const next: PipelineState = {
    ...readPipelineState(),
    ...patch,
    lastUpdated: Date.now(),
  };
  const temporaryFile = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(/* turbopackIgnore: true */ temporaryFile, JSON.stringify(next));
  fs.renameSync(/* turbopackIgnore: true */ temporaryFile, STATE_FILE);
  if (next.isRunning) {
    try {
      const lockContents = fs.readFileSync(/* turbopackIgnore: true */ LOCK_FILE, 'utf8');
      if (ownedLockToken && lockContents.startsWith(`${ownedLockToken}\n`)) {
        const now = new Date();
        fs.utimesSync(/* turbopackIgnore: true */ LOCK_FILE, now, now);
      }
    } catch {
      // Status can be updated outside an active lock during recovery.
    }
  }
  return next;
}

export function markTimedOutPipeline(): PipelineState {
  const current = readPipelineState();
  if (!current.isRunning || Date.now() - current.lastUpdated <= LOCK_TIMEOUT_MS) return current;
  return updatePipelineState({
    isRunning: false,
    currentStep: 'Error',
    stepProgress: 'Pipeline timed out or crashed.',
  });
}

/**
 * Cross-request/process lock for the single-machine Pi deployment. A stale lock
 * is reclaimed after the same timeout used by pipeline status.
 */
export function tryAcquirePipelineLock(): (() => void) | null {
  ensureRuntimeDirectory();

  try {
    const age = Date.now() - fs.statSync(/* turbopackIgnore: true */ LOCK_FILE).mtimeMs;
    const state = readPipelineState();
    
    // If the internal state says the pipeline is NOT running, or the lock is very old (e.g. Next.js crashed), break the lock.
    if (!state.isRunning || age > LOCK_TIMEOUT_MS) {
      fs.unlinkSync(/* turbopackIgnore: true */ LOCK_FILE);
      console.log('Broke stale pipeline lock.');
    }
  } catch {
    // A missing lock is the normal case.
  }

  const token = randomUUID();
  try {
    const descriptor = fs.openSync(/* turbopackIgnore: true */ LOCK_FILE, 'wx');
    fs.writeFileSync(descriptor, `${token}\n${process.pid}\n${Date.now()}\n`);
    fs.closeSync(descriptor);
    ownedLockToken = token;
  } catch {
    return null;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const lockContents = fs.readFileSync(/* turbopackIgnore: true */ LOCK_FILE, 'utf8');
      if (lockContents.startsWith(`${token}\n`)) {
        fs.unlinkSync(/* turbopackIgnore: true */ LOCK_FILE);
      }
    } catch {
      // Already released or cleaned up after a crash.
    } finally {
      if (ownedLockToken === token) ownedLockToken = null;
    }
  };
}
