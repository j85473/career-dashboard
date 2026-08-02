import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import {
  contextRulesForNativeScoring,
  isContextFeedbackEligible,
} from '../src/lib/contextFeedbackPolicy';
import {
  canonicalJson,
  CONTEXT_PROMPT_VERSION,
  MANAGER_PROMPT_VERSION,
  manifestHash,
  nativeContextSnapshotContents,
  NATIVE_SCORING_CHUNK_SIZE,
  NATIVE_SCORING_SCHEMA_VERSION,
  NativeContextProfile,
  NativeScoringJob,
  NativeScoringManifest,
  NativeScoringType,
  sha256,
  STANDARD_PROMPT_VERSION,
  WILDCARD_PROMPT_VERSION,
} from '../src/lib/nativeScoringBatch';
import { assertEvaluatorResumeMatches } from '../src/lib/nativeScoringPromptBinding';
import { getAllResumes } from '../src/lib/resume';
import { wildcardFeedbackForPrompt } from '../src/lib/wildcardFeedback';

type Phase = NativeScoringType;
type PhaseJob = NativeScoringJob & { passReason?: string };

const prisma = new PrismaClient();
const projectRoot = process.cwd();
const agentsRoot = path.join(projectRoot, '.agents');
const runsRoot = path.join(agentsRoot, 'eval_runs');
const lockPath = path.join(agentsRoot, 'scoring-lock.json');
let preparingBatchId: string | null = null;
let preparingPhase: Phase | null = null;

const promptFiles = {
  context: '.agents/agents/context-job-evaluator-v6/agent.md',
  standard: '.agents/agents/standard-job-evaluator-v6/agent.md',
  wildcard: '.agents/agents/wildcard-job-evaluator-v6/agent.md',
  manager: '.agents/agents/scoring-manager-v6/agent.md',
} as const;
const evidenceFile = '.agents/minified_evidence.json';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArguments(argv: string[]): { requestId: string; phase: Phase } {
  let requestId = '';
  let phase = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--request') {
      requestId = argv[index + 1] || '';
      index += 1;
    } else if (argv[index] === '--phase') {
      phase = argv[index + 1] || '';
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!UUID_PATTERN.test(requestId)) {
    throw new Error('Provide a UUID request ID with --request');
  }
  if (phase !== 'context' && phase !== 'standard' && phase !== 'wildcard') {
    throw new Error('Provide --phase context, standard, or wildcard');
  }
  return { requestId, phase };
}

function compactText(value: string | null | undefined, maxLength: number): string {
  const text = (value || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (text.length <= maxLength) return text;
  const tailLength = Math.min(4_000, Math.floor(maxLength / 4));
  return `${text.slice(0, maxLength - tailLength)}\n\n[content shortened]\n\n${text.slice(-tailLength)}`;
}

function atomicWrite(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporaryPath, filePath);
}

