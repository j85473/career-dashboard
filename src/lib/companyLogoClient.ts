// Serialize decorative requests so they cannot fill the browser's connections
// to the Dashboard, including when a database read or the network is slow.
let previous: Promise<unknown> = Promise.resolve();
const REQUEST_TIMEOUT_MS = 1500;
const MAX_ATTEMPTS = 6;

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}

export function requestCompanyLogo(url: string, signal: AbortSignal): Promise<{
  image: Blob | null;
  retryAfterMs: number | null;
}> {
  const request = previous.then(async () => {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, controller.signal]), priority: 'low',
      });
      if (response.status === 200) return { image: await response.blob(), retryAfterMs: null };
      await response.body?.cancel();
      if (response.status === 202 || response.status === 429 || response.status >= 500) {
        const seconds = Number(response.headers.get('Retry-After'));
        return { image: null, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3000 };
      }
      return { image: null, retryAfterMs: null };
    } finally { clearTimeout(timeout); }
  });
  previous = request.catch(() => undefined);
  return request;
}

/** Poll only for saved bytes; all external recovery happens after the response. */
export async function loadCompanyLogo(url: string, signal: AbortSignal): Promise<Blob | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let result;
    try { result = await requestCompanyLogo(url, signal); }
    catch {
      signal.throwIfAborted();
      result = { image: null, retryAfterMs: 3000 };
    }
    if (result.image || result.retryAfterMs === null) return result.image;
    if (attempt + 1 < MAX_ATTEMPTS) {
      await waitForRetry(Math.min(30_000, result.retryAfterMs * 2 ** attempt), signal);
    }
  }
  return null;
}
