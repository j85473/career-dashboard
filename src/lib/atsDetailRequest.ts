import type { AtsJobEnrichmentDependencies, EnrichAtsListingJobInput } from './atsJobEnrichment';

export const ATS_DETAIL_QUEUE_TIMEOUT_MS = 45_000;

export class AtsDetailHttpError extends Error {
  constructor(readonly status: number) {
    super(`ATS detail endpoint returned HTTP ${status}`);
    this.name = 'AtsDetailHttpError';
  }
}

/** A response for one posting is unusable, not evidence of a provider outage. */
export class AtsDetailResponseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AtsDetailResponseError';
    this.cause = cause;
  }
}

export class AtsEnrichmentControlError extends Error {
  constructor(readonly controlError: unknown) {
    // fetchAtsPlatformResponse classifies errors thrown by its response hook.
    // Keep this message on the explicit internal-persistence path so a schema-
    // worded database error cannot be mistaken for provider response drift.
    super('ATS enrichment provider control persistence failed');
    this.name = 'AtsEnrichmentControlError';
    this.cause = controlError;
  }
}

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

export function retryAtFrom429(response: Response, now: Date): Date | undefined {
  const retryAfter = response.headers.get('retry-after')?.trim();
  const seconds = Number.parseInt(retryAfter || '', 10);
  const pauseMs = Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, 15 * 60_000)
    : 60_000;
  return new Date(now.getTime() + pauseMs);
}

/** One evidence chain shares budgets, receipts and a network deadline. Parsing
 * the first response can run under the provider fence; follow-up requests run
 * only after it is released. Corporate-site failures never own an ATS circuit. */
export function createAtsDetailRequestSession(input: EnrichAtsListingJobInput,
  dependencies: AtsJobEnrichmentDependencies) {
  const { platform, slug } = input;
  const queueDeadline = AbortSignal.timeout(ATS_DETAIL_QUEUE_TIMEOUT_MS);
  const queueSignal = input.signal ? AbortSignal.any([input.signal, queueDeadline]) : queueDeadline;
  let networkSignal: AbortSignal | undefined;
  let attempted = false;
  let httpStatus: number | undefined;
  let respondedAt: Date | undefined;
  return {
    get attempted() { return attempted; },
    get httpStatus() { return httpStatus; },
    get respondedAt() { return respondedAt; },
    get aborted() { return Boolean(input.signal?.aborted || networkSignal?.aborted || (!attempted && queueSignal.aborted)); },
    assertWithinDeadline() { networkSignal?.throwIfAborted(); },
    async request(url: string, options: {
      transport?: 'fetch' | 'safe_fetch';
      vendorRequest?: boolean;
      allowMissing?: boolean;
      inspect?: (response: Response) => Promise<void>;
    } = {}): Promise<Response> {
      queueSignal.throwIfAborted();
      networkSignal?.throwIfAborted();
      const dispatchSignal = networkSignal ? AbortSignal.any([queueSignal, networkSignal]) : queueSignal;
      const vendorRequest = options.vendorRequest !== false;
      let inspected = false;
      const inspect = async (response: Response) => {
        if (inspected) return;
        inspected = true;
        httpStatus = response.status;
        respondedAt = dependencies.now();
        try { await input.onResponseReceived?.({ status: response.status, respondedAt }); }
        catch (error) { throw new AtsEnrichmentControlError(error); }
        if (response.status === 429) {
          throw await dependencies.createDeferredError(`ATS-${platform}`, retryAtFrom429(response, respondedAt));
        }
        if (!response.ok && !(options.allowMissing && [403, 404, 410].includes(response.status))) {
          if (!vendorRequest) throw new AtsDetailResponseError(`Linked employer website HTTP ${response.status}`);
          throw new AtsDetailHttpError(response.status);
        }
        await options.inspect?.(response);
      };
      const dispatch = async () => {
        dispatchSignal.throwIfAborted();
        for (const source of [`ATS-${platform}`, `ATS-${platform} Details`]) {
          let decision;
          try { decision = await dependencies.reserveProviderBudgetForSource(source); }
          catch (error) { throw new AtsEnrichmentControlError(error); }
          if (!decision.allowed) throw await dependencies.createDeferredError(`ATS-${platform}`,
            decision.retryAt || new Date(dependencies.now().getTime() + 15 * 60_000));
        }
        dispatchSignal.throwIfAborted();
        try { await input.onRequestStarted?.(); }
        catch (error) { throw new AtsEnrichmentControlError(error); }
        dispatchSignal.throwIfAborted();
        if (!networkSignal) {
          const deadline = AbortSignal.timeout(Math.min(120_000, Math.max(1, Math.trunc(input.requestTimeoutMs))));
          networkSignal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
        }
        networkSignal.throwIfAborted();
        attempted = true;
        try {
          const init: RequestInit = { signal: networkSignal, headers: options.transport === 'fetch'
            ? { Accept: 'application/json' }
            : { 'User-Agent': dependencies.jsonLdFetchUserAgent, Accept: 'application/json,text/html' } };
          return await (options.transport === 'fetch' ? dependencies.fetch : dependencies.safeExternalFetch)(url, init);
        } catch (error) {
          if (!vendorRequest && !isAbortError(error)) throw new AtsDetailResponseError('Linked employer website unavailable', error);
          throw error;
        }
      };
      const response = vendorRequest ? await dependencies.fetchPlatformResponse(platform, dispatchSignal, dispatch,
        { requestedUrl: url, boardSlug: slug, recordPlatformFailures: false, onResponse: inspect }) : await dispatch();
      await inspect(response);
      return response;
    },
  };
}
