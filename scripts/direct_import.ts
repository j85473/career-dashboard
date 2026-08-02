import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  ManifestChunk,
  NativeScoringManifest,
  nativeContextSnapshotContents,
  parseNativeContextProfile,
  parseNativeScoringChunk,
  parseNativeScoringManifest,
  parseStandardResult,
  parseWildcardResult,
  sha256,
  StandardScore,
  WildcardScore,
} from '../src/lib/nativeScoringBatch';
import { contextRulesForNativeScoring } from '../src/lib/contextFeedbackPolicy';
import {
  guardedStandardExperienceScore,
  passesStandardScoring,
  passesWildcardScoring,
  qualifiesForWildcardAfterStandard,
  STANDARD_EXPERIENCE_PASS_SCORE,
} from '../src/lib/scoringPolicy';

function guardedExperience(score: StandardScore): number {
  return guardedStandardExperienceScore(score);
}

function guardedExperienceReason(score: StandardScore, guardedScore: number): string {
  if (score.mandatoryRequirementsMet && guardedScore === score.experienceFitScore) {
    const outcome = guardedScore >= STANDARD_EXPERIENCE_PASS_SCORE
      ? 'QUALIFIED AND COMPETITIVE'
      : 'MINIMUM REQUIREMENTS MET, BELOW COMPETITIVE THRESHOLD';
    return `${outcome}: ${score.experienceFitReason}`;
  }
  const unmet = score.unmetMandatoryRequirements.join('; ')
    || (!score.domainMatch ? `required domain is ${score.requiredDomain || 'not established'}` : '')
    || 'mandatory qualification evidence is incomplete';
  return `NOT QUALIFIED — unmet mandatory requirement(s): ${unmet}. ${score.experienceFitReason}`;
}

interface StandardEvaluation {
  type: 'standard';
  chunk: ManifestChunk;
  score: StandardScore;
}

interface WildcardEvaluation {
  type: 'wildcard';
  chunk: ManifestChunk;
  score: WildcardScore;
}

type Evaluation = StandardEvaluation | WildcardEvaluation;

interface ValidatedRun {
  runRoot: string;
  manifest: NativeScoringManifest;
  contextProfile: ReturnType<typeof parseNativeContextProfile>;
  evaluations: Evaluation[];
  resultHashes: Record<string, string>;
}

interface ScoringLock {
  requestId?: string;
  phase?: 'standard' | 'wildcard';
  batchId: string;
  runRoot: string;
  manifestFile: string;
}

const prisma = new PrismaClient();
const projectRoot = process.cwd();
const agentsRoot = path.join(projectRoot, '.agents');
const runsRoot = path.join(agentsRoot, 'eval_runs');
const lockPath = path.join(agentsRoot, 'scoring-lock.json');
const lastRunPath = path.join(agentsRoot, 'scoring-last-run.json');
const ELIGIBLE_STANDARD_STATUSES = ['inbox', 'pending_af'];

