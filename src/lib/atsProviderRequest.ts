import type { AtsRetryReason } from './atsRetryReason';
import { planAtsRequest, waitForAtsRequestTurn, withAtsLocalRequestCapacity } from './atsRequestConcurrency';
import { atsRequestSpacingMs } from './atsRequestPacing';
import { atsAuthFailureIsPlatformWide, atsResponseSchemaFailureIsPlatformWide, atsRateLimitIsAbsentBoard, atsRateLimitIsBoardScoped } from './atsUtils';
import { classifyProviderFailure, recordProviderFailure, paceAtsProviderRequest, withProviderRequestCapacity } from './ingestionControl';
import { atsDistributedArchitectureActive } from './atsAcquisitionCoordination';

/**
 * Raised when an ATS platform throttles us. Distinct from a board being broken:
 * Workable returned 45,233 of these in a week against 190 successful reads, and
 * counting them as board failures would blacklist perfectly good boards.
 */
export class RateLimitedError extends Error {
  constructor(platform: string) {
    super(`${platform} rate-limited this request`);
    this.name = 'RateLimitedError';
  }
}

const platformPausedUntil = new Map<string, number>();
export const PLATFORM_THROTTLE_MS = 60 * 1000;

/** Pauses a whole platform after a 429, honouring Retry-After when offered. */
export function throttlePlatform(
  platform: string,
  retryAfter?: string | null,
  now: number = Date.now(),
): number {
  const seconds = Number.parseInt(retryAfter || '', 10);
  const pause = Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, 15 * 60 * 1000)
    : PLATFORM_THROTTLE_MS;
  const pauseUntil = Math.max(platformPausedUntil.get(platform) || 0, now + pause);
  platformPausedUntil.set(platform, pauseUntil);
  return pauseUntil - now;
}

export function platformPauseRemainingMs(platform: string, now: number = Date.now()): number {
  return Math.max(0, (platformPausedUntil.get(platform) || 0) - now);
}

export class IngestionInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestionInterruptedError';
  }
}

export function interruptionError(signal: AbortSignal, fallback: string): IngestionInterruptedError {
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : fallback;
  return reason instanceof IngestionInterruptedError ? reason : new IngestionInterruptedError(message);
}

