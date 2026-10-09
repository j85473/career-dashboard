import { load } from 'cheerio';
import { gunzipSync } from 'node:zlib';

export const TENANT_ATS_PLATFORMS = ['gem', 'jobscore', 'jazzhr', 'manatal', 'clearcompany', 'hirehive'] as const;
export type TenantAtsPlatform = typeof TENANT_ATS_PLATFORMS[number];
export const isTenantAtsPlatform = (platform: string): platform is TenantAtsPlatform =>
  (TENANT_ATS_PLATFORMS as readonly string[]).includes(platform);
type Row = Record<string, unknown>;
const atom = /^[a-z0-9][a-z0-9_-]*$/i;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const reserved = /^(?:www|api|app|help|support|docs|careers|jobs|feeds|assets|dashboard|openapi|api-documentation)$/i;
export const stringValue = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const row = (v: unknown): Row => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Tenant ATS listing schema expected an object');
  return v as Row;
};
const rows = (v: unknown): Row[] => {
  if (!Array.isArray(v)) throw new Error('Tenant ATS listing schema expected an array');
  return v.map(row);
};
function identifier(v: unknown): string {
  const id = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : stringValue(v);
  if (!id || !/^[a-z0-9_.:-]+$/i.test(id)) throw new Error('Tenant ATS listing schema has invalid posting identity');
  return id;
}
function totalValue(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error('Tenant ATS listing schema has invalid total');
  return v as number;
}

/** Resolve only vendor-owned tenant paths; never invent a tenant from an employer name. */
export function tenantAtsBoardSlugFromUrl(value: string, platform: TenantAtsPlatform): string | null {
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    const p = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    let slug: string | undefined;
    if (platform === 'gem') {
      if (host === 'jobs.gem.com') slug = p[0];
      // The API path has two fixed components, followed by its vanity name.
      if (host === 'api.gem.com' && p[0] === 'job_board' && p[1] === 'v0' && p[3] === 'job_posts') slug = p[2];
    } else if (platform === 'jobscore' && host === 'careers.jobscore.com' && ['careers', 'jobs'].includes(p[0])) slug = p[1];
    else if (platform === 'jazzhr') {
      if (/^[^.]+\.applytojob\.com$/.test(host)) slug = host.split('.')[0];
      if (host === 'app.jazz.co' && p.slice(0, 3).join('/') === 'feeds/export/jobs') slug = p[3];
    } else if (platform === 'manatal') {
      if (['www.careers-page.com', 'careers-page.com'].includes(host)) slug = p[0] === 'api' && p[1] === 'v1.0' && p[2] === 'c' ? p[3] : p[0];
    } else if (platform === 'clearcompany') {
      const site = u.searchParams.get('siteId') || u.searchParams.get('siteid');
      if (host === 'careers-content.clearcompany.com' && site && uuid.test(site)) return site.toLowerCase();
      if (host === 'careers-api.clearcompany.com' && p[0] === 'v1' && uuid.test(p[1] || '')) return p[1].toLowerCase();
      if (/^[^.]+\.hrmdirect\.com$/.test(host) && uuid.test(site || '')) return site!.toLowerCase();
    } else if (platform === 'hirehive' && /^[^.]+\.hirehive\.com$/.test(host)) slug = host.split('.')[0];
    return slug && atom.test(slug) && !reserved.test(slug) ? slug.toLowerCase() : null;
  } catch { return null; }
}

export function tenantAtsIdentityFromUrl(url: string): { platform: TenantAtsPlatform; slug: string } | null {
  for (const platform of TENANT_ATS_PLATFORMS) {
    const slug = tenantAtsBoardSlugFromUrl(url, platform);
    if (slug) return { platform, slug };
  }
  return null;
}

export function tenantAtsBoardUrl(platform: TenantAtsPlatform, slug: string): string {
  if (platform === 'clearcompany') {
    if (!uuid.test(slug)) throw new Error('Invalid ClearCompany public site identity');
    return `https://careers-content.clearcompany.com/js/v1/career-site-no-polyfill.js?siteId=${slug}`;
  }
  if (!atom.test(slug) || reserved.test(slug)) throw new Error('Invalid tenant ATS board identity');
  if (platform === 'gem') return `https://jobs.gem.com/${slug}`;
  if (platform === 'jobscore') return `https://careers.jobscore.com/careers/${slug}`;
  if (platform === 'jazzhr') return `https://${slug}.applytojob.com/apply/jobs/`;
  if (platform === 'manatal') return `https://www.careers-page.com/${slug}`;
  return `https://${slug}.hirehive.com/`;
}

export function tenantAtsPageSize(platform: string): number | null {
  return ['manatal', 'clearcompany', 'hirehive'].includes(platform) ? 20 : null;
}