function parseArguments(argv: string[]): { apply: boolean; runArgument: string | null } {
  let apply = false;
  let runArgument: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--run') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--run requires a run-directory path');
      }
      runArgument = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { apply, runArgument };
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error: unknown) {
    throw new Error(
      `Failed to read JSON ${path.relative(projectRoot, filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function readLock(): ScoringLock {
  if (!fs.existsSync(lockPath)) {
    throw new Error('No active .agents/scoring-lock.json was found');
  }
  const lock = readJson(lockPath);
  if (
    typeof lock !== 'object'
    || lock === null
    || Array.isArray(lock)
    || typeof (lock as Record<string, unknown>).batchId !== 'string'
    || typeof (lock as Record<string, unknown>).runRoot !== 'string'
    || typeof (lock as Record<string, unknown>).manifestFile !== 'string'
  ) {
    throw new Error('The active scoring lock is malformed');
  }
  return lock as unknown as ScoringLock;
}

function assertInsideRunsRoot(runRoot: string): void {
  const relative = path.relative(runsRoot, runRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('The run directory must be a child of .agents/eval_runs');
  }
}

function resolveRunRoot(runArgument: string | null): string {
  if (runArgument) {
    const runRoot = path.resolve(projectRoot, runArgument);
    assertInsideRunsRoot(runRoot);
    return runRoot;
  }
  const pointer = fs.existsSync(lockPath)
    ? readLock()
    : readJson(lastRunPath);
  if (
    typeof pointer !== 'object'
    || pointer === null
    || Array.isArray(pointer)
    || typeof (pointer as Record<string, unknown>).runRoot !== 'string'
  ) {
    throw new Error('No active or previously imported scoring run was found; provide --run');
  }
  const runRoot = path.resolve(
    projectRoot,
    (pointer as Record<string, string>).runRoot,
  );
  assertInsideRunsRoot(runRoot);
  return runRoot;
}

function resolveProjectFile(relativeFile: string): string {
  const absolutePath = path.resolve(projectRoot, relativeFile);
  const relative = path.relative(projectRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe project-relative path: ${relativeFile}`);
  }
  return absolutePath;
}

function resolveRunFile(runRoot: string, relativeFile: string): string {
  const absolutePath = path.resolve(runRoot, relativeFile);
  const relative = path.relative(runRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe run-relative path: ${relativeFile}`);
  }
  return absolutePath;
}

function loadAllowedEvidenceIds(filePath: string): Set<string> {
  const value = readJson(filePath);
  if (!Array.isArray(value)) {
    throw new Error('The evidence inventory must be an array');
  }
  const ids = value.map((entry, index) => {
    if (
      typeof entry !== 'object'
      || entry === null
      || Array.isArray(entry)
      || typeof (entry as Record<string, unknown>).id !== 'string'
      || !(entry as Record<string, string>).id.trim()
    ) {
      throw new Error(`Evidence entry ${index} has no valid id`);
    }
    return (entry as Record<string, string>).id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error('The evidence inventory contains duplicate IDs');
  }
  return new Set(ids);
}

function verifyFileHash(filePath: string, expectedHash: string, label: string): Buffer {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} is missing: ${path.relative(projectRoot, filePath)}`);
  }
  const contents = fs.readFileSync(filePath);
  if (sha256(contents) !== expectedHash) {
    throw new Error(`${label} hash does not match the immutable manifest`);
  }
  return contents;
}

