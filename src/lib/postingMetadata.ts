import type { AtsScrapeResult } from '@/lib/atsApi';
import { assessJobDescriptionQuality } from '@/lib/jobDescriptionQuality';

export type PostingMetadata = Pick<AtsScrapeResult, 'title' | 'company' | 'location'>;

export function postingMetadataValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && !/^(?:unknown(?: company| location)?|n\/a|not specified|not available)$/i.test(text) ? text : undefined;
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
  return { description: input.description, verified };
}

function readerLine(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/^\s*(?:#{1,6}\s+|[-•]\s+)/, '').trim();
}

/** Read explicit posting labels, never employer mentions in the duties or site navigation. */
export function parsePostingReaderMetadata(markdown: string, url: string): PostingMetadata {
  const sourceUrl = /^URL Source:\s*(\S+)/m.exec(markdown)?.[1];
  if (!sourceUrl || !postingUrlsMatch(sourceUrl, url)) return {};
  const content = /^Markdown Content:\s*\n([\s\S]+)$/m.exec(markdown)?.[1];
  if (!content) return {};
  const lines = content.split(/\r?\n/).map(readerLine).filter(Boolean);
  const metadata: PostingMetadata = {};
  for (let index = 0; index < Math.min(lines.length, 100); index += 1) {
    const line = lines[index];
    if (/^(?:job description|description|responsibilities|qualifications|about (?:the )?role|what you(?:'|’)ll do)$/i.test(line)) break;
    const match = /^(company|employer|hiring organization|job title|job location|work location|locations?)(?:\s*:\s*(.*))?$/i.exec(line);
    if (!match) continue;
    const value = postingMetadataValue(match[2] || lines[index + 1]);
    if (!value || value.length > 200 || /^https?:\/\//i.test(value)
      || /^(?:company|employer|hiring organization|job title|job location|work location|locations?)(?:\s*:|$)/i.test(value)
      || /^(?:job description|description|responsibilities|qualifications)$/i.test(value)) continue;
    if (/^(?:company|employer|hiring organization)$/i.test(match[1])) metadata.company ||= value;
    else if (/^job title$/i.test(match[1])) metadata.title ||= value;
    else metadata.location ||= value;
  }
  return metadata;
}
