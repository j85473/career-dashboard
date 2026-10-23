import { load } from 'cheerio';
import { companyLogoUrl, postingDomain, type LogoSubject } from './companyLogo';
import { employerAliasKey, employerNameRelation } from './employerIdentity';
import { employerUrlKey } from './employerUrl';
import { publishedEmployerName } from './publicAtsEmployer';
import { assertSafeExternalNavigationUrl, safeExternalFetch } from './safeExternalFetch';

function externalUrl(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return assertSafeExternalNavigationUrl(new URL(value.replace(/&amp;/gi, '&'), base)).href; } catch { return null; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageUrl(value: unknown, base: string): string | null {
  const row = record(value);
  return externalUrl(typeof value === 'string' ? value : row.contentUrl || row.url, base);
}

/** Only employer evidence counts; a board's favicon and social preview may belong to the ATS. */
export function postingLogo(html: string, pageUrl: string, company: string): string | null {
  const key = employerAliasKey(company);
  if (!key) return null;
  const $ = load(html);
  const matches = (name: unknown) => typeof name === 'string'
    && employerAliasKey(publishedEmployerName(name.replace(/\s+logo$/i, ''))) === key;
  const page = new URL(pageUrl);
  const workdayTenantMatches = /\.myworkdayjobs\.com$/.test(page.hostname)
    && page.hostname.split('.')[0].replace(/-/g, '') === key;
  const candidates = new Set<string>();
  const fallbacks = new Set<string>();
  let employerConfirmed = false;
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(script).text());
      const rows = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
      for (const raw of rows) {
        const row = record(raw);
        if (![row['@type']].flat().includes('JobPosting')) continue;
        const org = record(row.hiringOrganization);
        const websites = [org.sameAs, org.url].flat().filter((value): value is string => typeof value === 'string');
        const acronym = company.split(/[^a-z0-9]+/i).filter(Boolean).map(word => word[0]).join('').toLowerCase();
        const orgKey = typeof org.name === 'string' ? employerAliasKey(org.name) : '';
        const acronymConfirmed = acronym.length >= 3 && acronym === orgKey
          && websites.some(value => postingDomain(value, orgKey));
        // A published corporate domain can corroborate a board slug such as
        // Absorblms when the organization calls itself Absorb.
        if (!matches(org.name) && !acronymConfirmed && !websites.some(value => postingDomain(value, key))
          && !(workdayTenantMatches && typeof org.name === 'string' && employerNameRelation(org.name, company) === 'strong')) continue;
        employerConfirmed = true;
        const logo = imageUrl(org.logo, pageUrl);
        if (logo) candidates.add(logo);
        else {
          const domains = [...new Set(websites.map(value => postingDomain(value, key)).filter(Boolean))];
          if (domains.length === 1) fallbacks.add(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domains[0]!)}&sz=128`);
        }
      }
    } catch { /* Malformed structured data supplies no branding evidence. */ }
  }
  for (const image of $('img[alt]').toArray()) {
    const alt = $(image).attr('alt') || '';
    if (!/\blogo\b/i.test(alt) || !matches(alt)) continue;
    const logo = externalUrl($(image).attr('src'), pageUrl);
    if (logo) candidates.add(logo);
  }
  // Rippling supplies tenant branding in its structured application state even
  // when the board chooses not to display that logo on individual postings.
  if (page.hostname === 'ats.rippling.com') {
    try {
      const data = JSON.parse($('#__NEXT_DATA__').text());
      const board = record(record(record(record(data).props).pageProps).apiData).jobBoard;
      const branding = record(board);
      if (matches(branding.companyName) && branding.slug === page.pathname.split('/').filter(Boolean)[0]) {
        const logo = imageUrl(branding.logo, pageUrl);
        if (logo) candidates.add(logo);
      }
    } catch { /* Unrelated or malformed application state is not evidence. */ }
  }
  if (candidates.size === 1) return [...candidates][0];
  if (candidates.size > 1) return null;

  // These portals label their header image generically. Bind that image to
  // both the employer suffix in the page title and the same board's home link.
  const manatal = /^(?:www\.)?careers-page\.com$/.test(page.hostname);
  const jazzhr = /\.applytojob\.com$/.test(page.hostname);
  const title = $('title').text();
  const titleEmployer = manatal ? title.match(/ - ([^|]+) \| Career Page$/)?.[1]
    : jazzhr ? title.match(/ - (.+) - Career Page$/)?.[1] : null;
  if (titleEmployer && matches(titleEmployer)) {
    const logos = new Set<string>();
    for (const image of $(manatal ? 'a.navbar-brand img' : 'img[alt="brand logo"]').toArray()) {
      const home = externalUrl($(image).closest('a').attr('href'), pageUrl);
      const logo = externalUrl($(image).attr('src'), pageUrl);
      if (!home || !logo) continue;
      const link = new URL(home);
      const boardHome = manatal ? `/${page.pathname.split('/').filter(Boolean)[0]}` : '/apply';
      if (link.hostname === page.hostname && link.pathname.replace(/\/$/, '') === boardHome) logos.add(logo);
    }
    if (logos.size === 1) return [...logos][0];
  }

  // Workday publishes a tenant/site-specific logo rather than a vendor icon.
  // Require both the employer declaration and the exact site's asset path.
  const boardPath = page.pathname.split('/job/')[0];
  if (employerConfirmed && /\.myworkdayjobs\.com$/.test(page.hostname) && boardPath !== page.pathname) {
    const logo = externalUrl($('meta[property="og:image"]').attr('content'), pageUrl);
    if (logo) {
      const asset = new URL(logo);
      if (asset.origin === page.origin && asset.pathname === `${boardPath}/assets/logo`) return logo;
      // Some Workday sites publish `https://<site>/assets/logo`, dropping the
      // tenant host. Repair only that exact declared site under a named employer.
      const site = boardPath.split('/').filter(Boolean).at(-1);
      if (workdayTenantMatches && site && asset.hostname === site.toLowerCase() && asset.pathname === '/assets/logo') {
        return new URL(`${boardPath}/assets/logo`, page).href;
      }
    }
  }
  // Oracle's site favicon is customer branding only when the page names that
  // employer and the asset is bound to the same candidate-experience site.
  const site = page.pathname.match(/\/sites\/([^/]+)/i)?.[1];
  if (/\.oraclecloud\.com$/.test(page.hostname) && site && matches($('meta[property="og:site_name"]').attr('content'))) {
    for (const icon of $('link[rel="icon"]').toArray().reverse()) {
      const logo = externalUrl($(icon).attr('href'), pageUrl);
      if (!logo) continue;
      const asset = new URL(logo);
      if (asset.origin === page.origin && asset.pathname.startsWith('/hcmRestApi/CandidateExperience/siteFavicon/')
        && asset.searchParams.get('siteNumber') === site) return logo;
    }
  }
  return fallbacks.size === 1 ? [...fallbacks][0] : null;
}

