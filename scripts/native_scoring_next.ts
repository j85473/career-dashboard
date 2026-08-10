import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

import { NATIVE_SCORING_MANAGER_WAVE_SIZE, parseNativeScoringManifest } from '../src/lib/nativeScoringBatch';

type Phase = 'context' | 'standard';
type NativeScoringLock = {
  requestId: string;
  phase: Phase;
  batchId: string;
  runRoot: string;
  manifestFile: string;
};

const prisma = new PrismaClient();
const projectRoot = process.cwd();
const lockPath = path.join(projectRoot, '.agents', 'scoring-lock.json');
const runsRoot = path.join(projectRoot, '.agents', 'eval_runs');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUARANTINED_RESULTS_PER_CHUNK = 4;

function assertInside(parent: string, candidate: string, label: string): void {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the native scoring run directory`);
  }
}

function requestIdFromArguments(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--request' || !UUID_PATTERN.test(argv[1] || '')) {
    throw new Error('Usage: scoring:next -- --request <UUID>');
  }
  return argv[1];
}

function runTsScript(script: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-12_000),
  };
}

async function failRequest(requestId: string, message: string) {
  await prisma.nativeScoringRequest.update({
    where: { id: requestId },
    data: {
      status: 'failed',
      error: message.slice(0, 4_000),
      progress: 'Native scoring stopped safely. Preserved artifacts can be retried.',
      heartbeatAt: new Date(),
    },
  });
  return { action: 'failed', requestId, error: message.slice(0, 4_000) };
}

function readLock(): NativeScoringLock {
  const value = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
  if (
    typeof value.requestId !== 'string'
    || !['context', 'standard'].includes(String(value.phase))
    || typeof value.batchId !== 'string'
    || typeof value.runRoot !== 'string'
    || typeof value.manifestFile !== 'string'
  ) {
    throw new Error('The active native scoring lock is malformed');
  }
  return value as NativeScoringLock;
}

function quarantinedResultCount(runRoot: string, chunkId: string): number {
  const quarantineDir = path.join(runRoot, 'quarantine');
  if (!fs.existsSync(quarantineDir)) return 0;
  return fs.readdirSync(quarantineDir).filter((name) => (
    name.startsWith(`${chunkId}.`) && name.endsWith('.invalid.json')
  )).length;
}

async function importCompletedRun(
  requestId: string,
  phase: Phase,
  batchId: string,
): Promise<{ action: string; requestId: string }> {
  const script = phase === 'context' ? 'scripts/import_native_context.ts' : 'scripts/direct_import.ts';
  const dryRun = runTsScript(script, []);
  if (!dryRun.ok) {
    const chunkId = /chunk_\d{4}/.exec(dryRun.output)?.[0];
    if (chunkId) {
      const quarantined = runTsScript('scripts/quarantine_scoring_result.ts', ['--chunk', chunkId, '--apply']);
      if (!quarantined.ok) {
        throw new Error(`${phase} validation failed and ${chunkId} could not be quarantined: ${dryRun.output}\n${quarantined.output}`);
      }
      const lock = readLock();
      const quarantineDir = path.join(projectRoot, lock.runRoot, 'quarantine');
      const quarantinedCount = fs.existsSync(quarantineDir)
        ? fs.readdirSync(quarantineDir).filter((name) => (
          name.startsWith(`${chunkId}.`) && name.endsWith('.invalid.json')
        )).length
        : 0;
      if (quarantinedCount >= MAX_QUARANTINED_RESULTS_PER_CHUNK) {
        throw new Error(
          `${phase} validation failed ${quarantinedCount} times for ${chunkId}; `
          + `the latest result was quarantined and automatic retry stopped: ${dryRun.output}`,
        );
      }
      await prisma.nativeScoringRequest.update({
        where: { id: requestId },
        data: {
          status: 'running',
          phase: `${phase}_scoring`,
          error: null,
          progress: `${chunkId} failed schema validation and was quarantined; automatically regenerating it (${quarantinedCount}/${MAX_QUARANTINED_RESULTS_PER_CHUNK - 1} retries used).`,
          heartbeatAt: new Date(),
        },
      });
      return { action: 'continue', requestId };
    }
    const released = runTsScript('scripts/release_scoring_batch.ts', ['--batch', batchId, '--apply']);
    if (!released.ok) {
      throw new Error(`${phase} validation failed and its stale batch could not be released: ${dryRun.output}\n${released.output}`);
    }
    await prisma.nativeScoringRequest.update({
      where: { id: requestId },
      data: {
        status: 'running',
        phase: `${phase}_preparing`,
        error: null,
        progress: `A stale ${phase} run was preserved and released; preparing fresh immutable inputs.`,
        heartbeatAt: new Date(),
      },
    });
    return { action: 'continue', requestId };
  }
  const applied = runTsScript(script, ['--apply']);
  if (!applied.ok) throw new Error(`${phase} import failed: ${applied.output}`);
  return { action: 'continue', requestId };
}

async function main() {
  const requestId = requestIdFromArguments(process.argv.slice(2));
  let request = await prisma.nativeScoringRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error('Native scoring request not found');
  if (request.status === 'completed') {
    return {
      action: 'complete',
      requestId,
      summary: request.progress,
      counts: {
        context: request.contextJobs,
        standard: request.standardJobs,
      },
    };
  }
  if (request.status === 'failed') {
    return { action: 'failed', requestId, error: request.error || request.progress };
  }
  if (request.activeKey !== 'global') throw new Error('Native scoring request is not active');

  if (request.status === 'queued') {
    request = await prisma.nativeScoringRequest.update({
      where: { id: requestId },
      data: {
        status: 'running',
        phase: request.phase === 'queued' ? 'context_preparing' : request.phase,
        progress: 'Native Antigravity runner claimed the request.',
        attempt: { increment: 1 },
        claimedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
  } else {
    await prisma.nativeScoringRequest.update({
      where: { id: requestId },
      data: { heartbeatAt: new Date() },
    });
  }

  try {
    if (fs.existsSync(lockPath)) {
      const lock = readLock();
      if (lock.requestId !== requestId) {
        throw new Error(`Another request owns the active scoring lock: ${lock.requestId}`);
      }
      if (!lock.batchId.startsWith(`native_${requestId}_${lock.phase}_`)) {
        throw new Error('The active batch ID is not bound to its request and phase');
      }
      const runRoot = path.resolve(projectRoot, lock.runRoot);
      assertInside(runsRoot, runRoot, 'Lock run root');
      const manifestPath = path.resolve(projectRoot, lock.manifestFile);
      if (manifestPath !== path.join(runRoot, 'manifest.json')) {
        throw new Error('The lock manifest does not belong to its run directory');
      }
      const manifest = parseNativeScoringManifest(
        JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      );
      if (manifest.batchId !== lock.batchId) throw new Error('Lock and manifest batch IDs differ');
      if (manifest.chunks.some((chunk) => chunk.type !== lock.phase)) {
        throw new Error('Lock phase and manifest chunk type differ');
      }
      const missing = manifest.chunks
        .filter((chunk) => !fs.existsSync(path.resolve(runRoot, chunk.resultFile)))
        .map((chunk) => chunk.chunkId);
      if (missing.length > 0) {
        const exhaustedChunk = missing.find((chunkId) => (
          quarantinedResultCount(runRoot, chunkId) >= MAX_QUARANTINED_RESULTS_PER_CHUNK
        ));
        if (exhaustedChunk) {
          return failRequest(
            requestId,
            `${exhaustedChunk} already reached its validation retry limit; do not retry this preserved batch. Release it only after repairing and deploying the input sanitizer.`,
          );
        }
        // Evaluator payloads are large. A fresh manager every four chunks keeps
        // its conversation bounded while preserving two-evaluator concurrency.
        const chunks = missing.slice(0, NATIVE_SCORING_MANAGER_WAVE_SIZE);
        await prisma.nativeScoringRequest.update({
          where: { id: requestId },
          data: {
            phase: `${lock.phase}_scoring`,
            progress: `Waiting for ${chunks.length} ${lock.phase} chunk result(s) in the next bounded wave.`,
            heartbeatAt: new Date(),
          },
        });
        return {
          action: 'run_wave',
          requestId,
          phase: lock.phase,
          manifest: path.relative(projectRoot, path.resolve(projectRoot, lock.manifestFile)),
          chunks,
        };
      }
      return await importCompletedRun(requestId, lock.phase, lock.batchId);
    }

    request = await prisma.nativeScoringRequest.findUniqueOrThrow({ where: { id: requestId } });
    const phase = request.phase.startsWith('context')
      ? 'context'
      : request.phase.startsWith('standard')
        ? 'standard'
        : null;
    if (!phase) {
      if (request.phase === 'completed') {
        return { action: 'complete', requestId, summary: 'Native context and A/E scoring are complete.' };
      }
      throw new Error(`Unexpected native scoring phase: ${request.phase}`);
    }
    const prepared = runTsScript('scripts/prepare_native_scoring_phase.ts', [
      '--request', requestId, '--phase', phase,
    ]);
    if (!prepared.ok) throw new Error(prepared.output);
    const refreshed = await prisma.nativeScoringRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (refreshed.status === 'completed') {
      return {
        action: 'complete',
        requestId,
        summary: refreshed.progress,
        counts: {
          context: refreshed.contextJobs,
          standard: refreshed.standardJobs,
        },
      };
    }
    return { action: 'continue', requestId };
  } catch (error) {
    return failRequest(requestId, error instanceof Error ? error.message : String(error));
  }
}

main()
  .then((action) => console.log(JSON.stringify(action)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
