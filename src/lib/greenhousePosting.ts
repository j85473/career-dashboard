import * as cheerio from 'cheerio';
import type { AtsScrapeResult } from './atsApi';
import { cleanHtmlText } from './jobIngestion';
import { postingMetadataValue, postingUrlsMatch } from './postingMetadata';
import { publishedEmployerName } from './publicAtsEmployer';
import { safeExternalFetch } from './safeExternalFetch';
import { greenhousePostingUrl } from './coreAtsPostingUrl';

type Identity = { board: string; id: string };
const hosted = (host: string) => /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(host);
const boardName = (value: string) => /^[a-z0-9_-]+$/i.test(value) ? value : '';

export function greenhouseHostedPosting(value: string): Identity | null {
  return greenhousePostingUrl(value);
}

export function greenhouseEmbeddedJobId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const ids = url.searchParams.getAll('gh_jid');
    return ids.length === 1 && /^\d+$/.test(ids[0]) ? ids[0] : null;
  } catch { return null; }
}

/** Read actual script/iframe URLs, never comments, quoted JS or a domain guess. */
export function greenhouseEmbedIdentity(html: string, value: string): Identity | null {
  const id = greenhouseEmbeddedJobId(value);
  if (!id) return null;
  const $ = cheerio.load(html);
  const boards = new Set<string>();
  for (const node of $('script[src],iframe[src]').toArray()) {
    try {
      const url = new URL($(node).attr('src')!, value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosted(url.hostname)
        || !/^\/embed\/(?:job_board|job_app)(?:\/js)?\/?$/.test(url.pathname)) continue;
      const tokens = url.searchParams.getAll('for');
      const jobIds = url.searchParams.getAll('token');
      if (tokens.length !== 1 || jobIds.length > 1 || (jobIds.length && jobIds[0] !== id)) continue;
      const board = boardName(tokens[0]);
      if (board) boards.add(board);
    } catch { /* Unrelated or malformed URLs cannot name a board. */ }
  }
  return boards.size === 1 ? { board: [...boards][0], id } : null;
}

export function parseGreenhousePosting(body: unknown, identity: Identity, board?: unknown): AtsScrapeResult | null {
  if (!body || typeof body !== 'object') return null;
  const job = body as { id?: unknown; title?: unknown; content?: unknown; location?: { name?: unknown }; company_name?: unknown };
  const title = postingMetadataValue(job.title);
  if (String(job.id) !== identity.id || !title || typeof job.content !== 'string') return null;
  const company = publishedEmployerName(job.company_name) || publishedEmployerName((board as { name?: unknown } | null)?.name);
  return { ats: 'Greenhouse', atsSlug: identity.board, platform: 'greenhouse',
    title: title.replace(/^Job Application for /i, '').trim(), company: company || undefined,
    location: postingMetadataValue(job.location?.name), text: cleanHtmlText(job.content) };
}

export async function fetchGreenhousePosting(value: string, read: typeof safeExternalFetch = safeExternalFetch): Promise<AtsScrapeResult | null> {
  let identity = greenhouseHostedPosting(value);
  const fetchPage = (url: string, accept: string) => read(url, { headers: { Accept: accept, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!identity) {
    if (!greenhouseEmbeddedJobId(value)) return null;
    const page = await fetchPage(value, 'text/html');
    if (!page.ok || !postingUrlsMatch(page.url || value, value)) return null;
    identity = greenhouseEmbedIdentity(await page.text(), value);
  }
  if (!identity) return null;
  const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identity.board)}/jobs/${identity.id}`;
  const response = await fetchPage(endpoint, 'application/json');
  if (!response.ok || !postingUrlsMatch(response.url || endpoint, endpoint)) return null;
  const body = await response.json();
  const posting = parseGreenhousePosting(body, identity);
  if (!posting || posting.company) return posting;
  // Older API responses omit company_name. The board's published name is an
  // optional fallback; its token is never substituted for an employer name.
  try {
    const boardUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identity.board)}`;
    const board = await fetchPage(boardUrl, 'application/json');
    if (board.ok && postingUrlsMatch(board.url || boardUrl, boardUrl)) {
      posting.company = publishedEmployerName((await board.json())?.name) || undefined;
    }
  } catch { /* Keep the exact JD and location if optional branding is unavailable. */ }
  return posting;
}
