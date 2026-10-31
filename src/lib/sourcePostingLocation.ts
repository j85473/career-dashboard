import { load } from 'cheerio';
import { jsonLdPageMetadata, type JsonLdJobPosting } from './atsApi';
import { sameEmployer } from './employerIdentity';
import { isTerminalJobPostingPage } from './jobDescriptionQuality';
import { readRenderedPosting } from './jobPostingVerification';
import { parsePostingReaderMetadata, postingMetadataValue, postingUrlsMatch } from './postingMetadata';
import { US_STATE_LOCATION_PATTERN } from './postingLocation';
import { assertSafeExternalNavigationUrl, safeExternalFetch } from './safeExternalFetch';
import { urlMatchesAnyHost } from './urlHost';

type Posting = { title: string; company: string; url: string; location?: string | null };
export type SourceLocationRecovery = { location: string; url: string; method: 'json_ld' | 'rendered_location' };
const titleKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function isMissingPostingLocation(value: string | null | undefined): boolean {
  return !value?.trim() || /^(?:unknown(?: location)?|not specified|not available|n\/a|-)$/i.test(value.trim());
}

/** All posting objects count, including recommendations; an unlabeled URL is not enough to select one. */
function jobPostings(html: string): JsonLdJobPosting[] {
  const $ = load(html);
  const postings: JsonLdJobPosting[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    const types = Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
    if (types.includes('JobPosting')) postings.push(object as JsonLdJobPosting);
    if (Array.isArray(object['@graph'])) object['@graph'].forEach(visit);
  };
  $('script[type="application/ld+json"]').each((_, script) => {
    try { visit(JSON.parse($(script).text())); } catch { /* A malformed block supplies no location evidence. */ }
  });
  return postings;
}

/** Require the requested role and posting identity, never a title/URL city guess. */
export function sourceHtmlLocation(html: string, posting: Posting): string | null {
  if (isTerminalJobPostingPage(html)) return null;
  const $ = load(html);
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical && !postingUrlsMatch(canonical, posting.url)) return null;
  const heading = $('h1').first().text().trim();
  if (heading && titleKey(heading) !== titleKey(posting.title)) return null;
  const postings = jobPostings(html);
  const matching = postings.filter(candidate => {
    if (typeof candidate.title !== 'string' || titleKey(candidate.title) !== titleKey(posting.title)) return false;
    if (candidate.url != null) return typeof candidate.url === 'string' && postingUrlsMatch(candidate.url, posting.url);
    return postings.length === 1 && titleKey(heading) === titleKey(posting.title);
  });
  if (matching.length !== 1) return null;
  const metadata = jsonLdPageMetadata(matching[0], html);
  if (metadata.company && !sameEmployer(metadata, posting)) return null;
  return postingMetadataValue(metadata.location) || null;
}

/** The reader must identify the same URL and role; inspect only the posting header. */
export function sourceReaderLocation(markdown: string, posting: Posting): string | null {
  const source = /^URL Source:\s*(\S+)/m.exec(markdown)?.[1];
  if (!source || !postingUrlsMatch(source, posting.url)) return null;
  const content = /^Markdown Content:[ \t]*\r?\n([\s\S]+)$/m.exec(markdown)?.[1];
  if (!content || isTerminalJobPostingPage(content)) return null;
  const lines = content.split(/\r?\n/);
  const heading = lines.findIndex(line => /^#\s+/.test(line));
  if (heading < 0 || titleKey(lines[heading].replace(/^#\s+/, '')) !== titleKey(posting.title)) return null;
  const header: string[] = [];
  for (const line of lines.slice(heading + 1, heading + 60)) {
    if (/^#{1,6}\s+(?:description|job description|responsibilities|qualifications|about (?:the )?role|similar jobs|related jobs)\b/i.test(line)) break;
    if (/^#\s+/.test(line)) break;
    header.push(line);
  }
  const wrappedHeader = `URL Source: ${posting.url}\nMarkdown Content:\n${header.join('\n')}`;
  const metadata = parsePostingReaderMetadata(wrappedHeader, posting.url);
  if (metadata.company && !sameEmployer(metadata, posting)) return null;
  const publisherLayout = urlMatchesAnyHost(posting.url, ['monster.com', 'careerbuilder.com']);
  const employer = header.find(line => /^##\s+/.test(line))?.replace(/^##\s+/, '').trim();
  if (publisherLayout && (!employer || !sameEmployer({ company: employer }, posting))) return null;
  if (metadata.location) return metadata.location;

  // Monster and CareerBuilder publish a labeled facts table and a compact
  // employer/location header. Scope this layout to these publishers only.
  if (!publisherLayout) return null;
  const explicit = header.flatMap(line => {
    const tableValue = /^\s*\|?\s*Location\s*\|\s*([^|]+)\|?\s*$/i.exec(line)?.[1];
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1];
    const cityState = new RegExp(`^[^,:;|]{1,80},\\s*${US_STATE_LOCATION_PATTERN}(?:\\s*\\((?:Remote|Hybrid)\\))?$`, 'i');
    const value = tableValue?.trim() || (bullet && cityState.test(bullet) ? bullet : '');
    return postingMetadataValue(value) && cityState.test(value) ? [value] : [];
  });
  // A table may add the workplace arrangement to the same header city.
  const places = new Set(explicit.map(value => value.replace(/\s*\((?:Remote|Hybrid)\)$/i, '').toLowerCase()));
  if (places.size !== 1) return null;
  const arrangements = new Set([...header.flatMap(line => {
    const value = /^\s*[-*]\s+(Remote|Hybrid)\s*$/i.exec(line)?.[1];
    return value ? [value.toLowerCase()] : [];
  }), ...explicit.flatMap(value => {
    const arrangement = /\((Remote|Hybrid)\)$/i.exec(value)?.[1];
    return arrangement ? [arrangement.toLowerCase()] : [];
  })]);
  if (arrangements.size > 1) return null;
  const location = explicit.at(-1)!;
  const arrangement = [...arrangements][0];
  return arrangement && !/\((?:Remote|Hybrid)\)$/i.test(location)
    ? `${location} (${arrangement === 'remote' ? 'Remote' : 'Hybrid'})` : location;
}

/** New JSearch arrivals only; existing locations (including Remote) cause no requests. */
export async function recoverMissingSourceLocation(
  posting: Posting & { source: string },
  dependencies: { fetchPosting?: typeof safeExternalFetch; readPosting?: typeof readRenderedPosting; signal?: AbortSignal } = {},
): Promise<SourceLocationRecovery | null> {
  if (posting.source !== 'JSearch' || !isMissingPostingLocation(posting.location) || !posting.url) return null;
  try { assertSafeExternalNavigationUrl(posting.url); } catch { return null; }
  const signal = dependencies.signal;
  if (signal?.aborted) return null;
  try {
    const response = await (dependencies.fetchPosting || safeExternalFetch)(posting.url, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    // Redirects to a catalogue or another opening must never supply geography.
    if (response.url && !postingUrlsMatch(response.url, posting.url)) return null;
    if (response.status === 404 || response.status === 410) return null;
    if (response.ok) {
      const location = sourceHtmlLocation(await response.text(), posting);
      if (location) return { location, url: posting.url, method: 'json_ld' };
    }
  } catch { /* Access failure leaves the rendered fallback available. */ }
  if (signal?.aborted) return null;
  try {
    const response = await (dependencies.readPosting || readRenderedPosting)(posting.url);
    if (!response.ok || signal?.aborted) return null;
    const location = sourceReaderLocation(await response.text(), posting);
    return location ? { location, url: posting.url, method: 'rendered_location' } : null;
  } catch { return null; }
}
