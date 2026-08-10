import type { Prisma } from '@prisma/client';

import { recordJobPipelineEvent } from '@/lib/ingestionControl';
import { AUTHORITATIVE_SCORE_EVENT_TYPES, scoreInvalidationReason } from '@/lib/scoreAuthority';

type ScoreInvalidationClient = Pick<
  Prisma.TransactionClient,
  'jobScoreEvent' | 'jobPipelineEvent'
>;

export async function invalidateActiveJobScores(
  input: {
    jobId: string;
    source?: string | null;
    sourceId?: string | null;
    changedFields: readonly string[];
    route: string;
    occurredAt?: Date;
  },
  client: ScoreInvalidationClient,
): Promise<{ invalidatedEventIds: string[]; staleReason: string }> {
  const staleReason = scoreInvalidationReason(input.changedFields);
  const nonstaleScoreEvents = await client.jobScoreEvent.findMany({
    where: {
      jobId: input.jobId,
      evaluationType: { in: [...AUTHORITATIVE_SCORE_EVENT_TYPES] },
      staleAt: null,
    },
    select: { id: true },
  });
  if (nonstaleScoreEvents.length === 0) {
    return { invalidatedEventIds: [], staleReason };
  }

  const invalidatedAt = input.occurredAt || new Date();
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

  for (const scoreEvent of nonstaleScoreEvents) {
    await recordJobPipelineEvent({
      eventType: 'score_invalidated',
      jobId: input.jobId,
      stage: 'native_scoring',
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

  return {
    invalidatedEventIds: nonstaleScoreEvents.map((event) => event.id),
    staleReason,
  };
}
