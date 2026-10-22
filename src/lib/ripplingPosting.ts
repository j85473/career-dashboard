import type { AtsScrapeResult } from './atsApi';
import { cleanHtmlText, parseRipplingJobDetail } from './jobIngestion';
import { postingMetadataValue, postingUrlsMatch } from './postingMetadata';
import { safeExternalFetch } from './safeExternalFetch';

export function ripplingPostingIdentity(value: string) {
  try {
    const url = new URL(value);
    const path = /^\/([a-z0-9][a-z0-9_-]*)\/jobs\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'ats.rippling.com' || url.port || url.username || url.password || !path) return null;
    return { slug: path[1], id: path[2].toLowerCase() };
  } catch { return null; }
}

export function parseRipplingPosting(body: unknown, value: string): AtsScrapeResult | null {
  const identity = ripplingPostingIdentity(value);
  if (!identity || !body || typeof body !== 'object') return null;
  const job = body as Record<string, unknown>;
  const published = typeof job.url === 'string' ? ripplingPostingIdentity(job.url) : null;
  if (job.uuid !== identity.id || published?.slug !== identity.slug || published.id !== identity.id) return null;
  const title = postingMetadataValue(job.name);
  if (!title) return null;
  const details = parseRipplingJobDetail(job);
  return { ats: 'Rippling', platform: 'rippling', atsSlug: identity.slug,
    title, company: details.company || undefined, location: details.location || undefined,
    text: cleanHtmlText(details.rawDescription) };
}

export async function fetchRipplingPosting(value: string, read: typeof safeExternalFetch = safeExternalFetch): Promise<AtsScrapeResult | null> {
  const identity = ripplingPostingIdentity(value);
  if (!identity) return null;
  const detailUrl = `https://ats.rippling.com/api/v1/board/${identity.slug}/jobs/${identity.id}`;
  const response = await read(detailUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok || !postingUrlsMatch(response.url || detailUrl, detailUrl)) return null;
  return parseRipplingPosting(await response.json(), value);
}
