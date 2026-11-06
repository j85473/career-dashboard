import { directAtsPostingKey, isDirectPostingUrl } from './atsDirectMatch';

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Use the direct posting already supplied with this result, when unambiguous. */
export function preferredAggregatorApplyUrl(input: {
  primary?: unknown; fallback?: unknown; options?: unknown;
}): string {
  const primary = httpUrl(input.primary);
  const options = Array.isArray(input.options) ? input.options : [];
  const urls = [primary, ...options.map(option => option && typeof option === 'object'
    ? httpUrl(option.apply_link ?? option.link) : null)].filter((url): url is string => Boolean(url));
  const direct = new Map<string, string>();
  for (const url of urls) {
    if (!isDirectPostingUrl(url)) continue;
    const identity = directAtsPostingKey({ url });
    if (!direct.has(identity)) direct.set(identity, url);
  }
  // Multiple different employer postings are conflicting source evidence. A
  // publisher label or is_direct flag alone cannot identify the right one.
  if (direct.size === 1) return [...direct.values()][0];
  return primary || urls[0] || httpUrl(input.fallback) || '';
}
