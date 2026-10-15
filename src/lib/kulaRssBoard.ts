import { load } from 'cheerio';
import { SaxesParser } from 'saxes';
import { publishedEmployerName } from './publicAtsEmployer';
import { extractStructuredBaseCompensation } from './postedCompensation';

const host = 'careers.kula.ai';
const tenant = /^[a-z0-9][a-z0-9_-]*$/;
const reserved = new Set(['api', 'assets', 'jobs', 'careers', 'feed', 'feeds', 'portal', 'preview', 'support', 'docs', 'app']);

/** Board, RSS and posting links must all carry the same vendor-owned namespace. */
export function kulaBoardSlugFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== host || url.port || url.username || url.password) return null;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const slug = parts[0]?.toLowerCase();
    if (!slug || !tenant.test(slug) || reserved.has(slug)) return null;
    if (parts.length === 1 || parts.length === 2 && ['feed', 'sitemap.xml'].includes(parts[1])) return slug;
    return /^(?:[1-9]\d*)(?:-[^/]+)?$/.test(parts[1] || '')
      && (parts.length === 2 || parts.length === 3 && parts[2] === 'apply') ? slug : null;
  } catch { return null; }
}

export function kulaBoardUrl(slug: string): string {
  const url = `https://${host}/${slug}`;
  if (kulaBoardSlugFromUrl(url) !== slug) throw new Error('Invalid Kula board identity');
  return url;
}

function postingId(value: string, slug: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || kulaBoardSlugFromUrl(value) !== slug) throw new Error('Kula posting URL identity mismatch');
  const id = url.pathname.split('/')[2]?.match(/^([1-9]\d*)(?:-|$)/)?.[1];
  if (!id) throw new Error('Kula feed has no valid posting identity');
  return id;
}

type SalaryRange = { location: string; currency: string; interval: string; minAmount: number; maxAmount: number; type: string };
type Posting = {
  id: string; publicAtsPostingId: string; title: string; description: string; company: string; url: string;
  location: string; locations: string[]; createdAt?: string; salary?: string; postedCompensation?: string | null;
  kulaSalaryRanges: SalaryRange[];
};

