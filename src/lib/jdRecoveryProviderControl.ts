import {
  recordJobPipelineEvent,
  recordProviderFailure,
  recordProviderSuccess,
  reserveProviderBudgetForSource,
} from './ingestionControl';
import type { DetailProviderControl } from './jobIngestion';
import { ProviderCapacityRefusal } from './jdEnrichmentDeferral';

/**
 * Provider accounting for description calls made by the JD recovery pass.
 *
 * The recovery pass used to call the Glassdoor details endpoint with no
 * provider control at all. The reservation still ran — description calls spend
 * the same ledger as searches — but its refusal went nowhere: no pipeline
 * event, no circuit health, no counter. So on 2026-09-07 the request telemetry
 * showed 20 Glassdoor searches and 48 ingest-time description calls, and none
 * of the 69 recovery-pass calls that were refused. The queue filled with jobs
 * marked as dead postings and there was no record anywhere that they had been
 * turned away at the door.
 *
 * Every call now leaves a trace, so a starved provider is visible as a starved
 * provider.
 */
export function jdRecoveryProviderControl(job: {
  id: string;
  source?: string | null;
  sourceId?: string | null;
}): DetailProviderControl {
  return {
    beforeRequest: async (provider: string) => {
      const decision = await reserveProviderBudgetForSource(provider);
      await recordJobPipelineEvent({
        eventType: 'provider_request',
        jobId: job.id,
        stage: 'jd_recovery',
        source: provider,
        sourceId: job.sourceId || null,
        details: {
          allowed: decision.allowed,
          reason: decision.reason || null,
          retryAt: decision.retryAt?.toISOString() || null,
          dailyUsed: decision.dailyUsed,
        },
      });
      if (!decision.allowed) {
        // Carry the reservation's own retry time: it knows when the next
        // portion is released, and parking the job until then is what makes a
        // deferral cost elapsed time instead of a lap of an empty queue.
        throw new ProviderCapacityRefusal(
          `${provider} request blocked by ${decision.reason}`,
          decision.retryAt,
        );
      }
    },
    success: (provider: string) => {
      void recordProviderSuccess(provider).catch(() => {});
    },
    failure: (provider: string, error: unknown) => {
      void recordProviderFailure({ provider, error }).catch(() => {});
    },
  };
}
