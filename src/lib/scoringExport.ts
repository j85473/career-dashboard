import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { type PrismaClient } from '@prisma/client';
import * as mammoth from 'mammoth';

import aimEmployerOverrides from '../../data/scoring/aim-employer-overrides-v1.json';

import { createScoringBatch, getStoredScoringExport, type ScoringBatchSourceItem } from './scoringBatch';
import { canonicalJsonSha256, normalizeScoringText, normalizedTextSha256 } from './scoringCanonicalJson';
import { loadCoreEvidenceSnapshot } from './scoringEvidence';
import { scoringInputHash, type SemanticInputBinding, type ScoringStage } from './scoringInputBinding';
import { currentScoringInputVersions } from './scoringInputVersions';
import { resolveStagedScoreAuthority } from './scoreAuthority';
import { latestJobScoreEvents } from './jobScoreAuthorityQuery';

const USER_EVENT_TYPES = ['user_promote', 'user_reject', 'user_lifecycle'] as const;

type AimPrepared = ScoringBatchSourceItem & {
  exportJob: {
    jobId: string; ordinal: number; submittedUpdatedAt: string; company: string; title: string; location: string | null;
    sourceUrl: string | null; originalJd: string; sourceJdHash: string; metadataHash: string; inputHash: string;
  };
};

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('export limit must be 1–50');
}