async function waitForAbortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal?.aborted) throw interruptionError(signal, 'Ingestion interrupted.');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(interruptionError(signal!, 'Ingestion interrupted.'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export async function waitForPlatformSlot(platform: string, signal?: AbortSignal): Promise<void> {
  const remaining = platformPauseRemainingMs(platform);
  await waitForAbortableDelay(remaining, signal);
}

type AtsPlatformRequestSchedulingOptions = {
  waitForSlot?: typeof waitForPlatformSlot;
  paceRequest?: typeof paceAtsProviderRequest;
  withCrossProcessLease?: (action: () => Promise<Response>, leaseKey?: string) => Promise<Response>;
  recordThrottle?: (platform: string, pauseMs: number) => Promise<void>;
  recordFailure?: typeof recordProviderFailure;
  onResponse?: (response: Response) => Promise<void>;
  recordPlatformFailures?: boolean;
  /**
   * The address this request was sent to, so an answer from somewhere else is
   * not read as the board pacing us. Personio serves an unknown subdomain by
   * redirecting to its own marketing site under HTTP 429; pausing the platform
   * for that throttles ~2,800 working boards on behalf of one that does not
   * exist. Omitted by callers that are not addressing a single board.
   */
  requestedUrl?: string;
  /** Verified acquisition identity, shared by config, listing and detail calls. */
  boardSlug?: string;
};

export class AtsProviderFailureRecordedError extends Error {
  constructor(readonly providerError: unknown) {
    super(providerError instanceof Error ? providerError.message : String(providerError));
    this.name = 'AtsProviderFailureRecordedError';
    this.cause = providerError;
  }
}

/**
 * A listing worker has published a platform-wide ATS cooldown that the batch
 * consumer must honor. This is neither a bad job nor a failed detail endpoint:
 * the current durable chunk must stop and retain its unprocessed suffix.
 */
export class AtsPlatformDeferredError extends Error {
  constructor(
    readonly platform: string,
    readonly retryAt?: Date,
    readonly retryReason: AtsRetryReason = { code: 'provider_unavailable', scope: 'provider' },
  ) {
    super(
      `${platform} detail enrichment deferred by the platform circuit`
      + (retryAt ? ` until ${retryAt.toISOString()}` : ''),
    );
    this.name = 'AtsPlatformDeferredError';
  }
}

/**
 * Coordinate provider capacity and employer fences across processes. Providers
 * observed refusing bursts also share dispatch spacing. Inspect responses before
 * releasing capacity so queued calls observe a newly published cooldown.
 */
const serializedAtsRequestTails = new Map<string, Promise<void>>();

export async function fetchAtsPlatformResponse(
  platform: string,
  signal: AbortSignal | undefined,
  request: () => Promise<Response>,
  options: AtsPlatformRequestSchedulingOptions = {},
): Promise<Response> {
  const waitForLocalPause = () => (options.waitForSlot || waitForPlatformSlot)(platform, signal);
  const execute = async () => {
    if (signal?.aborted) throw interruptionError(signal, 'Ingestion interrupted.');
    const response = await request();
    // An off-host 429 is the vendor disowning the board, not the board pacing
    // us, so it must reach the per-board validation below without pausing the
    // platform or opening its circuit on the way. Judged here rather than in
    // the caller because this is where the throttle is published: leaving the
    // test downstream is how the rate-limit check came to mask an absent board
    // for every consumer at once.
    const absentBoard = options.requestedUrl !== undefined
      && response.status === 429
      && atsRateLimitIsAbsentBoard({
        platform,
        requestedUrl: options.requestedUrl,
        respondedUrl: response.url,
      });
    // A board-scoped 429 still refuses this request, but it is one employer's
    // server speaking and must not pause the platform or open its circuit.
    // The board's own retry is set by the listing quantum instead.
    if (response.status === 429 && !absentBoard && !atsRateLimitIsBoardScoped(platform)) {
      const pauseMs = throttlePlatform(platform, response.headers.get('retry-after'));
      if (options.recordPlatformFailures !== false || platform === 'oracle') {
        const recordThrottle = options.recordThrottle || (async (throttledPlatform: string, openForMs: number) => {
          await recordProviderFailure({
            provider: `ATS-${throttledPlatform}`,
            error: new RateLimitedError(throttledPlatform),
            openForMs,
          });
        });
        await recordThrottle(platform, pauseMs).catch((error) => {
          console.error(`Failed to persist ATS-${platform} platform throttle:`, error);
        });
      }
    }
    try {
      await options.onResponse?.(response);
    } catch (error) {
      const classification = classifyProviderFailure(error);
      // A credentials verdict means "the account we call with was refused", and
      // the circuit shuts the whole provider on the first one. That is right
      // for a shared API host and wrong for a platform where every board is a
      // different employer's own server: there, a 403 is one company declining
      // one request. `atsAuthFailureIsPlatformWide` is the single authority on
      // which kind this is, shared with `isAtsProviderWideError`, which already
      // judged the same 403 per-board while this boundary shut the platform.
      //
      // Unguarded, three Workday boards' 403s closed all ~7,700 Workday boards
      // repeatedly on 2026-09-02 and blocked 3,249 batches. Both hosts could
      // reach Workday normally throughout; the outage was entirely our own.
      const platformScoped = (classification !== 'credentials'
        || atsAuthFailureIsPlatformWide(platform))
        && (classification !== 'response_schema'
          || atsResponseSchemaFailureIsPlatformWide(platform));
      if (options.recordPlatformFailures !== false
        && platformScoped
        && (classification === 'credentials' || classification === 'response_schema')) {
        await (options.recordFailure || recordProviderFailure)({ provider: `ATS-${platform}`, error });
        throw new AtsProviderFailureRecordedError(error);
      }
      throw error;
    }
    if (options.recordPlatformFailures !== false
      && atsAuthFailureIsPlatformWide(platform)
      && (response.status === 401 || response.status === 403)) {
      await (options.recordFailure || recordProviderFailure)({
        provider: `ATS-${platform}`,
        error: new Error(`HTTP ${response.status}`),
      }).catch((error) => {
        console.error(`Failed to persist ATS-${platform} credential failure:`, error);
      });
    }
    return response;
  };

  const distributedArchitectureActive = await atsDistributedArchitectureActive();
  if (platform !== 'workable' && platform !== 'oracle' && !distributedArchitectureActive
    && !options.withCrossProcessLease) {
    await waitForLocalPause();
    return execute();
  }

  const plan = planAtsRequest(platform, options.requestedUrl, options.boardSlug);
  const requestLeaseKey = plan.boardLeaseKey || plan.providerKey + ':unidentified';
  const previous = serializedAtsRequestTails.get(requestLeaseKey) || Promise.resolve();
  let release!: () => void;
  const currentRequest = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => currentRequest);
  serializedAtsRequestTails.set(requestLeaseKey, tail);

  try {
    await waitForAtsRequestTurn(previous, signal);
    // Do not occupy the cross-process mutex while honoring a local Retry-After
    // pause that can last 15 minutes. Enter the durable lease immediately
    // before the request; its base-platform circuit reservation rechecks any
    // cooldown another PID may have published while this process was waiting.
    await waitForLocalPause();
    return await withAtsLocalRequestCapacity(plan, signal, async (slot) => {
      const guarded = async () => {
        // A peer can publish a cooldown while this request waits for capacity.
        // Defer immediately; do not hold a provider slot through that pause.
        const checkPause = () => {
          const remaining = platformPauseRemainingMs(platform);
          if (!options.waitForSlot && remaining > 0) {
            throw new AtsPlatformDeferredError(plan.providerKey, new Date(Date.now() + remaining));
          }
        };
        checkPause();
        if (!options.waitForSlot) await (options.paceRequest || paceAtsProviderRequest)(plan.providerKey, atsRequestSpacingMs(platform), signal);
        checkPause();
        return execute();
      };
      if (options.withCrossProcessLease) {
        const slotKey = slot === 0 ? plan.providerKey : plan.providerKey + ':request-slot:1';
        return options.withCrossProcessLease(guarded, slotKey);
      }
      return withProviderRequestCapacity(plan.providerKey, plan.boardLeaseKey, signal, guarded, slot);
    });
  } finally {
    release();
    // An aborted waiter must leave the predecessor in the queue until it
    // finishes, otherwise a later request could jump past the active owner.
    void tail.then(() => {
      if (serializedAtsRequestTails.get(requestLeaseKey) === tail) {
        serializedAtsRequestTails.delete(requestLeaseKey);
      }
    });
  }
}
