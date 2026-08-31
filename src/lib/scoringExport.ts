import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { Prisma, type AimScoringFailureReceipt, type PrismaClient } from '@prisma/client';
import * as mammoth from 'mammoth';

import { activeAimFailureSuppression } from './aimScoringFailure';
import { currentAimFailureIdentity } from './aimCurrentInput';
import { validateAimFactualVector } from './aimEvidence';
import {
  aimSourceJdHash,
  aimTrustedMetadataHash,
  normalizeAimTrustedMetadata,
} from './aimIdentity';
import { loadAimQuestionRegistry } from './aimQuestionRegistry';
import { loadAimScoringPolicy } from './aimScoringPolicy';
import { isCurrentAimExperienceAnchor } from './aimStage1';
import {
  createScoringBatch,
  getStoredScoringExport,
  type CreateScoringBatchInput,
  type ScoringBatchSourceItem,
} from './scoringBatch';
import { canonicalJsonSha256, normalizeScoringText } from './scoringCanonicalJson';
import { loadCoreEvidenceSnapshot } from './scoringEvidence';
import type { ScoringStage } from './scoringInputBinding';
import { currentScoringInputVersions, type CurrentScoringInputVersions } from './scoringInputVersions';
import {
  MANUAL_SCORING_BATCH_SIZE,
  MAX_SCORING_RUN_JOBS,
  SCORING_RUN_CHILD_BATCH_SIZE,
} from './scoringLimits';
import { createScoringRun } from './scoringRun';
import { resolveStagedScoreAuthority } from './scoreAuthority';
import { latestJobScoreEvents } from './jobScoreAuthorityQuery';
import { aimScoringPriorityOrder } from './manualScoringPriority';
import { operationalQueueWhere } from './operationalQueue';

const EXTRACTION_SCOPE_RANK: Readonly<Record<string, number>> = {
  stage1: 1,
  compensation_preflight: 2,
  complete: 3,
};

type DbClient = PrismaClient | Prisma.TransactionClient;

type AimExportJobV2 = {
  jobId: string;
  ordinal: number;
  submittedUpdatedAt: string;
  inputHash: string;
  trustedMetadata: { company: string; title: string; location: string | null };
  trustedMetadataHash: string;
  source: { originalJd: string; sourceJdHash: string };
  sourceIdentity: string;
  extractionIdentity: string;
  transportProvenance: { sourceUrl: string | null };
  reuse: null | {
    aimFactualExtractionId: string;
    scope: string;
    extractionIdentity: string;
    factualVectorHash: string;
    factualVector: Record<string, unknown>;
  };
};

type AimPrepared = ScoringBatchSourceItem & {
  exportJob: AimExportJobV2;
  currentFailureIdentity: {
    inputHash: string;
    extractionIdentity: string;
    runnerProtocolHash: string;
    scoringPolicyHash: string;
    resultBuilderSemanticVersion: string;
  };
};

type ExperiencePrepared = ScoringBatchSourceItem & { exportJob: Record<string, unknown> };

type AimCandidate = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  canonicalUrl: string | null;
  url: string | null;
  description: string | null;
  updatedAt: Date;
  aimFailureReceipts?: AimScoringFailureReceipt[];
};

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MANUAL_SCORING_BATCH_SIZE) {
    throw new Error(`export limit must be 1–${MANUAL_SCORING_BATCH_SIZE}`);
  }
}