function requiredProjectFile(relativePath: string): Buffer {
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Required file is missing: ${relativePath}`);
  return fs.readFileSync(absolutePath);
}

async function normalizeContextState(requestId: string): Promise<void> {
  await prisma.job.updateMany({
    where: {
      contextBatchId: { not: null },
      OR: [
        { status: { in: ['applied', 'interviewing', 'expired', 'archived'] } },
        { status: 'passed', passReason: { contains: 'expired', mode: 'insensitive' } },
      ],
    },
    data: { contextBatched: true, contextBatchId: null },
  });

  const profile = await prisma.contextProfile.findUnique({ where: { id: 'global' } });
  if (!profile) return;
  const sanitized = contextRulesForNativeScoring(profile.rulesText);
  if (sanitized === profile.rulesText.trim()) return;

  const inputHash = sha256(profile.rulesText);
  const idempotencyKey = `${requestId}:negative-only-normalizer:${inputHash.slice(0, 32)}`;
  await prisma.$transaction(async (tx) => {
    const updated = await tx.contextProfile.updateMany({
      where: { id: 'global', updatedAt: profile.updatedAt },
      data: { rulesText: sanitized },
    });
    if (updated.count !== 1) throw new Error('Context DB changed during negative-only normalization');
    await tx.contextRuleRevision.create({
      data: {
        contextProfileId: 'global',
        previousRulesText: profile.rulesText,
        newRulesText: sanitized,
        sourceJobIds: [],
        model: 'deterministic:negative-only-normalizer',
        promptVersion: 'context-negative-only-normalizer-v1',
        requestId,
        idempotencyKey,
        schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
        inputHash,
        contextHash: sha256(`${JSON.stringify({
          rulesText: profile.rulesText,
          submittedUpdatedAt: profile.updatedAt.toISOString(),
        }, null, 2)}\n`),
      },
    });
  });
}

async function releaseFailedPreparation(): Promise<void> {
  if (!preparingBatchId || !preparingPhase) return;
  if (preparingPhase === 'context') {
    await prisma.job.updateMany({
      where: { contextBatchId: preparingBatchId },
      data: { contextBatchId: null },
    });
  } else if (preparingPhase === 'standard') {
    await prisma.job.updateMany({
      where: { afBatchId: preparingBatchId },
      data: { afBatchId: null },
    });
  } else {
    await prisma.job.updateMany({
      where: { luckyBatchId: preparingBatchId },
      data: { luckyBatchId: null, luckyStatus: 'pending' },
    });
  }
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { batchId?: unknown };
    if (lock.batchId === preparingBatchId) fs.unlinkSync(lockPath);
  }
}

async function leaseJobs(phase: Phase, batchId: string): Promise<PhaseJob[]> {
  if (phase === 'context') {
    const candidateRows = await prisma.job.findMany({
      where: {
        status: 'passed',
        contextBatched: false,
        contextBatchId: null,
        passReason: { not: null },
        NOT: { passReason: { contains: 'expired', mode: 'insensitive' } },
      },
      take: 50,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true, passReason: true },
    });
    const candidates = candidateRows
      .filter((job) => isContextFeedbackEligible(job.status, job.passReason))
      .slice(0, NATIVE_SCORING_CHUNK_SIZE);
    if (candidates.length > 0) {
      await prisma.job.updateMany({
        where: {
          id: { in: candidates.map((job) => job.id) },
          status: 'passed',
          contextBatched: false,
          contextBatchId: null,
          NOT: { passReason: { contains: 'expired', mode: 'insensitive' } },
        },
        data: { contextBatchId: batchId },
      });
    }
    return prisma.job.findMany({
      where: { contextBatchId: batchId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        title: true,
        company: true,
        location: true,
        description: true,
        passReason: true,
        updatedAt: true,
      },
    }).then((jobs) => jobs.map((job) => ({
      id: job.id,
      title: compactText(job.title, 500) || '(Untitled job)',
      company: compactText(job.company, 500) || '(Unknown company)',
      location: compactText(job.location, 500),
      description: compactText(job.description, 12_000) || '(No job description stored.)',
      passReason: compactText(job.passReason, 2_000),
      submittedUpdatedAt: job.updatedAt.toISOString(),
    })));
  }

  if (phase === 'standard') {
    const candidates = await prisma.job.findMany({
      where: {
        status: { in: ['inbox', 'pending_af'] },
        scoringStatus: 'scored',
        jdBatchId: null,
        batchJobId: null,
        afBatchId: null,
        aimFitScore: null,
      },
      take: 300,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (candidates.length > 0) {
      await prisma.job.updateMany({
        where: {
          id: { in: candidates.map((job) => job.id) },
          status: { in: ['inbox', 'pending_af'] },
          scoringStatus: 'scored',
          jdBatchId: null,
          batchJobId: null,
          afBatchId: null,
          aimFitScore: null,
        },
        data: { afBatchId: batchId },
      });
    }
    return fetchScoringJobs({ afBatchId: batchId });
  }

  const candidates = await prisma.job.findMany({
    where: {
      status: { in: ['dismissed', 'pending_af', 'inbox'] },
      luckyStatus: 'pending',
      scoringStatus: 'scored',
      jdBatchId: null,
      batchJobId: null,
      afBatchId: null,
      luckyBatchId: null,
      reqFitScore: { not: null },
    },
    take: 100,
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (candidates.length > 0) {
    await prisma.job.updateMany({
      where: {
        id: { in: candidates.map((job) => job.id) },
        luckyStatus: 'pending',
        luckyBatchId: null,
        reqFitScore: { not: null },
      },
      data: { luckyBatchId: batchId, luckyStatus: 'scoring' },
    });
  }
  return fetchScoringJobs({ luckyBatchId: batchId });
}

async function fetchScoringJobs(where: { afBatchId?: string; luckyBatchId?: string }): Promise<PhaseJob[]> {
  const jobs = await prisma.job.findMany({
    where,
    orderBy: { id: 'asc' },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      description: true,
      updatedAt: true,
    },
  });
  return jobs.map((job) => ({
    id: job.id,
    title: compactText(job.title, 500),
    company: compactText(job.company, 500),
    location: compactText(job.location, 500),
    description: compactText(job.description, 12_000),
    submittedUpdatedAt: job.updatedAt.toISOString(),
  }));
}

async function finishEmptyPhase(requestId: string, phase: Phase): Promise<void> {
  if (phase === 'context') {
    await prisma.nativeScoringRequest.update({
      where: { id: requestId },
      data: { phase: 'standard_preparing', progress: 'Context is current. Preparing A/E scoring.' },
    });
  } else if (phase === 'standard') {
    await prisma.nativeScoringRequest.update({
      where: { id: requestId },
      data: { phase: 'wildcard_preparing', progress: 'A/E scoring is current. Preparing wildcard scoring.' },
    });
  } else {
    await prisma.nativeScoringRequest.update({
      where: { id: requestId },
      data: {
        activeKey: null,
        status: 'completed',
        phase: 'completed',
        progress: 'Native context, A/E, and wildcard scoring are complete.',
        completedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
  }
}

async function main(): Promise<void> {
  const { requestId, phase } = parseArguments(process.argv.slice(2));
  if (fs.existsSync(lockPath)) throw new Error('A native scoring lock already exists');
  const request = await prisma.nativeScoringRequest.findUnique({ where: { id: requestId } });
  if (!request || request.activeKey !== 'global' || !['queued', 'running'].includes(request.status)) {
    throw new Error('The native scoring request is not active');
  }

  const resumes = await getAllResumes();
  const coreResume = resumes.find((resume) => resume.name === 'Joseph_Lamb_Resume');
  if (!coreResume) throw new Error('The Joseph_Lamb_Resume core resume was not found');
  const compactResume = compactText(coreResume.text, 50_000);
  const promptBuffers = {
    context: requiredProjectFile(promptFiles.context),
    standard: requiredProjectFile(promptFiles.standard),
    wildcard: requiredProjectFile(promptFiles.wildcard),
    manager: requiredProjectFile(promptFiles.manager),
  };
  assertEvaluatorResumeMatches(
    promptBuffers.standard.toString('utf8'),
    '## 2. Context Rules & Policy Precedence',
    compactResume,
    'standard',
  );
  assertEvaluatorResumeMatches(
    promptBuffers.wildcard.toString('utf8'),
    '## 2. Wildcard Profile (The Dreamer Archetype)',
    compactResume,
    'wildcard',
  );
  const evidence = requiredProjectFile(evidenceFile);
  const standardEvidence = /### Minified Evidence Inventory\s*```json\s*([\s\S]*?)\s*```/.exec(
    promptBuffers.standard.toString('utf8'),
  );
  if (!standardEvidence || canonicalJson(JSON.parse(standardEvidence[1])) !== canonicalJson(JSON.parse(evidence.toString('utf8')))) {
    throw new Error('The baked standard evidence does not match the trusted evidence file');
  }

  if (phase === 'context') await normalizeContextState(requestId);

  const batchId = `native_${requestId}_${phase}_${randomUUID().slice(0, 8)}`;
  preparingBatchId = batchId;
  preparingPhase = phase;
  const jobs = await leaseJobs(phase, batchId);
  if (jobs.length === 0) {
    await finishEmptyPhase(requestId, phase);
    console.log(JSON.stringify({ prepared: false, requestId, phase }));
    return;
  }

  const contextProfileEntity = await prisma.contextProfile.findUnique({ where: { id: 'global' } });
  const contextProfile: NativeContextProfile = {
    rulesText: contextRulesForNativeScoring(contextProfileEntity?.rulesText),
    submittedUpdatedAt: contextProfileEntity?.updatedAt.toISOString() || null,
  };
  const contextContents = nativeContextSnapshotContents(contextProfile);

  const runRoot = path.join(runsRoot, batchId);
  const chunksDir = path.join(runRoot, 'chunks');
  const resultsDir = path.join(runRoot, 'results');
  fs.mkdirSync(chunksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });

  const userPreferences = await prisma.userPreference.findMany({
    where: { NOT: { type: { startsWith: 'wildcard_' } } },
    take: 50,
    orderBy: { createdAt: 'desc' },
    select: { type: true, text: true },
  });
  const wildcardProfileEntity = await prisma.wildcardProfile.findFirst();
  const wildcardProfile = wildcardFeedbackForPrompt(
    wildcardProfileEntity?.profileText || '- No wildcard profile has been established.',
  );
  const exportSnapshot = `${JSON.stringify({
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    requestId,
    batchId,
    phase,
    resume: compactResume,
    contextProfile,
    userPreferences,
    wildcardProfile,
    jobs,
  }, null, 2)}\n`;
  atomicWrite(path.join(runRoot, 'export.snapshot.json'), exportSnapshot);
  atomicWrite(path.join(runRoot, 'context.snapshot.json'), contextContents);

  const chunks: NativeScoringManifest['chunks'] = [];
  for (let offset = 0; offset < jobs.length; offset += NATIVE_SCORING_CHUNK_SIZE) {
    const chunkId = `chunk_${String(chunks.length).padStart(4, '0')}`;
    const chunkJobs = jobs.slice(offset, offset + NATIVE_SCORING_CHUNK_SIZE);
    const chunk = phase === 'wildcard'
      ? { schemaVersion: NATIVE_SCORING_SCHEMA_VERSION, batchId, chunkId, type: phase, jobs: chunkJobs }
      : { schemaVersion: NATIVE_SCORING_SCHEMA_VERSION, batchId, chunkId, type: phase, contextProfile, jobs: chunkJobs };
    const contents = `${JSON.stringify(chunk, null, 2)}\n`;
    atomicWrite(path.join(chunksDir, `${chunkId}.json`), contents);
    chunks.push({
      chunkId,
      type: phase,
      inputFile: `chunks/${chunkId}.json`,
      resultFile: `results/${chunkId}.result.json`,
      inputHash: sha256(contents),
      jobs: chunkJobs.map((job) => ({ id: job.id, submittedUpdatedAt: job.submittedUpdatedAt })),
    });
  }

  const createdAt = new Date().toISOString();
  const unsigned: Omit<NativeScoringManifest, 'manifestHash'> = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId,
    createdAt,
    chunkSize: NATIVE_SCORING_CHUNK_SIZE,
    model: { surface: 'antigravity-native-subagent', tier: 'flash', expectedModel: 'gemini-3.6-flash' },
    prompts: {
      context: { version: CONTEXT_PROMPT_VERSION, file: promptFiles.context, sha256: sha256(promptBuffers.context) },
      standard: { version: STANDARD_PROMPT_VERSION, file: promptFiles.standard, sha256: sha256(promptBuffers.standard) },
      wildcard: { version: WILDCARD_PROMPT_VERSION, file: promptFiles.wildcard, sha256: sha256(promptBuffers.wildcard) },
      manager: { version: MANAGER_PROMPT_VERSION, file: promptFiles.manager, sha256: sha256(promptBuffers.manager) },
    },
    evidence: { file: evidenceFile, sha256: sha256(evidence) },
    contextSnapshot: {
      file: 'context.snapshot.json',
      sha256: sha256(contextContents),
      submittedUpdatedAt: contextProfile.submittedUpdatedAt,
    },
    exportSnapshot: { file: 'export.snapshot.json', sha256: sha256(exportSnapshot) },
    chunks,
  };
  const manifest: NativeScoringManifest = { ...unsigned, manifestHash: manifestHash(unsigned) };
  atomicWrite(path.join(runRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  atomicWrite(lockPath, `${JSON.stringify({
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    requestId,
    phase,
    batchId,
    runRoot: path.relative(projectRoot, runRoot),
    manifestFile: path.relative(projectRoot, path.join(runRoot, 'manifest.json')),
    createdAt,
  }, null, 2)}\n`);

  const phaseField = `${phase}BatchId` as 'contextBatchId' | 'standardBatchId' | 'wildcardBatchId';
  const runField = `${phase}Runs` as 'contextRuns' | 'standardRuns' | 'wildcardRuns';
  await prisma.nativeScoringRequest.update({
    where: { id: requestId },
    data: {
      status: 'running',
      phase: `${phase}_scoring`,
      progress: `Prepared ${jobs.length} ${phase} item(s) in ${chunks.length} immutable chunk(s).`,
      heartbeatAt: new Date(),
      [phaseField]: batchId,
      [runField]: { increment: 1 },
    },
  });
  console.log(JSON.stringify({ prepared: true, requestId, phase, batchId, chunks: chunks.length, jobs: jobs.length }));
}

main()
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Native phase preparation failed: ${message}`);
    await releaseFailedPreparation().catch((cleanupError: unknown) => {
      console.error(
        `Failed preparation cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    });
    const requestId = process.argv[process.argv.indexOf('--request') + 1];
    if (UUID_PATTERN.test(requestId || '')) {
      await prisma.nativeScoringRequest.updateMany({
        where: { id: requestId },
        data: { status: 'failed', error: message.slice(0, 4_000), progress: 'Native phase preparation failed.' },
      }).catch(() => undefined);
    }
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
