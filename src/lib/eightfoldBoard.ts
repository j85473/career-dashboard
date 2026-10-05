import * as cheerio from 'cheerio';

export const EIGHTFOLD_DOMAINS = ['eightfold.ai', 'eightfold-eu.ai', 'eightfold-ca.ai', 'eightfold-ap.ai', 'eightfold-me.ai', 'eightfold-wu.ai', 'eightfold-gov.ai'] as const;
const RESERVED = new Set(['www', 'api', 'apiv2', 'docs', 'apidocs', 'support', 'help', 'blog', 'static', 'preview']);
type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const dnsName = (value: string): boolean => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);

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
  const data = JSON.parse($('#pcsx-data').text() || '{}') as Row;
  const configs = record(data.configs) ? data.configs : {};
  const pcs = record(configs.pcsxConfig) ? configs.pcsxConfig : {};
  const branding = record(pcs.branding) ? pcs.branding : {};
  const domain = typeof data.domain === 'string' ? data.domain.toLowerCase() : '';
  const company = typeof branding.companyName === 'string' ? branding.companyName.trim() : '';
  if (!dnsName(domain) || !company || (expectedDomain && domain !== expectedDomain)) {
    throw new Error('Eightfold public career configuration missing or employer domain mismatch');
  }
  return { domain, company };
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
