import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';

import type { AtsAcquisitionBackpressureTelemetry } from './atsAcquisition';

/**
 * Cap the acquisition child's V8 old space.
 *
 * Node sizes its default heap from detected memory, which on the 4 GB Pi is
 * roughly two gigabytes -- more than half the machine, and far more than this
 * worker legitimately needs. The v2 ledger deliberately works in bounded quanta
 * and never accumulates a board payload, so a heap this size buys nothing and
 * simply lets slow growth push a host that is already in swap further into it.
 *
 * The default is deliberately generous. Old space is only part of resident
 * memory -- the Node binary, Prisma's native engine, and buffers sit outside
 * it -- so a cap read off an RSS figure would sit far below the real ceiling
 * and abort a worker that was behaving. 1 GB stays clear of the ~550 MB
 * resident set observed on the Pi while still halving the default.
 *
 * Lower ATS_ACQUISITION_WORKER_HEAP_MB only against measured heap, never RSS;
 * exceeding the cap aborts the child rather than degrading it.
 */
export const ATS_ACQUISITION_WORKER_HEAP_MB = Math.max(256, Math.min(
  2_048,
  Number.parseInt(process.env.ATS_ACQUISITION_WORKER_HEAP_MB || '1024', 10) || 1024,
));
export const ATS_ACQUISITION_DATABASE_CONNECTION_LIMIT = 4;
export const ATS_ACQUISITION_DATABASE_POOL_TIMEOUT_SECONDS = 5;
export const ATS_ACQUISITION_DATABASE_CONNECT_TIMEOUT_SECONDS = 5;
export const ATS_ACQUISITION_WORKER_STOP_GRACE_MS = 15_000;
export const ATS_ACQUISITION_WORKER_TERM_GRACE_MS = 5_000;

export type AtsAcquisitionParentMessage = {
  type: 'stop';
  reason: string;
};

export type AtsAcquisitionWorkerMessage =
  | { type: 'ready'; role: 'ats-acquisition'; pid: number }
  | { type: 'progress'; role: 'ats-acquisition'; pid: number; message: string }
  | ({ type: 'backpressure'; role: 'ats-acquisition'; pid: number } & AtsAcquisitionBackpressureTelemetry)
  | { type: 'warning'; role: 'ats-acquisition'; pid: number; message: string }
  | { type: 'fatal'; role: 'ats-acquisition'; pid: number; message: string }
  | {
      type: 'stopped';
      role: 'ats-acquisition';
      pid: number;
      reason: 'stop-requested' | 'parent-disconnect' | 'signal';
    };

export type AtsAcquisitionWorkerLaunchConfig = {
  executable: string;
  workerPath: string;
  args: string[];
  options: SpawnOptions;
};

export type AtsAcquisitionWorkerExit = {
  pid: number;
  reason: AtsAcquisitionWorkerMessage & { type: 'stopped' };
};

type SpawnImplementation = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

/** Give acquisition a separate, deliberately bounded Prisma data pool. */
export function buildAtsAcquisitionDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  }
  url.searchParams.set('connection_limit', String(ATS_ACQUISITION_DATABASE_CONNECTION_LIMIT));
  url.searchParams.set('pool_timeout', String(ATS_ACQUISITION_DATABASE_POOL_TIMEOUT_SECONDS));
  url.searchParams.set('connect_timeout', String(ATS_ACQUISITION_DATABASE_CONNECT_TIMEOUT_SECONDS));
  return url.toString();
}

export function buildAtsAcquisitionWorkerLaunchConfig(input: {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  workerPath?: string;
} = {}): AtsAcquisitionWorkerLaunchConfig {
  const cwd = input.cwd || process.cwd();
  const environment = input.environment || process.env;
  if (!environment.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to start the ATS acquisition worker.');
  }
  const workerPath = input.workerPath || path.resolve(cwd, 'scripts/workers/ats-acquisition.ts');
  return {
    executable: process.execPath,
    workerPath,
    // Use an ordinary Node spawn rather than child_process.fork. Next 16.3's
    // Turbopack treats a dynamic fork target as a module dependency and refuses
    // the absolute runtime path during production builds. Spawn preserves the
    // attached IPC channel without asking the bundler to resolve the worker.
    args: [`--max-old-space-size=${ATS_ACQUISITION_WORKER_HEAP_MB}`, '--import', 'tsx', workerPath],
    options: {
      cwd,
      detached: false,
      shell: false,
      serialization: 'json',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        ...environment,
        DATABASE_URL: buildAtsAcquisitionDatabaseUrl(environment.DATABASE_URL),
        PIPELINE_WORKER_ROLE: 'ats-acquisition',
      },
    },
  };
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

