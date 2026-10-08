import * as cheerio from 'cheerio';
import { isUkgBoardHost } from './ukgHost';

const generic = /^(?:unknown company|company|organization|website|site|image|header logo|logo image|home(?: page)?|welcome|login|log in|just a moment|career site|candidate experience(?: site)?|oracle(?: cloud)?|careers?|jobs?|candidate experience|successfactors|ukg|ultipro|logo|company logo)$/i;
const value = (input: unknown): string => typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
const internalLabel = /\b(?:rebranding|brand(?:ing)?|template|default|logo)\b|brand$|[-_]white$|^US\s*-\s*LLC(?: recruiting)?$/i;
const hostKey = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '');

/** Career-page decorations identify the brand but are not part of its name. */
export function publishedEmployerName(input: unknown): string {
  const name = value(input).replace(/^(?:careers?|jobs?) at /i, '').replace(/ careers?(?: site| portal)?$/i, '').trim();
  return name && !generic.test(name) && !internalLabel.test(name) && !internalLabel.test(name.replace(/[_-]+/g, ' ')) ? name : '';
}

export function oracleCareerSiteUrl(postingUrl: string): string {
  const url = new URL(postingUrl);
  const site = url.pathname.match(/^\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([a-z0-9_-]+)(?:\/|$)/i)?.[1];
  if (!url.hostname.endsWith('.oraclecloud.com') || !site) return '';
  return new URL(`/hcmRestApi/resources/latest/recruitingCESites/${site}?onlyData=true`, url).href;
}

/** Bind published organization/site branding to the exact requested site. */
export function oracleCareerSiteEmployer(payload: unknown, postingUrl: string): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const row = payload as Record<string, unknown>;
  const expected = new URL(postingUrl).pathname.match(/\/sites\/([a-z0-9_-]+)(?:\/|$)/i)?.[1];
  if (!oracleCareerSiteUrl(postingUrl) || !expected || row.SiteNumber !== expected) return '';
  const rawName = value(row.SeoOrganizationName || row.SiteName);
  const name = rawName === 'Oracle' && new URL(postingUrl).hostname === 'eeho.fa.us2.oraclecloud.com' ? 'Oracle' : publishedEmployerName(rawName);
  // An internal code or generic career-site title is not organization proof.
  if (!name || /\b(?:career|careers|carrera|candidate|portal|sitio|empleo)\b/i.test(name)
    || /^[A-Z]{1,3}[_-]\d+$/i.test(name)) return '';
  if (name === 'Oracle' && new URL(postingUrl).hostname !== 'eeho.fa.us2.oraclecloud.com') return '';
  return name;
}

export function oracleBrandedEmployer(html: string, url: string): string {
  const target = new URL(url);
  if (!target.hostname.endsWith('.oraclecloud.com')) return '';
  const $ = cheerio.load(html);
  const rawName = value($('meta[property="og:site_name"], meta[name="og:site_name"]').first().attr('content'));
  const name = publishedEmployerName(rawName);
  if (name && !generic.test(name)) return name;
  // This is Oracle's own recruiting tenant, verified by its corporate logo.
  // The vendor's generic label on a customer tenant supplies no employer.
  if (rawName === 'Oracle' && target.hostname === 'eeho.fa.us2.oraclecloud.com') {
    try {
      const logo = new URL($('meta[property="og:image"]').attr('content') || '', url);
      if (hostKey(logo) === 'oracle.com' && /logo/i.test(logo.pathname)) return 'Oracle';
    } catch { /* No verified corporate branding. */ }
  }
  return '';
}

function ukgBoardPath(url: string): string | null {
  const target = new URL(url);
  if (!isUkgBoardHost(target.hostname)) return null;
  return target.pathname.match(/^\/[^/]+\/JobBoard\/[0-9a-f-]{36}(?:\/|$)/i)?.[0].replace(/\/$/, '') || null;
}