export function tenantAtsRequest(platform: TenantAtsPlatform, slug: string, offset = 0): { url: string; init: RequestInit } {
  tenantAtsBoardUrl(platform, slug);
  if (!Number.isSafeInteger(offset) || offset < 0 || (tenantAtsPageSize(platform) && offset % 20 !== 0)) throw new Error('Invalid tenant ATS listing offset');
  if (!tenantAtsPageSize(platform) && offset !== 0) throw new Error('Whole-feed tenant ATS listings do not use offsets');
  let url: string;
  if (platform === 'gem') url = `https://api.gem.com/job_board/v0/${slug}/job_posts/`;
  else if (platform === 'jobscore') url = `https://careers.jobscore.com/jobs/${slug}/feed.json`;
  else if (platform === 'jazzhr') url = `https://app.jazz.co/feeds/export/jobs/${slug}`;
  else if (platform === 'manatal') url = `https://www.careers-page.com/api/v1.0/c/${slug}/jobs/?page_size=20&page=${offset / 20 + 1}`;
  else if (platform === 'clearcompany') url = `https://careers-api.clearcompany.com/v1/${slug}?pageIndex=${offset / 20}&pageSize=20`;
  else url = `https://${slug}.hirehive.com/api/v2/jobs?page=${offset / 20 + 1}&page_size=20`;
  return { url, init: { headers: { Accept: platform === 'jazzhr' ? 'application/xml,text/xml' : 'application/json' } } };
}

/** Public tenant-page branding is authority; the tenant slug is not an employer name. */
export function tenantAtsConfig(platform: TenantAtsPlatform, slug: string, html: string): { company: string } {
  const $ = load(html);
  const canonical = $('meta[property="og:url"]').attr('content');
  if (canonical && tenantAtsBoardSlugFromUrl(canonical, platform) !== slug) throw new Error('Tenant ATS public page identity mismatch');
  const title = stringValue($('meta[property="og:title"]').attr('content')) || $('title').first().text().trim();
  let company = '';
  if (platform === 'gem') company = title.replace(/\s+Careers\s*$/i, '');
  if (platform === 'manatal') company = title.replace(/^\s*-\s*/, '').replace(/\s*\|\s*Career Page\s*$/i, '');
  if (platform === 'hirehive' && /^Jobs at\s+.+\s*\|\s*HireHive\.com\s*$/i.test(title)) company = title.replace(/\s*\|\s*HireHive\.com\s*$/i, '').replace(/^Jobs at\s+/i, '');
  if (company === title) company = ''; // Require the known branding shape.
  return { company };
}

