import 'dotenv/config';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { findRegisteredAgyProjectId } from '../src/lib/agyProject';
import { NATIVE_SCORING_EXPECTED_MODEL } from '../src/lib/nativeScoringBatch';

const prisma = new PrismaClient();
const projectRoot = process.cwd();
const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const staleAfterMs = 15 * 60 * 1000;
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

function agyProjectId(): string {
  const configured = process.env.AGY_PROJECT_ID?.trim();
  if (configured && UUID_PATTERN.test(configured)) return configured;
  const projectsRoot = path.join(os.homedir(), '.gemini', 'config', 'projects');
  if (!fs.existsSync(projectsRoot)) {
    throw new Error('No Agy project registry exists. Run `agy --new-project agents` once from this workspace.');
  }
  const projectId = findRegisteredAgyProjectId(projectsRoot, projectRoot);
  if (projectId) return projectId;
  throw new Error('This workspace is not registered with Agy. Run `agy --new-project agents` once, then retry.');
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

async function runRequest(requestId: string): Promise<void> {
  const child = spawn(agyBinary(), [
    '--project', agyProjectId(),
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
  const heartbeat = setInterval(() => {
    prisma.nativeScoringRequest.updateMany({
      where: { id: requestId, status: 'running', workerId },
      data: { heartbeatAt: new Date() },
    }).catch((error) => console.error('Watcher heartbeat failed:', error));
  }, 30_000);

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

  if (launchError) {
    await prisma.nativeScoringRequest.updateMany({
      where: { id: requestId, status: 'running', workerId },
      data: {
        status: 'failed',
        error: `Agy CLI could not be launched: ${launchError}`.slice(0, 4_000),
        progress: 'Native scoring did not start; use Retry after correcting the local Agy installation.',
        heartbeatAt: new Date(),
      },
    });
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
    await markStaleRequest();
    const request = await claimNextRequest();
    if (request) await runRequest(request.id);
    if (once || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (!stopping);
}

main()
  .catch((error: unknown) => {
    console.error(`Native scoring watcher failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
