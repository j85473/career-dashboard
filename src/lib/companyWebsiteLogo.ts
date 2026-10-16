import { load } from 'cheerio';
import { companyLogoUrl } from './companyLogo';
import { employerAliasKey } from './employerIdentity';
import { assertSafeExternalNavigationUrl } from './safeExternalFetch';

const host = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '');

/** A possible address is a search candidate, never sufficient logo evidence. */
export function companyWebsiteCandidate(company: string): string | null {
  const key = employerAliasKey(company);
  return key.length >= 4 && key.length <= 80 && !/^(?:unknown|confidential|undisclosed)/.test(key)
    ? `https://${key}.com/` : null;
}

/** Verify the corporate site's published identity before requesting its favicon. */
export function corporateWebsiteLogo(html: string, requestedUrl: string, respondedUrl: string, company: string): string | null {
  const requested = assertSafeExternalNavigationUrl(requestedUrl);
  const responded = assertSafeExternalNavigationUrl(respondedUrl);
  if (host(requested) !== host(responded)) return null;
  const key = employerAliasKey(company);
  if (!key) return null;
  const matches = (value: unknown) => typeof value === 'string' && employerAliasKey(value.replace(/[®™©]/g, '')) === key;
  const $ = load(html);
  // Challenge/error documents can contain the employer's name in their title.
  if (/just a moment|access denied|domain (?:is )?for sale|buy this domain|parked domain|security check/i.test($('title').text())) return null;
  let confirmed = false;
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(script).text());
      const rows = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
      for (const row of rows) {
        if (!row || ![row['@type']].flat().some(type => /^(?:Organization|Corporation|LocalBusiness|OnlineStore)$/.test(type))) continue;
        if (!matches(row.name) && !matches(row.legalName)) continue;
        if (typeof row.url !== 'string' || host(new URL(row.url, responded)) !== host(responded)) continue;
        confirmed = true;
      }
    } catch { /* Malformed declarations do not establish identity. */ }
  }
  const titles = [$('title').text(), $('meta[property="og:site_name"]').attr('content') || ''];
  if (titles.some(title => title.split(/\s+[|—–-]\s+|[|:]/).some(part => matches(part.trim())))) confirmed = true;
  for (const image of $('header a[href] img[alt], a[class*=logo][href] img[alt], a[class*=brand][href] img[alt]').toArray()) {
    if (!matches(($(image).attr('alt') || '').replace(/\s+logo$/i, ''))) continue;
    try {
      const home = new URL($(image).closest('a').attr('href') || '', responded);
      if (host(home) === host(responded) && /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?\/?)?$/i.test(home.pathname)) confirmed = true;
    } catch { /* An invalid home link supplies no evidence. */ }
  }
  return confirmed ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host(responded))}&sz=128` : null;
}

export async function recoverCompanyWebsiteLogo(company: string, fetchPage: (url: string) => Promise<Response>): Promise<string | null> {
  // Reviewed corrections outrank name-derived candidates, including homonyms.
  const reviewed = companyLogoUrl({ company });
  if (reviewed) return reviewed;
  const candidate = companyWebsiteCandidate(company);
  if (!candidate) return null;
  try {
    const response = await fetchPage(candidate);
    if (!response.ok) return null;
    return corporateWebsiteLogo(await response.text(), candidate, response.url || candidate, company);
  } catch { return null; }
}
