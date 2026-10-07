import { createHash } from 'node:crypto';

/**
 * Oracle employers have distinct tenant hosts. Two fixed durable mutexes let
 * different hosts overlap while every request to the same host stays serial.
 * Hash collisions reduce concurrency; they can never increase it. Slot zero
 * retains the original lease key so older workers share that same bound.
 * Circuit health and Retry-After remain platform-wide, separate from this key.
 */
export function atsRequestLeaseKey(platform: string, requestedUrl?: string): string {
  const originalKey = `ATS-${platform}`;
  if (platform !== 'oracle' || !requestedUrl) return originalKey;
  try {
    const url = new URL(requestedUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.oraclecloud.com')) return originalKey;
    const bucket = createHash('sha256').update(url.hostname.toLowerCase()).digest()[0] % 2;
    return bucket === 0 ? originalKey : `${originalKey}:request-slot:1`;
  } catch {
    return originalKey;
  }
}

/** Abort an individual waiter without allowing its successors past the owner. */
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
    previous.then(() => {
      cleanup();
      resolve();
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
}
