import { load } from 'cheerio';

// Explicitly verified employer-host / public API organization pairs. A vanity
// hostname alone must never be converted into an invented vendor tenant.
const boards: Record<string, { host: string; organization: string; company: string; scoutOrgId: number; portal: string }> = {
  deltek: { host: 'careers.deltek.com', organization: 'd78c5717-c840-461e-8f42-7e005f1a8068', company: 'Deltek', scoutOrgId: 2458, portal: 'Kenexa' },
};
export const SYMPHONY_PAGE_SIZE = 20;
function board(slug: string) {
  const result = Object.hasOwn(boards, slug) ? boards[slug] : undefined;
  if (!result) throw new Error('Unverified Symphony Talent board identity');
  return result;
}

export function symphonyBoardSlugFromUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    const match = Object.entries(boards).find(([, b]) => b.host === u.hostname);
    if (!match || !/^(?:\/|\/job\/[1-9]\d*(?:\/[^/]+)?\/?)$/.test(u.pathname)) return null;
    return match[0];
  } catch { return null; }
}

export function symphonyBoardUrl(slug: string): string { return `https://${board(slug).host}/`; }

export function symphonyPostingIdentity(value: string): { slug: string; id: string } | null {
  const slug = symphonyBoardSlugFromUrl(value);
  if (!slug) return null;
  const id = new URL(value).pathname.split('/')[2];
  return id && /^[1-9]\d*$/.test(id) ? { slug, id } : null;
}

export function symphonyPostingRequest(value: string): string | null {
  const identity = symphonyPostingIdentity(value);
  if (!identity) return null;
  const url = new URL('https://jobsapi-google.m-cloud.io/api/job/get');
  url.search = new URLSearchParams({ companyName: `companies/${board(identity.slug).organization}`, id: identity.id }).toString();
  return url.href;
}

export function symphonyBoardRequest(slug: string, offset = 0): { url: string; init: RequestInit } {
  const b = board(slug);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % SYMPHONY_PAGE_SIZE) throw new Error('Invalid Symphony listing offset');
  const url = new URL('https://jobsapi-google.m-cloud.io/api/job/search');
  url.search = new URLSearchParams({ companyName: `companies/${b.organization}`, pageSize: String(SYMPHONY_PAGE_SIZE),
    offset: String(offset), customAttributeFilter: `ats_portalid=${JSON.stringify(b.portal)}`, orderBy: 'posting_publish_time desc' }).toString();
  return { url: url.href, init: { headers: { Accept: 'application/json' }, cache: 'no-store' } };
}

/** Verify the public site still publishes the organization we are about to query. */
export function parseSymphonyConfig(slug: string, html: string, landedUrl?: string): { company: string } {
  const b = board(slug);
  if (landedUrl && symphonyBoardSlugFromUrl(landedUrl) !== slug) throw new Error('Symphony career page redirected away from its board');
  const compact = html.replace(/\\\//g, '/');
  if (!compact.includes(`companies/${b.organization}`) || !compact.includes('https://jobsapi-google.m-cloud.io/api/')
    || !load(html).text().includes(b.company)) throw new Error('Symphony public career configuration identity mismatch');
  return { company: b.company };
}

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Symphony listing schema expected an object');
  return value as Row;
}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export function parseSymphonyListing(slug: string, payload: unknown, offset = 0): { jobs: Row[]; metadata: Row; total: number } {
  symphonyBoardRequest(slug, offset);
  const b = board(slug), data = row(payload);
  if (!Number.isSafeInteger(data.totalHits) || (data.totalHits as number) < 0 || !Array.isArray(data.searchResults)) throw new Error('Symphony listing schema has invalid results or total');
  const total = data.totalHits as number, results = data.searchResults;
  const hasMore = offset + results.length < total;
  if (results.length > SYMPHONY_PAGE_SIZE || offset + results.length > total || hasMore && results.length !== SYMPHONY_PAGE_SIZE
    || !hasMore && data.nextPageToken != null) throw new Error('Symphony listing total and continuation disagree');
  const ids = new Set<string>();
  const jobs = results.map(value => {
    const j = row(row(value).job), id = typeof j.id === 'number' && Number.isSafeInteger(j.id) && j.id > 0 ? String(j.id) : '';
    if (!id || ids.has(id)) throw new Error('Symphony listing has missing or repeated posting identity');
    ids.add(id);
    const url = text(j.url), title = text(j.title), description = text(j.description);
    if (j.scout_orgid !== b.scoutOrgId || j.company_name !== b.company || j.ats_portalid !== b.portal
      || symphonyBoardSlugFromUrl(url) !== slug || new URL(url).protocol !== 'https:'
      || new URL(url).pathname.split('/')[2] !== id) throw new Error('Symphony listing posting identity mismatch');
    if (!title || !description || !text(j.ref)) throw new Error('Symphony listing has no title, description or requisition');
    // Deltek's display location carries remote scope. The primary API office
    // can be headquarters even for a US-wide remote role; never substitute it.
    const location = text(j.level) || [text(j.primary_city), text(j.primary_state), text(j.primary_country)].filter(Boolean).join(', ') || 'Unknown Location';
    return { id: `${slug}::${id}`, publicAtsPostingId: id, title, description, company: b.company, url, location,
      symphonyRequisition: text(j.ref), symphonyApplyUrl: text(j.seo_url), postedTravel: text(j.travel) || null };
  });
  return { jobs, total, metadata: { name: b.company, listingHasMore: hasMore, symphonyListingOffset: offset } };
}
