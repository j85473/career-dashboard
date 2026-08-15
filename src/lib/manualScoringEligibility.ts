import type { Prisma } from '@prisma/client';

export type ManualScoringStage = 'aim' | 'experience';

const USER_EVENT_TYPES = ['user_promote', 'user_reject', 'user_lifecycle'] as const;
const EXPLICIT_RESCORE_EVENT = {
  pipelineEvents: { some: { eventType: 'user_rescore' } },
} as const;

/**
 * Keep ordinary human lifecycle decisions out of pending scoring while
 * allowing an explicit user-requested rescore to move through both manual
 * stages after the job has been removed from the Inbox.
 *
 * The immutable user_rescore event distinguishes a deliberately requeued job
 * from the dormant pending backlog. Inbox admission remains owned by the
 * completed Aim + Experience decision.
 */
export function manualScoringStatusWhere(stage: ManualScoringStage): Prisma.JobWhereInput {
  if (stage === 'aim') {
    return {
      status: 'pending_af',
      OR: [
        {
          NOT: [
            { fitCategory: 'promoted' },
            { passReason: { startsWith: 'Promoted by user:', mode: 'insensitive' } },
            { pipelineEvents: { some: { eventType: { in: [...USER_EVENT_TYPES] } } } },
          ],
        },
        EXPLICIT_RESCORE_EVENT,
      ],
    };
  }

  return {
    status: 'pending_af',
    OR: [
      { pipelineEvents: { none: { eventType: { in: [...USER_EVENT_TYPES] } } } },
      EXPLICIT_RESCORE_EVENT,
    ],
  };
}
