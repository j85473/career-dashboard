import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { prisma } from './prisma';

export type PipelineStateClient = Pick<PrismaClient, 'pipelineState'>;

// Heartbeats ride the ticker, which updates every few seconds, so a lock this
// old belongs to a dead process. Recovering in five minutes beats thirty
// minutes of nobody being able to start a run.
export const PIPELINE_LOCK_STALE_MS = 5 * 60 * 1000;
// A host running the old file-lock code still mirrors lastUpdated as it works.
// Treating that as a live run is what stops a second pipeline being launched
// on top of it before every host has deployed this change.
export const PIPELINE_ACTIVITY_FRESH_MS = 2 * 60 * 1000;
// How long an ordinary Stop holds the schedule before it lapses. Long enough to
// cover a working session; short enough that a Stop nobody remembers costs an
// evening rather than the days it used to. An explicitly indefinite Stop is a
// separate mode and never lapses.
export const PIPELINE_PAUSE_DEFAULT_MS = Number.parseInt(
  process.env.PIPELINE_PAUSE_DEFAULT_MS || String(6 * 60 * 60 * 1000),
  10,
);

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
const LOCK_TIMEOUT_MS = 30 * 60 * 1000;
let ownedLockToken: string | null = null;

type PipelineRuntimeGlobal = typeof globalThis & {
  __careerDashboardPipelineAbortController?: AbortController;
};

const pipelineRuntime = globalThis as PipelineRuntimeGlobal;

/**
 * Registers the controller owned by this server process. The database stop
 * flag remains the cross-host authority; this local mirror lets the stop route
 * interrupt fetches and sleeps immediately when it lands on the owning host.
 *
 * Returns null when this process already owns a live pipeline. Registering
 * unconditionally used to overwrite the previous run's controller, so a Stop
 * reached only the newer loop and the older one kept running untracked, still
 * holding task leases.
 */
export function registerActivePipelineAbortController(controller: AbortController): (() => void) | null {
  const existing = pipelineRuntime.__careerDashboardPipelineAbortController;
  if (existing && !existing.signal.aborted && existing !== controller) return null;
  pipelineRuntime.__careerDashboardPipelineAbortController = controller;
  return () => {
    if (pipelineRuntime.__careerDashboardPipelineAbortController === controller) {
      delete pipelineRuntime.__careerDashboardPipelineAbortController;
    }
  };
}

/**
 * Refreshes the lock lease on its own clock.
 *
 * The heartbeat used to ride `updatePipelineState`, which only fires when a
 * progress message is emitted. A legitimately quiet stretch — a 10-minute ATS
 * turn, a 10-minute scraper spawn — looked identical to a dead process, so the
 * lock went stale and another caller started a second pipeline on top of the
 * first.
 */
export function startPipelineLockHeartbeat(
  client: PipelineStateClient = prisma,
  intervalMs = 30_000,
): () => void {
  const timer = setInterval(() => {
    const token = ownedLockToken;
    if (!token) return;
    void client.pipelineState.updateMany({
      where: { id: 'global', lockToken: token },
      data: { lockHeartbeatAt: new Date() },
    }).catch((error: unknown) => console.error('Failed to refresh pipeline lock heartbeat:', error));
  }, intervalMs);
  // Never hold the process open on the heartbeat alone.
  timer.unref?.();
  return () => clearInterval(timer);
}

export function abortActivePipeline(reason = 'Pipeline stop requested.'): boolean {
  const controller = pipelineRuntime.__careerDashboardPipelineAbortController;
  if (!controller || controller.signal.aborted) return false;
  controller.abort(new Error(reason));
  return true;
}

