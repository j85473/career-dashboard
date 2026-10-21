import { safeExternalFetch } from './safeExternalFetch';
import { readBoundedAtsBody } from './tenantAtsBoards';

export class BioSpaceFeedError extends Error {
  constructor(status: number, readonly retryAfterMs?: number) { super(`BioSpace HTTP ${status}`); }
}

/** Preserve a provider's retry instruction in the durable circuit, including
 * HTTP-date headers. Invalid headers retain the normal bounded backoff. */
export function bioSpaceRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const delay = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 7 * 86_400_000) : undefined;
}

export async function fetchBioSpaceFeed(query: string, signal?: AbortSignal,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = safeExternalFetch): Promise<string> {
  const url = new URL('https://jobs.biospace.com/jobsrss/');
  url.searchParams.set('keywords', query);
  const response = await fetcher(url.href, {
    headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const retryAfter = response.status === 429 || response.status === 503 ? bioSpaceRetryAfter(response.headers.get('retry-after')) : undefined;
    await response.body?.cancel();
    throw new BioSpaceFeedError(response.status, retryAfter);
  }
  const xml = await readBoundedAtsBody(response, 5 * 1024 * 1024);
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) throw Error('BioSpace response schema mismatch: expected an RSS channel; retaining the search for retry');
  return xml;
}