async function prepareAim(prisma: PrismaClient, limit: number): Promise<AimPrepared[]> {
  const versions = currentScoringInputVersions();
  const candidates = await prisma.job.findMany({
    where: {
      status: 'pending_af', scoringStatus: 'scored', tailoringStaged: false, description: { not: null },
      scoringBatchItems: { none: { status: 'leased' } },
      pipelineEvents: { none: { eventType: { in: [...USER_EVENT_TYPES] } } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: Math.min(limit * 5, 250),
    select: { id: true, title: true, company: true, location: true, canonicalUrl: true, url: true, description: true, updatedAt: true },
  });
  const bundles = await latestJobScoreEvents(candidates.map((job) => job.id));
  const ready = candidates.filter((job) => {
    const bundle = bundles.get(job.id);
    if (!bundle?.aim) return true;
    return resolveStagedScoreAuthority(bundle).aimAuthorityState === 'stale_replay_needed';
  }).slice(0, limit);
  return ready.map((job, ordinal) => {
    const originalJd = normalizeScoringText(job.description || '');
    const sourceJdHash = normalizedTextSha256(originalJd);
    const sourceUrl = job.canonicalUrl || job.url;
    const metadataHash = canonicalJsonSha256({ company: job.company, title: job.title, location: job.location, sourceUrl });
    const binding: SemanticInputBinding = {
      stage: 'aim', protocolVersion: versions.protocolVersion, schemaVersion: 'career-dashboard-aim-export-v1',
      globalInputVersionsHash: versions.aimInputVersionsHash,
      policyHash: versions.aimPolicyHash, sourceJdHash, metadataHash,
      employerOverridesHash: versions.employerOverridesHash, preferencesHash: versions.aimPolicyHash,
    };
    const inputHash = scoringInputHash(binding);
    const exportJob = {
      jobId: job.id, ordinal, submittedUpdatedAt: job.updatedAt.toISOString(), company: job.company, title: job.title,
      location: job.location, sourceUrl, originalJd, sourceJdHash, metadataHash, inputHash,
    };
    return {
      jobId: job.id, submittedUpdatedAt: job.updatedAt, sourceJdHash, inputHash,
      inputSnapshot: { ...exportJob, globalInputVersionsHash: versions.aimInputVersionsHash, binding },
      exportJob,
    };
  });
}

async function prepareExperience(prisma: PrismaClient, limit: number) {
  const versions = currentScoringInputVersions();
  const candidates = await prisma.job.findMany({
    where: {
      status: 'pending_af', tailoringStaged: false,
      scoringBatchItems: { none: { status: 'leased' } },
      pipelineEvents: { none: { eventType: { in: [...USER_EVENT_TYPES] } } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: Math.min(limit * 5, 250),
    select: { id: true, updatedAt: true },
  });
  const bundles = await latestJobScoreEvents(candidates.map((job) => job.id));
  const prepared: Array<ScoringBatchSourceItem & { exportJob: Record<string, unknown> }> = [];
  for (const job of candidates) {
    const bundle = bundles.get(job.id);
    if (!bundle) continue;
    const authority = resolveStagedScoreAuthority(bundle);
    if (!authority.currentAim?.passed || !bundle.cleanedArtifact || authority.experienceAuthorityState === 'current') continue;
    const artifact = await prisma.jobScoringArtifact.findUnique({ where: { id: bundle.cleanedArtifact.id } });
    if (!artifact || artifact.staleAt) continue;
    const aimEventHash = authority.currentAim.resultHash;
    if (!aimEventHash) throw new Error(`Aim event ${authority.currentAim.id} has no result hash`);
    const metadataHash = canonicalJsonSha256({ jobId: job.id, submittedUpdatedAt: job.updatedAt.toISOString() });
    const binding: SemanticInputBinding = {
      stage: 'experience', protocolVersion: versions.protocolVersion, schemaVersion: 'career-dashboard-experience-export-v1',
      globalInputVersionsHash: versions.experienceInputVersionsHash,
      policyHash: versions.experiencePolicyHash, sourceJdHash: artifact.sourceJdHash, metadataHash,
      cleanedArtifactHash: artifact.contentHash, sourceAimEventHash: aimEventHash,
      resumeHash: versions.resumeHash, evidenceHash: versions.evidenceHash,
    };
    const inputHash = scoringInputHash(binding);
    const ordinal = prepared.length;
    const exportJob = {
      jobId: job.id, ordinal, submittedUpdatedAt: job.updatedAt.toISOString(), aimEventId: authority.currentAim.id,
      aimEventHash, cleanedArtifactId: artifact.id, cleanedArtifactHash: artifact.contentHash,
      cleanedText: artifact.cleanedText, sourceJdHash: artifact.sourceJdHash, inputHash,
    };
    prepared.push({
      jobId: job.id, submittedUpdatedAt: job.updatedAt, sourceJdHash: artifact.sourceJdHash, inputHash,
      inputSnapshot: { ...exportJob, globalInputVersionsHash: versions.experienceInputVersionsHash, binding },
      sourceAimEventId: authority.currentAim.id, cleanedArtifactId: artifact.id, exportJob,
    });
    if (prepared.length === limit) break;
  }
  return prepared;
}

export async function exportScoringBatch(prisma: PrismaClient, stage: ScoringStage, limit = 20) {
  assertLimit(limit);
  const versions = currentScoringInputVersions();
  if (stage === 'aim') {
    const prepared = await prepareAim(prisma, limit);
    if (prepared.length === 0) throw new Error('no Aim Ready jobs are available');
    const batch = await createScoringBatch(prisma, {
      stage, schemaVersion: 'career-dashboard-aim-export-v1', policyVersion: 'aim-policy-v1',
      inputVersionsHash: versions.aimInputVersionsHash, preferenceHash: versions.aimPolicyHash,
      employerOverridesHash: versions.employerOverridesHash, items: prepared,
      buildExport: ({ batchId, createdAt, expiresAt, manifestHash, protocolVersion }) => ({
        schemaVersion: 'career-dashboard-aim-export-v1',
        batch: { id: batchId, stage, createdAt, expiresAt, protocolVersion, policyVersion: 'aim-policy-v1', manifestHash },
        preferences: { policyHash: versions.aimPolicyHash, employerOverridesHash: versions.employerOverridesHash, employerOverrides: aimEmployerOverrides },
        jobs: prepared.map((item) => item.exportJob),
      }),
    });
    return { batch, file: await getStoredScoringExport(prisma, batch.id) };
  }

  const prepared = await prepareExperience(prisma, limit);
  if (prepared.length === 0) throw new Error('no Experience Ready jobs are available');
  const resumeBytes = fs.readFileSync('data/resumes/JosephLamb_Resume.docx');
  const actualResumeHash = createHash('sha256').update(resumeBytes).digest('hex');
  if (actualResumeHash !== versions.resumeHash) throw new Error('canonical resume changed during export');
  const extractedText = normalizeScoringText((await mammoth.extractRawText({ buffer: resumeBytes })).value);
  const evidence = loadCoreEvidenceSnapshot();
  const batch = await createScoringBatch(prisma, {
    stage, schemaVersion: 'career-dashboard-experience-export-v1', policyVersion: 'experience-policy-v1',
    inputVersionsHash: versions.experienceInputVersionsHash, resumeHash: versions.resumeHash, evidenceHash: versions.evidenceHash,
    items: prepared,
    buildExport: ({ batchId, createdAt, expiresAt, manifestHash, protocolVersion }) => ({
      schemaVersion: 'career-dashboard-experience-export-v1',
      batch: { id: batchId, stage, createdAt, expiresAt, protocolVersion, policyVersion: 'experience-policy-v1', manifestHash },
      resume: { filename: 'JosephLamb_Resume.docx', hash: versions.resumeHash, extractedText }, evidence,
      jobs: prepared.map((item) => item.exportJob),
    }),
  });
  return { batch, file: await getStoredScoringExport(prisma, batch.id) };
}