/** A timer that resolves early when a pipeline stop aborts its owner. */
export async function waitForPipelineDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

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
  
  // Mirror to the database for cross-host visibility, and carry the lock
  // heartbeat with it: the ticker updates every few seconds, which is exactly
  // the cadence the lease needs. Only the owner refreshes its own lock.
  const heldToken = ownedLockToken;
  const mirrored = {
    isRunning: next.isRunning,
    currentStep: next.currentStep,
    stepProgress: next.stepProgress,
    lastUpdated: new Date(next.lastUpdated),
  };
  prisma.pipelineState.upsert({
    where: { id: 'global' },
    update: mirrored,
    create: { id: 'global', ...mirrored },
  })
    .then(() => {
      if (!next.isRunning || !heldToken) return;
      return prisma.pipelineState.updateMany({
        where: { id: 'global', lockToken: heldToken },
        data: { lockHeartbeatAt: new Date() },
      });
    })
    .catch((err) => console.error('Failed to sync pipeline state to DB:', err));

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
 * Cross-host lock. The Mac and the Pi share one database but not a filesystem,
 * so the lock has to live where both can see it.
 */
export async function tryAcquirePipelineLock(
  client: PipelineStateClient = prisma,
  now: number = Date.now(),
  options: { requireScheduleEnabled?: boolean } = {},
): Promise<(() => Promise<void>) | null> {
  // The claim below is a conditional update, so the row has to exist first.
  await client.pipelineState.upsert({
    where: { id: 'global' },
    update: {},
    create: { id: 'global' },
  });

  const token = randomUUID();
  const staleBefore = new Date(now - PIPELINE_LOCK_STALE_MS);
  const activeSince = new Date(now - PIPELINE_ACTIVITY_FRESH_MS);

  const claimed = await client.pipelineState.updateMany({
    where: {
      id: 'global',
      AND: [
        // Free, or abandoned by a process that stopped heartbeating.
        {
          OR: [
            { lockToken: null },
            { lockHeartbeatAt: null },
            { lockHeartbeatAt: { lt: staleBefore } },
          ],
        },
        // A scheduled start is refused while a pause is in force. An expired
        // pause is not in force: a Stop nobody ever resumed used to keep the
        // scheduler off forever, silently, because this was a bare boolean.
        // A NULL `pausedUntil` under a pause is deliberate and still blocks.
        ...(options.requireScheduleEnabled
          ? [{ OR: [{ schedulePaused: false }, { pausedUntil: { lte: new Date(now) } }] }]
          : []),
      ],
      // A host still reporting progress holds the pipeline even when it wrote
      // no lock, which is how a not-yet-deployed host is respected.
      NOT: { isRunning: true, lastUpdated: { gte: activeSince } },
    },
    data: {
      lockToken: token,
      lockOwner: `${os.hostname()}:${process.pid}`,
      lockHeartbeatAt: new Date(now),
      // Claiming the pipeline settles the pause either way, so an expired pause
      // does not linger in the UI as though it were still holding anything.
      schedulePaused: false,
      pausedUntil: null,
    },
  });
  if (claimed.count !== 1) return null;

  ownedLockToken = token;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      // Token-guarded so a lock reclaimed by another host after this one went
      // stale is never deleted by the original owner.
      await client.pipelineState.updateMany({
        where: { id: 'global', lockToken: token },
        data: { lockToken: null, lockOwner: null, lockHeartbeatAt: null },
      });
    } finally {
      if (ownedLockToken === token) ownedLockToken = null;
    }
  };
}

let stopCheckCache: { at: number; running: boolean } | null = null;

/**
 * Whether a stop has been requested, read from the shared row so a Stop pressed
 * on either host reaches the host actually running the loop. Called from tight
 * loops, so results are cached briefly.
 */
export async function pipelineStopRequested(
  client: PipelineStateClient = prisma,
  now: number = Date.now(),
): Promise<boolean> {
  if (stopCheckCache && now - stopCheckCache.at < 3_000) return !stopCheckCache.running;
  try {
    const row = await client.pipelineState.findUnique({
      where: { id: 'global' },
      select: { isRunning: true },
    });
    stopCheckCache = { at: now, running: row?.isRunning !== false };
    return !stopCheckCache.running;
  } catch {
    // A connection blip must not abort a multi-hour ingestion. A genuine
    // outage still ends the run: the heartbeat stops and the lock expires.
    return false;
  }
}
