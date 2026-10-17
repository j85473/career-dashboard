import * as cheerio from 'cheerio';

export const EIGHTFOLD_DOMAINS = ['eightfold.ai', 'eightfold-eu.ai', 'eightfold-ca.ai', 'eightfold-ap.ai', 'eightfold-me.ai', 'eightfold-wu.ai', 'eightfold-gov.ai'] as const;
const RESERVED = new Set(['www', 'api', 'apiv2', 'docs', 'apidocs', 'support', 'help', 'blog', 'static', 'preview']);
type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const dnsName = (value: string): boolean => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);

export function eightfoldPostingIdFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const pathId = /^\/careers\/job\/(\d+)(?:-[^/]+)?\/?$/.exec(url.pathname)?.[1];
    const selectedIds = url.searchParams.getAll('pid');
    if (selectedIds.length > 1 || (pathId && selectedIds.some(id => id !== pathId))) return null;
    const queryId = /^\/careers\/?$/.test(url.pathname) ? selectedIds[0] : null;
    return pathId || (queryId && /^\d+$/.test(queryId) ? queryId : null);
  } catch { return null; }
}

/** Shared app hosts require the explicit employer domain; tenant hosts do not. */
export function eightfoldBoardSlugFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || !/^\/careers(?:\/|$)/i.test(url.pathname)) return null;
    const base = EIGHTFOLD_DOMAINS.find((domain) => url.hostname.endsWith(`.${domain}`));
    if (!base) return null;
    const tenant = url.hostname.slice(0, -base.length - 1);
    if (!tenant || tenant.includes('.') || RESERVED.has(tenant)) return null;
    const domain = url.searchParams.get('domain');
    if (domain && !dnsName(domain)) return null;
    if (tenant === 'app' && !domain) return null;
    // Only the shared app host is domain-scoped. Tracking/query variants on
    // employer hosts must not create a second board for the same tenant.
    return tenant === 'app' ? `${url.hostname}::${domain!.toLowerCase()}` : url.hostname;
  } catch { return null; }
}

export function eightfoldBoardIdentity(slug: string): { host: string; domain: string | null } {
  const [host, domain, extra] = slug.toLowerCase().split('::');
  if (extra !== undefined || !dnsName(host) || (domain !== undefined && !dnsName(domain))) throw new Error('Invalid Eightfold board identity');
  return { host, domain: domain || null };
}

export function eightfoldCareersUrl(slug: string): string {
  const { host, domain } = eightfoldBoardIdentity(slug);
  const url = new URL(`https://${host}/careers`);
  if (domain) url.searchParams.set('domain', domain);
  return url.href;
}

export function parseEightfoldConfig(html: string, expectedDomain: string | null = null): { domain: string; company: string } {
  const $ = cheerio.load(html);
  const identities: Array<{ domain: string; company: string }> = [];
  for (const selector of ['#pcsx-data', '#smartApplyData']) {
    const elements = $(selector);
    if (!elements.length) continue;
    if (elements.length !== 1) throw new Error('Ambiguous Eightfold public career configuration');
    const data: unknown = JSON.parse(elements.text());
    if (!record(data)) throw new Error('Invalid Eightfold public career configuration');
    const configs = record(data.configs) ? data.configs : {};
    const pcs = record(configs.pcsxConfig) ? configs.pcsxConfig : {};
    const branding = selector === '#smartApplyData'
      ? (record(data.branding) ? data.branding : {})
      : (record(pcs.branding) ? pcs.branding : {});
    const domain = typeof data.domain === 'string' ? data.domain.toLowerCase() : '';
    const company = typeof branding.companyName === 'string' ? branding.companyName.trim() : '';
    if (!dnsName(domain) || !company || (expectedDomain && domain !== expectedDomain)) {
      throw new Error('Eightfold public career configuration missing or employer domain mismatch');
    }
    identities.push({ domain, company });
  }
  const identity = identities[0];
  if (!identity || identities.some(value => value.domain !== identity.domain || value.company !== identity.company)) {
    throw new Error('Eightfold public career configuration missing or employer domain mismatch');
  }
  return identity;
}

/** Custom domains must publish Eightfold's configuration on the employer's own host. */
export function eightfoldPostingPageConfig(raw: string, html: string): { domain: string; company: string; slug: string | null } | null {
  try {
    const url = new URL(raw);
    if (!eightfoldPostingIdFromUrl(raw)) return null;
    if (url.searchParams.getAll('domain').length > 1) return null;
    const slug = eightfoldBoardSlugFromUrl(raw);
    const config = parseEightfoldConfig(html, url.searchParams.get('domain')?.toLowerCase()
      || (slug ? eightfoldBoardIdentity(slug).domain : null));
    if (!slug && url.hostname !== config.domain && !url.hostname.endsWith(`.${config.domain}`)) return null;
    // A custom host is verified for this posting, not a new collection board:
    // its existing Eightfold tenant may already be registered separately.
    return { ...config, slug };
  } catch { return null; }
}

