import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

import {
  NativeContextScoringChunk,
  nativeContextSnapshotContents,
  parseContextResult,
  parseNativeContextProfile,
  parseNativeScoringChunk,
  parseNativeScoringManifest,
  sha256,
} from '../src/lib/nativeScoringBatch';
import { contextRulesForNativeScoring } from '../src/lib/contextFeedbackPolicy';

const prisma = new PrismaClient();
const projectRoot = process.cwd();
const lockPath = path.join(projectRoot, '.agents', 'scoring-lock.json');
const runsRoot = path.join(projectRoot, '.agents', 'eval_runs');

function safeProjectPath(relativePath: string): string {
  const absolute = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unsafe path: ${relativePath}`);
  return absolute;
}

function safeRunPath(runRoot: string, relativePath: string): string {
  const absolute = path.resolve(runRoot, relativePath);
  const relative = path.relative(runRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unsafe run path: ${relativePath}`);
  return absolute;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function verifyHash(filePath: string, expected: string, label: string): Buffer {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing`);
  const contents = fs.readFileSync(filePath);
  if (sha256(contents) !== expected) throw new Error(`${label} hash does not match the manifest`);
  return contents;
}

function clearActiveLock(batchId: string): void {
  try {
    if (!fs.existsSync(lockPath)) return;
    const current = readJson(lockPath) as { batchId?: unknown };
    if (current.batchId === batchId) fs.unlinkSync(lockPath);
  } catch (error: unknown) {
    console.warn(
      `Context import succeeded, but the scoring lock could not be cleared: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');
  if (process.argv.slice(2).some((value) => value !== '--apply')) throw new Error('Unknown argument');
  if (!fs.existsSync(lockPath)) throw new Error('No active native scoring lock was found');
  const lock = readJson(lockPath) as {
    requestId?: unknown;
    phase?: unknown;
    batchId?: unknown;
    runRoot?: unknown;
    manifestFile?: unknown;
  };
  if (
    typeof lock.requestId !== 'string'
    || lock.phase !== 'context'
    || typeof lock.batchId !== 'string'
    || typeof lock.runRoot !== 'string'
    || typeof lock.manifestFile !== 'string'
  ) {
    throw new Error('The active lock is not a context run');
  }
  if (!lock.batchId.startsWith(`native_${lock.requestId}_context_`)) {
    throw new Error('The context batch ID is not bound to its durable request');
  }
  const runRoot = safeProjectPath(lock.runRoot);
  const runRelative = path.relative(runsRoot, runRoot);
  if (!runRelative || runRelative.startsWith('..') || path.isAbsolute(runRelative)) {
    throw new Error('Context run root must be a child of .agents/eval_runs');
  }
  const manifestPath = safeProjectPath(lock.manifestFile);
  if (manifestPath !== path.join(runRoot, 'manifest.json')) {
    throw new Error('The active context manifest must be the selected run manifest');
  }
  const manifest = parseNativeScoringManifest(readJson(manifestPath));
  if (
    manifest.batchId !== lock.batchId
    || manifest.chunks.length !== 1
    || manifest.chunks[0].type !== 'context'
  ) {
    throw new Error('Context runs must contain exactly one context chunk');
  }

  verifyHash(safeProjectPath(manifest.prompts.context.file), manifest.prompts.context.sha256, 'Context prompt');
  verifyHash(safeProjectPath(manifest.prompts.standard.file), manifest.prompts.standard.sha256, 'Standard prompt');
  verifyHash(safeProjectPath(manifest.prompts.manager.file), manifest.prompts.manager.sha256, 'Manager prompt');
  verifyHash(safeProjectPath(manifest.evidence.file), manifest.evidence.sha256, 'Evidence inventory');
  verifyHash(safeRunPath(runRoot, manifest.exportSnapshot.file), manifest.exportSnapshot.sha256, 'Export snapshot');
  const rawContextSnapshot = verifyHash(
    safeRunPath(runRoot, manifest.contextSnapshot.file),
    manifest.contextSnapshot.sha256,
    'Context snapshot',
  );
  const submittedContextProfile = parseNativeContextProfile(
    JSON.parse(rawContextSnapshot.toString('utf8')),
    'context snapshot',
  );
  if (submittedContextProfile.submittedUpdatedAt !== manifest.contextSnapshot.submittedUpdatedAt) {
    throw new Error('Context snapshot version does not match the manifest');
  }

  const manifestChunk = manifest.chunks[0];
  const rawChunk = verifyHash(
    safeRunPath(runRoot, manifestChunk.inputFile),
    manifestChunk.inputHash,
    'Context input',
  );
  const chunk = parseNativeScoringChunk(JSON.parse(rawChunk.toString('utf8')));
  if (
    chunk.type !== 'context'
    || chunk.batchId !== manifest.batchId
    || chunk.chunkId !== manifestChunk.chunkId
    || chunk.contextProfile.submittedUpdatedAt !== manifest.contextSnapshot.submittedUpdatedAt
    || chunk.contextProfile.rulesText !== submittedContextProfile.rulesText
  ) {
    throw new Error('Context input metadata does not match the manifest');
  }
  const expectedJobs = manifestChunk.jobs;
  if (
    chunk.jobs.length !== expectedJobs.length
    || chunk.jobs.some((job, index) => (
      job.id !== expectedJobs[index].id
      || job.submittedUpdatedAt !== expectedJobs[index].submittedUpdatedAt
    ))
  ) {
    throw new Error('Context input jobs do not match the manifest');
  }
  const resultPath = safeRunPath(runRoot, manifestChunk.resultFile);
  if (!fs.existsSync(resultPath)) throw new Error('Context result is missing');
  const rawResult = fs.readFileSync(resultPath);
  let contextResult: ReturnType<typeof parseContextResult>;
  try {
    contextResult = parseContextResult(
      JSON.parse(rawResult.toString('utf8')),
      expectedJobs,
      manifest.contextSnapshot.submittedUpdatedAt,
    );
  } catch (error: unknown) {
    throw new Error(
      `${manifestChunk.chunkId} result failed schema validation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const idempotencyKey = `${manifest.batchId}:context-profile`;
  const existing = await prisma.contextRuleRevision.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (
      existing.batchId !== manifest.batchId
      || existing.inputHash !== manifestChunk.inputHash
      || existing.contextHash !== manifest.contextSnapshot.sha256
      || existing.manifestHash !== manifest.manifestHash
      || existing.resultHash !== sha256(rawResult)
      || existing.requestId !== lock.requestId
      || existing.schemaVersion !== manifest.schemaVersion
      || existing.chunkId !== manifestChunk.chunkId
      || existing.promptVersion !== manifest.prompts.context.version
      || existing.model !== `antigravity:${manifest.model.expectedModel}`
    ) {
      throw new Error('Existing context idempotency record does not match this immutable run');
    }
    console.log('This exact context batch was already applied; no writes were performed.');
    clearActiveLock(manifest.batchId);
    return;
  }

  const [profile, jobs] = await Promise.all([
    prisma.contextProfile.findUnique({ where: { id: 'global' } }),
    prisma.job.findMany({
      where: { id: { in: expectedJobs.map((job) => job.id) } },
      select: {
        id: true,
        status: true,
        passReason: true,
        contextBatched: true,
        contextBatchId: true,
        updatedAt: true,
      },
    }),
  ]);
  const currentProfileVersion = profile?.updatedAt.toISOString() || null;
  if (currentProfileVersion !== manifest.contextSnapshot.submittedUpdatedAt) {
    throw new Error('Context DB changed after preparation; refusing a stale update');
  }
  const currentContextContents = nativeContextSnapshotContents({
    rulesText: contextRulesForNativeScoring(profile?.rulesText),
    submittedUpdatedAt: currentProfileVersion,
  });
  if (sha256(currentContextContents) !== manifest.contextSnapshot.sha256) {
    throw new Error('Current Context DB content does not match the immutable context snapshot');
  }
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  for (const expected of expectedJobs) {
    const job = jobsById.get(expected.id);
    if (
      !job
      || job.status !== 'passed'
      || job.contextBatched
      || job.contextBatchId !== manifest.batchId
      || job.updatedAt.toISOString() !== expected.submittedUpdatedAt
      || !job.passReason
      || /\bexpired\b/i.test(job.passReason.trim())
    ) {
      throw new Error(`Context feedback job ${expected.id} lost its exact negative-only lease/state`);
    }
  }

  console.log(`Validated immutable context batch ${manifest.batchId}.`);
  console.log(`Feedback decisions: ${expectedJobs.length}`);
  console.log(`Context rules changed: ${contextResult.updatedContextRules.trim() !== (profile?.rulesText || '').trim()}`);
  if (!apply) {
    console.log('Dry-run validation passed. Re-run with --apply to commit this exact context update.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    const profileStillCurrent = profile
      ? await tx.contextProfile.count({ where: { id: 'global', updatedAt: profile.updatedAt } }) === 1
      : await tx.contextProfile.count({ where: { id: 'global' } }) === 0;
    if (!profileStillCurrent) throw new Error('Context DB changed during import');
    const stillLeased = await tx.job.count({
      where: {
        contextBatchId: manifest.batchId,
        contextBatched: false,
        status: 'passed',
        OR: expectedJobs.map((job) => ({ id: job.id, updatedAt: new Date(job.submittedUpdatedAt) })),
      },
    });
    if (stillLeased !== expectedJobs.length) throw new Error('Context feedback leases changed during import');

    if (profile) {
      const updated = await tx.contextProfile.updateMany({
        where: { id: 'global', updatedAt: profile.updatedAt },
        data: { rulesText: contextResult.updatedContextRules },
      });
      if (updated.count !== 1) throw new Error('Context DB optimistic update failed');
    } else {
      await tx.contextProfile.create({
        data: { id: 'global', rulesText: contextResult.updatedContextRules },
      });
    }
    await tx.contextRuleRevision.create({
      data: {
        contextProfileId: 'global',
        previousRulesText: profile?.rulesText || '',
        newRulesText: contextResult.updatedContextRules,
        sourceJobIds: expectedJobs.map((job) => job.id),
        model: `antigravity:${manifest.model.expectedModel}`,
        promptVersion: manifest.prompts.context.version,
        requestId: lock.requestId as string,
        idempotencyKey,
        schemaVersion: manifest.schemaVersion,
        batchId: manifest.batchId,
        chunkId: manifestChunk.chunkId,
        inputHash: manifestChunk.inputHash,
        contextHash: manifest.contextSnapshot.sha256,
        manifestHash: manifest.manifestHash,
        resultHash: sha256(rawResult),
      },
    });
    const processed = await tx.job.updateMany({
      where: { contextBatchId: manifest.batchId, contextBatched: false, status: 'passed' },
      data: { contextBatched: true, contextBatchId: null },
    });
    if (processed.count !== expectedJobs.length) throw new Error('Not every context feedback lease was consumed');
    await tx.nativeScoringRequest.update({
      where: { id: lock.requestId as string },
      data: {
        phase: 'context_preparing',
        progress: `Applied ${expectedJobs.length} negative context decision(s); checking for more.`,
        contextJobs: { increment: expectedJobs.length },
        heartbeatAt: new Date(),
      },
    });
  }, { maxWait: 15_000, timeout: 60_000 });

  try {
    fs.writeFileSync(path.join(runRoot, 'import-receipt.json'), `${JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      batchId: manifest.batchId,
      requestId: lock.requestId,
      phase: 'context',
      importedAt: new Date().toISOString(),
      manifestHash: manifest.manifestHash,
      contextHash: manifest.contextSnapshot.sha256,
      resultHash: sha256(rawResult),
      feedbackCount: expectedJobs.length,
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error: unknown) {
    console.warn(
      `Database commit succeeded, but the context receipt could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  clearActiveLock(manifest.batchId);
  console.log('Context update committed atomically. Result artifacts were preserved.');
}

main()
  .catch((error: unknown) => {
    console.error(`Native context import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