/** Read literal properties only. Never evaluate vendor JavaScript or expressions. */
function literalProperty(source: string, property: string): string {
  const matches = [...source.matchAll(new RegExp(`\\b${property}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')\\s*[,}]`, 'g'))];
  if (matches.length !== 1) return '';
  const quoted = matches[0][1];
  try {
    if (quoted.startsWith('"')) return JSON.parse(quoted);
    // UKG uses single quotes for literal URLs, which need no JS evaluation.
    return quoted.slice(1, -1).replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\(['"\\/])/g, '$1');
  } catch { return ''; }
}

export function ukgBoardBranding(html: string, url: string): { company: string; employerUrl: string } {
  const boardPath = ukgBoardPath(url);
  if (!boardPath) return { company: '', employerUrl: '' };
  const origin = new URL(url).origin;
  const $ = cheerio.load(html);
  const names: string[] = [], links: string[] = [];
  const corporateLink = (raw: string): string => {
    try {
      const link = new URL(raw);
      return ['https:', 'http:'].includes(link.protocol) && !link.username && !link.password
        && !/(?:^|\.)(?:ultipro\.com|ukg\.net|oraclecloud\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|twitter\.com|x\.com)$/.test(link.hostname) ? link.href : '';
    } catch { return ''; }
  };
  for (const image of $('img[data-automation="navbar-small-logo"], img[data-automation="navbar-large-logo"]').toArray()) {
    try {
      const logo = new URL($(image).attr('src') || '', url);
      if (logo.origin !== origin || !["GetLargeHeaderLogo", "GetSmallHeaderLogo"].some(endpoint =>
        logo.pathname.toLowerCase() === `${boardPath}/Styles/${endpoint}`.toLowerCase())) continue;
      const rawName = value($(image).attr('alt'));
      const name = internalLabel.test(rawName) ? '' : publishedEmployerName(rawName);
      if (name) names.push(name);
      const link = corporateLink($(image).closest('a').attr('href') || '');
      if (link) links.push(link);
    } catch { /* Unrelated or malformed logo does not supply authority. */ }
  }
  const unique = [...new Set(names)], uniqueLinks = [...new Set(links)];
  if (unique.length || uniqueLinks.length) return { company: unique.length === 1 ? unique[0] : '',
    employerUrl: uniqueLinks.length === 1 && unique.length <= 1 ? uniqueLinks[0] : '' };
  const headers = [...html.matchAll(/React\.createElement\(RecNavHeader,\s*\{([\s\S]*?)\bprofileItems\s*:/g)];
  if (headers.length !== 1) return { company: '', employerUrl: '' };
  const props = headers[0][1];
  try {
    const board = new URL(literalProperty(props, 'jobBoardLink'), url);
    const logo = new URL(literalProperty(props, 'largeLogoSrc'), url);
    const link = new URL(literalProperty(props, 'logoHref'));
    if (board.origin !== origin || board.pathname.toLowerCase() !== boardPath.toLowerCase()
      || logo.origin !== origin || logo.pathname.toLowerCase() !== `${boardPath}/Styles/GetLargeHeaderLogo`.toLowerCase()
      || !corporateLink(link.href)) return { company: '', employerUrl: '' };
    return { company: '', employerUrl: link.href };
  } catch { return { company: '', employerUrl: '' }; }
}

/** Names come from the linked employer's own metadata, never its hostname. */
export function employerWebsiteName(html: string, requestedUrl: string, respondedUrl = requestedUrl): string {
  if (hostKey(new URL(requestedUrl)) !== hostKey(new URL(respondedUrl))) return '';
  const $ = cheerio.load(html);
  const name = publishedEmployerName($('meta[property="og:site_name"],meta[name="og:site_name"]').first().attr('content'));
  if (name) return name;
  const names: string[] = [];
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(script).text());
      const rows = Array.isArray(data) ? data : Array.isArray(data['@graph']) ? data['@graph'] : [data];
      for (const row of rows) {
        if (!/^(?:Organization|Corporation|OnlineStore|LocalBusiness)$/.test(row?.['@type'])) continue;
        const label = publishedEmployerName(row.name), ownUrl = value(row.url);
        if (label && !generic.test(label) && ownUrl && hostKey(new URL(ownUrl)) === hostKey(new URL(requestedUrl))) names.push(label);
      }
    } catch { /* Malformed metadata has no authority. */ }
  }
  const unique = [...new Set(names)];
  if (unique.length === 1) return unique[0];
  // A corporate site's own home-link logo is explicit organization branding.
  // Product/partner images and links away from its own home page do not count.
  const logoNames = $('header a[href] img[alt], [class*=header] a[href] img[alt], a[class*=logo] img[alt], a[class*=brand] img[alt]').toArray().flatMap(image => {
    try {
      const anchor = $(image).closest('a');
      const link = new URL(anchor.attr('href') || '', respondedUrl);
      const src = $(image).attr('src') || '';
      const rawName = value($(image).attr('alt'));
      if (/\b(?:white|black|dark|light|horizontal|vertical|reverse)\s+logo$/i.test(rawName)) return [];
      const label = publishedEmployerName(rawName.replace(/\s+logo$/i, ''));
      return hostKey(link) === hostKey(new URL(requestedUrl)) && /^\/(?:en(?:[-_]us)?\/?)?$/i.test(link.pathname)
        && /logo|brand/i.test(`${src} ${anchor.attr('class') || ''} ${$(image).attr('class') || ''}`)
        && label ? [label] : [];
    } catch { return []; }
  });
  const logos = [...new Set(logoNames)];
  return logos.length === 1 ? logos[0] : '';
}

const websiteNames = new Map<string, { name: string; expiresAt: number }>();
export async function resolveUkgBoardEmployer(html: string, url: string,
  fetchPage: (url: string) => Promise<Response>): Promise<string> {
  const branding = ukgBoardBranding(html, url);
  if (branding.company || !branding.employerUrl) return branding.company;
  const cached = websiteNames.get(branding.employerUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  const response = await fetchPage(branding.employerUrl);
  const name = response.ok ? employerWebsiteName(await response.text(), branding.employerUrl, response.url || branding.employerUrl) : '';
  websiteNames.set(branding.employerUrl, { name, expiresAt: Date.now() + (name ? 86400000 : 300000) });
  return name;
}
