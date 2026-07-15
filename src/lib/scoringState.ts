export type DeepseekBatchProgress = {
  scoresProcessed: number;
  contextJobsProcessed: number;
  contextUpdated: boolean;
  staleClaimsReleased: number;
};

/** Preserve an explicit lifecycle decision when an edit also invalidates scores. */
export function statusAfterScoringInputEdit(explicitStatus: unknown): string {
  return typeof explicitStatus === 'string' && explicitStatus.length > 0
    ? explicitStatus
    : 'pending_af';
}

/**
 * A zero-score batch is not necessarily an empty queue: optimistic concurrency
 * can reject every response after a user edit. In that case the released jobs
 * should rotate to the back of the queue and the evaluator should continue.
 */
export function shouldContinueDeepseekEvaluation(result: DeepseekBatchProgress): boolean {
  return result.scoresProcessed > 0
    || result.contextJobsProcessed > 0
    || result.contextUpdated
    || result.staleClaimsReleased > 0;
}
