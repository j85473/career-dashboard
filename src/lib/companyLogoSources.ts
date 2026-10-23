import { load } from 'cheerio';
import { companyLogoDomain, companyLogoUrl, postingDomain, reviewedCompanyWebsite, type LogoSubject } from './companyLogo';
import { postingLogo } from './companyLogoRecovery';
import { companyWebsiteCandidate, corporateWebsiteLogo } from './companyWebsiteLogo';
import { employerAliasKey } from './employerIdentity';
import { assertSafeExternalNavigationUrl } from './safeExternalFetch';

type FetchPage = (url: string) => Promise<Response>;

function external(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return assertSafeExternalNavigationUrl(new URL(value, base)).href; } catch { return null; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function structuredRows(html: string): Record<string, unknown>[] {
  const $ = load(html);
  return $('script[type="application/ld+json"]').toArray().flatMap(script => {
    try {
      const data = JSON.parse($(script).text());
      return (Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data]).map(record);
    } catch { return []; }
  });
}

/** Only known tenant boundaries can turn an expired posting into a board lookup. */
export function companyLogoBoardUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = assertSafeExternalNavigationUrl(value);
    const host = url.hostname;
    const parts = url.pathname.split('/').filter(Boolean);
    if (/^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(host)
      || /^jobs\.(?:eu\.)?lever\.co$/.test(host) || host === 'jobs.ashbyhq.com'
      || /^(?:jobs|careers)\.smartrecruiters\.com$/.test(host) || host === 'apply.workable.com'
      || host === 'ats.rippling.com') {
      return parts[0] ? new URL(`/${parts[0]}`, url).href : null;
    }
    if (/\.myworkdayjobs\.com$/.test(host) && url.pathname.includes('/job/')) {
      return new URL(url.pathname.split('/job/')[0], url).href;
    }
    if (/\.(?:recruitee\.com|breezy\.hr|teamtailor\.com|pinpointhq\.com|bamboohr\.com)$/.test(host)) {
      return `${url.origin}/`;
    }
  } catch { /* Unsafe or malformed input establishes no board. */ }
  return null;
}

/** Successes can be shared across postings; unrelated ATS tenants stay separate. */
export function companyLogoScope(subject: LogoSubject): string {
  const domain = companyLogoDomain(subject);
  if (domain) return `website:${domain}`;
  const boards = [...new Set([subject.canonicalUrl, subject.url].map(companyLogoBoardUrl).filter(Boolean))].sort();
  return JSON.stringify(boards);
}

/** Websites declared for this employer, rather than a guessed top-level domain. */
export function postingCompanyWebsites(html: string, pageUrl: string, company: string): string[] {
  const key = employerAliasKey(company);
  if (!key) return [];
  const websites = new Set<string>();
  const add = (value: unknown) => {
    const url = external(value, pageUrl);
    if (!url) return;
    const parsed = new URL(url);
    if (/(?:^|\.)(?:linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|greenhouse\.io|ashbyhq\.com|lever\.co|myworkdayjobs\.com|myworkdaysite\.com|oraclecloud\.com|himalayas\.app|smartrecruiters\.com|workable\.com|rippling\.com|recruitee\.com|breezy\.hr|teamtailor\.com|pinpointhq\.com|bamboohr\.com|icims\.com|dayforcehcm\.com|adp\.com|paycomonline\.net|successfactors\.com|successfactors\.eu|taleo\.net|ultipro\.com|applytojob\.com|careers-page\.com|indeed\.com|ziprecruiter\.com|glassdoor\.com)$/.test(parsed.hostname)) return;
    websites.add(`${parsed.origin}/`);
  };
  for (const row of structuredRows(html)) {
    if (![row['@type']].flat().includes('JobPosting')) continue;
    const org = record(row.hiringOrganization);
    if (typeof org.name !== 'string' || employerAliasKey(org.name) !== key) continue;
    for (const value of [org.sameAs, org.url].flat()) add(value);
  }
  // A link published in the posting can corroborate the literal domain brand,
  // including .ai/.io/.org; no list of invented TLDs is needed.
  const $ = load(html);
  for (const link of $('a[href]').toArray()) {
    const url = external($(link).attr('href'), pageUrl);
    if (url && postingDomain(url, key)) add(url);
  }
  return [...websites];
}

