import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as mammoth from 'mammoth';
import { PrismaClient, type Prisma } from '@prisma/client';

import {
  contextRulesForNativeScoring,
  isContextFeedbackEligible,
  validateTypedContextRules,
} from '../src/lib/contextFeedbackPolicy';
import { materializeTypedContextRules } from '../src/lib/contextRuleMaterialization';
import {
  canonicalJson,
  CONTEXT_PROMPT_VERSION,
  MANAGER_PROMPT_VERSION,
  manifestHash,
  NATIVE_SCORING_EXPECTED_MODEL,
  nativeContextSnapshotContents,
  NATIVE_SCORING_CHUNK_SIZE,
  NATIVE_SCORING_STANDARD_BATCH_SIZE,
  NATIVE_SCORING_SCHEMA_VERSION,
  NativeContextProfile,
  NativeScoringJob,
  NativeScoringManifest,
  NativeStandardScoringJob,
  NativeScoringType,
  sha256,
  STANDARD_PROMPT_VERSION,
} from '../src/lib/nativeScoringBatch';
import { extractMandatoryRequirementCandidates } from '../src/lib/mandatoryRequirements';
import {
  assertCanonicalScoringResume,
  assertEvaluatorResumeMatches,
  CANONICAL_SCORING_RESUME_BASENAME,
} from '../src/lib/nativeScoringPromptBinding';
import { passesPreFilter } from '../src/lib/jobFiltering';
import { assessJobDescriptionQuality } from '../src/lib/jobDescriptionQuality';
import {
  recentDismissedRecoveryIds,
  RECENT_DISMISSED_RECOVERY_DAYS,
  RECENT_DISMISSED_RECOVERY_LIMIT,
  latestUsablePromptVersions,
  staleActiveScoreIds,
  type StandardScoreProvenance,
} from '../src/lib/scoringFreshness';

