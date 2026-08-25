import type { Prisma } from '@prisma/client';

import { recordJobPipelineEvent } from '@/lib/ingestionControl';
import { AUTHORITATIVE_SCORE_EVENT_TYPES, scoreInvalidationReason } from '@/lib/scoreAuthority';
import { automatedLifecycleIsProtected } from '@/lib/manualImportPolicy';
import { assertJobLifecycleInvariants } from '@/lib/jobLifecycleInvariant';
import type { CurrentScoringInputVersions } from '@/lib/scoringInputVersions';

type ScoreInvalidationClient = Prisma.TransactionClient;

export async function invalidateActiveJobScores(
  input: {
    jobId: string;
    source?: string | null;
    sourceId?: string | null;
    changedFields: readonly string[];
    route: string;
    occurredAt?: Date;
    scoringInputVersions?: CurrentScoringInputVersions;
  },
  client: ScoreInvalidationClient,
): Promise<{
  invalidatedEventIds: string[];
  invalidatedArtifactIds: string[];
  invalidatedExtractionIds: string[];
  supersededBatchIds: string[];
  staleReason: string;
}> {
  const staleReason = scoreInvalidationReason(input.changedFields);
  const nonstaleScoreEvents = await client.jobScoreEvent.findMany({
    where: {
      jobId: input.jobId,
      evaluationType: { in: [...AUTHORITATIVE_SCORE_EVENT_TYPES] },
      staleAt: null,
    },
    select: { id: true, lifecycleProjection: true, createdAt: true },
  });

  const invalidatedAt = input.occurredAt || new Date();
  if (nonstaleScoreEvents.length > 0) {
    const invalidated = await client.jobScoreEvent.updateMany({
      where: {
        id: { in: nonstaleScoreEvents.map((event) => event.id) },
        staleAt: null,
      },
      data: { staleAt: invalidatedAt, staleReason },
    });
    if (invalidated.count !== nonstaleScoreEvents.length) {
      throw new Error('A score changed while its job inputs were being edited');
    }
  }

  const activeArtifacts = await client.jobScoringArtifact.findMany({ where: { jobId: input.jobId, staleAt: null }, select: { id: true } });
  if (activeArtifacts.length > 0) {
    const invalidatedArtifacts = await client.jobScoringArtifact.updateMany({
      where: { id: { in: activeArtifacts.map((artifact) => artifact.id) }, staleAt: null },
      data: { staleAt: invalidatedAt, staleReason },
    });
    if (invalidatedArtifacts.count !== activeArtifacts.length) throw new Error('a scoring artifact changed during invalidation');
  }

  const extractionInputsChanged = input.changedFields.some((field) => (
    ['description', 'title', 'company', 'location'].includes(field)
  ));
  const activeExtractions = extractionInputsChanged
    ? await client.aimFactualExtraction.findMany({
      where: { jobId: input.jobId, staleAt: null },
      select: { id: true },
    })
    : [];
  if (activeExtractions.length > 0) {
    const invalidatedExtractions = await client.aimFactualExtraction.updateMany({
      where: { id: { in: activeExtractions.map((extraction) => extraction.id) }, staleAt: null },
      data: { staleAt: invalidatedAt, staleReason },
    });
    if (invalidatedExtractions.count !== activeExtractions.length) {
      throw new Error('an Aim factual extraction changed during invalidation');
    }
  }

  const activeBatchItems = await client.scoringBatchItem.findMany({
    where: { jobId: input.jobId, status: 'leased', batch: { status: 'exported' } },
    select: { batchId: true },
  });
  const supersededBatchIds = [...new Set(activeBatchItems.map((item) => item.batchId))];
  if (supersededBatchIds.length > 0) {
    await client.scoringBatch.updateMany({
      where: { id: { in: supersededBatchIds }, status: 'exported' },
      data: { status: 'superseded', supersededAt: invalidatedAt, supersededReason: staleReason },
    });
  }

  const job = await client.job.findUnique({
    where: { id: input.jobId },
    select: {
      status: true, tailoringStaged: true, source: true,
      pipelineEvents: { where: { eventType: { in: ['user_promote', 'user_reject', 'user_lifecycle'] } }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 1, select: { id: true } },
    },
  });
  const latestMachineProjection = [...nonstaleScoreEvents].sort((left, right) => right.createdAt.valueOf() - left.createdAt.valueOf())[0]?.lifecycleProjection;
  if (
    job
    && !automatedLifecycleIsProtected(job)
    && !job.tailoringStaged
    && job.pipelineEvents.length === 0
    && latestMachineProjection
    && job.status === latestMachineProjection
  ) {
    await client.job.update({ where: { id: input.jobId }, data: { status: 'pending_af' } });
  }

  for (const scoreEvent of nonstaleScoreEvents) {
    await recordJobPipelineEvent({
      eventType: 'score_invalidated',
      jobId: input.jobId,
      stage: 'manual_scoring',
      source: input.source,
      sourceId: input.sourceId,
      occurredAt: invalidatedAt,
      identityParts: ['job_input_edit', scoreEvent.id],
      details: {
        invalidatedEventId: scoreEvent.id,
        reason: staleReason,
        changedFields: [...input.changedFields],
        route: input.route,
      },
    }, client);
  }

  await assertJobLifecycleInvariants(client, [input.jobId], { versions: input.scoringInputVersions });

  return {
    invalidatedEventIds: nonstaleScoreEvents.map((event) => event.id),
    invalidatedArtifactIds: activeArtifacts.map((artifact) => artifact.id),
    invalidatedExtractionIds: activeExtractions.map((extraction) => extraction.id),
    supersededBatchIds,
    staleReason,
  };
}
