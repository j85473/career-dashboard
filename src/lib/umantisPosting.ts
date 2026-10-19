import * as cheerio from 'cheerio';
import type { AtsScrapeResult } from './atsApi';
import { safeExternalFetch } from './safeExternalFetch';
import { assessJobDescriptionQuality } from './jobDescriptionQuality';
import { US_STATE_LOCATION_PATTERN } from './postingLocation';

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const normalized = (value: string) => clean(value).toLowerCase();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class UmantisPostingUnavailableError extends Error {
  constructor() {
    super('Umantis did not return a verified vacancy description. No job was imported. Please use the vacancy description link or paste the full job description.');
    this.name = 'UmantisPostingUnavailableError';
  }
}

export function isUmantisPostingHost(host: string): boolean {
  return /^recruitingapp-\d+\.umantis\.com$/i.test(host);
}

export function umantisPostingIdentity(value: string): { id: string; language: string; descriptionUrl: string; applicationUrl: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !isUmantisPostingHost(url.hostname)
      || url.searchParams.has('ShowDocument')) return null;
    const path = /^\/Vacancies\/(\d+)\/(?:Description\/(\d+)|Application\/(?:New|CheckLogin|Login)\/(\d+))\/?$/i.exec(url.pathname);
    if (!path) return null;
    const id = path[1], language = path[2] || path[3];
    return { id, language, descriptionUrl: `${url.origin}/Vacancies/${id}/Description/${language}`,
      applicationUrl: `${url.origin}/Vacancies/${id}/Application/New/${language}` };
  } catch { return null; }
}

/** A public application link binds the detail template to the selected vacancy. */
export function parseUmantisPostingHtml(html: string, value: string): AtsScrapeResult | null {
  const identity = umantisPostingIdentity(value);
  if (!identity || !/\/Description\//i.test(new URL(value).pathname)) return null;
  const $ = cheerio.load(html);
  const pageTitle = clean($('head title').text());
  $('script,style,noscript,nav,footer,form,[hidden],[aria-hidden="true"]').remove();
  const headings = $('.content h1').toArray().map(node => clean($(node).text())).filter(Boolean);
  if (headings.length !== 1 || normalized(headings[0]) !== normalized(pageTitle)) return null;
  const title = headings[0];
  if (title.length > 200) return null;
  const content = $('.content').filter((_, node) => $(node).find('h1').length > 0).first().clone();
  const hasApplyLink = content.find('a[href]').toArray().some(node => {
    try {
      const target = new URL($(node).attr('href')!, value);
      return /\/Application\//i.test(target.pathname) && umantisPostingIdentity(target.href)?.descriptionUrl === identity.descriptionUrl;
    } catch { return false; }
  });
  if (!hasApplyLink || !content.find('h2,h3').toArray().some(node => /^Job Description\s*:?$/i.test(clean($(node).text())))) return null;
  content.find('.apply,.apply1,.back,.social,button').remove();
  content.find('a').each((_, node) => { $(node).replaceWith($(node).contents()); });
  content.find('br,p,div,li,h1,h2,h3,h4').append('\n');
  const text = content.text().replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  if (!assessJobDescriptionQuality(text, { structuredSource: true }).scorable) return null;

  // Residency is a work-base requirement. A sales territory is not a set of
  // alternative offices and must not be substituted for this authored rule.
  const role = escapeRegex(title.split(/\s+-\s+/)[0]);
  const residency = new RegExp(`(?:^|[.!?]\\s+|\\n)\\s*(?:The (?:${role}|(?:successful )?candidate)|You) must (?:live|reside|be based) (?:within|in) ([^,\\n.!?]{1,80},\\s*${US_STATE_LOCATION_PATTERN})(?:\\s+area)?\\.(?:\\s|$)`, 'gi');
  const requiredBases = [...new Set([...text.matchAll(residency)].map(match => clean(match[1])))];
  const location = requiredBases.length ? `${requiredBases.join('; ')} (residency required)` : undefined;
  return { ats: 'Umantis', title, location, text };
}

/** The employer is explicit in the form's browser title, not in the tenant ID. */
export function parseUmantisApplicationEmployer(html: string, value: string, expectedTitle: string): string | undefined {
  const identity = umantisPostingIdentity(value);
  if (!identity || !/\/Application\//i.test(new URL(value).pathname)) return undefined;
  const $ = cheerio.load(html);
  const expected = `${expectedTitle} - Application`;
  if (normalized($('h1').first().text()) !== normalized(expected)) return undefined;
  const pageTitle = clean($('head title').text());
  const match = new RegExp(`^${escapeRegex(expected)}\\s*\\|\\s*(.{2,160}?)\\s+eRecruiting$`, 'i').exec(pageTitle);
  const sameForm = $('form[action]').toArray().some(node => {
    try { return umantisPostingIdentity(new URL($(node).attr('action')!, value).href)?.descriptionUrl === identity.descriptionUrl; }
    catch { return false; }
  });
  const company = match ? clean(match[1]) : '';
  return sameForm && company && !/^(?:unknown(?: company)?|company|umantis|abacus|eRecruiting)$/i.test(company) ? company : undefined;
}

export async function fetchUmantisPosting(value: string, fetcher: typeof safeExternalFetch = safeExternalFetch): Promise<AtsScrapeResult | null> {
  const identity = umantisPostingIdentity(value);
  if (!identity) return null;
  const read = async (url: string) => {
    const response = await fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    const finalUrl = response.url || url;
    if (!response.ok || umantisPostingIdentity(finalUrl)?.descriptionUrl !== identity.descriptionUrl
      || /\/Description\//i.test(new URL(finalUrl).pathname) !== /\/Description\//i.test(new URL(url).pathname)) return null;
    return { html: await response.text(), url: finalUrl };
  };
  const page = await read(identity.descriptionUrl);
  const posting = page && parseUmantisPostingHtml(page.html, page.url);
  if (!posting) return null;
  try {
    const application = await read(identity.applicationUrl);
    if (application) posting.company = parseUmantisApplicationEmployer(application.html, application.url, posting.title!);
  } catch { /* Keep verified vacancy details when the optional branding read fails. */ }
  return posting;
}
