import * as cheerio from 'cheerio';
import { safeExternalFetch } from './safeExternalFetch';
import { urlMatchesAnyHost } from './urlHost';

type ExternalFetcher = typeof safeExternalFetch;

const REDIRECTOR_HOSTS = ['adzuna.com', 'jsearch.p.rapidapi.com'] as const;

function isGenericRedirector(value: string): boolean {
  return urlMatchesAnyHost(value, REDIRECTOR_HOSTS);
}

function findHimalayasApplyUrl(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  for (const anchor of $('a').toArray()) {
    const text = $(anchor).text().trim().toLowerCase();
    const href = $(anchor).attr('href');
    if (!href || !text.includes('apply')) continue;
    try {
      const candidate = new URL(href, baseUrl);
      if (urlMatchesAnyHost(candidate.toString(), ['himalayas.app']) && candidate.pathname.startsWith('/companies/')) {
        continue;
      }
      return candidate.toString();
    } catch {
      // Ignore malformed links and keep looking for a valid Apply target.
    }
  }
  return null;
}

/**
 * Resolve an external job URL with DNS validation and IP pinning on every hop.
 * Browser navigation was intentionally removed: it could resolve private hosts
 * after validation and allowed subresource requests outside the checked chain.
 */
export async function resolveRedirectUrl(
  url: string,
  fastTimeoutMs = 3000,
  fetcher: ExternalFetcher = safeExternalFetch,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, fastTimeoutMs));
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    const resolvedUrl = response.url || url;

    if (urlMatchesAnyHost(url, ['himalayas.app']) && response.ok) {
      const applyUrl = findHimalayasApplyUrl(await response.text(), resolvedUrl);
      if (applyUrl) {
        const applyResponse = await fetcher(applyUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        });
        return applyResponse.url || applyUrl;
      }
    }

    if (resolvedUrl !== url && !isGenericRedirector(resolvedUrl)) return resolvedUrl;
    return url;
  } catch (error) {
    if (error instanceof Error && error.name !== 'AbortError') {
      console.error('Safe redirect resolution failed for', url, error.message);
    }
    return url;
  } finally {
    clearTimeout(timeout);
  }
}
