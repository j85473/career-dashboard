import { boardIdentityFromUrl } from './atsDirectMatch';

export type BrowserLink = { text?: string | null; href?: string | null };

/**
 * Direct employer ATS destinations exposed by a rendered Himalayas page.
 *
 * Anonymous pages currently replace Apply with an internal signup URL. That
 * URL is never useful as a canonical destination, and neither are arbitrary
 * third-party links in the description. Until a destination is a supported
 * ATS posting, the browser observation is evidence that the page rendered —
 * not authority to rewrite a stored apply link.
 */
export function directAtsApplyUrls(links: readonly BrowserLink[]): string[] {
  const result = new Set<string>();
  for (const link of links) {
    const label = String(link.text || '').trim();
    const value = String(link.href || '').trim();
    if (!value || !/apply/i.test(`${label} ${value}`)) continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    if (parsed.hostname === 'himalayas.app' || parsed.hostname.endsWith('.himalayas.app')) continue;
    if (!boardIdentityFromUrl(parsed.toString())) continue;
    result.add(parsed.toString());
  }
  return [...result];
}

export function pagePassedCloudflare(body: string, title: string): boolean {
  const combined = `${title}\n${body}`;
  if (/performing security verification|just a moment|verifying you are human|cf-chl-/i.test(combined)) return false;
  return body.trim().length >= 300;
}