async function verifiedAimReuse(
  client: DbClient,
  jobId: string,
  extractionIdentity: string,
  originalJd: string,
  trustedMetadata: AimExportJobV2['trustedMetadata'],
  versions: CurrentScoringInputVersions,
): Promise<AimExportJobV2['reuse']> {
  const rows = await client.aimFactualExtraction.findMany({
    where: { jobId, extractionIdentity, staleAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (rows.length === 0) return null;
  const { registry } = loadAimQuestionRegistry(versions.questionRegistryHash);
  const { policy } = loadAimScoringPolicy(registry, versions.aimPolicyHash);
  const verified = rows.map((row) => {
    const expectedBindings: Array<[unknown, unknown, string]> = [
      [row.schemaVersion, 'career-dashboard-aim-factual-vector-v1', 'schemaVersion'],
      [row.extractionIdentity, extractionIdentity, 'extractionIdentity'],
      [row.sourceJdHash, aimSourceJdHash(originalJd), 'sourceJdHash'],
      [row.trustedMetadataHash, aimTrustedMetadataHash(trustedMetadata), 'trustedMetadataHash'],
      [row.questionRegistryVersion, versions.questionRegistryVersion, 'questionRegistryVersion'],
      [row.questionRegistryHash, versions.questionRegistryHash, 'questionRegistryHash'],
      [row.promptContractVersion, versions.promptContractVersion, 'promptContractVersion'],
      [row.promptContractHash, versions.promptContractHash, 'promptContractHash'],
      [row.responseContractVersion, versions.responseContractVersion, 'responseContractVersion'],
      [row.responseContractHash, versions.responseContractHash, 'responseContractHash'],
      // Runner/preflight/concurrency settings are immutable row provenance but
      // deliberately are not extraction-identity invalidators. Any runner change
      // that alters accepted facts must increment extractorSemanticVersion.
      [row.packetStrategyVersion, versions.packetStrategyVersion, 'packetStrategyVersion'],
      [row.packetStrategyHash, versions.packetStrategyHash, 'packetStrategyHash'],
      [row.canonicalizationVersion, versions.canonicalizationVersion, 'canonicalizationVersion'],
      [row.anonymizationPolicyVersion, versions.anonymizationPolicyVersion, 'anonymizationPolicyVersion'],
      [row.anonymizationPolicyHash, versions.anonymizationPolicyHash, 'anonymizationPolicyHash'],
      [row.extractorSemanticVersion, versions.extractorSemanticVersion, 'extractorSemanticVersion'],
    ];
    for (const [actual, expected, field] of expectedBindings) {
      if (actual !== expected) throw new Error(`stored Aim extraction ${row.id} has stale ${field}`);
    }
    const vector = validateAimFactualVector({
      vector: row.extractionSnapshot,
      canonicalOriginalJd: originalJd,
      trustedMetadata,
      registry,
      policy,
    });
    if (vector.scope !== row.scope || vector.factualVectorHash !== row.factualVectorHash) {
      throw new Error(`stored Aim extraction ${row.id} disagrees with its immutable vector`);
    }
    return { row, vector };
  }).sort((left, right) => (
    (EXTRACTION_SCOPE_RANK[right.vector.scope] ?? 0) - (EXTRACTION_SCOPE_RANK[left.vector.scope] ?? 0)
    || right.row.createdAt.valueOf() - left.row.createdAt.valueOf()
  ));
  const selected = verified[0];
  return {
    aimFactualExtractionId: selected.row.id,
    scope: selected.vector.scope,
    extractionIdentity: selected.vector.extractionIdentity,
    factualVectorHash: selected.vector.factualVectorHash,
    factualVector: selected.vector as unknown as Record<string, unknown>,
  };
}

async function prepareAimCandidate(
  client: DbClient,
  job: AimCandidate,
  ordinal: number,
  versions: CurrentScoringInputVersions,
): Promise<AimPrepared> {
  const originalJd = normalizeScoringText(job.description || '');
  const trustedMetadata = normalizeAimTrustedMetadata({ company: job.company, title: job.title, location: job.location });
  const sourceJdHash = aimSourceJdHash(originalJd);
  const trustedMetadataHash = aimTrustedMetadataHash(trustedMetadata);
  const currentFailureIdentity = currentAimFailureIdentity(job, versions);
  const { sourceIdentity, extractionIdentity, inputHash } = currentFailureIdentity;
  const reuse = await verifiedAimReuse(
    client,
    job.id,
    extractionIdentity,
    originalJd,
    trustedMetadata,
    versions,
  );
  const exportJob: AimExportJobV2 = {
    jobId: job.id,
    ordinal,
    submittedUpdatedAt: job.updatedAt.toISOString(),
    inputHash,
    trustedMetadata,
    trustedMetadataHash,
    source: { originalJd, sourceJdHash },
    sourceIdentity,
    extractionIdentity,
    transportProvenance: { sourceUrl: job.canonicalUrl || job.url },
    reuse,
  };
  return {
    jobId: job.id,
    submittedUpdatedAt: job.updatedAt,
    sourceJdHash,
    inputHash,
    inputSnapshot: {
      ...exportJob,
      globalInputVersionsHash: versions.aimInputVersionsHash,
      extractionVersionsHash: versions.aimExtractionVersionsHash,
      scoringVersionsHash: versions.aimScoringVersionsHash,
    } as unknown as Prisma.InputJsonValue,
    aimFactualExtractionId: reuse?.aimFactualExtractionId,
    latestPacketPlanHash: reuse && isRecord(reuse.factualVector.provenance)
      ? String(reuse.factualVector.provenance.packetPlanHash || '') || undefined
      : undefined,
    exportJob,
    currentFailureIdentity,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function prepareAim(prisma: PrismaClient, limit: number): Promise<AimPrepared[]> {
  const versions = currentScoringInputVersions();
  const prepared: AimPrepared[] = [];
  const pageSize = 250;
  let offset = 0;
  let exhausted = false;

  while (prepared.length < limit && !exhausted) {
    const candidates = await prisma.job.findMany({
      where: {
        ...operationalQueueWhere('aim_fit', []),
        description: { not: null },
        scoringBatchItems: { none: { status: 'leased' } },
      },
      orderBy: aimScoringPriorityOrder(),
      skip: offset,
      take: pageSize,
      select: {
        id: true,
        title: true,
        company: true,
        location: true,
        canonicalUrl: true,
        url: true,
        description: true,
        updatedAt: true,
        aimFailureReceipts: {
          where: { suppressionActive: true, clearedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        },
      },
    });
    offset += candidates.length;
    exhausted = candidates.length < pageSize;
    const bundles = await latestJobScoreEvents(candidates.map((job) => job.id), prisma);

    for (const job of candidates) {
      const bundle = bundles.get(job.id);
      if (bundle?.aim && resolveStagedScoreAuthority(bundle).aimAuthorityState !== 'stale_replay_needed') continue;
      const item = await prepareAimCandidate(prisma, job, prepared.length, versions);
      const suppressed = job.aimFailureReceipts.some((receipt) => activeAimFailureSuppression(receipt, item.currentFailureIdentity));
      if (suppressed) continue;
      prepared.push(item);
      if (prepared.length === limit) break;
    }
  }
  return prepared;
}

function aimBatchInput(prepared: AimPrepared[], versions: CurrentScoringInputVersions): CreateScoringBatchInput {
  return {
    stage: 'aim',
    schemaVersion: 'career-dashboard-aim-export-v2',
    protocolVersion: versions.protocolVersion,
    policyVersion: versions.aimPolicyVersion,
    inputVersionsHash: versions.aimInputVersionsHash,
    questionRegistryHash: versions.questionRegistryHash,
    promptContractHash: versions.promptContractHash,
    responseContractHash: versions.responseContractHash,
    runnerProtocolHash: versions.runnerProtocolHash,
    packetStrategyHash: versions.packetStrategyHash,
    scoringPolicyHash: versions.aimPolicyHash,
    anonymizationPolicyHash: versions.anonymizationPolicyHash,
    resultBuilderSemanticVersion: versions.resultBuilderSemanticVersion,
    items: prepared,
    buildExport: ({ batchId, createdAt, expiresAt, manifestHash, protocolVersion }) => ({
      schemaVersion: 'career-dashboard-aim-export-v2',
      batch: {
        id: batchId,
        stage: 'aim',
        createdAt,
        expiresAt,
        protocolVersion,
        exportSchemaVersion: 'career-dashboard-aim-export-v2',
        questionRegistryVersion: versions.questionRegistryVersion,
        questionRegistryHash: versions.questionRegistryHash,
        scoringPolicyVersion: versions.aimPolicyVersion,
        scoringPolicyHash: versions.aimPolicyHash,
        promptContractVersion: versions.promptContractVersion,
        promptContractHash: versions.promptContractHash,
        responseContractVersion: versions.responseContractVersion,
        responseContractHash: versions.responseContractHash,
        runnerProtocolVersion: versions.runnerProtocolVersion,
        runnerProtocolHash: versions.runnerProtocolHash,
        packetStrategyVersion: versions.packetStrategyVersion,
        packetStrategyHash: versions.packetStrategyHash,
        canonicalizationVersion: versions.canonicalizationVersion,
        anonymizationPolicyVersion: versions.anonymizationPolicyVersion,
        anonymizationPolicyHash: versions.anonymizationPolicyHash,
        extractorSemanticVersion: versions.extractorSemanticVersion,
        resultBuilderSemanticVersion: versions.resultBuilderSemanticVersion,
        manifestHash,
      },
      jobs: prepared.map((item) => item.exportJob),
    }),
  };
}

export async function buildAimFailureRetryBatchInput(
  tx: Prisma.TransactionClient,
  receipt: AimScoringFailureReceipt,
): Promise<CreateScoringBatchInput> {
  const versions = currentScoringInputVersions();
  const job = await tx.job.findUnique({
    where: { id: receipt.jobId },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      canonicalUrl: true,
      url: true,
      description: true,
      updatedAt: true,
    },
  });
  if (!job?.description) throw new Error('suppressed Aim job no longer has a source JD');
  const prepared = await prepareAimCandidate(tx, job, 0, versions);
  if (!activeAimFailureSuppression(receipt, prepared.currentFailureIdentity)) {
    throw new Error('Aim failure suppression no longer matches current inputs');
  }
  return aimBatchInput([prepared], versions);
}

async function prepareExperience(prisma: PrismaClient, limit: number) {
  const versions = currentScoringInputVersions();
  const prepared: Array<ScoringBatchSourceItem & { exportJob: Record<string, unknown> }> = [];
  const pageSize = 250;
  let offset = 0;
  let exhausted = false;

  while (prepared.length < limit && !exhausted) {
    const candidates = await prisma.job.findMany({
      where: {
        ...operationalQueueWhere('experience_fit', []),
        description: { not: null },
        scoringBatchItems: { none: { status: 'leased' } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: pageSize,
      select: {
        id: true,
        title: true,
        company: true,
        location: true,
        description: true,
        updatedAt: true,
      },
    });
    offset += candidates.length;
    exhausted = candidates.length < pageSize;
    const bundles = await latestJobScoreEvents(candidates.map((job) => job.id), prisma);

    for (const job of candidates) {
      const bundle = bundles.get(job.id);
      if (!bundle) continue;
      const authority = resolveStagedScoreAuthority(bundle);
      const aim = authority.currentAim;
      if (!aim?.passed || aim.schemaVersion !== 'career-dashboard-aim-result-v2'
        || !aim.aimFactualExtractionId || !aim.semanticResultHash
        || authority.experienceAuthorityState === 'current') continue;
      const extraction = await prisma.aimFactualExtraction.findUnique({ where: { id: aim.aimFactualExtractionId } });
      const originalJd = normalizeScoringText(job.description || '');
      const sourceJdHash = aimSourceJdHash(originalJd);
      if (!isCurrentAimExperienceAnchor(extraction, sourceJdHash)) continue;
      const trustedMetadata = normalizeAimTrustedMetadata({ company: job.company, title: job.title, location: job.location });
      const trustedMetadataHash = aimTrustedMetadataHash(trustedMetadata);
      if (trustedMetadataHash !== extraction.trustedMetadataHash) continue;
      const inputHash = canonicalJsonSha256({
        kind: 'experience_batch_item_input_v2',
        stage: 'experience',
        protocolVersion: versions.protocolVersion,
        exportSchemaVersion: 'career-dashboard-experience-export-v2',
        globalInputVersionsHash: versions.experienceInputVersionsHash,
        sourceAimEventId: aim.id,
        aimFactualExtractionId: extraction.id,
        sourceJdHash,
        trustedMetadataHash,
        aimSemanticResultHash: aim.semanticResultHash,
        resumeHash: versions.resumeHash,
        evidenceHash: versions.evidenceHash,
      });
      const ordinal = prepared.length;
      const exportJob = {
        jobId: job.id,
        ordinal,
        submittedUpdatedAt: job.updatedAt.toISOString(),
        sourceAimEventId: aim.id,
        aimFactualExtractionId: extraction.id,
        sourceJdHash,
        originalJd,
        trustedMetadata,
        trustedMetadataHash,
        aimSemanticResultHash: aim.semanticResultHash,
        inputHash,
      };
      prepared.push({
        jobId: job.id,
        submittedUpdatedAt: job.updatedAt,
        sourceJdHash,
        inputHash,
        inputSnapshot: {
          ...exportJob,
          globalInputVersionsHash: versions.experienceInputVersionsHash,
        } as unknown as Prisma.InputJsonValue,
        sourceAimEventId: aim.id,
        aimFactualExtractionId: extraction.id,
        exportJob,
      });
      if (prepared.length === limit) break;
    }
  }
  return prepared;
}

function reordinalizePrepared<T extends ScoringBatchSourceItem & { exportJob: Record<string, unknown> }>(
  items: T[],
): T[] {
  return items.map((item, ordinal) => ({
    ...item,
    exportJob: { ...item.exportJob, ordinal },
    inputSnapshot: {
      ...(item.inputSnapshot as unknown as Record<string, unknown>),
      ordinal,
    } as unknown as Prisma.InputJsonValue,
  }));
}

function experienceBatchInput(
  prepared: ExperiencePrepared[],
  versions: CurrentScoringInputVersions,
  extractedText: string,
  evidence: ReturnType<typeof loadCoreEvidenceSnapshot>,
): CreateScoringBatchInput {
  return {
    stage: 'experience',
    schemaVersion: 'career-dashboard-experience-export-v2',
    protocolVersion: versions.protocolVersion,
    policyVersion: 'experience-policy-v2',
    inputVersionsHash: versions.experienceInputVersionsHash,
    resumeHash: versions.resumeHash,
    evidenceHash: versions.evidenceHash,
    items: prepared,
    buildExport: ({ batchId, createdAt, expiresAt, manifestHash, protocolVersion }) => ({
      schemaVersion: 'career-dashboard-experience-export-v2',
      batch: {
        id: batchId,
        stage: 'experience',
        createdAt,
        expiresAt,
        protocolVersion,
        exportSchemaVersion: 'career-dashboard-experience-export-v2',
        policyVersion: 'experience-policy-v2',
        manifestHash,
      },
      resume: { filename: 'JosephLamb_Resume.docx', hash: versions.resumeHash, extractedText },
      evidence,
      jobs: prepared.map((item) => item.exportJob),
    }),
  };
}

async function experienceSharedInputs(versions: CurrentScoringInputVersions) {
  const resumeBytes = fs.readFileSync('data/resumes/JosephLamb_Resume.docx');
  const actualResumeHash = createHash('sha256').update(resumeBytes).digest('hex');
  if (actualResumeHash !== versions.resumeHash) throw new Error('canonical resume changed during export');
  const extractedText = normalizeScoringText((await mammoth.extractRawText({ buffer: resumeBytes })).value);
  return { extractedText, evidence: loadCoreEvidenceSnapshot() };
}

export async function exportScoringBatch(
  prisma: PrismaClient,
  stage: ScoringStage,
  limit = MANUAL_SCORING_BATCH_SIZE,
) {
  assertLimit(limit);
  const versions = currentScoringInputVersions();
  if (stage === 'aim') {
    const prepared = await prepareAim(prisma, limit);
    if (prepared.length === 0) throw new Error('no Aim Ready jobs are available');
    const batch = await createScoringBatch(prisma, aimBatchInput(prepared, versions));
    return { batch, file: await getStoredScoringExport(prisma, batch.id) };
  }

  const prepared = await prepareExperience(prisma, limit);
  if (prepared.length === 0) throw new Error('no Experience Ready jobs are available');
  const { extractedText, evidence } = await experienceSharedInputs(versions);
  const batch = await createScoringBatch(
    prisma,
    experienceBatchInput(prepared as ExperiencePrepared[], versions, extractedText, evidence),
  );
  return { batch, file: await getStoredScoringExport(prisma, batch.id) };
}

export async function exportScoringRun(prisma: PrismaClient, stage: ScoringStage) {
  const versions = currentScoringInputVersions();
  const prepared = stage === 'aim'
    ? await prepareAim(prisma, MAX_SCORING_RUN_JOBS + 1)
    : await prepareExperience(prisma, MAX_SCORING_RUN_JOBS + 1);
  if (prepared.length === 0) throw new Error(`no ${stage === 'aim' ? 'Aim' : 'Experience'} Ready jobs are available`);
  if (prepared.length > MAX_SCORING_RUN_JOBS) {
    throw new Error(`scoring run exceeds the ${MAX_SCORING_RUN_JOBS}-job safety ceiling; no jobs were leased`);
  }

  let extractedText = '';
  let evidence: ReturnType<typeof loadCoreEvidenceSnapshot> | null = null;
  if (stage === 'experience') {
    const shared = await experienceSharedInputs(versions);
    extractedText = shared.extractedText;
    evidence = shared.evidence;
  }

  const batchInputs: CreateScoringBatchInput[] = [];
  for (let start = 0; start < prepared.length; start += SCORING_RUN_CHILD_BATCH_SIZE) {
    const child = reordinalizePrepared(
      prepared.slice(start, start + SCORING_RUN_CHILD_BATCH_SIZE) as Array<
        AimPrepared | ExperiencePrepared
      >,
    );
    batchInputs.push(stage === 'aim'
      ? aimBatchInput(child as AimPrepared[], versions)
      : experienceBatchInput(
        child as ExperiencePrepared[],
        versions,
        extractedText,
        evidence!,
      ));
  }
  return createScoringRun(prisma, { stage, batchInputs });
}
