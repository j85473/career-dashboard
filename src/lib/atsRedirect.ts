import 'server-only';
import { safeExternalFetch } from './safeExternalFetch';

export async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    const response = await safeExternalFetch(url, { signal: AbortSignal.timeout(8000) });
    return response.url || url;
  } catch {
    // Strict bot protection can block a HEAD/GET even when the original URL is
    // usable in a browser, so retain the validated original as a fallback.
    return url;
  }
}