/** The RSS GUID repeats per location. Only tenant plus posting ID identifies a card. */
export function parseKulaRssListing(slug: string, body: string | null): {
  jobs: Posting[]; metadata: Record<string, unknown>; total: number;
} {
  const boardUrl = kulaBoardUrl(slug);
  const xml = body?.trim() || '';
  // Reject error pages, truncated downloads, and declarations of external entities.
  if (!xml.endsWith('</rss>') || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Kula listing schema expected a complete RSS feed');
  // Cheerio recovers damaged markup. Validate XML first so a partial catalogue
  // cannot be mistaken for a complete successful board response.
  try { new SaxesParser({ xmlns: true }).write(xml).close(); }
  catch { throw new Error('Kula listing schema contains malformed XML'); }
  const $ = load(xml, { xmlMode: true });
  const roots = $.root().children();
  const channel = roots.children('channel');
  if (roots.length !== 1 || !roots.is('rss') || roots.attr('version') !== '2.0'
    || roots.attr('xmlns:job') !== 'https://kula.ai/rss' || channel.length !== 1 || roots.children().length !== 1) throw new Error('Kula listing schema expected its RSS job namespace');
  const single = (node: ReturnType<typeof $>, name: string, required = false): string => {
    const values = node.children().filter((_i, element) => element.type === 'tag' && element.name === name);
    if (values.length > 1 || required && values.length !== 1) throw new Error(`Kula listing schema has invalid ${name}`);
    return values.text().trim();
  };
  const company = publishedEmployerName(single(channel, 'title', true));
  if (!company || single(channel, 'link', true).replace(/\/$/, '') !== boardUrl) throw new Error('Kula feed has no verified employer or matching board');
  const entries = channel.children('item');
  if ($('item').length !== entries.length) throw new Error('Kula listing schema has nested or misplaced job entries');
  const postings = new Map<string, Posting>();
  for (const node of entries.toArray()) {
    const item = $(node);
    const id = postingId(single(item, 'link', true), slug);
    const guid = single(item, 'guid');
    if (guid && postingId(guid, slug) !== id) throw new Error('Kula GUID and posting identity disagree');
    const title = single(item, 'title', true);
    const description = single(item, 'description', true);
    if (!title || !description) throw new Error('Kula listing schema has no title or description');
    const published = single(item, 'pubDate');
    if (published && !Number.isFinite(Date.parse(published))) throw new Error('Kula listing schema has invalid publication date');
    const createdAt = published ? new Date(published).toISOString() : undefined;
    const locationNodes = item.children('job\\:location');
    // Some feeds repeat the item per office; others put every office inside
    // one item. Preserve all restrictions in either representation.
    const locations = locationNodes.toArray().map(node => {
      const locationNode = $(node);
      const country = single(locationNode, 'job:country');
      const city = single(locationNode, 'job:city');
      const state = single(locationNode, 'job:state');
      const office = single(locationNode, 'job:officeName');
      const remoteFlag = single(locationNode, 'job:remote');
      if (remoteFlag && !['true', 'false'].includes(remoteFlag)) throw new Error('Kula listing schema has invalid remote flag');
      const place = [...new Set([city, state, country].filter(Boolean))].join(', ') || office;
      const remote = remoteFlag === 'true' || !remoteFlag && single(item, 'job:workplace') === 'REMOTE';
      // A missing country stays missing; an office label is never a global-remote claim.
      return remote ? `${place || 'Unknown Location'} (Remote)` : place || 'Unknown Location';
    });
    // Some valid postings omit location entirely. Keep that uncertainty for
    // the existing geography gate instead of rejecting every job on the board.
    if (!locations.length) locations.push(single(item, 'job:workplace') === 'REMOTE' ? 'Unknown Location (Remote)' : 'Unknown Location');
    const existing = postings.get(id);
    if (existing && (existing.title !== title || existing.description !== description || existing.createdAt !== createdAt)) {
      throw new Error('Kula location entries disagree about the same posting');
    }
    const posting: Posting = existing || {
      id: `${slug}::${id}`, publicAtsPostingId: id, title, description, company,
      url: `${boardUrl}/${id}`, location: '', locations: [], ...(createdAt ? { createdAt } : {}), kulaSalaryRanges: [],
    };
    for (const location of locations) if (!posting.locations.includes(location)) posting.locations.push(location);
    const salaries = item.children('job\\:salary');
    for (const salaryNode of salaries.toArray()) {
      const salary = $(salaryNode);
      const minimum = single(salary, 'job:minAmount');
      const maximum = single(salary, 'job:maxAmount');
      const currency = single(salary, 'job:currency');
      const interval = single(salary, 'job:interval');
      const type = single(salary, 'job:type');
      if (!minimum || !maximum || !currency || !interval || !type) continue;
      const minAmount = Number(minimum), maxAmount = Number(maximum);
      if (!Number.isFinite(minAmount) || !Number.isFinite(maxAmount) || minAmount < 0 || maxAmount < minAmount) throw new Error('Kula listing schema has invalid salary');
      for (const location of locations) {
        const range = { location, currency, interval, minAmount, maxAmount, type };
        if (!posting.kulaSalaryRanges.some(other => JSON.stringify(other) === JSON.stringify(range))) posting.kulaSalaryRanges.push(range);
      }
    }
    postings.set(id, posting);
  }
  const jobs = [...postings.values()].map(posting => {
    posting.locations.sort();
    posting.location = posting.locations.join('; ');
    if (posting.kulaSalaryRanges.length) {
      posting.salary = posting.kulaSalaryRanges.map(range => `${range.currency} ${range.minAmount}–${range.maxAmount} / ${range.interval.toLowerCase()} (${range.type.toLowerCase()}; ${range.location})`).join('; ');
      posting.postedCompensation = extractStructuredBaseCompensation(posting.kulaSalaryRanges.filter(range => range.type === 'BASE').map(range => ({
        currency: range.currency, frequency: range.interval === 'YEARLY' ? 'YEAR' : range.interval,
        rangeStart: range.minAmount, rangeEnd: range.maxAmount,
      })));
    }
    return posting;
  });
  return { jobs, total: jobs.length, metadata: { name: company, listingHasMore: false, tenantListingOffset: 0, kulaFeedEntryCount: entries.length } };
}
