import { hasIncompleteLocations, INCOMPLETE_LOCATION, US_STATE_LOCATION_PATTERN } from './postingLocation';
import type { AtsScrapeResult } from '@/lib/atsApi';
import { assessJobDescriptionQuality } from '@/lib/jobDescriptionQuality';
import { reviewedTalemetryEmployer } from './talemetryEmployer';

export type PostingMetadata = Pick<AtsScrapeResult, 'title' | 'company' | 'location'>;

export function postingMetadataValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && !/^(?:all|unknown(?: company| location)?|n\/a|not specified|not available)$/i.test(text) ? text : undefined;
}

export function postingLocations(primary: unknown, additional: unknown, workplace?: unknown): string | undefined {
  const values = [primary, ...(Array.isArray(additional) ? additional : [])]
    .map(postingMetadataValue).filter((value): value is string => Boolean(value));
  const location = [...new Set(values)].join('; ');
  if (!location) return undefined;
  const arrangement = postingMetadataValue(workplace);
  return arrangement && /^(remote|hybrid)$/i.test(arrangement) && !location.toLowerCase().includes(arrangement.toLowerCase())
    ? `${location} (${arrangement[0].toUpperCase() + arrangement.slice(1).toLowerCase()})`
    : location;
}

/** A complete description is not proof that an adapter also returned metadata. */
export async function completePostingMetadata(
  primary: AtsScrapeResult | null,
  readMetadata: () => Promise<PostingMetadata | null>,
): Promise<AtsScrapeResult | null> {
  if (postingMetadataValue(primary?.company) && postingMetadataValue(primary?.location)) return primary;
  const fallback = await readMetadata().catch(() => null);
  if (!fallback) return primary;
  return {
    text: '',
    ats: 'Unknown',
    ...primary,
    title: postingMetadataValue(primary?.title) || fallback.title,
    company: postingMetadataValue(primary?.company) || fallback.company,
    location: postingMetadataValue(primary?.location) || fallback.location,
  };
}

function postingUrlKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['ref', 'source', 'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'gh_src', 'lever-source', 'lever-origin'].includes(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/$/, '');
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

export function postingUrlsMatch(left: string, right: string): boolean {
  try {
    const key = postingUrlKey(new URL(left, right).toString());
    return Boolean(key) && key === postingUrlKey(right);
  } catch {
    return false;
  }
}

export function postingRefreshDescription(input: {
  description: string;
  structuredSource: boolean;
  existingDescription: string | null;
  preserveScores: boolean;
  metadata: PostingMetadata;
}): { description: string; verified: boolean } {
  const verified = assessJobDescriptionQuality(input.description, { structuredSource: input.structuredSource }).scorable;
  if (input.preserveScores && !verified) {
    if (!input.metadata.title && !input.metadata.company && !input.metadata.location) {
      throw new Error('The posting did not provide verifiable job details');
    }
    return { description: input.existingDescription || '', verified: false };
  }
  if (!verified) throw new Error('The posting did not provide a verifiable job description');
  return { description: input.description, verified };
}

function readerLine(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/^\s*(?:#{1,6}\s+|[-•]\s+)/, '').trim();
}

/** DEJobs publishes the employing entity in a labeled requisition footer. */
export function postingFooterCompany(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const companies = new Set<string>();
  for (let index = 0; index < lines.length - 1; index += 1) {
    const company = /^\*\*Company:\*\*\s*(.{1,160})$/.exec(lines[index])?.[1];
    if (company && /^\*\*Req ID:\*\*\s*\S/.test(lines[index + 1])
      && lines.slice(Math.max(0, index - 8), index).some(line => /^\*\*Job Category:\*\*/.test(line))) {
      const value = postingMetadataValue(company);
      if (value) companies.add(value);
    }
  }
  return companies.size === 1 ? [...companies][0] : undefined;
}

/** Read explicit posting labels, never employer mentions in the duties or site navigation. */
export function parsePostingReaderMetadata(markdown: string, url: string): PostingMetadata {
  const sourceUrl = /^URL Source:\s*(\S+)/m.exec(markdown)?.[1];
  if (!sourceUrl || !postingUrlsMatch(sourceUrl, url)) return {};
  const content = /^Markdown Content:\s*\n([\s\S]+)$/m.exec(markdown)?.[1];
  if (!content) return {};
  const rawLines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const lines = rawLines.map(readerLine);
  const metadata: PostingMetadata = {};
  for (let index = 0; index < Math.min(lines.length, 100); index += 1) {
    const line = lines[index];
    // Faceted navigation lists companies and locations, but none identifies
    // the selected job. Resume only at the posting's main heading.
    if (/^(?:filters?|apply filters(?: delete all filters)?|delete all filters)$/i.test(line)) {
      while (index + 1 < lines.length && !/^#\s+\S/.test(rawLines[index + 1])) index += 1;
      continue;
    }
    if (/^(?:job description|description|responsibilities|qualifications|about (?:the )?role|what you(?:'|’)ll do)$/i.test(line)) break;
    const match = /^(company|employer|hiring organization|job title|job location|work location|locations?)(?:\s*:\s*(.*))?$/i.exec(line);
    if (!match) continue;
    const value = postingMetadataValue(match[2] || lines[index + 1]);
    if (!value || value.length > 200 || /^https?:\/\//i.test(value)
      || /^(?:company|employer|hiring organization|job title|job location|work location|locations?)(?:\s*:|$)/i.test(value)
      || /^(?:job description|description|responsibilities|qualifications)$/i.test(value)) continue;
    if (/^(?:company|employer|hiring organization)$/i.test(match[1])) metadata.company ||= value;
    else if (/^job title$/i.test(match[1])) metadata.title ||= value;
    else {
      const locations = [value];
      if (!match[2]) for (let next = index + 2; next < Math.min(lines.length, index + 22); next += 1) {
        const option = postingMetadataValue(lines[next]);
        const region = `(?:${US_STATE_LOCATION_PATTERN}|United States(?: of America)?|Canada|United Kingdom|Germany|France|India|Australia)`;
        const locationLine = new RegExp(`^(?:[^:;]+,\\s*${region}(?:,\\s*(?:US|USA|United States))?(?:\\s*\\((?:Remote|Hybrid)\\))?|Remote(?:\\s*[-,]\\s*(?:US|USA|United States))?|United States(?: of America)?|Canada|Minnesota|MN)$`, 'i');
        if (!option || option.length > 120 || !locationLine.test(option)) break;
        locations.push(option);
      }
      metadata.location = postingLocations(metadata.location, locations);
    }
  }
  // A role heading followed immediately by a city/state is authored metadata
  // when it agrees with the reader's page title. Do not infer from prose.
  const headingIndex = rawLines.findIndex(line => /^#\s+\S/.test(line));
  const heading = headingIndex >= 0 ? readerLine(rawLines[headingIndex]) : undefined;
  const pageTitle = /^Title:\s*(.+)$/m.exec(markdown)?.[1]?.trim();
  const headingLocation = headingIndex >= 0 ? readerLine(rawLines[headingIndex + 1] || '') : '';
  const beforeBody = headingIndex >= 0 && !rawLines.slice(0, headingIndex).some(line =>
    /^(?:description|job description|responsibilities|qualifications)$/i.test(readerLine(line)));
  if (beforeBody && heading && heading === pageTitle
    && new RegExp(`^[^,:;]{1,80},\\s*(?:${US_STATE_LOCATION_PATTERN})(?:,\\s*(?:US|USA|United States))?$`, 'i').test(headingLocation)) {
    metadata.title ||= heading;
    metadata.location ||= headingLocation;
  }
  const footerCompany = postingFooterCompany(content);
  if (footerCompany) metadata.company ||= footerCompany;
  const reviewedEmployer = reviewedTalemetryEmployer(url, content);
  if (reviewedEmployer) metadata.company ||= reviewedEmployer;
  if (hasIncompleteLocations(lines.slice(0, 100).join('\n'))) metadata.location = postingLocations(metadata.location, [INCOMPLETE_LOCATION]);
  return metadata;
}