export function parseTenantAtsListing(platform: TenantAtsPlatform, slug: string, payload: unknown, body: string | null,
  config: { company: string } = { company: '' }, offset = 0): { jobs: Row[]; metadata: Row; total: number } {
  tenantAtsRequest(platform, slug, offset);
  let list: Row[], total: number, company = config.company, hasMore = false;
  if (platform === 'jazzhr') {
    const $ = load(body || '', { xmlMode: true });
    const roots = $.root().children();
    if (roots.length !== 1 || !roots.is('jobs') || roots.children().toArray().some(n => n.type === 'tag' && !['job', 'company', 'publisher', 'publisherurl', 'lastBuildDate'].includes(n.name))) throw new Error('JazzHR listing schema expected jobs XML');
    list = roots.children('job').toArray().map(n => {
      const j = $(n); const v = (k: string) => j.children(k).first().text().trim();
      return { id: v('id'), title: v('title'), description: v('description'), url: v('url'), city: v('city'), state: v('state'), country: v('country') };
    });
    company = roots.children('company').first().text().trim();
    total = list.length;
  } else if (platform === 'gem') { list = rows(payload); total = list.length; }
  else {
    const data = row(payload);
    if (platform === 'jobscore') { list = rows(data.jobs); company = stringValue(data.company_name); total = list.length; }
    else if (platform === 'manatal') {
      list = rows(data.results); total = totalValue(data.count);
      if (data.next != null) {
        const next = new URL(stringValue(data.next));
        const expected = new URL(tenantAtsRequest(platform, slug, offset + 20).url);
        if (next.origin !== expected.origin || next.pathname !== expected.pathname || Number(next.searchParams.get('page')) !== offset / 20 + 2 || Number(next.searchParams.get('page_size')) !== 20) throw new Error('Manatal listing continuation identity mismatch');
        hasMore = true;
      }
    } else if (platform === 'clearcompany') {
      list = rows(data.results); total = totalValue(data.totalCount);
      if (data.currentPageIndex !== offset / 20) throw new Error('ClearCompany returned a repeated listing page');
      hasMore = offset + list.length < total;
    } else {
      list = rows(data.items); const meta = row(data.meta); total = totalValue(meta.total_items);
      if (meta.page !== offset / 20 + 1 || meta.page_size !== 20 || typeof meta.has_next_page !== 'boolean') throw new Error('HireHive listing page identity mismatch');
      hasMore = meta.has_next_page as boolean;
    }
  }
  const pageSize = tenantAtsPageSize(platform);
  if (pageSize !== null && (list.length > pageSize || offset + list.length > total
    || hasMore !== (offset + list.length < total))) throw new Error('Tenant ATS listing total and continuation disagree');
  if (['gem', 'jobscore', 'jazzhr', 'manatal', 'hirehive'].includes(platform) && !company) throw new Error('Tenant ATS listing has no verified employer');
  if (hasMore && list.length !== 20) throw new Error('Tenant ATS listing has an incomplete continuation page');
  const seen = new Set<string>();
  const jobs = list.map(j => {
    const id = identifier(platform === 'manatal' ? j.hash : j.id);
    if (seen.has(id)) throw new Error('Tenant ATS listing has repeated posting identity');
    seen.add(id);
    const title = stringValue(j.position_name || j.positionTitle || j.title);
    const description = platform === 'gem' ? stringValue(j.content_plain) || stringValue(j.content)
      : platform === 'hirehive' ? stringValue(row(j.description).html) || stringValue(row(j.description).text) : stringValue(j.description);
    const employer = platform === 'clearcompany' ? stringValue(j.brandName) || company : company;
    let url = stringValue(j.absolute_url || j.detail_url || j.url || j.hosted_url || j.applyLink);
    if (platform === 'manatal') url = `https://www.careers-page.com/${slug}/job/${id}`;
    if (!title || !description || !url || !employer) throw new Error('Tenant ATS listing schema has no title, description, employer or posting URL');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Tenant ATS posting URL is unsafe');
    if (platform === 'clearcompany' && parsed.hostname !== 'jobs.clearcompany.com' && !/^[^.]+\.hrmdirect\.com$/.test(parsed.hostname)) throw new Error('ClearCompany posting URL identity mismatch');
    const matchingSlug = tenantAtsBoardSlugFromUrl(url, platform);
    // JazzHR can publish the operator's custom career domain; ClearCompany can
    // publish an hrmdirect link. Other sources must remain on their exact tenant.
    if (!['jazzhr', 'clearcompany'].includes(platform) && matchingSlug !== slug) throw new Error('Tenant ATS posting URL identity mismatch');
    let location = stringValue(j.location_display) || (typeof j.location === 'string' ? stringValue(j.location) : stringValue(row(j.location || {}).name));
    if (!location) location = [j.city, j.state, j.country].map(stringValue).filter(Boolean).join(', ');
    if (platform === 'hirehive') location = [j.location, j.state_code, j.country].map(stringValue).filter(Boolean).join(', ');
    if (platform === 'clearcompany' && Array.isArray(j.locations)) location = j.locations.map(v => {
      const place = row(v); return [place.city, place.subdivision, place.country].map(stringValue).filter(Boolean).join(', ');
    }).filter(Boolean).join('; ') || location;
    if (j.remote === true || /remote/i.test(stringValue(j.location_type))) location = location ? `${location} (Remote)` : 'Remote';
    const compensation = stringValue(j.formatted_public_compensation) || stringValue(j.salary);
    const createdAt = stringValue(j.first_published_at || j.opened_date || j.publish_date || j.published_date || j.postedDate);
    return { id: `${slug}::${id}`, publicAtsPostingId: id, title, description, company: employer, url,
      location, ...(createdAt ? { createdAt } : {}), ...(compensation ? { salary: compensation } : {}) };
  });
  return { jobs, metadata: { name: company, listingHasMore: hasMore, tenantListingOffset: offset }, total };
}

export class AtsFirstCollectionSizeError extends Error {
  constructor(message: string) { super(message); this.name = 'AtsFirstCollectionSizeError'; }
}

/** Count decoded stream bytes, not a possibly absent or compressed Content-Length. */
export async function readBoundedAtsBody(response: Response, maximumBytes = 5 * 1024 * 1024): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new AtsFirstCollectionSizeError('ATS catalogue exceeds the bounded response allowance; held for size review');
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const data = Buffer.concat(chunks);
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try { return gunzipSync(data, { maxOutputLength: maximumBytes }).toString('utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new AtsFirstCollectionSizeError('ATS catalogue exceeds the decoded response allowance; held for size review');
      throw error;
    }
  }
  return data.toString('utf8');
}
