import { BrowserAtsHttpReader, canUseBrowserAtsHttp } from './browserAtsHttp';
import { isBrowserAtsPlatform } from './browserAtsBoards';
import { isPublicAtsPlatform, publicAtsBoardUrl, publicAtsNeedsConfig, parsePublicAtsConfig,
  buildPublicAtsBoardRequest, parsePublicAtsListing, publicAtsPageSize, atsListingUsesXml } from './publicAtsBoards';
import { readBoundedAtsBody } from './tenantAtsBoards';
import { directAtsTitleKey, type BoardIdentity, type BoardPosting } from './atsDirectMatch';
import { sameEmployer } from './employerIdentity';
import { cleanHtmlText } from './jobIngestion';
import { AdpPublicReader } from './adpPublicReader';
import type { WorkdayMatchJob } from './workdayDirectMatch';

type ReadResponse = (url: string, init?: RequestInit) => Promise<Response>;
export const supportsAdditionalEmployerCatalogue = (platform: string): boolean =>
  isPublicAtsPlatform(platform) || canUseBrowserAtsHttp(platform) || platform === 'adp';

/** Reuse acquisition's validated public formats without writing acquisition state. */
export async function readAdditionalEmployerCatalogue(board: BoardIdentity, read: ReadResponse,
  job?: WorkdayMatchJob): Promise<BoardPosting[] | null> {
  if (isBrowserAtsPlatform(board.platform) && (canUseBrowserAtsHttp(board.platform) || board.platform === 'adp')) {
    if (!job) return null;
    const reader = new BrowserAtsHttpReader(async () => {}, read);
    const adp = board.platform === 'adp' ? new AdpPublicReader(board.slug, async () => {}, read) : null;
    const links = new Map<string, { id: string; title: string; url: string }>();
    let next: string | undefined;
    let total: number | undefined;
    let complete = false;
    const pages = new Set<string>();
    for (let page = 1; page <= 50; page++) {
      const result = adp ? await adp.listing(page) : await reader.page(board.platform, board.slug, page, next);
      if (!result || pages.has(result.signature)) return null;
      pages.add(result.signature);
      if (result.total != null) {
        if (total !== undefined && total !== result.total) return null;
        total = result.total;
      }
      for (const link of result.links) {
        if (links.has(link.id) || !link.title) return null;
        links.set(link.id, link);
      }
      if (links.size > 2000) return null;
      if (!result.next) { complete = total === undefined || links.size === total; break; }
      if (result.next.kind !== 'url' && !adp) return null;
      next = result.next.kind === 'url' ? result.next.url : undefined;
    }
    if (!complete) return null;
    const candidates = [...links.values()].filter(link => directAtsTitleKey(link.title) === directAtsTitleKey(job.title));
    if (candidates.length > 25) return null;
    const postings: BoardPosting[] = [];
    for (const link of candidates) {
      const detail = adp ? await adp.detail(link) : await reader.detail(board.platform, board.slug, link, [...links.values()]);
      if (!detail) return null;
      if (!sameEmployer({ company: job.canonicalEmployer?.(detail.company) || detail.company }, { company: job.company })) continue;
      postings.push({ title: detail.title, url: detail.url, location: detail.location || null, description: cleanHtmlText(detail.description) });
    }
    return postings;
  }
  if (!isPublicAtsPlatform(board.platform)) return null;
  let config = { company: '' };
  if (publicAtsNeedsConfig(board.platform)) {
    const url = publicAtsBoardUrl(board.platform, board.slug);
    const response = await read(url);
    config = parsePublicAtsConfig(board.platform, board.slug, await readBoundedAtsBody(response), response.url || url);
  }
  let total: number | null = null;
  const postings = new Map<string, BoardPosting>();
  const pageSize = publicAtsPageSize(board.platform);
  for (let offset = 0; offset < 2000; offset += pageSize || 2000) {
    const request = buildPublicAtsBoardRequest(board.platform, board.slug, offset, config);
    const response = await read(request.url, request.init);
    // An unrelated redirect cannot turn a dead API into a plausible catalogue.
    if (response.url && new URL(response.url).origin !== new URL(request.url).origin) return null;
    const text = await readBoundedAtsBody(response);
    const parsed = parsePublicAtsListing(board.platform, board.slug,
      atsListingUsesXml(board.platform) ? null : JSON.parse(text), text, config, offset);
    if (parsed.total !== null) {
      if (total !== null && total !== parsed.total || parsed.total > 2000) return null;
      total = parsed.total;
    }
    for (const row of parsed.jobs) {
      const url = String(row.url || '');
      if (!url || !row.title || postings.has(url)) return null;
      postings.set(url, { title: String(row.title), url, location: String(row.location || '') || null,
        description: cleanHtmlText(String(row.description || '')) || null });
    }
    if (!pageSize) return total === null || postings.size === total ? [...postings.values()] : null;
    if (total !== null && postings.size === total) return [...postings.values()];
    if (parsed.jobs.length !== pageSize || total === null || postings.size > total) return null;
  }
  return null;
}