type FetchPage = (url: string) => Promise<Response>;

export async function recoverCompanyLogo(subject: LogoSubject, fetchPage: FetchPage): Promise<string | null> {
  const known = companyLogoUrl(subject);
  if (known) return known;
  for (const url of [...new Set([subject.canonicalUrl, subject.url])]) {
    if (!url || !subject.company) continue;
    try {
      const response = await fetchPage(assertSafeExternalNavigationUrl(url).href);
      if (!response.ok) continue;
      const finalUrl = response.url || url;
      // A redirect to another employer/board cannot establish branding.
      const board = employerUrlKey(url);
      if (board ? employerUrlKey(finalUrl) !== board
        : new URL(finalUrl).origin !== new URL(url).origin || new URL(finalUrl).pathname !== new URL(url).pathname) continue;
      const logo = postingLogo(await response.text(), finalUrl, subject.company);
      if (logo) return logo;
    } catch { /* A blocked/expired posting leaves the initials visible. */ }
  }
  return null;
}

const workdayImages = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string; expires: number }>();

/** Some Workday sites send PNG bytes as text/plain, which browsers refuse as images. */
export async function workdayLogoImage(url: string,
  fetchImage: FetchPage = value => safeExternalFetch(value, { signal: AbortSignal.timeout(8000) }),
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
  const target = new URL(url);
  if (!/\.myworkdayjobs\.com$/.test(target.hostname) || !target.pathname.endsWith('/assets/logo')) return null;
  const cached = workdayImages.get(url);
  if (cached && cached.expires > Date.now()) return cached;
  try {
    const response = await fetchImage(url);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 131072) return null;
    const signature = Buffer.from(bytes);
    const type = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : signature[0] === 255 && signature[1] === 216 && signature[2] === 255 ? 'image/jpeg'
      : /^GIF8[79]a$/.test(signature.subarray(0, 6).toString()) ? 'image/gif' : null;
    if (!type) return null;
    if (workdayImages.size >= 128) workdayImages.delete(workdayImages.keys().next().value!);
    workdayImages.set(url, { bytes, type, expires: Date.now() + 86400000 });
    return { bytes, type };
  } catch { return null; }
}
