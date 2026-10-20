import type { AtsScrapeResult } from './atsApi';
import { leverAshbyPostingUrl } from './coreAtsPostingUrl';
import { cleanHtmlText } from './jobIngestion';
import { postingLocations, postingMetadataValue, postingUrlsMatch } from './postingMetadata';

/** Resolve application aliases through the exact posting API, retaining region. */
export async function fetchLeverAshbyPosting(value: string, read: typeof fetch = fetch): Promise<AtsScrapeResult | null> {
  const identity = leverAshbyPostingUrl(value);
  if (!identity) return null;
  const response = await read(identity.apiUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok || !postingUrlsMatch(response.url || identity.apiUrl, identity.apiUrl)) return null;
  const body = await response.json();
  const samePosting = (url: unknown) => {
    if (url === undefined) return true;
    if (typeof url !== 'string') return false;
    const other = leverAshbyPostingUrl(url);
    return other?.apiUrl === identity.apiUrl && other?.id === identity.id;
  };
  if (identity.provider === 'Lever') {
    if (!body || body.id !== identity.id || !postingMetadataValue(body.text)
      || !samePosting(body.hostedUrl) || !samePosting(body.applyUrl)) return null;
    const parts = [body.descriptionPlain || body.description];
    if (Array.isArray(body.lists)) for (const list of body.lists) parts.push(list?.text, list?.content);
    parts.push(body.additionalPlain || body.additional, body.salaryDescriptionPlain || body.salaryDescription);
    return { text: cleanHtmlText(parts.filter((part): part is string => typeof part === 'string').join('\n\n')),
      ats: 'Lever', atsSlug: identity.board, platform: 'lever', title: postingMetadataValue(body.text),
      location: postingLocations(body.categories?.location, body.categories?.allLocations, body.workplaceType) };
  }
  if (!Array.isArray(body?.jobs)) return null;
  const matches = body.jobs.filter((job: { id?: unknown } | null) => job?.id === identity.id);
  if (matches.length !== 1) return null;
  const job = matches[0];
  if (!postingMetadataValue(job.title) || !samePosting(job.jobUrl) || !samePosting(job.applyUrl)) return null;
  return { text: cleanHtmlText(job.descriptionHtml || job.descriptionPlain || ''),
    ats: 'Ashby', atsSlug: identity.board, platform: 'ashby', title: postingMetadataValue(job.title),
    location: postingLocations(job.location,
      job.secondaryLocations?.map((place: { location?: string }) => place.location),
      job.workplaceType || (job.isRemote ? 'Remote' : undefined)) };
}
