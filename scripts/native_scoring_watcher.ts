import 'dotenv/config';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { findRegisteredAgyProjectIdWithAgent } from '../src/lib/agyProject';
import { NATIVE_SCORING_EXPECTED_MODEL } from '../src/lib/nativeScoringBatch';
import { NATIVE_SCORING_STALE_AFTER_MS } from '../src/lib/nativeScoringLease';
import { currentBatchId, summarizeBatchDirectory } from '../src/lib/nativeScoringBatchProgress';

const prisma = new PrismaClient();
const projectRoot = process.cwd();
const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const staleAfterMs = NATIVE_SCORING_STALE_AFTER_MS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let stopping = false;
let activeChild: ChildProcess | null = null;

function requestStop(): void {
  stopping = true;
  if (activeChild && activeChild.exitCode === null && !activeChild.killed) {
    activeChild.kill('SIGTERM');
  }
}

function parseArguments(argv: string[]): { once: boolean; pollMs: number } {
  let once = false;
  let pollMs = 5_000;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--once') {
      once = true;
    } else if (argv[index] === '--poll-ms') {
      pollMs = Number.parseInt(argv[index + 1] || '', 10);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!Number.isInteger(pollMs) || pollMs < 1_000 || pollMs > 60_000) {
    throw new Error('--poll-ms must be between 1000 and 60000');
  }
  return { once, pollMs };
}

function agyBinary(): string {
  const configured = process.env.AGY_BIN?.trim();
  const candidate = configured || path.join(os.homedir(), '.local', 'bin', 'agy');
  if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) {
    throw new Error(`Agy CLI was not found at ${candidate}. Set AGY_BIN to its absolute path.`);
  }
  return candidate;
}

function hasNativeRunner(agyBin: string, projectId: string): boolean {
  const result = spawnSync(agyBin, ['--project', projectId, 'agents'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
  });
  return result.status === 0
    && result.stdout.split(/\r?\n/).some((line) => line.trim() === 'native-scoring-runner-v6');
}

function agyProjectId(agyBin: string): string {
  const configured = process.env.AGY_PROJECT_ID?.trim();
  if (configured) {
    if (!UUID_PATTERN.test(configured)) {
      throw new Error('AGY_PROJECT_ID must be a UUID');
    }
    if (!hasNativeRunner(agyBin, configured)) {
      throw new Error(`Configured Agy project ${configured} does not expose native-scoring-runner-v6`);
    }
    return configured;
  }
  const projectsRoot = path.join(os.homedir(), '.gemini', 'config', 'projects');
  if (!fs.existsSync(projectsRoot)) {
    throw new Error('No Agy project registry exists. Run `agy --new-project agents` once from this workspace.');
  }
  const projectId = findRegisteredAgyProjectIdWithAgent(
    projectsRoot,
    projectRoot,
    (candidateId) => hasNativeRunner(agyBin, candidateId),
  );
  if (projectId) return projectId;
  throw new Error(
    'No registered Agy project for this workspace exposes native-scoring-runner-v6. Run `agy --new-project agents` once, verify the runner is listed, then retry.',
  );
}

function nativeRunnerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  const trustedRuntimePaths = [
    path.dirname(process.execPath),
    path.join(projectRoot, 'node_modules', '.bin'),
  ];
  const inheritedPaths = (environment.PATH || '/usr/bin:/bin:/usr/sbin:/sbin')
    .split(path.delimiter)
    .filter(Boolean);
  environment.PATH = [...new Set([...trustedRuntimePaths, ...inheritedPaths])].join(path.delimiter);
  for (const key of [
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'OPENAI_API_KEY',
  ]) {
    delete environment[key];
  }
  return environment;
}

async function markStaleRequest(): Promise<void> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const stale = await prisma.nativeScoringRequest.findFirst({
    where: {
      activeKey: 'global',
      status: 'running',
      OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: cutoff } }],
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!stale) return;
  await prisma.nativeScoringRequest.updateMany({
    where: { id: stale.id, status: 'running', updatedAt: stale.updatedAt },
    data: {
      status: 'failed',
      error: 'The native scoring heartbeat expired. Preserved manifests and leases can be resumed with Retry.',
      progress: 'Native scoring stopped before the request completed.',
    },
  });
}

async function claimNextRequest() {
  const queued = await prisma.nativeScoringRequest.findFirst({
    where: { activeKey: 'global', status: 'queued' },
    orderBy: { createdAt: 'asc' },
  });
  if (!queued) return null;
  const claimed = await prisma.nativeScoringRequest.updateMany({
    where: { id: queued.id, status: 'queued', updatedAt: queued.updatedAt },
    data: {
      status: 'running',
      phase: queued.phase === 'queued' ? 'context_preparing' : queued.phase,
      workerId,
      claimedAt: new Date(),
      heartbeatAt: new Date(),
      attempt: { increment: 1 },
      progress: 'Local Mac watcher launched the native Antigravity runner.',
    },
  });
  return claimed.count === 1
    ? prisma.nativeScoringRequest.findUnique({ where: { id: queued.id } })
    : null;
}

