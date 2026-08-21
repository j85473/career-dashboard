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
  /** Set when a write was withheld because the requeue set exceeded maxRequeue. */
  withheldReason?: string;
};

/**
 * Reports which stored scores were produced under a different version of the
 * scoring inputs (policy, prompts, schemas, resume, evidence inventory).
 *
 * **Reporting is all it does by default.** Refining a policy does not mean the
 * judgments made before the refinement were wrong, and re-scoring the backlog
 * costs real manual hours, so version drift alone never invalidates a score.
 * Scores stay exactly where they are and jobs stay where they are; the report
 * simply tells you what drifted. `resolveStagedScoreAuthority` treats the same
 * drift as informational for the same reason.
 *
 * `invalidateDrifted: true` opts into the destructive path for the rare change
 * that genuinely does void prior judgments — clearing scores and requeuing
 * those jobs for a fresh manual pass. `maxRequeue` bounds that path so it
 * cannot wipe an unexpected amount in one unattended run.
 *
 * Nothing here ever produces a score: importing a scored artifact is the only
 * path that writes one.
 */
export async function reconcileScoringInputVersions(
  prisma: PrismaClient,
  options: {
    dryRun?: boolean;
    now?: Date;
    maxRequeue?: number;
    invalidateDrifted?: boolean;
  } = {},
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
  // Set membership rather than Array.includes: these scan the full event set
  // once per event, and this runs against the whole scored corpus inside a
  // deploy window.
  const staleAimEventIdSet = new Set(staleAimEventIds);
  const staleExperienceEventIdSet = new Set(staleExperienceEventIds);
  const staleEventIdSet = new Set(staleEventIds);
  const staleAimJobIds = new Set(events.filter((event) => staleAimEventIdSet.has(event.id)).map((event) => event.jobId));
  const staleExperienceJobIds = new Set(events.filter((event) => staleExperienceEventIdSet.has(event.id)).map((event) => event.jobId));
  const affectedJobIds = [...new Set(events.filter((event) => staleEventIdSet.has(event.id)).map((event) => event.jobId))];
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
  const requeuedJobIdSet = new Set(requeuedJobIds);
  const actionNeededJobIds = jobs.filter((job) => !requeuedJobIdSet.has(job.id)).map((job) => job.id);

  const report: ReconcileReport = {
    generatedAt: now.toISOString(), staleAimEventIds, staleExperienceEventIds,
    staleArtifactIds: artifacts.map((artifact) => artifact.id), staleExtractionIds,
    supersededBatchIds, requeuedJobIds, actionNeededJobIds,
    applied: !options.dryRun,
  };
  if (options.dryRun) return report;

  // Default: report drift, change nothing. A refined policy does not retract
  // the judgments made before it.
  if (!options.invalidateDrifted) {
    return {
      ...report,
      applied: false,
      withheldReason: requeuedJobIds.length === 0 && actionNeededJobIds.length === 0
        ? 'no drifted scores to report'
        : [
          requeuedJobIds.length > 0
            ? `${requeuedJobIds.length} job(s) carry scores from an earlier input version and were left untouched; pass invalidateDrifted to clear them`
            : null,
          actionNeededJobIds.length > 0
            ? `${actionNeededJobIds.length} additional drifted job(s) also need a manual lifecycle decision before they can be requeued`
            : null,
        ].filter(Boolean).join('; '),
    };
  }

  // Clearing scores destroys completed work, including the rationale text.
  // Past the cap this is a corpus-wide wipe rather than routine drift, so
  // report it and write nothing; re-run without a cap once you have seen the
  // number and decided you want it.
  if (options.maxRequeue !== undefined && requeuedJobIds.length > options.maxRequeue) {
    return {
      ...report,
      applied: false,
      withheldReason: `requeue set of ${requeuedJobIds.length} job(s) exceeds the ${options.maxRequeue}-job unattended cap`,
    };
  }

  await prisma.$transaction(async (tx) => {
    if (staleEventIds.length > 0) await tx.jobScoreEvent.updateMany({ where: { id: { in: staleEventIds }, staleAt: null }, data: { staleAt: now, staleReason: 'global-scoring-input-version-changed' } });
    if (report.staleArtifactIds.length > 0) await tx.jobScoringArtifact.updateMany({ where: { id: { in: report.staleArtifactIds }, staleAt: null }, data: { staleAt: now, staleReason: 'cleaner-version-changed' } });
    if (staleExtractionIds.length > 0) await tx.aimFactualExtraction.updateMany({
      where: { id: { in: staleExtractionIds }, staleAt: null },
      data: { staleAt: now, staleReason: 'aim-extraction-authority-changed' },
    });
    if (supersededBatchIds.length > 0) await tx.scoringBatch.updateMany({ where: { id: { in: supersededBatchIds }, status: 'exported' }, data: { status: 'superseded', supersededAt: now, supersededReason: 'global-scoring-input-version-changed' } });
    const replayAimJobIds = requeuedJobIds.filter((jobId) => staleAimJobIds.has(jobId));
    const replayExperienceJobIds = requeuedJobIds.filter((jobId) => !staleAimJobIds.has(jobId) && staleExperienceJobIds.has(jobId));
    if (replayAimJobIds.length > 0) await tx.job.updateMany({
      where: { id: { in: replayAimJobIds } },
      data: {
        status: 'pending_af',
        aimFitScore: null,
        reqFitScore: null,
        reqFitRationale: null,
        experienceStatus: 'queued',
        travelScore: null,
        compensation: null,
      },
    });
    if (replayExperienceJobIds.length > 0) await tx.job.updateMany({
      where: { id: { in: replayExperienceJobIds } },
      data: {
        status: 'pending_af',
        reqFitScore: null,
        reqFitRationale: null,
        experienceStatus: 'queued',
      },
    });
    if (requeuedJobIds.length > 0) await tx.jobPipelineEvent.createMany({
      data: requeuedJobIds.map((jobId) => ({
        eventKey: `score-version-requeue:${jobId}:${now.toISOString()}`,
        jobId,
        eventType: 'score_replay_queued',
        stage: 'manual_scoring',
        occurredAt: now,
        details: { reason: 'global-scoring-input-version-changed', actor: 'system' } as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 120_000,
  });
  return report;
}
