import { load } from 'cheerio';
import { parseHttpUrl } from './urlHost';
import { ZOHO_RECRUIT_DOMAINS } from './zohoRecruitHost';

type RecordValue = Record<string, unknown>;
const RESERVED_TENANTS = new Set(['www', 'api', 'app', 'accounts', 'recruit', 'help', 'support', 'docs', 'status']);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Zoho Recruit listing expected an object');
  return value as RecordValue;
}

/** The regional hostname and named career page together identify one catalogue. */
export function zohoRecruitBoardSlugFromUrl(value: string): string | null {
  const url = parseHttpUrl(value);
  if (!url || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const domain = ZOHO_RECRUIT_DOMAINS.find(candidate => host.endsWith(`.${candidate}`));
  const tenant = domain ? host.slice(0, -(domain.length + 1)) : '';
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(tenant) || RESERVED_TENANTS.has(tenant)) return null;
  const match = /^\/jobs\/([^/]+)(?:\/\d+(?:\/[^/]+)?)?\/?$/.exec(url.pathname);
  if (!match) return null;
  try {
    const page = decodeURIComponent(match[1]);
    if (!page || page.length > 160 || /[\x00-\x1f\x7f/\\?#]|::/.test(page) || page === '.' || page === '..') return null;
    return `${host}::${encodeURIComponent(page)}`;
  } catch { return null; }
}

export function zohoRecruitBoardUrl(slug: string): string {
  const [host, page, extra] = slug.split('::');
  const url = `https://${host}/jobs/${page}`;
  if (extra !== undefined || zohoRecruitBoardSlugFromUrl(url) !== slug) throw new Error('Invalid Zoho Recruit board identity');
  return url;
}

export function zohoRecruitBoardRequest(slug: string): { url: string; init: RequestInit } {
  const board = new URL(zohoRecruitBoardUrl(slug));
  const url = new URL('/recruit/v2/public/Job_Openings', board);
  url.searchParams.set('pagename', decodeURIComponent(slug.split('::')[1]));
  // The public career endpoint returns the same complete array embedded in
  // the board page. Employer integration API page/per_page parameters do not
  // apply here; sending them made the verified public endpoint return 400.
  return { url: url.href, init: { headers: { Accept: 'application/json' } } };
}

export function parseZohoRecruitBoardConfig(slug: string, html: string): { company: string } {
  const $ = load(html);
  const raw = $('input#meta').attr('value');
  if (!raw) throw new Error('Zoho Recruit board has no public career configuration');
  const meta = record(JSON.parse(raw));
  if (meta.employee_portal === true || zohoRecruitBoardSlugFromUrl(text(meta.list_url)) !== slug
    || encodeURIComponent(text(meta.page_name)) !== slug.split('::')[1]) {
    throw new Error('Zoho Recruit public career configuration identity mismatch');
  }
  const organization = record(meta.org_info);
  const company = organization.hide_company_name === true ? '' : text(organization.company_name);
  if (!company) throw new Error('Zoho Recruit public career configuration has no employer');
  return { company };
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^yes$/i.test(value)) return true;
  if (typeof value === 'string' && /^no$/i.test(value)) return false;
  return null;
}

export function parseZohoRecruitListing(slug: string, payload: unknown, company = ''):
  { jobs: RecordValue[]; metadata: RecordValue; total: number } {
  const boardUrl = zohoRecruitBoardUrl(slug);
  const data = record(payload);
  const info = record(data.info);
  if (data.code !== 'success' || !Array.isArray(data.data)
    || encodeURIComponent(text(info.page_name)) !== slug.split('::')[1]) {
    throw new Error('Zoho Recruit listing schema or career page identity mismatch');
  }
  const ids = new Set<string>();
  const jobs: RecordValue[] = [];
  for (const value of data.data) {
    const row = record(value);
    const id = text(row.id);
    if (!/^\d+$/.test(id) || ids.has(id)) throw new Error('Zoho Recruit listing has an invalid or repeated posting identity');
    ids.add(id);
    const published = booleanValue(row.Publish);
    if (published === null) throw new Error('Zoho Recruit listing has no publication state');
    if (!published) continue; // Career sites can retain filled positions alongside their open roles.
    const title = text(row.Posting_Title);
    const description = text(row.Job_Description);
    if (!title || !description) throw new Error('Zoho Recruit published posting has no title or description');
    const address = [row.City, row.State, row.Country].map(text).filter(Boolean).join(', ');
    const location = booleanValue(row.Remote_Job) === true ? (address ? `Remote, ${address}` : 'Remote') : address;
    jobs.push({ id: `${slug}::${id}`, publicAtsPostingId: id, title, company, description, location,
      // Keep links on the verified vendor board. The feed may publish a vanity
      // URL, but it cannot redirect matching to another host or requisition.
      url: `${boardUrl}/${id}`, ...(text(row.Date_Opened) ? { createdAt: text(row.Date_Opened) } : {}) });
  }
  return { jobs, metadata: { name: company }, total: jobs.length };
}
