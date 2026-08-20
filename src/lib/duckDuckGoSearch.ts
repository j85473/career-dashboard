import { load } from 'cheerio';
import { safeExternalFetch } from './safeExternalFetch';

const DUCKDUCKGO_HTML_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const SEARCH_TIMEOUT_MS = 10_000;

type SearchFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function resultTarget(href: string): string | null {
  try {
    const resultUrl = new URL(href, 'https://duckduckgo.com');
    const isDuckDuckGoRedirect = resultUrl.hostname === 'duckduckgo.com'
      || resultUrl.hostname.endsWith('.duckduckgo.com');
    const target = isDuckDuckGoRedirect
      ? resultUrl.searchParams.get('uddg')
      : resultUrl.toString();
    if (!target) return null;

    const targetUrl = new URL(target);
    return ['http:', 'https:'].includes(targetUrl.protocol) ? targetUrl.toString() : null;
  } catch {
    return null;
  }
}

export function extractDuckDuckGoResultUrls(html: string): string[] {
  const $ = load(html);
  const urls: string[] = [];
  const seen = new Set<string>();

  $('a.result__a').each((_index, element) => {
    const href = $(element).attr('href');
    const target = href ? resultTarget(href) : null;
    if (target && !seen.has(target)) {
      seen.add(target);
      urls.push(target);
    }
  });

  return urls;
}

export async function searchDuckDuckGo(
  query: string,
  fetcher: SearchFetch = safeExternalFetch,
): Promise<string[]> {
  if (!query.trim()) return [];

  const searchUrl = new URL(DUCKDUCKGO_HTML_SEARCH_URL);
  searchUrl.searchParams.set('q', query);
  const response = await fetcher(searchUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129 Safari/537.36',
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo HTML search returned HTTP ${response.status}`);
  }

  return extractDuckDuckGoResultUrls(await response.text());
}