/** URL aliases are equivalent only with page-published Eightfold employer evidence. */
export function eightfoldPostingUrlsMatch(left: string, right: string, html: string): boolean {
  try {
    const expected = new URL(right);
    const candidate = new URL(left, expected);
    if (candidate.origin !== expected.origin) return false;
    const id = eightfoldPostingIdFromUrl(expected.href);
    return Boolean(id && eightfoldPostingIdFromUrl(candidate.href) === id
      && eightfoldPostingPageConfig(expected.href, html) && eightfoldPostingPageConfig(candidate.href, html));
  } catch { return false; }
}

/** Read only the selected position, never the first related job in the page data. */
export function eightfoldPostingPageMetadata(url: string, html: string): { title?: string; company: string; location?: string } | null {
  const config = eightfoldPostingPageConfig(url, html);
  if (!config) return null;
  const $ = cheerio.load(html);
  const id = eightfoldPostingIdFromUrl(url);
  const matches: Row[] = [];
  for (const selector of ['#pcsx-data', '#smartApplyData']) {
    const raw = $(selector).text();
    if (!raw) continue;
    const data = JSON.parse(raw) as Row;
    if (data.pid !== undefined && String(data.pid) !== id) return null;
    if (Array.isArray(data.positions)) {
      const selected = data.positions.filter((job): job is Row => record(job) && String(job.id) === id);
      if (selected.length > 1) return null;
      matches.push(...selected);
    }
  }
  const titles = [...new Set(matches.flatMap(job => typeof job.name === 'string' && job.name.trim() ? [job.name.trim()] : []))];
  const locations = [...new Set(matches.flatMap(job => eightfoldLocation(job) ? [eightfoldLocation(job)!] : []))];
  if (titles.length > 1 || locations.length > 1) return null;
  return { company: config.company, ...(titles[0] ? { title: titles[0] } : {}), ...(locations[0] ? { location: locations[0] } : {}) };
}

export function eightfoldSearchUrl(slug: string, offset = 0, resolvedDomain?: string): string {
  const { host, domain } = eightfoldBoardIdentity(slug);
  const url = new URL(`https://${host}/api/pcsx/search`);
  if (resolvedDomain || domain) url.searchParams.set('domain', resolvedDomain || domain!);
  url.searchParams.set('query', '');
  url.searchParams.set('location', '');
  url.searchParams.set('start', String(offset));
  url.searchParams.set('sort_by', 'recent');
  url.searchParams.set('hl', 'en');
  return url.href;
}

export function eightfoldDetailUrl(slug: string, id: string | number, domain?: string): string {
  const url = new URL(eightfoldSearchUrl(slug, 0, domain));
  url.pathname = '/api/pcsx/position_details';
  url.search = '';
  url.searchParams.set('position_id', String(id));
  const resolvedDomain = domain || eightfoldBoardIdentity(slug).domain;
  if (resolvedDomain) url.searchParams.set('domain', resolvedDomain);
  url.searchParams.set('hl', 'en');
  return url.href;
}

export function parseEightfoldListing(body: unknown): { positions: Row[]; count: number } {
  const data = record(body) && body.status === 200 && record(body.data) ? body.data : null;
  if (!data || !Array.isArray(data.positions) || !Number.isInteger(data.count) || Number(data.count) < 0
    || data.positions.some((job) => !record(job) || !/^\d+$/.test(String(job.id)) || typeof job.name !== 'string')) {
    throw new Error('Eightfold ATS listing schema is invalid');
  }
  return { positions: data.positions as Row[], count: Number(data.count) };
}

export function eightfoldLocation(job: Row): string | null {
  const locations = Array.isArray(job.locations) ? job.locations.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())) : [];
  const location = locations.join('; ') || (typeof job.location === 'string' ? job.location : '');
  const remote = typeof job.workLocationOption === 'string' && /^remote(?:_|$)/.test(job.workLocationOption);
  return [remote ? 'Remote' : '', location].filter(Boolean).join(' — ') || null;
}

/** Retain the public employer URL, never a login-only Career Hub target. */
export function eightfoldPostingUrl(slug: string, job: Row): string {
  const { host, domain } = eightfoldBoardIdentity(slug);
  const fallback = new URL(`/careers/job/${String(job.id)}`, `https://${host}`);
  if (domain) fallback.searchParams.set('domain', domain);
  if (typeof job.publicUrl === 'string') {
    try {
      const url = new URL(job.publicUrl);
      if (url.protocol === 'https:' && url.pathname === fallback.pathname) return url.href;
    } catch { /* compose from validated identity */ }
  }
  return fallback.href;
}
