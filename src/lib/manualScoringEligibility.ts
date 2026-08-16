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
          AND: [
            { fitCategory: { not: 'promoted' } },
            // `passReason` is nullable, and SQL evaluates `NULL LIKE '…'` to
            // NULL rather than false — so `NOT` over it yields NULL, which is
            // not true, and the row is dropped. Every job that has never been
            // passed has a null reason, so a bare NOT emptied the whole Aim Fit
            // queue: 26,225 eligible jobs presented as 3.
            {
              OR: [
                { passReason: null },
                { NOT: { passReason: { startsWith: 'Promoted by user:', mode: 'insensitive' } } },
              ],
            },
            { NOT: { pipelineEvents: { some: { eventType: { in: [...USER_EVENT_TYPES] } } } } },
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