function isOptionalAdmissionState(value: unknown): boolean {
  return value === undefined || value === 'open' || value === 'draining';
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

function hasValidPersistenceBreakdown(message: Record<string, unknown>): boolean {
  const legacy = message.legacyPersistenceJobs;
  const v2 = message.v2PersistenceJobs;
  if (legacy === undefined && v2 === undefined) return true;
  return isOptionalCount(legacy)
    && isOptionalCount(v2)
    && typeof legacy === 'number'
    && typeof v2 === 'number'
    && typeof message.remainingJobs === 'number'
    && legacy + v2 === message.remainingJobs;
}

function isWorkerMessage(value: unknown): value is AtsAcquisitionWorkerMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const message = value as Record<string, unknown>;
  const type = message.type;
  if (type === 'backpressure') {
    return typeof message.active === 'boolean'
      && typeof message.remainingJobs === 'number'
      && Number.isInteger(message.remainingJobs)
      && message.remainingJobs >= 0
      && typeof message.highWatermark === 'number'
      && Number.isInteger(message.highWatermark)
      && message.highWatermark > 0
      && typeof message.lowWatermark === 'number'
      && Number.isInteger(message.lowWatermark)
      && message.lowWatermark >= 0
      && message.lowWatermark < message.highWatermark
      // The acquisition-stage sums are reported alongside the gate, not part of
      // it. Accept a message that omits them so a version-skewed child cannot
      // blank the whole backpressure lane over a purely descriptive field.
      && isOptionalCount(message.enrichmentJobs)
      && isOptionalCount(message.listingJobs)
      && isOptionalCount(message.compactionJobs)
      && isOptionalCount(message.publicationJobs)
      && hasValidPersistenceBreakdown(message)
      && isOptionalAdmissionState(message.admissionState)
      && (message.publicationPaused === undefined || typeof message.publicationPaused === 'boolean')
      && isOptionalTimestamp(message.observedAt);
  }
  return type === 'ready'
    || type === 'progress'
    || type === 'warning'
    || type === 'fatal'
    || type === 'stopped';
}

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
};

function childExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve) => {
    let settled = false;
    let childError: Error | null = null;
    child.once('error', (error) => {
      childError = error;
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, error: childError });
    });
  });
}

