import { Prisma, type PrismaClient } from '@prisma/client';

import { currentScoringInputVersions, eventInputBindingsCurrent } from './scoringInputVersions';

type ReconcileReport = {
  generatedAt: string;
  staleAimEventIds: string[];
  staleExperienceEventIds: string[];
  staleArtifactIds: string[];
  staleExtractionIds: string[];
  supersededBatchIds: string[];
  requeuedJobIds: string[];
  actionNeededJobIds: string[];
  applied: boolean;
};

export async function reconcileScoringInputVersions(
  prisma: PrismaClient,
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<ReconcileReport> {
  const versions = currentScoringInputVersions();
  const now = options.now || new Date();
  const events = await prisma.jobScoreEvent.findMany({
    where: { evaluationType: { in: ['aim_fit', 'experience_fit'] }, staleAt: null },
    select: { id: true, jobId: true, evaluationType: true, schemaVersion: true, inputBindings: true, cleanedJdArtifactId: true, lifecycleProjection: true, createdAt: true },
    orderBy: [{ jobId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  const staleAimEventIds = events.filter((event) => event.evaluationType === 'aim_fit'
    && event.schemaVersion === 'career-dashboard-aim-result-v2'
    && !eventInputBindingsCurrent('aim', event.inputBindings, versions)).map((event) => event.id);
  const staleExperienceEventIds = events.filter((event) => event.evaluationType === 'experience_fit'
    && event.schemaVersion === 'career-dashboard-experience-result-v2'
    && !eventInputBindingsCurrent('experience', event.inputBindings, versions)).map((event) => event.id);
  const extractions = await prisma.aimFactualExtraction.findMany({
    where: { staleAt: null },
    select: {
      id: true,
      questionRegistryHash: true,
      promptContractHash: true,
      responseContractHash: true,
      packetStrategyHash: true,
      canonicalizationVersion: true,
      anonymizationPolicyVersion: true,
      anonymizationPolicyHash: true,
      extractorSemanticVersion: true,
    },
  });
  const staleExtractionIds = extractions.filter((extraction) => (
    extraction.questionRegistryHash !== versions.questionRegistryHash
    || extraction.promptContractHash !== versions.promptContractHash
    || extraction.responseContractHash !== versions.responseContractHash
    || extraction.packetStrategyHash !== versions.packetStrategyHash
    || extraction.canonicalizationVersion !== versions.canonicalizationVersion
    || extraction.anonymizationPolicyVersion !== versions.anonymizationPolicyVersion
    || extraction.anonymizationPolicyHash !== versions.anonymizationPolicyHash
    || extraction.extractorSemanticVersion !== versions.extractorSemanticVersion
  )).map((extraction) => extraction.id);
  // Cleaned artifacts are immutable v1 replay history after the v2 original-JD
  // cutover. A retired cleaner version cannot stale or rewrite that history.
  const artifacts: Array<{ id: string }> = [];
  const batches = await prisma.scoringBatch.findMany({
    where: { status: 'exported', schemaVersion: { in: ['career-dashboard-aim-export-v2', 'career-dashboard-experience-export-v2'] } },
    select: { id: true, stage: true, inputVersionsHash: true },
  });
  const supersededBatchIds = batches.filter((batch) => batch.inputVersionsHash !== (batch.stage === 'aim' ? versions.aimInputVersionsHash : versions.experienceInputVersionsHash)).map((batch) => batch.id);
  const staleEventIds = [...staleAimEventIds, ...staleExperienceEventIds];
  const affectedJobIds = [...new Set(events.filter((event) => staleEventIds.includes(event.id)).map((event) => event.jobId))];
  const jobs = affectedJobIds.length === 0 ? [] : await prisma.job.findMany({
    where: { id: { in: affectedJobIds } },
    select: { id: true, status: true, tailoringStaged: true, pipelineEvents: { where: { eventType: { in: ['user_promote', 'user_reject', 'user_lifecycle'] } }, take: 1, select: { id: true } } },
  });
  const latestEventByJob = new Map<string, typeof events[number]>();
  for (const event of events) if (!latestEventByJob.has(event.jobId)) latestEventByJob.set(event.jobId, event);
  const requeuedJobIds = jobs.filter((job) => {
    const projection = latestEventByJob.get(job.id)?.lifecycleProjection;
    return !job.tailoringStaged && job.pipelineEvents.length === 0 && Boolean(projection) && job.status === projection;
  }).map((job) => job.id);
  const actionNeededJobIds = jobs.filter((job) => !requeuedJobIds.includes(job.id)).map((job) => job.id);

  const report: ReconcileReport = {
    generatedAt: now.toISOString(), staleAimEventIds, staleExperienceEventIds,
    staleArtifactIds: artifacts.map((artifact) => artifact.id), staleExtractionIds,
    supersededBatchIds, requeuedJobIds, actionNeededJobIds,
    applied: !options.dryRun,
  };
  if (options.dryRun) return report;

  await prisma.$transaction(async (tx) => {
    if (staleEventIds.length > 0) await tx.jobScoreEvent.updateMany({ where: { id: { in: staleEventIds }, staleAt: null }, data: { staleAt: now, staleReason: 'global-scoring-input-version-changed' } });
    if (report.staleArtifactIds.length > 0) await tx.jobScoringArtifact.updateMany({ where: { id: { in: report.staleArtifactIds }, staleAt: null }, data: { staleAt: now, staleReason: 'cleaner-version-changed' } });
    if (staleExtractionIds.length > 0) await tx.aimFactualExtraction.updateMany({
      where: { id: { in: staleExtractionIds }, staleAt: null },
      data: { staleAt: now, staleReason: 'aim-extraction-authority-changed' },
    });
    if (supersededBatchIds.length > 0) await tx.scoringBatch.updateMany({ where: { id: { in: supersededBatchIds }, status: 'exported' }, data: { status: 'superseded', supersededAt: now, supersededReason: 'global-scoring-input-version-changed' } });
    if (requeuedJobIds.length > 0) await tx.job.updateMany({ where: { id: { in: requeuedJobIds } }, data: { status: 'pending_af' } });
    for (const jobId of requeuedJobIds) {
      await tx.jobPipelineEvent.create({ data: {
        eventKey: `score-version-requeue:${jobId}:${now.toISOString()}`,
        jobId, eventType: 'score_replay_queued', stage: 'manual_scoring', occurredAt: now,
        details: { reason: 'global-scoring-input-version-changed', actor: 'system' } as Prisma.InputJsonValue,
      } });
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return report;
}