/** Read actual corporate images after identity has been established. */
export function corporateLogoSources(html: string, requestedUrl: string, respondedUrl: string,
  company: string, verifiedWebsite = false): string[] {
  const requested = new URL(requestedUrl);
  const responded = new URL(respondedUrl);
  const host = (url: URL) => url.hostname.replace(/^www\./, '');
  if (host(requested) !== host(responded)) return [];
  if (!verifiedWebsite && !corporateWebsiteLogo(html, requestedUrl, respondedUrl, company)) return [];
  const $ = load(html);
  if (/just a moment|access denied|domain (?:is )?for sale|buy this domain|parked domain|security check/i.test($('title').text())) return [];
  const logos = new Set<string>();
  const add = (value: unknown) => { const url = external(value, respondedUrl); if (url) logos.add(url); };
  for (const row of structuredRows(html)) {
    if (![row['@type']].flat().some(type => ['Organization', 'Corporation', 'LocalBusiness'].includes(String(type)))) continue;
    const declared = external(row.url, respondedUrl);
    if (!declared || host(new URL(declared)) !== host(responded)) continue;
    if (typeof row.name !== 'string' || employerAliasKey(row.name) !== employerAliasKey(company)) continue;
    const logo = record(row.logo);
    add(typeof row.logo === 'string' ? row.logo : logo.contentUrl || logo.url);
  }
  for (const icon of $('link[rel~="icon"], link[rel="apple-touch-icon"]').toArray()) add($(icon).attr('href'));
  add(new URL('/favicon.ico', responded).href);
  add(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host(responded))}&sz=128`);
  return [...logos];
}

function sameEvidencePage(requested: string, responded: string): boolean {
  if (requested === responded) return true;
  const board = companyLogoBoardUrl(requested);
  if (board) return board === companyLogoBoardUrl(responded);
  const left = new URL(requested), right = new URL(responded);
  return left.origin === right.origin && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '');
}

/** Lazy candidates let a broken image fall through to independent evidence. */
export async function* companyLogoSources(subject: LogoSubject, fetchPage: FetchPage): AsyncGenerator<string> {
  const company = subject.company || '';
  if (!employerAliasKey(company)) return;
  const known = companyLogoUrl(subject);
  if (known) yield known;
  const reviewed = reviewedCompanyWebsite(company);
  const domain = companyLogoDomain(subject);
  const websites = new Set<string>(reviewed ? [reviewed] : domain ? [`https://${domain}/`] : []);
  const published = new Set(websites);
  const visitedWebsites = new Set<string>();
  async function* websiteSources(website: string): AsyncGenerator<string> {
    if (visitedWebsites.has(website)) return;
    visitedWebsites.add(website);
    // A published corporate domain remains useful when its page blocks a reader.
    if (published.has(website)) yield `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(website).hostname.replace(/^www\./, ''))}&sz=128`;
    try {
      const response = await fetchPage(website);
      if (response.ok) yield* corporateLogoSources(await response.text(), website, response.url || website, company, published.has(website));
    } catch { /* A source outage leaves the remaining candidates available. */ }
  }
  // A failed favicon for a known company should try that company's native
  // images before spending its time budget on potentially blocked ATS pages.
  if (known) for (const website of websites) yield* websiteSources(website);
  const pages = [...new Set([subject.canonicalUrl, subject.url, ...[subject.canonicalUrl, subject.url].map(companyLogoBoardUrl)])];
  for (const value of pages) {
    if (!value) continue;
    try {
      const url = assertSafeExternalNavigationUrl(value).href;
      const response = await fetchPage(url);
      if (!response.ok || !sameEvidencePage(url, response.url || url)) continue;
      const html = await response.text(), finalUrl = response.url || url;
      const logo = postingLogo(html, finalUrl, company);
      if (logo) yield logo;
      for (const website of postingCompanyWebsites(html, finalUrl, company)) {
        websites.add(website); published.add(website);
      }
      // Most successful pages need no second recruiting-page request.
      if (websites.size) break;
    } catch { /* Expired or blocked pages do not prevent independent fallback. */ }
  }
  const guessed = companyWebsiteCandidate(company);
  if (guessed) websites.add(guessed);
  for (const website of websites) yield* websiteSources(website);
}