async function failClaimedLaunch(requestId: string, error: string): Promise<void> {
  await prisma.nativeScoringRequest.updateMany({
    where: { id: requestId, status: 'running', workerId },
    data: {
      status: 'failed',
      error: `Agy CLI could not be launched: ${error}`.slice(0, 4_000),
      progress: 'Native scoring did not start; use Retry after correcting the local Agy installation.',
      heartbeatAt: new Date(),
    },
  });
}

async function runRequest(requestId: string): Promise<void> {
  let agyBin: string;
  let projectId: string;
  try {
    agyBin = agyBinary();
    projectId = agyProjectId(agyBin);
  } catch (error: unknown) {
    await failClaimedLaunch(requestId, error instanceof Error ? error.message : String(error));
    return;
  }
  const child = spawn(agyBin, [
    '--project', projectId,
    '--agent', 'native-scoring-runner-v6',
    '--model', NATIVE_SCORING_EXPECTED_MODEL,
    '--effort', 'high',
    '--print', `Run native scoring request ${requestId}.`,
    '--print-timeout', '2h',
  ], {
    cwd: projectRoot,
    env: nativeRunnerEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  activeChild = child;

  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  // Only this host has the runner's manifest directory, so the heartbeat is
  // where chunk progress gets published for the deployed dashboard to read.
  const publishProgress = async ({ final = false }: { final?: boolean } = {}) => {
    const current = await prisma.nativeScoringRequest.findUnique({
      where: { id: requestId },
      select: { phase: true, contextBatchId: true, standardBatchId: true },
    });
    if (!current) return;
    const progress = summarizeBatchDirectory(
      currentBatchId(current),
      path.join(projectRoot, '.agents', 'eval_runs'),
    );
    if (final) {
      // The runner marks the request finished itself, so the heartbeat's
      // `status: running` guard would drop the last write and freeze the chunk
      // count mid-wave. The closing snapshot deliberately ignores that guard,
      // and touches only the counts so it can never revive a finished request.
      await prisma.nativeScoringRequest.updateMany({ where: { id: requestId }, data: progress });
      return;
    }
    await prisma.nativeScoringRequest.updateMany({
      where: { id: requestId, status: 'running', workerId },
      data: { heartbeatAt: new Date(), ...progress },
    });
  };

  const heartbeat = setInterval(() => {
    publishProgress().catch((error) => console.error('Watcher heartbeat failed:', error));
  }, 30_000);
  void publishProgress().catch(() => {});

  let launchError: string | null = null;
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).catch((error: unknown) => {
    launchError = error instanceof Error ? error.message : String(error);
    return null;
  }).finally(() => {
    clearInterval(heartbeat);
    if (activeChild === child) activeChild = null;
  });

  // Whatever the outcome, record where the wave actually got to: a completed run
  // should not display a partial bar, and a failed one should show how far it got.
  await publishProgress({ final: true }).catch((error) => console.error('Final progress publish failed:', error));

  if (launchError) {
    await failClaimedLaunch(requestId, launchError);
    return;
  }

  const request = await prisma.nativeScoringRequest.findUnique({ where: { id: requestId } });
  if (request && !['completed', 'failed', 'cancelled'].includes(request.status)) {
    await prisma.nativeScoringRequest.update({
      where: { id: requestId },
      data: {
        status: 'failed',
        error: `Agy CLI exited with code ${exitCode ?? 'unknown'} before completion.`,
        progress: 'Native scoring stopped safely; use Retry to resume preserved work.',
        heartbeatAt: new Date(),
      },
    });
  }
}

async function main(): Promise<void> {
  const { once, pollMs } = parseArguments(process.argv.slice(2));
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  do {
    try {
      await markStaleRequest();
      const request = await claimNextRequest();
      if (request) await runRequest(request.id);
    } catch (error: unknown) {
      // A database blip costs one poll cycle, never the daemon: launchd only
      // restarts a watcher that exits, and a stranded queued request has no
      // other claimant.
      console.error(`Native scoring poll failed: ${error instanceof Error ? error.message : String(error)}`);
      if (once) throw error;
    }
    if (once || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (!stopping);
}

main()
  .catch((error: unknown) => {
    console.error(`Native scoring watcher failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    // Lingering tsx/esbuild handles kept a failed watcher alive once, so
    // KeepAlive never restarted it. Exit explicitly instead.
    process.exit(process.exitCode ?? 0);
  });