function validateRun(runRoot: string): ValidatedRun {
  if (!fs.existsSync(runRoot) || !fs.statSync(runRoot).isDirectory()) {
    throw new Error(`Run directory not found: ${path.relative(projectRoot, runRoot)}`);
  }

  const manifestPath = path.join(runRoot, 'manifest.json');
  const manifest = parseNativeScoringManifest(readJson(manifestPath));
  if (manifest.chunks.some((chunk) => chunk.type === 'context')) {
    throw new Error('Context runs must use npm run scoring:context:validate or scoring:context:import');
  }

  verifyFileHash(
    resolveProjectFile(manifest.prompts.context.file),
    manifest.prompts.context.sha256,
    'Context evaluator prompt',
  );
  verifyFileHash(
    resolveProjectFile(manifest.prompts.standard.file),
    manifest.prompts.standard.sha256,
    'Standard evaluator prompt',
  );
  verifyFileHash(
    resolveProjectFile(manifest.prompts.wildcard.file),
    manifest.prompts.wildcard.sha256,
    'Wildcard evaluator prompt',
  );
  verifyFileHash(
    resolveProjectFile(manifest.prompts.manager.file),
    manifest.prompts.manager.sha256,
    'Scoring manager prompt',
  );
  const evidencePath = resolveProjectFile(manifest.evidence.file);
  verifyFileHash(evidencePath, manifest.evidence.sha256, 'Evidence inventory');
  verifyFileHash(
    resolveRunFile(runRoot, manifest.exportSnapshot.file),
    manifest.exportSnapshot.sha256,
    'Export snapshot',
  );
  const rawContextSnapshot = verifyFileHash(
    resolveRunFile(runRoot, manifest.contextSnapshot.file),
    manifest.contextSnapshot.sha256,
    'Context snapshot',
  );
  const contextProfile = parseNativeContextProfile(
    JSON.parse(rawContextSnapshot.toString('utf8')),
    'context snapshot',
  );
  if (contextProfile.submittedUpdatedAt !== manifest.contextSnapshot.submittedUpdatedAt) {
    throw new Error('Context snapshot version does not match the manifest');
  }
  const allowedEvidenceIds = loadAllowedEvidenceIds(evidencePath);

  const resultsDirectory = path.join(runRoot, 'results');
  if (!fs.existsSync(resultsDirectory)) {
    throw new Error('The run results directory is missing');
  }
  const expectedResultFiles = new Set(
    manifest.chunks.map((chunk) => path.basename(chunk.resultFile)),
  );
  const actualResultFiles = fs.readdirSync(resultsDirectory)
    .filter((file) => file.endsWith('.json'));
  const unexpectedResults = actualResultFiles.filter((file) => !expectedResultFiles.has(file));
  if (unexpectedResults.length > 0) {
    throw new Error(`Unexpected JSON result files are present: ${unexpectedResults.join(', ')}`);
  }

  const evaluations: Evaluation[] = [];
  const resultHashes: Record<string, string> = {};
  for (const manifestChunk of manifest.chunks) {
    const inputPath = resolveRunFile(runRoot, manifestChunk.inputFile);
    const rawInput = verifyFileHash(
      inputPath,
      manifestChunk.inputHash,
      `Input ${manifestChunk.chunkId}`,
    );
    const chunk = parseNativeScoringChunk(JSON.parse(rawInput.toString('utf8')));
    if (
      chunk.batchId !== manifest.batchId
      || chunk.chunkId !== manifestChunk.chunkId
      || chunk.type !== manifestChunk.type
    ) {
      throw new Error(`${manifestChunk.chunkId} metadata does not match the manifest`);
    }
    const expectedIds = manifestChunk.jobs.map((job) => job.id);
    const inputIds = chunk.jobs.map((job) => job.id);
    if (
      expectedIds.length !== inputIds.length
      || expectedIds.some((id, index) => id !== inputIds[index])
    ) {
      throw new Error(`${manifestChunk.chunkId} job IDs do not match the manifest`);
    }
    chunk.jobs.forEach((job, index) => {
      if (job.submittedUpdatedAt !== manifestChunk.jobs[index].submittedUpdatedAt) {
        throw new Error(`${manifestChunk.chunkId} optimistic version does not match the manifest`);
      }
    });
    if (
      chunk.type === 'standard'
      && (
        chunk.contextProfile.rulesText !== contextProfile.rulesText
        || chunk.contextProfile.submittedUpdatedAt !== contextProfile.submittedUpdatedAt
      )
    ) {
      throw new Error(`${manifestChunk.chunkId} Context DB input does not match the manifest snapshot`);
    }

    const resultPath = resolveRunFile(runRoot, manifestChunk.resultFile);
    if (!fs.existsSync(resultPath)) {
      throw new Error(`Missing result for ${manifestChunk.chunkId}`);
    }
    const rawResult = fs.readFileSync(resultPath);
    resultHashes[manifestChunk.chunkId] = sha256(rawResult);
    let resultValue: unknown;
    try {
      resultValue = JSON.parse(rawResult.toString('utf8'));
    } catch (error: unknown) {
      throw new Error(
        `${manifestChunk.chunkId} result is not bare JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      if (manifestChunk.type === 'standard') {
        const scores = parseStandardResult(resultValue, expectedIds, allowedEvidenceIds);
        scores.forEach((score) => evaluations.push({
          type: 'standard',
          chunk: manifestChunk,
          score,
        }));
      } else {
        const scores = parseWildcardResult(resultValue, expectedIds);
        scores.forEach((score) => evaluations.push({
          type: 'wildcard',
          chunk: manifestChunk,
          score,
        }));
      }
    } catch (error: unknown) {
      throw new Error(
        `${manifestChunk.chunkId} result failed schema validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const expectedJobCount = manifest.chunks.reduce((total, chunk) => total + chunk.jobs.length, 0);
  if (evaluations.length !== expectedJobCount) {
    throw new Error(`Expected ${expectedJobCount} evaluations but validated ${evaluations.length}`);
  }
  if (new Set(evaluations.map((evaluation) => evaluation.score.id)).size !== evaluations.length) {
    throw new Error('The validated run contains duplicate job IDs');
  }

  return { runRoot, manifest, contextProfile, evaluations, resultHashes };
}

function idempotencyKey(batchId: string, evaluation: Evaluation): string {
  return `${batchId}:${evaluation.type}:${evaluation.score.id}`;
}

function standardCountForRequest(run: ValidatedRun): number {
  return run.evaluations.filter((evaluation) => evaluation.type === 'standard').length;
}

function wildcardCountForRequest(run: ValidatedRun): number {
  return run.evaluations.filter((evaluation) => evaluation.type === 'wildcard').length;
}

async function preflightDatabase(run: ValidatedRun): Promise<{
  alreadyApplied: boolean;
  jobsById: Map<string, {
    id: string;
    updatedAt: Date;
    status: string;
    scoringStatus: string;
    aimFitScore: number | null;
    reqFitScore: number | null;
    afBatchId: string | null;
    luckyBatchId: string | null;
    luckyStatus: string;
  }>;
}> {
  const keys = run.evaluations.map((evaluation) => idempotencyKey(run.manifest.batchId, evaluation));
  const activeLock = fs.existsSync(lockPath) ? readLock() : null;
  const expectedRequestId = activeLock?.requestId || run.manifest.batchId;
  const existingEvents = await prisma.jobScoreEvent.findMany({
    where: { idempotencyKey: { in: keys } },
    select: {
      idempotencyKey: true,
      jobId: true,
      evaluationType: true,
      promptHash: true,
      evidenceHash: true,
      inputHash: true,
      batchId: true,
      manifestHash: true,
      resultHash: true,
      contextHash: true,
      contextProfileUpdatedAt: true,
      requestId: true,
      schemaVersion: true,
      chunkId: true,
      promptVersion: true,
      model: true,
    },
  });
  if (existingEvents.length > 0) {
    if (existingEvents.length !== keys.length) {
      throw new Error(
        `Partial prior import detected: ${existingEvents.length} of ${keys.length} idempotency records exist`,
      );
    }
    const expectedByKey = new Map(run.evaluations.map((evaluation) => [
      idempotencyKey(run.manifest.batchId, evaluation),
      evaluation,
    ]));
    for (const event of existingEvents) {
      const evaluation = event.idempotencyKey
        ? expectedByKey.get(event.idempotencyKey)
        : undefined;
      if (
        !evaluation
        || event.jobId !== evaluation.score.id
        || event.evaluationType !== evaluation.type
        || event.promptHash !== run.manifest.prompts[evaluation.type].sha256
        || event.evidenceHash !== run.manifest.evidence.sha256
        || event.inputHash !== evaluation.chunk.inputHash
        || event.batchId !== run.manifest.batchId
        || event.manifestHash !== run.manifest.manifestHash
        || event.resultHash !== run.resultHashes[evaluation.chunk.chunkId]
        || event.requestId !== expectedRequestId
        || event.schemaVersion !== run.manifest.schemaVersion
        || event.chunkId !== evaluation.chunk.chunkId
        || event.promptVersion !== run.manifest.prompts[evaluation.type].version
        || event.model !== 'antigravity:flash'
        || event.contextHash !== (evaluation.type === 'standard'
          ? run.manifest.contextSnapshot.sha256
          : null)
        || (event.contextProfileUpdatedAt?.toISOString() || null) !== (evaluation.type === 'standard'
          ? run.manifest.contextSnapshot.submittedUpdatedAt
          : null)
      ) {
        throw new Error('Existing idempotency records do not match this immutable run');
      }
    }
    return { alreadyApplied: true, jobsById: new Map() };
  }

  const jobIds = run.evaluations.map((evaluation) => evaluation.score.id);
  const jobs = await prisma.job.findMany({
    where: { id: { in: jobIds } },
    select: {
      id: true,
      updatedAt: true,
      status: true,
      scoringStatus: true,
      aimFitScore: true,
      reqFitScore: true,
      afBatchId: true,
      luckyBatchId: true,
      luckyStatus: true,
    },
  });
  if (jobs.length !== jobIds.length) {
    const found = new Set(jobs.map((job) => job.id));
    const missing = jobIds.filter((id) => !found.has(id));
    throw new Error(`Jobs are missing from the database: ${missing.join(', ')}`);
  }
  const jobsById = new Map(jobs.map((job) => [job.id, job]));

  for (const evaluation of run.evaluations) {
    const job = jobsById.get(evaluation.score.id);
    if (!job) {
      throw new Error(`Job ${evaluation.score.id} disappeared during preflight`);
    }
    const version = evaluation.chunk.jobs.find((entry) => entry.id === evaluation.score.id);
    if (!version || job.updatedAt.toISOString() !== version.submittedUpdatedAt) {
      throw new Error(`Job ${job.id} changed after export; refusing a stale overwrite`);
    }
    if (evaluation.type === 'standard') {
      if (
        job.afBatchId !== run.manifest.batchId
        || !ELIGIBLE_STANDARD_STATUSES.includes(job.status)
        || job.scoringStatus !== 'scored'
        || job.aimFitScore !== null
      ) {
        throw new Error(`Standard job ${job.id} no longer holds the expected batch lease/state`);
      }
    } else if (
      job.luckyBatchId !== run.manifest.batchId
      || job.luckyStatus !== 'scoring'
    ) {
      throw new Error(`Wildcard job ${job.id} no longer holds the expected batch lease/state`);
    } else if (job.reqFitScore === null && !run.evaluations.some((e) => e.type === 'standard' && e.score.id === job.id)) {
      console.warn(`[WARNING] Skipping wildcard evaluation for job ${job.id} because it lacks an experience score and is not in the standard batch.`);
      continue;
    }
  }

  if (run.evaluations.some((evaluation) => evaluation.type === 'standard')) {
    const contextProfile = await prisma.contextProfile.findUnique({
      where: { id: 'global' },
      select: { rulesText: true, updatedAt: true },
    });
    const currentContextVersion = contextProfile?.updatedAt.toISOString() || null;
    if (currentContextVersion !== run.manifest.contextSnapshot.submittedUpdatedAt) {
      throw new Error('Context DB changed after A/E preparation; refusing scores made with stale context');
    }
    const currentContextContents = nativeContextSnapshotContents({
      rulesText: contextRulesForNativeScoring(contextProfile?.rulesText),
      submittedUpdatedAt: currentContextVersion,
    });
    if (
      sha256(currentContextContents) !== run.manifest.contextSnapshot.sha256
      || contextRulesForNativeScoring(contextProfile?.rulesText) !== run.contextProfile.rulesText
    ) {
      throw new Error('Current Context DB content does not match the immutable A/E snapshot');
    }
  }

  return { alreadyApplied: false, jobsById };
}

async function applyRun(
  run: ValidatedRun,
  jobsById: Awaited<ReturnType<typeof preflightDatabase>>['jobsById'],
): Promise<void> {
  const activeLock = readLock();
  const lockedRunRoot = path.resolve(projectRoot, activeLock.runRoot);
  const phase = run.evaluations.every((evaluation) => evaluation.type === 'wildcard')
    ? 'wildcard'
    : 'standard';
  if (
    typeof activeLock.requestId !== 'string'
    || activeLock.phase !== phase
    || !activeLock.batchId.startsWith(`native_${activeLock.requestId}_${phase}_`)
    || activeLock.batchId !== run.manifest.batchId
    || lockedRunRoot !== run.runRoot
  ) {
    throw new Error('The active scoring lock does not match the run being applied');
  }

  await prisma.$transaction(async (tx) => {
    const keys = run.evaluations.map((evaluation) => idempotencyKey(run.manifest.batchId, evaluation));
    const priorCount = await tx.jobScoreEvent.count({
      where: { idempotencyKey: { in: keys } },
    });
    if (priorCount !== 0) {
      throw new Error('A concurrent or partial import was detected inside the transaction');
    }

    const events = [];
    for (const evaluation of run.evaluations) {
      const job = jobsById.get(evaluation.score.id);
      if (!job) {
        throw new Error(`Missing preflight state for ${evaluation.score.id}`);
      }
      const version = evaluation.chunk.jobs.find((entry) => entry.id === evaluation.score.id);
      if (!version) {
        throw new Error(`Missing manifest version for ${evaluation.score.id}`);
      }
      const prompt = run.manifest.prompts[evaluation.type];

      if (evaluation.type === 'standard') {
        const experienceFitScore = guardedExperience(evaluation.score);
        const experienceFitReason = guardedExperienceReason(evaluation.score, experienceFitScore);
        const passed = passesStandardScoring(
          evaluation.score.aimFitScore,
          experienceFitScore,
        );
        const update = await tx.job.updateMany({
          where: {
            id: evaluation.score.id,
            afBatchId: run.manifest.batchId,
            updatedAt: new Date(version.submittedUpdatedAt),
            status: { in: ELIGIBLE_STANDARD_STATUSES },
            scoringStatus: 'scored',
            aimFitScore: null,
          },
          data: {
            aimFitScore: evaluation.score.aimFitScore,
            passReason: evaluation.score.aimFitReason,
            reqFitScore: experienceFitScore,
            reqFitRationale: experienceFitReason,
            travelScore: evaluation.score.travelScore,
            status: passed ? 'inbox' : 'dismissed',
            luckyStatus: qualifiesForWildcardAfterStandard(
              evaluation.score.aimFitScore,
              experienceFitScore,
            )
              ? 'pending'
              : 'none',
            afBatchId: null,
            scoringStatus: 'scored',
            experienceStatus: 'scored',
            scoreError: null,
            deepseekScoreError: null,
          },
        });
        if (update.count !== 1) {
          throw new Error(`Standard job ${evaluation.score.id} lost its lease during import`);
        }
        events.push({
          jobId: evaluation.score.id,
          evaluationType: 'standard',
          model: 'antigravity:flash',
          promptVersion: prompt.version,
          requestId: activeLock.requestId || run.manifest.batchId,
          idempotencyKey: idempotencyKey(run.manifest.batchId, evaluation),
          schemaVersion: run.manifest.schemaVersion,
          chunkId: evaluation.chunk.chunkId,
          batchId: run.manifest.batchId,
          manifestHash: run.manifest.manifestHash,
          resultHash: run.resultHashes[evaluation.chunk.chunkId],
          promptHash: prompt.sha256,
          evidenceHash: run.manifest.evidence.sha256,
          inputHash: evaluation.chunk.inputHash,
          evidenceIds: evaluation.score.evidenceIds,
          contextHash: run.manifest.contextSnapshot.sha256,
          contextProfileUpdatedAt: run.manifest.contextSnapshot.submittedUpdatedAt
            ? new Date(run.manifest.contextSnapshot.submittedUpdatedAt)
            : null,
          aimFitScore: evaluation.score.aimFitScore,
          experienceFitScore,
          travelScore: evaluation.score.travelScore,
          domainMatch: evaluation.score.domainMatch,
          requiredDomain: evaluation.score.requiredDomain,
          candidateDomain: evaluation.score.candidateDomain,
          requiredYearsInDomain: evaluation.score.requiredYearsInDomain,
          candidateYearsInDomain: evaluation.score.candidateYearsInDomain,
          passed,
          aimReason: evaluation.score.aimFitReason,
          experienceReason: experienceFitReason,
        });
      } else {
        let reqFitScore = job.reqFitScore;
        if (reqFitScore === null) {
          const standardEval = run.evaluations.find((e) => e.type === 'standard' && e.score.id === evaluation.score.id);
          if (standardEval && standardEval.type === 'standard') {
            reqFitScore = guardedExperience(standardEval.score);
          }
        }
        if (reqFitScore === null) {
          console.warn(`[WARNING] Resetting lease for wildcard job ${evaluation.score.id} (no experience score)`);
          await tx.job.update({
            where: { id: evaluation.score.id },
            data: { luckyStatus: 'pending', luckyBatchId: null },
          });
          continue;
        }
        const passed = passesWildcardScoring(evaluation.score.vibeFitScore, reqFitScore);
        const update = await tx.job.updateMany({
          where: {
            id: evaluation.score.id,
            luckyBatchId: run.manifest.batchId,
            luckyStatus: 'scoring',
            updatedAt: new Date(version.submittedUpdatedAt),
          },
          data: {
            luckyStatus: passed ? 'inbox' : 'dismissed',
            luckyBatchId: null,
            luckyAimFitScore: evaluation.score.vibeFitScore,
            luckyPassReason: passed
              ? `Vibe Fit: ${evaluation.score.vibeFitReason}`
              : `[Wildcard Reject] Vibe Fit: ${evaluation.score.vibeFitReason}`,
            luckyScoreError: null,
          },
        });
        if (update.count !== 1) {
          throw new Error(`Wildcard job ${evaluation.score.id} lost its lease during import`);
        }
        events.push({
          jobId: evaluation.score.id,
          evaluationType: 'wildcard',
          model: 'antigravity:flash',
          promptVersion: prompt.version,
          requestId: activeLock.requestId || run.manifest.batchId,
          idempotencyKey: idempotencyKey(run.manifest.batchId, evaluation),
          schemaVersion: run.manifest.schemaVersion,
          chunkId: evaluation.chunk.chunkId,
          batchId: run.manifest.batchId,
          manifestHash: run.manifest.manifestHash,
          resultHash: run.resultHashes[evaluation.chunk.chunkId],
          promptHash: prompt.sha256,
          evidenceHash: run.manifest.evidence.sha256,
          inputHash: evaluation.chunk.inputHash,
          evidenceIds: [],
          aimFitScore: evaluation.score.vibeFitScore,
          experienceFitScore: reqFitScore,
          passed,
          aimReason: evaluation.score.vibeFitReason,
        });
      }
    }

    await tx.jobScoreEvent.createMany({ data: events });

    if (typeof activeLock.requestId === 'string') {
      await tx.nativeScoringRequest.update({
        where: { id: activeLock.requestId },
        data: phase === 'standard'
          ? {
            phase: 'standard_preparing',
            progress: `Imported ${standardCountForRequest(run)} A/E score(s); checking for more.`,
            standardJobs: { increment: standardCountForRequest(run) },
            heartbeatAt: new Date(),
          }
          : {
            phase: 'wildcard_preparing',
            progress: `Imported ${wildcardCountForRequest(run)} wildcard score(s); checking for more.`,
            wildcardJobs: { increment: wildcardCountForRequest(run) },
            heartbeatAt: new Date(),
          },
      });
    }
  }, { maxWait: 15_000, timeout: 300_000 });

  const standardCount = run.evaluations.filter((evaluation) => evaluation.type === 'standard').length;
  const wildcardCount = run.evaluations.length - standardCount;
  const receipt = {
    schemaVersion: run.manifest.schemaVersion,
    batchId: run.manifest.batchId,
    manifestHash: run.manifest.manifestHash,
    importedAt: new Date().toISOString(),
    model: run.manifest.model,
    standardCount,
    wildcardCount,
    resultHashes: run.resultHashes,
  };
  const receiptPath = path.join(run.runRoot, 'import-receipt.json');
  try {
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error: unknown) {
    console.warn(
      `Database commit succeeded, but the receipt could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    fs.writeFileSync(lastRunPath, `${JSON.stringify({
      batchId: run.manifest.batchId,
      runRoot: path.relative(projectRoot, run.runRoot),
      manifestFile: path.relative(projectRoot, path.join(run.runRoot, 'manifest.json')),
      importedAt: receipt.importedAt,
    }, null, 2)}\n`, 'utf8');
  } catch (error: unknown) {
    console.warn(
      `Import succeeded, but the last-run pointer could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const lock = readLock();
    if (lock.batchId === run.manifest.batchId) {
      fs.unlinkSync(lockPath);
    }
  } catch (error: unknown) {
    console.warn(
      `Import succeeded, but the scoring lock could not be cleared: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function main(): Promise<void> {
  const { apply, runArgument } = parseArguments(process.argv.slice(2));
  const runRoot = resolveRunRoot(runArgument);
  const run = validateRun(runRoot);
  const standardCount = run.evaluations.filter((evaluation) => evaluation.type === 'standard').length;
  const wildcardCount = run.evaluations.length - standardCount;

  console.log(`Validated immutable batch ${run.manifest.batchId}.`);
  console.log(`Chunks: ${run.manifest.chunks.length}`);
  console.log(`Standard evaluations: ${standardCount}`);
  console.log(`Wildcard evaluations: ${wildcardCount}`);

  const preflight = await preflightDatabase(run);
  if (preflight.alreadyApplied) {
    console.log('This exact batch was already imported; no database writes were performed.');
    try {
      const lock = readLock();
      if (lock.batchId === run.manifest.batchId) fs.unlinkSync(lockPath);
    } catch (error: unknown) {
      console.warn(
        `The batch was already applied, but the scoring lock could not be cleared: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return;
  }

  const standardPasses = run.evaluations.filter((evaluation) => (
    evaluation.type === 'standard'
    && passesStandardScoring(
      evaluation.score.aimFitScore,
      guardedExperience(evaluation.score),
    )
  )).length;
  const wildcardPasses = run.evaluations.filter((evaluation) => {
    if (evaluation.type !== 'wildcard') return false;
    let reqFitScore = preflight.jobsById.get(evaluation.score.id)?.reqFitScore;
    if (reqFitScore == null) {
      const standardEval = run.evaluations.find((e) => e.type === 'standard' && e.score.id === evaluation.score.id);
      if (standardEval && standardEval.type === 'standard') {
        reqFitScore = guardedExperience(standardEval.score);
      }
    }
    return reqFitScore !== null
      && reqFitScore !== undefined
      && passesWildcardScoring(evaluation.score.vibeFitScore, reqFitScore);
  }).length;
  console.log(`Proposed standard passes: ${standardPasses}`);
  console.log(`Proposed wildcard passes: ${wildcardPasses}`);

  if (!apply) {
    console.log('Dry-run validation passed. Re-run with --apply to commit this exact manifest.');
    return;
  }

  await applyRun(run, preflight.jobsById);
  console.log('Import committed atomically. Result artifacts were preserved in the run directory.');
}

main()
  .catch((error: unknown) => {
    console.error(`Native scoring import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
