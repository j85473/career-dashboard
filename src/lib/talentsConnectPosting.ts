import * as cheerio from 'cheerio';
import type { AtsScrapeResult } from './atsApi';
import { extractJsonLdJobPosting } from './atsApi';
import { cleanHtmlText } from './jobIngestion';
import { postingMetadataValue, postingUrlsMatch } from './postingMetadata';
import { safeExternalFetch } from './safeExternalFetch';

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const nameKey = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** A branded talentsconnect offer has a UUID-bound header and application link. */
export function talentsConnectPage(html: string, value: string) {
  try {
    const url = new URL(value);
    const path = new RegExp(`^/[a-z]{2}/offer/[^/]+/(${UUID})/?$`, 'i').exec(url.pathname);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !path) return null;
    // Only known presentation/tracking parameters may be omitted when binding
    // JSON-LD. Other selectors must retain the ordinary exact-URL check.
    for (const parameter of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(parameter) || ['trid', 'showApplicationForm'].includes(parameter)) url.searchParams.delete(parameter);
    }
    const $ = cheerio.load(html);
    const headers = $('.contentItemHeaderOffer[data-offer-id]').filter((_, node) =>
      $(node).attr('data-offer-id')?.toLowerCase() === path[1].toLowerCase());
    if (headers.length !== 1) return null;
    const posting = extractJsonLdJobPosting(html, url.href);
    const identifier = (posting as { identifier?: { value?: unknown } } | null)?.identifier?.value;
    const title = postingMetadataValue(posting?.title);
    const company = typeof posting?.hiringOrganization === 'object' ? postingMetadataValue(posting.hiringOrganization.name) : undefined;
    if (identifier !== path[1] || !title || !company || typeof posting?.description !== 'string'
      || nameKey(headers.find('h1').text()) !== nameKey(title)) return null;
    const container = headers.closest('.mainItemAjax');
    const links = new Map<string, { company: string; id: string }>();
    for (const node of container.find('.c-buttonbox a[href], .c-buttonbox-sticky a[href], .c-buttonbox-sticky--mobile a[href]').toArray()) {
      const target = new URL($(node).attr('href')!, value);
      const application = /^\/([a-z0-9_-]+)\/(\d+)(?:-[^/]*)?\/?$/i.exec(target.pathname);
      if (target.protocol === 'https:' && !target.username && !target.password && !target.port
        && target.hostname === 'jobs.smartrecruiters.com' && application) {
        links.set(`${application[1].toLowerCase()}:${application[2]}`, { company: application[1], id: application[2] });
      }
    }
    if (links.size !== 1) return null;
    const places = Array.isArray(posting.jobLocation) ? posting.jobLocation : posting.jobLocation ? [posting.jobLocation] : [];
    const cities = places.map(place => postingMetadataValue(place.address?.addressLocality)).filter((s): s is string => Boolean(s));
    return { title, company, cities, application: [...links.values()][0],
      text: cleanHtmlText(posting.description.replace(/\\n/g, '\n')) };
  } catch { return null; }
}

/** The source page's country can be a template default. Use the exact linked
 * ATS record, corroborated by role and city, instead of guessing geography. */
export async function fetchTalentsConnectPosting(html: string, value: string, read: typeof safeExternalFetch = safeExternalFetch): Promise<AtsScrapeResult | null> {
  const page = talentsConnectPage(html, value);
  if (!page) return null;
  const endpoint = `https://api.smartrecruiters.com/v1/companies/${page.application.company}/postings/${page.application.id}`;
  const response = await read(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok || !postingUrlsMatch(response.url || endpoint, endpoint)) return null;
  const job = await response.json();
  if (String(job.id) !== page.application.id || typeof job.name !== 'string' || nameKey(job.name) !== nameKey(page.title)
    || typeof job.company?.identifier !== 'string' || nameKey(job.company.identifier) !== nameKey(page.application.company)
    || !page.cities.length || typeof job.location?.city !== 'string' || !page.cities.some(city => nameKey(city) === nameKey(job.location.city))) return null;
  const location = postingMetadataValue(job.location.fullLocation);
  if (!location) return null;
  const sections = job.jobAd?.sections;
  const text = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map(key => sections?.[key]).filter(section => typeof section?.text === 'string')
    .map(section => `${postingMetadataValue(section.title) || ''}\n${cleanHtmlText(section.text)}`).join('\n\n').trim();
  if (!text) return null;
  const arrangement = job.location.hybrid === true ? 'Hybrid' : job.location.remote === true ? 'Remote' : '';
  return { ats: 'SmartRecruiters', title: page.title, company: page.company, text,
    location: `${location}${arrangement && !new RegExp(arrangement, 'i').test(location) ? ` (${arrangement})` : ''}` };
}
