import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';

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
    args: ['--import', 'tsx', workerPath],
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

function isWorkerMessage(value: unknown): value is AtsAcquisitionWorkerMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const type = (value as { type: unknown }).type;
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