async function exitsWithin(exitPromise: Promise<ChildExit>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([exitPromise.then(() => true as const), timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

function sendStop(child: ChildProcess, reason: string): void {
  if (!child.connected) return;
  const message: AtsAcquisitionParentMessage = { type: 'stop', reason };
  child.send(message, () => {
    // A close between the connected check and send is an expected stop race.
  });
}

/**
 * Stop only the attached worker we launched. The child first receives a
 * structured stop request so it can durably finish its current board receipt;
 * SIGTERM and SIGKILL are bounded fallbacks. This promise does not resolve
 * until the exact child has closed.
 */
async function stopAttachedChild(
  child: ChildProcess,
  exitPromise: Promise<ChildExit>,
  reason: string,
  stopGraceMs: number,
  termGraceMs: number,
): Promise<void> {
  sendStop(child, reason);
  if (await exitsWithin(exitPromise, stopGraceMs)) return;
  child.kill('SIGTERM');
  if (await exitsWithin(exitPromise, termGraceMs)) return;
  child.kill('SIGKILL');
  await exitPromise;
}

export type RunAtsAcquisitionWorkerProcessOptions = {
  signal: AbortSignal;
  shouldStop: () => Promise<boolean>;
  onReady?: (pid: number) => void;
  onProgress?: (pid: number, message: string) => void;
  onBackpressure?: (pid: number, telemetry: AtsAcquisitionBackpressureTelemetry) => void;
  onWarning?: (pid: number, message: string) => void;
  onFatal?: (pid: number, message: string) => void;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  workerPath?: string;
  stopGraceMs?: number;
  termGraceMs?: number;
  spawnImplementation?: SpawnImplementation;
};

/**
 * Run one attached acquisition worker. Unexpected exit rejects only after the
 * old PID is closed; the route's ordinary loop supervisor can then start one,
 * and only one, replacement process.
 */
export async function runAtsAcquisitionWorkerProcess(
  input: RunAtsAcquisitionWorkerProcessOptions,
): Promise<AtsAcquisitionWorkerExit> {
  const launch = buildAtsAcquisitionWorkerLaunchConfig(input);
  const child = (input.spawnImplementation || spawn)(launch.executable, launch.args, launch.options);
  if (!child.pid) {
    child.kill('SIGKILL');
    throw new Error('ATS acquisition worker did not expose a child PID.');
  }
  if (child.pid === process.pid) {
    child.kill('SIGKILL');
    throw new Error('ATS acquisition worker was not isolated in a different OS process.');
  }

  const pid = child.pid;
  const exitPromise = childExit(child);
  let fatalMessage: string | null = null;
  let stoppedMessage: (AtsAcquisitionWorkerMessage & { type: 'stopped' }) | null = null;
  let stopPromise: Promise<void> | null = null;
  const beginStop = (reason: string) => {
    stopPromise ||= stopAttachedChild(
      child,
      exitPromise,
      reason,
      input.stopGraceMs ?? ATS_ACQUISITION_WORKER_STOP_GRACE_MS,
      input.termGraceMs ?? ATS_ACQUISITION_WORKER_TERM_GRACE_MS,
    );
  };
  const abortListener = () => beginStop('pipeline-abort');
  input.signal.addEventListener('abort', abortListener, { once: true });

  child.on('message', (message: unknown) => {
    if (!isWorkerMessage(message)) {
      input.onWarning?.(pid, 'Ignored malformed ATS acquisition worker IPC message.');
      return;
    }
    if (message.pid !== pid || message.role !== 'ats-acquisition') {
      input.onWarning?.(pid, 'Ignored ATS acquisition worker IPC message with mismatched identity.');
      return;
    }
    if (message.type === 'ready') input.onReady?.(pid);
    if (message.type === 'progress') input.onProgress?.(pid, message.message);
    if (message.type === 'backpressure') {
      input.onBackpressure?.(pid, {
        active: message.active,
        remainingJobs: message.remainingJobs,
        highWatermark: message.highWatermark,
        lowWatermark: message.lowWatermark,
        enrichmentJobs: message.enrichmentJobs ?? 0,
        listingJobs: message.listingJobs ?? 0,
        compactionJobs: message.compactionJobs ?? 0,
        publicationJobs: message.publicationJobs ?? 0,
        admissionState: message.admissionState,
        publicationPaused: message.publicationPaused ?? false,
        legacyPersistenceJobs: message.legacyPersistenceJobs,
        v2PersistenceJobs: message.v2PersistenceJobs,
        observedAt: message.observedAt,
      });
    }
    if (message.type === 'warning') input.onWarning?.(pid, message.message);
    if (message.type === 'fatal') {
      fatalMessage = message.message;
      input.onFatal?.(pid, message.message);
    }
    if (message.type === 'stopped') stoppedMessage = message;
  });

  if (input.signal.aborted) beginStop('pipeline-abort');
  const exit = await exitPromise;
  input.signal.removeEventListener('abort', abortListener);
  if (stopPromise) await stopPromise;

  const stopRequested = input.signal.aborted || await input.shouldStop().catch(() => false);
  // EventEmitter callbacks run outside TypeScript's linear control-flow model;
  // retain the runtime-updated message rather than narrowing the outer let to
  // its initial null value after the close await.
  const finalStoppedMessage = stoppedMessage as (AtsAcquisitionWorkerMessage & { type: 'stopped' }) | null;
  if (finalStoppedMessage && (finalStoppedMessage.reason === 'stop-requested' || stopRequested)) {
    return { pid, reason: finalStoppedMessage };
  }
  if (stopRequested) {
    return {
      pid,
      reason: { type: 'stopped', role: 'ats-acquisition', pid, reason: 'stop-requested' },
    };
  }

  const detail = fatalMessage
    || exit.error?.message
    || `exit code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'}`;
  throw new Error(`ATS acquisition worker PID ${pid} exited unexpectedly (${detail}).`);
}
