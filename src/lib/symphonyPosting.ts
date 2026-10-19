import { load } from 'cheerio';
import { cleanHtmlText } from './jobIngestion';
import { assessJobDescriptionQuality } from './jobDescriptionQuality';
import { safeExternalFetch } from './safeExternalFetch';
import { symphonyPostingIdentity, symphonyPostingRequest, parseSymphonyListing } from './symphonyAtsBoard';
import type { AtsScrapeResult } from './atsApi';

/** Deltek's page JSON-LD contains only Company Summary; use the exact API job. */
export function parseSymphonyPosting(payload: unknown, requestedUrl: string): AtsScrapeResult | null {
  const identity = symphonyPostingIdentity(requestedUrl);
  if (!identity) return null;
  try {
    const job = parseSymphonyListing(identity.slug, { totalHits: 1, nextPageToken: null, searchResults: [{ job: payload }] }).jobs[0];
    if (job.publicAtsPostingId !== identity.id) return null;
    const $ = load(String(job.description));
    $('script, style, template, [hidden], [aria-hidden="true"]').remove();
    $('[style]').filter((_index, element) => /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test($(element).attr('style') || '')).remove();
    // A company overview is structured data too, but cannot replace the role.
    const duties = cleanHtmlText($('[data-field="responsibilities"]').html() || '');
    const qualifications = cleanHtmlText($('[data-field="qualifications"]').html() || '');
    if (!duties || !qualifications || !assessJobDescriptionQuality(`${duties}\n\n${qualifications}`, { structuredSource: true }).scorable) return null;
    const headings: Record<string, string> = { responsibilities: 'Responsibilities', description: 'Company Summary', businessSummary: 'Business Summary',
      qualifications: 'Qualifications', compensation: 'Compensation', travel: 'Travel Requirements', compliance: 'Compliance Requirements',
      EEO: 'EEO Statement', 'E-Verify': 'E-Verify Statement', Privacy: 'Applicant Privacy Notice' };
    $('[data-field]').each((_index, element) => {
      const heading = headings[$(element).attr('data-field') || ''];
      if (heading && cleanHtmlText($(element).html() || '')) $(element).prepend(`<h2>${heading}</h2>`);
    });
    const text = cleanHtmlText($.html());
    return { text, title: String(job.title), company: String(job.company), location: String(job.location),
      ats: 'Symphony Talent', platform: 'symphony', atsSlug: identity.slug };
  } catch { return null; }
}

export async function fetchSymphonyPosting(url: string, read: typeof safeExternalFetch = safeExternalFetch): Promise<AtsScrapeResult | null> {
  const api = symphonyPostingRequest(url);
  if (!api) return null;
  const response = await read(api, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) return null;
  return parseSymphonyPosting(await response.json(), url);
}