type Phase = NativeScoringType;
type PhaseJob = (NativeScoringJob | NativeStandardScoringJob) & { passReason?: string };

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
  manager: '.agents/agents/scoring-manager-v6/agent.md',
} as const;
const evidenceFile = '.agents/minified_evidence.json';
const baselineResumeFile = `data/resumes/${CANONICAL_SCORING_RESUME_BASENAME}`;
const DISMISSED_RECOVERY_CAMPAIGN_PROMPT_VERSION = 'standard-job-evaluator-v6.3';
const DISMISSED_RECOVERY_EVENT_SCAN_LIMIT = 5_000;
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
  if (phase !== 'context' && phase !== 'standard') {
    throw new Error('Provide --phase context or standard');
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
  const typedValidation = validateTypedContextRules(sanitized);
  if (typedValidation.rejected.length > 0) {
    throw new Error('Deterministic Context normalization produced a conflicting typed rule');
  }

  const inputHash = sha256(profile.rulesText);
  const idempotencyKey = `${requestId}:negative-only-normalizer:${inputHash.slice(0, 32)}`;
  await prisma.$transaction(async (tx) => {
    const updated = await tx.contextProfile.updateMany({
      where: { id: 'global', updatedAt: profile.updatedAt },
      data: { rulesText: sanitized },
    });
    if (updated.count !== 1) throw new Error('Context DB changed during negative-only normalization');
    await materializeTypedContextRules(tx, 'global', typedValidation.accepted, {
      source: 'legacy-normalizer',
      requestId,
      promptVersion: 'context-negative-only-normalizer-v2',
      confidence: null,
    });
    await tx.contextRuleRevision.create({
      data: {
        contextProfileId: 'global',
        previousRulesText: profile.rulesText,
        newRulesText: sanitized,
        sourceJobIds: [],
        model: 'deterministic:negative-only-normalizer',
        promptVersion: 'context-negative-only-normalizer-v2',
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

type StandardRequeueCounts = { staleInbox: number; recentDismissals: number };

const freshStandardQueueData = {
  status: 'pending_af',
  aimFitScore: null,
  reqFitScore: null,
  reqFitRationale: null,
  travelScore: null,
  compensation: null,
  passReason: null,
  experienceStatus: 'queued',
  afBatchId: null,
  scoreError: null,
  deepseekScoreError: null,
} as const;

// A version refresh must never make a currently visible inbox job disappear.
// Preserve its last committed scores and status until the replacement batch is
// validated and imported atomically. The distinct marker lets the standard
// lease query include it without confusing it with an ordinary unscored job.
const staleInboxRefreshData = {
  experienceStatus: 'rescore_queued',
  afBatchId: null,
  scoreError: null,
  deepseekScoreError: null,
} as const;

async function requeueForStandardScoring(tx: Prisma.TransactionClient): Promise<StandardRequeueCounts> {
  const candidates = await tx.job.findMany({
    where: {
      status: 'inbox',
      scoringStatus: 'scored',
      tailoringStaged: false,
      aimFitScore: { not: null },
      jdBatchId: null,
      batchJobId: null,
      afBatchId: null,
      fitCategory: { not: 'promoted' },
      pipelineEvents: { none: { eventType: { in: ['user_promote', 'user_reject'] } } },
      OR: [
        { passReason: null },
        { NOT: { passReason: { contains: 'promoted', mode: 'insensitive' } } },
      ],
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, passReason: true, tailoringStaged: true },
  });
  const events = candidates.length === 0 ? [] : await tx.jobScoreEvent.findMany({
    where: { jobId: { in: candidates.map((job) => job.id) }, evaluationType: 'standard' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { jobId: true, promptVersion: true, staleAt: true },
  });
  const latestVersions = latestUsablePromptVersions(events);
  const staleIds = staleActiveScoreIds(candidates, latestVersions, STANDARD_PROMPT_VERSION);
  const staleUpdate = staleIds.length === 0 ? { count: 0 } : await tx.job.updateMany({
    where: {
      id: { in: staleIds },
      status: 'inbox',
      scoringStatus: 'scored',
      tailoringStaged: false,
      aimFitScore: { not: null },
      jdBatchId: null,
      batchJobId: null,
      afBatchId: null,
      fitCategory: { not: 'promoted' },
      OR: [
        { passReason: null },
        { NOT: { passReason: { contains: 'promoted', mode: 'insensitive' } } },
      ],
      pipelineEvents: { none: { eventType: { in: ['user_promote', 'user_reject'] } } },
    },
    data: staleInboxRefreshData,
  });
  if (staleUpdate.count !== staleIds.length) {
    throw new Error('A stale Inbox candidate changed during native replay preparation');
  }

  // Recent-dismissal recovery is a one-time V6.3 calibration campaign. Once
  // any V6.3 standard result exists, later routine requests rescore only stale
  // active jobs and newly ingested work.
  const priorRecoveryCampaignScore = await tx.jobScoreEvent.findFirst({
    where: { evaluationType: 'standard', promptVersion: DISMISSED_RECOVERY_CAMPAIGN_PROMPT_VERSION },
    select: { id: true },
  });
  const cutoff = new Date(Date.now() - RECENT_DISMISSED_RECOVERY_DAYS * 24 * 60 * 60 * 1_000);
  const dismissalEvents = priorRecoveryCampaignScore ? [] : await tx.jobScoreEvent.findMany({
    where: { evaluationType: 'standard', createdAt: { gte: cutoff } },
    take: DISMISSED_RECOVERY_EVENT_SCAN_LIMIT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { jobId: true, promptVersion: true, passed: true, createdAt: true, staleAt: true },
  });
  const latestDismissalEvents = new Map<string, StandardScoreProvenance>();
  for (const event of dismissalEvents) {
    if (!latestDismissalEvents.has(event.jobId)) latestDismissalEvents.set(event.jobId, event);
  }
  const dismissedJobs = latestDismissalEvents.size === 0 ? [] : await tx.job.findMany({
    where: {
      id: { in: [...latestDismissalEvents.keys()] },
      status: 'dismissed',
      scoringStatus: 'scored',
      tailoringStaged: false,
      aimFitScore: { not: null },
      jdBatchId: null,
      batchJobId: null,
      afBatchId: null,
      fitCategory: { not: 'promoted' },
      OR: [
        { passReason: null },
        { NOT: { passReason: { contains: 'promoted', mode: 'insensitive' } } },
      ],
      pipelineEvents: { none: { eventType: { in: ['user_promote', 'user_reject'] } } },
    },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      description: true,
      url: true,
      aimFitScore: true,
      reqFitScore: true,
    },
  });
  const recoveryIds = recentDismissedRecoveryIds(
    dismissedJobs.map((job) => ({
      id: job.id,
      title: job.title,
      aimFitScore: job.aimFitScore,
      reqFitScore: job.reqFitScore,
      localFilterPasses: passesPreFilter({
        title: job.title,
        company: job.company,
        location: job.location || '',
        description: job.description || '',
        url: job.url || '',
      }).passes,
    })),
    latestDismissalEvents,
    STANDARD_PROMPT_VERSION,
    cutoff,
    RECENT_DISMISSED_RECOVERY_LIMIT,
  );
  const recoveredUpdate = recoveryIds.length === 0 ? { count: 0 } : await tx.job.updateMany({
    where: {
      id: { in: recoveryIds },
      status: 'dismissed',
      scoringStatus: 'scored',
      tailoringStaged: false,
      aimFitScore: { not: null },
      jdBatchId: null,
      batchJobId: null,
      afBatchId: null,
      fitCategory: { not: 'promoted' },
      OR: [
        { passReason: null },
        { NOT: { passReason: { contains: 'promoted', mode: 'insensitive' } } },
      ],
      pipelineEvents: { none: { eventType: { in: ['user_promote', 'user_reject'] } } },
    },
    data: freshStandardQueueData,
  });
  if (recoveredUpdate.count !== recoveryIds.length) {
    throw new Error('A dismissed recovery candidate changed during native replay preparation');
  }

  return { staleInbox: staleUpdate.count, recentDismissals: recoveredUpdate.count };
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
      },
      take: 500,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true, passReason: true },
    });
    const ineligibleIds = candidateRows
      .filter((job) => !isContextFeedbackEligible(job.status, job.passReason))
      .map((job) => job.id);
    if (ineligibleIds.length > 0) {
      await prisma.job.updateMany({
        where: { id: { in: ineligibleIds }, status: 'passed', contextBatched: false },
        data: { contextBatched: true, contextBatchId: null },
      });
    }
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
    const availableStandardJob: Prisma.JobWhereInput = {
      scoringStatus: 'scored',
      jdBatchId: null,
      batchJobId: null,
      afBatchId: null,
      tailoringStaged: false,
      NOT: [
        { fitCategory: 'promoted' },
        { passReason: { startsWith: 'Promoted by user:', mode: 'insensitive' } },
        { pipelineEvents: { some: { eventType: { in: ['user_promote', 'user_reject'] } } } },
      ],
    };
    const candidateOrder = [{ updatedAt: 'asc' as const }, { id: 'asc' as const }];

    // Refreshes protect jobs the user can already see. New pending jobs come
    // next, ahead of legacy inbox rows that never received an A/E score.
    const refreshCandidates = await prisma.job.findMany({
      where: {
        ...availableStandardJob,
        status: 'inbox',
        aimFitScore: { not: null },
        experienceStatus: 'rescore_queued',
      },
      take: NATIVE_SCORING_STANDARD_BATCH_SIZE,
      orderBy: candidateOrder,
      select: { id: true },
    });
    const pendingCapacity = NATIVE_SCORING_STANDARD_BATCH_SIZE - refreshCandidates.length;
    const pendingCandidates = pendingCapacity <= 0 ? [] : await prisma.job.findMany({
      where: {
        ...availableStandardJob,
        status: 'pending_af',
        aimFitScore: null,
      },
      take: pendingCapacity,
      orderBy: candidateOrder,
      select: { id: true },
    });
    const legacyCapacity = pendingCapacity - pendingCandidates.length;
    const legacyInboxCandidates = legacyCapacity <= 0 ? [] : await prisma.job.findMany({
      where: {
        ...availableStandardJob,
        status: 'inbox',
        aimFitScore: null,
      },
      take: legacyCapacity,
      orderBy: candidateOrder,
      select: { id: true },
    });
    const candidates = [
      ...refreshCandidates,
      ...pendingCandidates,
      ...legacyInboxCandidates,
    ];
    if (candidates.length > 0) {
      await prisma.job.updateMany({
        where: {
          id: { in: candidates.map((job) => job.id) },
          status: { in: ['inbox', 'pending_af'] },
          scoringStatus: 'scored',
          jdBatchId: null,
          batchJobId: null,
          afBatchId: null,
          tailoringStaged: false,
          NOT: [
            { fitCategory: 'promoted' },
            { passReason: { startsWith: 'Promoted by user:', mode: 'insensitive' } },
            { pipelineEvents: { some: { eventType: { in: ['user_promote', 'user_reject'] } } } },
          ],
          OR: [
            { aimFitScore: null },
            {
              status: 'inbox',
              aimFitScore: { not: null },
              experienceStatus: 'rescore_queued',
            },
          ],
        },
        data: { afBatchId: batchId },
      });
    }
    return fetchScoringJobs({ afBatchId: batchId });
  }

  throw new Error(`Unsupported phase: ${phase}`);
}

async function fetchScoringJobs(where: { afBatchId: string }): Promise<NativeStandardScoringJob[]> {
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
  const scorableJobs: NativeStandardScoringJob[] = [];
  for (const job of jobs) {
    const description = compactText(job.description, 12_000);
    const quality = assessJobDescriptionQuality(description);
    if (!quality.scorable) {
      await prisma.job.updateMany({
        where: { id: job.id, afBatchId: where.afBatchId },
        data: {
          scoringStatus: 'needs_jd',
          afBatchId: null,
          scoreError: `JD quality review required: ${quality.reason}`,
        },
      });
      continue;
    }
    try {
      scorableJobs.push({
        id: job.id,
        title: compactText(job.title, 500),
        company: compactText(job.company, 500),
        location: compactText(job.location, 500),
        description,
        mandatoryRequirementCandidates: extractMandatoryRequirementCandidates(description, job.title),
        submittedUpdatedAt: job.updatedAt.toISOString(),
      });
    } catch (error) {
      await prisma.job.updateMany({
        where: { id: job.id, afBatchId: where.afBatchId },
        data: {
          scoringStatus: 'needs_jd',
          afBatchId: null,
          scoreError: `JD requirement coverage review required: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }
  return scorableJobs;
}

async function finishEmptyPhase(requestId: string, phase: Phase): Promise<void> {
  if (phase === 'context') {
    await prisma.$transaction(async (tx) => {
      const counts = await requeueForStandardScoring(tx);
      await tx.nativeScoringRequest.update({
        where: { id: requestId },
        data: {
          phase: 'standard_preparing',
          progress: `Context is current. Requeued ${counts.staleInbox} stale inbox job(s) and ${counts.recentDismissals} recent A/E dismissal(s); preparing A/E scoring.`,
        },
      });
    }, { maxWait: 15_000, timeout: 60_000 });
  } else if (phase === 'standard') {
    await prisma.nativeScoringRequest.update({
      where: { id: requestId },
      data: {
        activeKey: null,
        status: 'completed',
        phase: 'completed',
        progress: 'Native context and A/E scoring are complete.',
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

  const baselineResumeBytes = requiredProjectFile(baselineResumeFile);
  const baselineResume = await mammoth.extractRawText({ buffer: baselineResumeBytes });
  assertCanonicalScoringResume(
    baselineResumeFile,
    baselineResumeBytes,
    baselineResume.value,
  );
  const compactResume = compactText(baselineResume.value, 50_000);
  const promptBuffers = {
    context: requiredProjectFile(promptFiles.context),
    standard: requiredProjectFile(promptFiles.standard),
    manager: requiredProjectFile(promptFiles.manager),
  };
  assertEvaluatorResumeMatches(
    promptBuffers.standard.toString('utf8'),
    '## 2. Context Rules & Policy Precedence',
    compactResume,
    'standard',
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
    take: 50,
    orderBy: { createdAt: 'desc' },
    select: { type: true, text: true },
  });
  const exportSnapshot = `${JSON.stringify({
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    requestId,
    batchId,
    phase,
    resume: compactResume,
    contextProfile,
    userPreferences,
    jobs,
  }, null, 2)}\n`;
  atomicWrite(path.join(runRoot, 'export.snapshot.json'), exportSnapshot);
  atomicWrite(path.join(runRoot, 'context.snapshot.json'), contextContents);

  const chunks: NativeScoringManifest['chunks'] = [];
  for (let offset = 0; offset < jobs.length; offset += NATIVE_SCORING_CHUNK_SIZE) {
    const chunkId = `chunk_${String(chunks.length).padStart(4, '0')}`;
    const chunkJobs = jobs.slice(offset, offset + NATIVE_SCORING_CHUNK_SIZE);
    const chunk = { schemaVersion: NATIVE_SCORING_SCHEMA_VERSION, batchId, chunkId, type: phase, contextProfile, jobs: chunkJobs };
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
    model: {
      surface: 'antigravity-native-subagent',
      tier: 'flash',
      expectedModel: NATIVE_SCORING_EXPECTED_MODEL,
    },
    prompts: {
      context: { version: CONTEXT_PROMPT_VERSION, file: promptFiles.context, sha256: sha256(promptBuffers.context) },
      standard: { version: STANDARD_PROMPT_VERSION, file: promptFiles.standard, sha256: sha256(promptBuffers.standard) },
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

  const phaseField = `${phase}BatchId` as 'contextBatchId' | 'standardBatchId';
  const runField = `${phase}Runs` as 'contextRuns' | 'standardRuns';
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
