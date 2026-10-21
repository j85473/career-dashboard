import * as cheerio from 'cheerio';

import { discoveredAtsBoardFromJobUrl } from './atsBoardDiscovery';
import { identifyAts } from './atsUtils';
import { gustoBoardSlugFromUrl } from './gustoBoard';
import { assertSafeExternalNavigationUrl } from './safeExternalFetch';

export type WebDiscoveredBoard = { platform: string; slug: string; matchedUrl: string };
export type WebDiscoveryLink = { url: string; priority: number };

const CAREERS = /(?:career|jobs?|join[-_ /]?(?:us|our[-_ /]?team)|work[-_ /]?with|opportunit|vacanc)/i;
const DIRECTORY = /(?:director(?:y|ies)|members?|companies|partners?|portfolio|businesses)/i;
const ASSET = /\.(?:pdf|zip|gz|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|woff2?|ttf|css|js|json|xml|rss|atom|docx?|xlsx?)(?:$|\/)/i;
const SKIP_PATH = /(?:^|\/)(?:login|logout|sign-?in|sign-?up|register|unsubscribe|checkout|cart|delete|remove|privacy|terms|calendar)(?:\/|$)/i;
const SOCIAL_HOST = /(?:^|\.)(?:facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|pinterest\.com)$/i;

/** Preserve case and identity-bearing query values; only remove tracking and fragments. */
export function normalizeDiscoveryUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    // Explicitly reject javascript:, data:, file:, mailto:, tel:, ftp: and every
    // other non-HTTP scheme before a URL can enter the crawl queue.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    assertSafeExternalNavigationUrl(url);
    if (url.href.length > 2048 || url.searchParams.size > 8) return null;
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|gclid|fbclid|msclkid)$/i.test(name)) url.searchParams.delete(name);
    }
    return url.href;
  } catch {
    return null;
  }
}

/** Use the collectors' existing identity parsers; never guess a tenant from a company name. */
export function knownAtsBoardFromUrl(value: string): WebDiscoveredBoard | null {
  const matchedUrl = normalizeDiscoveryUrl(value);
  if (!matchedUrl) return null;
  const gustoSlug = gustoBoardSlugFromUrl(matchedUrl);
  const board = gustoSlug ? { platform: 'gusto', slug: gustoSlug }
    : discoveredAtsBoardFromJobUrl(matchedUrl, identifyAts({ url: matchedUrl }));
  return board ? { ...board, matchedUrl } : null;
}

export function discoveryLinkPriority(url: string, label = ''): number {
  const parsed = new URL(url);
  const hint = `${parsed.pathname} ${label}`;
  if (CAREERS.test(hint)) return 100;
  if (DIRECTORY.test(hint)) return 70;
  if (parsed.pathname === '/' && !parsed.search) return 50;
  return 10;
}

export function isExplorableDiscoveryUrl(value: string): boolean {
  const url = new URL(value);
  return !SOCIAL_HOST.test(url.hostname) && !ASSET.test(url.pathname) && !SKIP_PATH.test(url.pathname);
}

/** Discover destinations, not jobs. Scripts are examined only for known ATS URLs. */
export function extractAtsDiscoveryLinks(html: string, pageUrl: string, maximumLinks = 500): {
  boards: WebDiscoveredBoard[]; links: WebDiscoveryLink[];
} {
  const $ = cheerio.load(html);
  const robots = $('meta[name="robots" i],meta[name="CareerDashboardDiscovery" i]').toArray()
    .map(node => $(node).attr('content') || '').join(',');
  if (/(?:^|[\s,])(?:nofollow|none)(?:$|[\s,])/i.test(robots)) return { boards: [], links: [] };
  const base = normalizeDiscoveryUrl($('base[href]').first().attr('href') || '', pageUrl) || pageUrl;
  const boards = new Map<string, WebDiscoveredBoard>();
  const links = new Map<string, WebDiscoveryLink>();
  const consider = (raw: string, label = '', knownOnly = false) => {
    const url = normalizeDiscoveryUrl(raw, base);
    if (!url) return;
    const board = knownAtsBoardFromUrl(url);
    if (board) {
      boards.set(`${board.platform}:${board.slug}`, board);
    } else if (!knownOnly && isExplorableDiscoveryUrl(url)) {
      const priority = discoveryLinkPriority(url, label);
      if (!links.has(url) || links.get(url)!.priority < priority) links.set(url, { url, priority });
    }
  };
  $('a[href],iframe[src],script[src],form[action]').each((_index, node) => {
    const element = $(node);
    if (/(?:^|\s)nofollow(?:$|\s)/i.test(element.attr('rel') || '')) return;
    consider(element.attr('href') || element.attr('src') || element.attr('action') || '', element.text().slice(0, 200), node.name !== 'a');
  });
  $('script:not([src])').each((_index, node) => {
    const script = $(node).text().replaceAll('\\/', '/').replace(/\\u002f/gi, '/');
    for (const match of script.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) consider(match[0], '', true);
  });
  return {
    boards: [...boards.values()],
    links: [...links.values()].sort((a, b) => b.priority - a.priority).slice(0, maximumLinks),
  };
}
