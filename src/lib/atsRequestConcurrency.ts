import { createHash } from 'node:crypto';
import { boardSlugFromJobUrl } from './atsBoardYield';
import { ATS_PER_BOARD_HOST_PLATFORMS } from './atsUtils';

const SUPPORTED_PROVIDERS = new Set([
  ...ATS_PER_BOARD_HOST_PLATFORMS,
  'greenhouse', 'ashby', 'lever', 'workable', 'smartrecruiters', 'rippling',
]);
export const ATS_PROVIDER_REQUEST_CAPACITY = 2;

export type AtsRequestPlan = {
  providerKey: string;
  boardLeaseKey: string | null;
  /** An unidentified request occupies the whole pool, preserving serialization. */
  units: 1 | 2;
};

/** Listing, config and detail calls must resolve to the same employer fence. */
export function planAtsRequest(platform: string, requestedUrl?: string, boardSlug?: string): AtsRequestPlan {
  const providerKey = 'ATS-' + platform;
  const exclusive: AtsRequestPlan = { providerKey, boardLeaseKey: null, units: 2 };
  if (!SUPPORTED_PROVIDERS.has(platform) || !requestedUrl) return exclusive;
  let url: URL;
  try { url = new URL(requestedUrl); } catch { return exclusive; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return exclusive;
  const host = url.hostname.toLowerCase();
  let scope = '';
  // One Workday employer can expose several sites; fence the employer host.
  // Oracle retains its host-wide protection without fixed hash collisions.
  if ((platform === 'workday' && /^[a-z0-9.-]+\.myworkdayjobs\.com$/.test(host))
    || (platform === 'oracle' && /^[a-z0-9.-]+\.oraclecloud\.com$/.test(host))) {
    scope = host;
  } else {
    const slug = boardSlug?.trim();
    if (slug && slug.length <= 512 && !/[\x00-\x1f\x7f]/.test(slug)) scope = slug.toLowerCase();
    // Public APIs on shared vendor hosts need their board namespace, not just
    // the hostname; otherwise all employers would still share one fence.
    if (!scope) {
      const shared = platform === 'greenhouse' && host === 'boards-api.greenhouse.io'
        ? url.pathname.match(/^\/v1\/boards\/([^/]+)\//)
        : platform === 'ashby' && host === 'api.ashbyhq.com'
          ? url.pathname.match(/^\/posting-api\/job-board\/([^/]+)/)
          : platform === 'lever' && /^api(?:\.eu)?\.lever\.co$/.test(host)
            ? url.pathname.match(/^\/v0\/postings\/([^/]+)/)
            : platform === 'smartrecruiters' && host === 'api.smartrecruiters.com'
              ? url.pathname.match(/^\/(?:v1|api-v1)\/companies\/([^/]+)\//)
              : platform === 'workable' && ['www.workable.com', 'apply.workable.com'].includes(host)
                ? url.pathname.match(/^\/api\/(?:v1\/)?accounts\/([^/]+)/)
                : platform === 'rippling' && host === 'ats.rippling.com'
                  ? url.pathname.match(/^\/api\/v1\/board\/([^/]+)\//) : null;
      if (shared) scope = shared[1].toLowerCase();
      else {
        const publicSlug = boardSlugFromJobUrl(url.href, platform);
        if (publicSlug) scope = publicSlug.toLowerCase();
      }
    }
  }
  if (!scope) return exclusive;
  const digest = createHash('sha256').update(scope).digest('hex');
  return { providerKey, boardLeaseKey: 'ats-request-board:' + platform + ':' + digest, units: 1 };
}

type Waiter = {
  units: number;
  resolve: (slots: number[]) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};
const pools = new Map<string, { available: number[]; waiters: Waiter[] }>();

/** Fair, abortable process-local capacity; the database fence remains global. */
export async function withAtsLocalRequestCapacity<T>(
  plan: AtsRequestPlan, signal: AbortSignal | undefined, action: (slot: number) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  let pool = pools.get(plan.providerKey);
  if (!pool) {
    pool = { available: [0, 1], waiters: [] };
    pools.set(plan.providerKey, pool);
  }
  const current = pool;
  const pump = () => {
    while (current.waiters.length && current.available.length >= current.waiters[0].units) {
      const waiter = current.waiters.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.resolve(current.available.splice(0, waiter.units));
    }
  };
  const slots = await new Promise<number[]>((resolve, reject) => {
    const waiter: Waiter = {
      units: plan.units, resolve, reject, signal,
      abort: () => {
        const index = current.waiters.indexOf(waiter);
        if (index < 0) return;
        current.waiters.splice(index, 1);
        signal?.removeEventListener('abort', waiter.abort);
        reject(signal?.reason || new Error('ATS request capacity wait interrupted.'));
        pump();
      },
    };
    current.waiters.push(waiter);
    signal?.addEventListener('abort', waiter.abort, { once: true });
    if (signal?.aborted) waiter.abort();
    else pump();
  });
  try {
    if (signal?.aborted) throw signal.reason;
    return await action(slots[0]);
  } finally {
    current.available.push(...slots);
    pump();
  }
}

/** Abort a board waiter without letting its successors bypass the owner. */
export async function waitForAtsRequestTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) throw signal.reason || new Error('ATS request queue wait interrupted.');
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(signal.reason || new Error('ATS request queue wait interrupted.'));
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    previous.then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
  });
}
