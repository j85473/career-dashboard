import * as cheerio from 'cheerio';
import type { AtsScrapeResult } from './atsApi';
import { cleanHtmlText } from './jobIngestion';
import { publishedEmployerName } from './publicAtsEmployer';
import { postingMetadataValue, postingUrlsMatch, type PostingMetadata } from './postingMetadata';
import { safeExternalFetch } from './safeExternalFetch';

export function bambooHrPostingIdentity(value: string): { host: string; id: string; url: string } | null {
  try {
    const url = new URL(value);
    const path = /^\/careers\/(\d+)\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/^[a-z0-9][a-z0-9-]*\.bamboohr\.com$/.test(url.hostname) || !path) return null;
    return { host: url.hostname, id: path[1], url: `${url.origin}/careers/${path[1]}` };
  } catch { return null; }
}

/** The browser title is the vendor. The sharing metadata names the exact job. */
export function bambooHrPageMetadata(html: string, value: string): PostingMetadata {
  const identity = bambooHrPostingIdentity(value);
  if (!identity) return {};
  const $ = cheerio.load(html);
  const values = (property: string) => [...new Set($(`meta[property="${property}"]`).toArray()
    .map(node => postingMetadataValue($(node).attr('content'))).filter((v): v is string => Boolean(v)))];
  const urls = values('og:url');
  const titles = values('og:title');
  const companies = values('og:site_name');
  const published = urls.length === 1 ? bambooHrPostingIdentity(urls[0]) : null;
  if (published?.url !== identity.url || titles.length !== 1 || /^BambooHR$/i.test(titles[0])) return {};
  return { title: titles[0], company: companies.length === 1 ? publishedEmployerName(companies[0]) || undefined : undefined };
}

/** Bind the public JSON to the requested tenant and vacancy before extracting. */
export function parseBambooHrPosting(body: unknown, value: string, html = ''): AtsScrapeResult | null {
  const identity = bambooHrPostingIdentity(value);
  const job = (body as { result?: { jobOpening?: Record<string, unknown> } } | null)?.result?.jobOpening;
  if (!identity || !job || typeof job.jobOpeningShareUrl !== 'string'
    || bambooHrPostingIdentity(job.jobOpeningShareUrl)?.url !== identity.url
    || typeof job.jobOpeningStatus !== 'string' || job.jobOpeningStatus.toLowerCase() !== 'open'
    || typeof job.description !== 'string') return null;
  const title = postingMetadataValue(job.jobOpeningName);
  if (!title || /^BambooHR$/i.test(title)) return null;
  const metadata = bambooHrPageMetadata(html, value);
  // Hiring geography is distinct from payroll/employment-provider labels and
  // the application form's country selector. Never read either as a location.
  const address = (job.atsLocation || job.location) as Record<string, unknown> | undefined;
  const places = address ? [address.city, address.state || address.province, address.country || address.addressCountry]
    .map(postingMetadataValue).filter(Boolean) : [];
  const location = [...new Set(places)].join(', ');
  // BambooHR's public careers data uses 0=on-site, 1=remote, 2=hybrid.
  const arrangement = String(job.locationType) === '1' ? 'Remote' : String(job.locationType) === '2' ? 'Hybrid' : '';
  return { ats: 'BambooHR', title, company: metadata.title === title ? metadata.company : undefined,
    text: cleanHtmlText(job.description),
    location: location ? `${location}${arrangement ? ` (${arrangement})` : ''}` : arrangement || undefined };
}

export async function fetchBambooHrPosting(value: string, read: typeof safeExternalFetch = safeExternalFetch): Promise<AtsScrapeResult | null> {
  const identity = bambooHrPostingIdentity(value);
  if (!identity) return null;
  const detailUrl = `${identity.url}/detail`;
  const fetchPage = (url: string, accept: string) => read(url, { headers: { Accept: accept, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  const [detail, page] = await Promise.all([
    fetchPage(detailUrl, 'application/json'),
    fetchPage(identity.url, 'text/html').catch(() => null),
  ]);
  if (!detail.ok || !postingUrlsMatch(detail.url || detailUrl, detailUrl)) return null;
  const html = page?.ok && postingUrlsMatch(page.url || identity.url, identity.url) ? await page.text() : '';
  return parseBambooHrPosting(await detail.json(), identity.url, html);
}
